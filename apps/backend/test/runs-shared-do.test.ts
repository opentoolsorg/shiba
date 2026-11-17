import { describe, expect, it, vi } from "vitest";
import { buildSessionAgentName, type WebSessionRecord } from "../src/web-sessions.js";

// Per-DO run stores: the caller's own DO, another user's DO, and the shared
// "default" DO that automations / review / Sentry runs queue on (P7 #4).
const stores = vi.hoisted(() => ({
  tasks: {} as Record<string, Array<{ taskId: string; updatedAt: number; attempts: { runId?: string; approvalId?: string }[] }>>,
  runs: {} as Record<string, Array<{ runId: string; createdAt: number }>>,
  sessions: {} as Record<string, WebSessionRecord[]>,
  user: "op@example.com",
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async (_ns: unknown, name: string) => ({
    fetch: async (input: Request | string) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      const sessionId = url.pathname.match(/^\/internal\/web-sessions\/([^/]+)$/)?.[1];
      if (sessionId) {
        const session = stores.sessions[name]?.find((row) => row.id === decodeURIComponent(sessionId));
        return session ? Response.json({ session }) : Response.json({ error: "Session not found." }, { status: 404 });
      }
      if (url.pathname === "/api/tasks") return Response.json({ tasks: stores.tasks[name] ?? [] });
      const runs = stores.runs[name] ?? [];
      const id = url.pathname.match(/^\/api\/runs\/([^/]+)$/)?.[1];
      if (id) {
        const run = runs.find((r) => r.runId === decodeURIComponent(id));
        return run ? Response.json({ run }) : Response.json({ error: "Run not found." }, { status: 404 });
      }
      const limit = url.searchParams.get("limit");
      return Response.json({ runs: limit ? runs.slice(-Number(limit)).reverse() : runs });
    },
  }),
  routeAgentRequest: async () => null,
}));
vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/request-auth.js")>()),
  isAuthorizedRequest: async () => true,
  resolveUserId: async () => stores.user,
}));

import type { Env } from "../src/env.js";
import { handleRuns } from "../src/runs-routes.js";

const env = (approvers?: string) =>
  ({ CodingOrchestrator: {}, DASHBOARD_APPROVERS: approvers }) as unknown as Env;

stores.runs = {
  "op@example.com": [{ runId: "mine", createdAt: 2 }],
  "other@example.com": [{ runId: "theirs", createdAt: 3 }],
  default: [
    { runId: "automation", createdAt: 1 },
    { runId: "review", createdAt: 4 },
  ],
};

async function list(path: string, e: Env): Promise<string[]> {
  const res = await handleRuns(new Request(`https://shiba.test${path}`), e);
  expect(res?.status, await res?.clone().text()).toBe(200);
  const body = (await res!.json()) as { runs: Array<{ runId: string }> };
  return body.runs.map((r) => r.runId);
}

describe("GET /api/runs reads the shared default DO", () => {
  it("merges default-DO runs for a dashboard approver, oldest first", async () => {
    stores.user = "op@example.com";
    expect(await list("/api/runs", env("op@example.com"))).toEqual(["automation", "mine", "review"]);
  });

  it("keeps the bounded listing newest-first and capped", async () => {
    stores.user = "op@example.com";
    expect(await list("/api/runs?limit=2", env("op@example.com"))).toEqual(["review", "mine"]);
  });

  it("falls back to the default DO for run detail", async () => {
    stores.user = "op@example.com";
    const res = await handleRuns(new Request("https://shiba.test/api/runs/automation"), env("op@example.com"));
    expect(res?.status).toBe(200);
    expect(((await res!.json()) as { run: { runId: string } }).run.runId).toBe("automation");
  });

  it("never shows shared or other users' runs to a non-approver", async () => {
    stores.user = "other@example.com";
    expect(await list("/api/runs", env("op@example.com"))).toEqual(["theirs"]);
    const res = await handleRuns(new Request("https://shiba.test/api/runs/automation"), env("op@example.com"));
    expect(res?.status).toBe(404);
  });

  it("does not merge into a session-scoped listing", async () => {
    stores.user = "op@example.com";
    const session = crypto.randomUUID();
    stores.sessions[stores.user] = [{ id: session, userId: stores.user, agentName: buildSessionAgentName(stores.user, session),
      name: "Separate private session", createdAt: 1, updatedAt: 1, metadata: {} }];
    expect(await list(`/api/runs?session=${session}`, env("op@example.com"))).toEqual([]);
  });
});


