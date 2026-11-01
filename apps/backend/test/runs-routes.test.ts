import { describe, expect, it, vi } from "vitest";

// The gateway strips inbound vouchers before proxying to the DO: assert on
// the exact Request the stub receives, not on handleRuns' response.
const forwarded = vi.hoisted(() => ({ requests: [] as Request[] }));
vi.mock("agents/routing", () => ({
  getAgentByName: async (_ns: unknown, _name: string) => ({
    fetch: async (request: Request | string) => {
      if (typeof request === "string") return Response.json({ session: {} });
      forwarded.requests.push(request);
      return Response.json({ runs: [] });
    },
  }),
  routeAgentRequest: async () => null,
}));
vi.mock("../src/request-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/request-auth.js")>();
  return {
    ...actual,
    isAuthorizedRequest: async () => true,
    resolveUserId: async () => "devin",
  };
});

import { AGENT_PRINCIPAL_HEADER, LOCAL_INTAKE_HEADER } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { handleRuns, queueCollaborationRun } from "../src/runs-routes.js";
import { activateSkill, createSkill, reviewSkill } from "../src/skills-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const env = { CodingOrchestrator: {} } as unknown as Env;

describe("handleRuns voucher hygiene", () => {
  it("forwards a repo-free room handoff through the normal Worker approval intake with a trusted handoff fence", async () => {
    forwarded.requests.length = 0;
    const executionTarget = {
      kind: "artifact-workspace" as const,
      expectedDeliverables: ["reports/room.md"],
    };
    const response = await queueCollaborationRun(
      new Request("https://shiba.test/api/collaboration/rooms/room-1/handoffs", {
        method: "POST", headers: { "content-type": "application/json" },
      }),
      env,
      {
        task: "Write a room report.",
        executionTarget,
        customAgentId: "employee-1",
        profileVersion: 3,
        commandId: "handoff-1",
        collaborationHandoffId: "handoff-1",
        runtime: "sandbox",
      },
    );
    expect(response?.status).toBe(200);
    const forwardedBody = await forwarded.requests[0]?.json() as Record<string, unknown>;
    expect(forwardedBody).toMatchObject({
      task: "Write a room report.",
      executionTarget,
      customAgentId: "employee-1",
      customAgentVersion: 3,
      collaborationHandoffId: "handoff-1",
      orgId: "self-hosted",
      threadKey: "devin",
    });
    expect(forwardedBody.repoUrl).toBeUndefined();
  });

  it("rejects an oversized task after resolving active skill text before forwarding", async () => {
    forwarded.requests.length = 0;
    const db = customAgentD1();
    const bindings = { ...env, AGENT_AUDIT: db.database } as Env;
    const instructions = "Review each affected module carefully.";
    const skill = await createSkill(bindings, "self-hosted", "devin", { name: "Review", instructions });
    await reviewSkill(bindings, "self-hosted", "devin", skill.id, 1, instructions);
    await activateSkill(bindings, "self-hosted", "devin", skill.id, 1, instructions);
    const response = await handleRuns(new Request("https://shiba.test/api/runs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "x".repeat(3990), repoUrl: "https://github.com/o/r", skillPins: [{ skillId: skill.id, version: 1 }] }),
    }), bindings);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: expect.stringContaining("complete task and selected skill instructions") });
    expect(forwarded.requests).toHaveLength(0);
  });

  it.each([undefined, "default", "someone-else", "web:victim:00000000-0000-4000-8000-000000000001"])("stamps the authenticated user's run queue over client threadKey %s", async (threadKey) => {
    forwarded.requests.length = 0;
    const response = await handleRuns(new Request("https://shiba.test/api/runs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "inspect", threadKey, repoUrl: "https://github.com/o/r" }),
    }), env);
    expect(response?.status).toBe(200);
    expect(await forwarded.requests[0]?.json()).toMatchObject({ task: "inspect", threadKey: "devin" });
  });

  it.each([undefined, "foreign-org", "self-hosted", { forged: true }])("pins dashboard profile/provider lookup to authenticated deployment org over %j", async (orgId) => {
    forwarded.requests.length = 0;
    await handleRuns(new Request("https://shiba.test/api/runs", { method: "POST",
      headers: { "content-type": "application/json", "X-Org-Id": "foreign-header-org" },
      body: JSON.stringify({ task: "inspect", orgId, customAgentId: "selected-profile", sandboxProvider: "computesdk" }),
    }), env);
    expect(await forwarded.requests[0]?.json()).toMatchObject({ orgId: "self-hosted", threadKey: "devin", customAgentId: "selected-profile", sandboxProvider: "computesdk" });
  });

  it("stamps the verified named-session target instead of a forged shared thread key", async () => {
    forwarded.requests.length = 0;
    const sessionId = "00000000-0000-4000-8000-000000000001";
    await handleRuns(new Request(`https://shiba.test/api/runs?session=${sessionId}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "inspect", threadKey: "default" }),
    }), env);
    expect(await forwarded.requests[0]?.json()).toMatchObject({ threadKey: `web:devin:${sessionId}` });
  });

  it.each([" run ", "", null, 0])("uses the same default run-kind semantics as intake for %s", async (kind) => {
    forwarded.requests.length = 0;
    await handleRuns(new Request("https://shiba.test/api/runs", { method: "POST",
      body: JSON.stringify({ kind, threadKey: "forged" }),
    }), env);
    expect(await forwarded.requests[0]?.json()).toMatchObject({ threadKey: "devin" });
  });

  it("keeps side-effect approval routing distinct from personal coding-run ownership", async () => {
    forwarded.requests.length = 0;
    await handleRuns(new Request("https://shiba.test/api/runs", { method: "POST",
      body: JSON.stringify({ kind: "email_send", threadKey: "mailbox-thread", orgId: "forged-org", payload: {} }),
    }), env);
    expect(await forwarded.requests[0]?.json()).toMatchObject({ kind: "email_send", threadKey: "mailbox-thread", orgId: "self-hosted" });
  });

  it("does not route existing-run mutations through the shared orchestrator for email kinds", async () => {
    forwarded.requests.length = 0;
    const response = await handleRuns(new Request("https://shiba.test/api/runs/run-1/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "email_send" }),
    }), env);
    expect(response?.status).toBe(200);
    expect(forwarded.requests).toHaveLength(1);
    expect(new URL(forwarded.requests[0]!.url).pathname).toBe("/api/runs/run-1/archive");
  });
  it("strips a forged agent-principal header before proxying to the DO", async () => {
    forwarded.requests.length = 0;
    const request = new Request("https://shiba.test/api/runs", {
      headers: { [AGENT_PRINCIPAL_HEADER]: "claude-code" },
    });
    const response = await handleRuns(request, env);
    expect(response?.status).toBe(200);
    expect(forwarded.requests).toHaveLength(1);
    // The DO treats queuedBy and the /api/spine filter as worker-vouched;
    // an inbound copy is a forgery and must never reach it.
    const proxied = forwarded.requests[0];
    expect(proxied?.headers.get(AGENT_PRINCIPAL_HEADER)).toBeNull();
    expect(proxied?.headers.get(LOCAL_INTAKE_HEADER)).toBe("dashboard");
  });

  it("stamps the dashboard intake voucher over any inbound copy", async () => {
    forwarded.requests.length = 0;
    const request = new Request("https://shiba.test/api/runs", {
      headers: { [LOCAL_INTAKE_HEADER]: "forged" },
    });
    const response = await handleRuns(request, env);
    expect(response?.status).toBe(200);
    expect(forwarded.requests[0]?.headers.get(LOCAL_INTAKE_HEADER)).toBe("dashboard");
  });

  it("routes GET /api/spine through the same lane with the principal strip", async () => {
    forwarded.requests.length = 0;
    const request = new Request("https://shiba.test/api/spine", {
      headers: { [AGENT_PRINCIPAL_HEADER]: "claude-code" },
    });
    const response = await handleRuns(request, env);
    expect(response?.status).toBe(200);
    expect(forwarded.requests).toHaveLength(1);
    // Dashboard-authed callers always get the full view — the filter only
    // applies to internally stamped agent principals, never this lane.
    const proxied = forwarded.requests[0];
    expect(new URL(proxied!.url).pathname).toBe("/api/spine");
    expect(proxied?.headers.get(AGENT_PRINCIPAL_HEADER)).toBeNull();
  });

  it("routes authenticated task history and retry/cancel actions through the scoped orchestrator", async () => {
    forwarded.requests.length = 0;
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const paths = [
      `/api/tasks?session=${sessionId}`,
      `/api/tasks/task_abc/retry?session=${sessionId}`,
      `/api/tasks/task_abc/cancel?session=${sessionId}`,
    ];
    for (const path of paths) {
      const response = await handleRuns(new Request(`https://shiba.test${path}`, {
        method: path.includes("/retry") || path.includes("/cancel") ? "POST" : "GET",
        headers: path.includes("/retry") || path.includes("/cancel") ? { "content-type": "application/json" } : undefined,
        body: path.includes("/retry") ? JSON.stringify({ commandId: "retry-task-0001" })
          : path.includes("/cancel") ? JSON.stringify({ attempt: 1 }) : undefined,
      }), env);
      expect(response?.status).toBe(200);
    }
    expect(forwarded.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/tasks", "/api/tasks/task_abc/retry", "/api/tasks/task_abc/cancel",
    ]);
    expect(forwarded.requests.every((request) => new URL(request.url).searchParams.get("session") === sessionId)).toBe(true);
  });

  it("rejects non-GET methods on /api/spine", async () => {
    const response = await handleRuns(
      new Request("https://shiba.test/api/spine", { method: "POST" }),
      env,
    );
    expect(response?.status).toBe(405);
  });
});
