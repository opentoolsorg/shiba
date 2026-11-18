import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  AutomationsScope,
  AUTOMATION_WORKSPACE_HEADER,
} from "../src/platform/automations-scope.js";
import { automationsStub } from "../src/automations-stub.js";
import type { Env } from "../src/env.js";
import { Automations } from "../src/automations-do.js";
import { createAutomation } from "../src/automations.js";
import { getAgentByName } from "agents/routing";
import { handleApprovals } from "../src/approvals-routes.js";
import * as requestAuth from "../src/request-auth.js";
import * as orgAuth from "../src/org-request-auth.js";

vi.mock("agents/routing", () => ({ getAgentByName: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

class Storage {
  data = new Map<string, unknown>();
  async get<T>(key: string) {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async list({ prefix = "" } = {}) {
    return new Map([...this.data].filter(([key]) => key.startsWith(prefix)));
  }
  async transaction<T>(work: (storage: Storage) => Promise<T>) {
    return work(this);
  }
}

function fixture() {
  const objects = new Map<
    string,
    { storage: Storage; router: AutomationsScope; local: Mock<(request: Request) => Promise<Response>> }
  >();
  const env = {
    SHIBA_SCOPED_DO: "1",
    Automations: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: (request: Request) => {
          const object = get(name);
          return object.router.fetch(request, object.local);
        },
      }),
    },
  } as unknown as Env;
  function get(name: string) {
    let object = objects.get(name);
    if (!object) {
      const storage = new Storage();
      const local = vi.fn(async (request: Request) => {
        if (new URL(request.url).pathname === "/internal/tick") {
          await storage.put("executions", ((await storage.get<number>("executions")) ?? 0) + 1);
        }
        return Response.json((await storage.get("state")) ?? { items: [] });
      });
      const router = new AutomationsScope(
        { id: name, storage } as unknown as DurableObjectState,
        env,
      );
      object = { storage, router, local };
      objects.set(name, object);
    }
    return object;
  }
  const call = (workspace?: string, path = "/api/automations", headers?: HeadersInit) =>
    automationsStub(env, workspace).fetch(
      new Request(`https://internal${path}`, { method: "POST", headers }),
    );
  return { get, env, call, objects };
}

describe("workspace automation migration and dispatch", () => {
  it("never probes private or other workspace approvals through a team selector", async () => {
    vi.spyOn(requestAuth, "isAuthorizedRequest").mockResolvedValue(true);
    vi.spyOn(requestAuth, "resolveUserId").mockResolvedValue("owner");
    vi.spyOn(orgAuth, "resolveOrgForApiRequest").mockResolvedValue({ orgId: "team:one", principal: null });
    const names: string[] = [];
    vi.mocked(getAgentByName).mockImplementation(async (_namespace, name) => {
      names.push(name);
      return { fetch: async () => Response.json({ approvals: [], decided: [], result: "unknown" }) } as never;
    });
    const env = { SHIBA_SCOPED_DO: "1", DASHBOARD_APPROVERS: "owner" } as Env;
    expect((await handleApprovals(new Request("https://internal/api/approvals"), env))?.status).toBe(200);
    const decision = await handleApprovals(new Request("https://internal/api/approvals", {
      method: "POST", body: JSON.stringify({ threadKey: "owner", approvalId: "private", approved: false }),
    }), env);
    expect(await decision?.json()).toEqual({ result: "unknown" });
    expect(names.every((name) => name === "ws:team%3Aone")).toBe(true);
  });

  it("imports legacy secrets and accounting only into self-hosted, once", async () => {
    const f = fixture();
    const legacy = { items: [{ id: "legacy", webhookSecret: "private-secret", runCount: 7 }] };
    await f.get("default").storage.put("state", legacy);
    expect(await (await f.call("team:one")).json()).toEqual({ items: [] });
    expect(await (await f.call("self-hosted")).json()).toEqual(legacy);
    await f.get("ws:self-hosted").storage.put("state", { items: [] });
    expect(await (await f.call("self-hosted")).json()).toEqual({ items: [] });
    expect(await (await f.call("team:two")).json()).toEqual({ items: [] });
  });

  it("does not allow a forged workspace header to override the authenticated selection", async () => {
    const f = fixture();
    await f.call("team:one", "/api/automations", { [AUTOMATION_WORKSPACE_HEADER]: "team:two" });
    expect(f.objects.has("ws:team%3Atwo")).toBe(false);
    expect(f.get("ws:team%3Aone").local).toHaveBeenCalledTimes(1);
    const target = f.get("ws:team%3Aone");
    expect(
      (
        await target.router.fetch(
          new Request("https://internal/api/automations", {
            headers: { [AUTOMATION_WORKSPACE_HEADER]: "team:two" },
          }),
          target.local,
        )
      ).status,
    ).toBe(403);
  });

  it("fans out only to registered workspaces and does not execute a scheduled slot twice, even after restart", async () => {
    const f = fixture();
    await f.call("team:one");
    const tick = () => f.call(undefined, "/internal/tick", { "X-Shiba-Schedule-Slot": "42" });
    await Promise.all([tick(), tick()]);
    for (const name of ["ws:self-hosted", "ws:team%3Aone"]) {
      expect(await f.get(name).storage.get("executions")).toBe(1);
      const object = f.get(name);
      object.router = new AutomationsScope(
        { id: name, storage: object.storage } as unknown as DurableObjectState,
        f.env,
      );
    }
    await tick();
    await f.call(undefined, "/internal/tick", { "X-Shiba-Schedule-Slot": "41" });
    expect(f.get("default").local).not.toHaveBeenCalled();
    expect(f.objects.has("ws:unregistered")).toBe(false);
    expect(await f.get("ws:team%3Aone").storage.get("executions")).toBe(1);
  });

  it("reports target failures and retries an unsuccessful slot", async () => {
    const f = fixture();
    await f.call("team:one");
    f.get("ws:team%3Aone").local.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const tick = () => f.call(undefined, "/internal/tick", { "X-Shiba-Schedule-Slot": "9" });
    expect((await tick()).status).toBe(503);
    expect((await tick()).status).toBe(200);
    expect(await f.get("ws:team%3Aone").storage.get("executions")).toBe(1);
    expect(await f.get("ws:self-hosted").storage.get("executions")).toBe(1);
  });

  it("queues a migrated due schedule once, without copying it into a team or executing it on the legacy DO", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 28, 10, 0));
    const objects = new Map<string, { storage: Storage; instance: Automations }>();
    const queued: { name: string; commandId: string; orgId: string }[] = [];
    vi.mocked(getAgentByName).mockImplementation(
      async (_namespace, name) =>
        ({
          fetch: async (request: Request) => {
            if (request.method === "POST")
              queued.push({
                name,
                ...((await request.json()) as { commandId: string; orgId: string }),
              });
            return Response.json(
              request.method === "POST"
                ? { approvalId: "approval" }
                : { runs: [], approvals: [], decided: [] },
            );
          },
        }) as never,
    );
    const env = {
      SHIBA_SCOPED_DO: "1",
      AUTOMATIONS_ENABLED: "true",
      AI: {},
      Automations: {
        idFromName: (name: string) => name,
        get: (name: string) => ({ fetch: (request: Request) => get(name).instance.fetch(request) }),
      },
    } as unknown as Env;
    function get(name: string) {
      let object = objects.get(name);
      if (!object) {
        const storage = new Storage();
        object = {
          storage,
          instance: new Automations({ id: name, storage } as unknown as DurableObjectState, env),
        };
        objects.set(name, object);
      }
      return object;
    }
    const automation = createAutomation({
      id: "legacy-schedule",
      prompt: "Prepare a draft",
      repoUrl: "https://github.com/owner/repo",
      triggers: [{ kind: "schedule", cron: "*/5 * * * *" }],
    }).automation;
    await get("default").storage.put("state", { items: [automation] });
    const team = await automationsStub(env, "team:one").fetch(
      new Request("https://internal/api/automations"),
    );
    expect(await team.json()).toEqual({ automations: [] });
    const tick = () =>
      automationsStub(env).fetch(
        new Request("https://internal/internal/tick", {
          method: "POST",
          headers: { "X-Shiba-Schedule-Slot": "42" },
        }),
      );
    expect((await tick()).status).toBe(200);
    expect((await tick()).status).toBe(200);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ name: "ws:self-hosted", orgId: "self-hosted" });
    expect(await get("default").storage.get("state")).toEqual({ items: [automation] });
  });
});