describe("routine task DTO", () => {
  const routine = {
    id: "weekly", name: "Weekly summary", prompt: "Summarize", repoUrl: "https://github.com/o/r", enabled: true,
    runCount: 1, nextRunAt: 1_800_000_000_000,
    triggers: [{ kind: "schedule", cron: "0 9 * * 1", timezone: "America/New_York" }],
    occurrences: [{ approvalId: "routine-approval", runId: "routine-run" }],
  };
  const bindings = (approvers?: string) => ({ ...env(approvers), Automations: {
    idFromName: () => "default", get: () => ({ fetch: async () => Response.json({ automations: [routine] }) }),
  } }) as unknown as Env;
  const own = { taskId: "own-task", updatedAt: 1, attempts: [{ runId: "mine" }] };
  const scheduled = { taskId: "routine-task", updatedAt: 2, attempts: [{ approvalId: "routine-approval" }] };
  const other = { taskId: "other-shared-task", updatedAt: 3, attempts: [{ runId: "review" }] };
  async function tasks(path: string, e: Env) {
    const response = await handleRuns(new Request(`https://shiba.test${path}`), e);
    expect(response?.status).toBe(200);
    return (await response?.json() as { tasks: { taskId: string; routine?: unknown }[] }).tasks;
  }
  it("joins routine metadata onto shared tasks only for an unscoped dashboard approver", async () => {
    stores.user = "op@example.com";
    stores.tasks = { "op@example.com": [own], default: [scheduled, other] };
    const result = await tasks("/api/tasks", bindings(stores.user));
    expect(result.map((task) => task.taskId)).toEqual(["routine-task", "own-task"]);
    expect(result[0]?.routine).toEqual({ id: "weekly", name: "Weekly summary", schedule: "0 9 * * 1", timezone: "America/New_York", nextRunAt: routine.nextRunAt });
    expect(result[1]?.routine).toBeUndefined();
    expect(await tasks("/api/tasks", bindings())).toEqual([own]);
  });
  it("includes routine metadata on authorized run lists and details", async () => {
    stores.user = "op@example.com";
    stores.runs.default = [{ runId: "routine-run", createdAt: 1 }, { runId: "unrelated", createdAt: 2 }];
    const listed = await handleRuns(new Request("https://shiba.test/api/runs"), bindings(stores.user));
    const body = await listed?.json() as { runs: { runId: string; routine?: { id: string } }[] };
    expect(body.runs.find((run) => run.runId === "routine-run")?.routine?.id).toBe("weekly");
    expect(body.runs.find((run) => run.runId === "unrelated")?.routine).toBeUndefined();
    const found = await handleRuns(new Request("https://shiba.test/api/runs/routine-run"), bindings(stores.user));
    expect(await found?.json()).toMatchObject({ run: { runId: "routine-run", routine: { id: "weekly" } } });
    expect((await handleRuns(new Request("https://shiba.test/api/runs/routine-run"), bindings()))?.status).toBe(404);
  });
  it("never merges shared routine tasks into a selected session", async () => {
    stores.user = "op@example.com";
    stores.tasks = { default: [scheduled] };
    const session = crypto.randomUUID();
    stores.sessions[stores.user] = [{ id: session, userId: stores.user, agentName: buildSessionAgentName(stores.user, session),
      name: "Private session", createdAt: 1, updatedAt: 1, metadata: {} }];
    expect(await tasks(`/api/tasks?session=${session}`, bindings(stores.user))).toEqual([]);
  });
});
