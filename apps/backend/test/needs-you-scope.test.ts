import { applyAllMigrations } from "./fixtures/all-migrations.js";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleTeamWork } from "../src/team-work-routes.js";

const runsByOwner = vi.hoisted(() => new Map<string, Array<{ runId: string; orgId?: string; createdAt?: number; task?: string; status?: string; queuedBy?: string; parentRunId?: string }>>());
vi.mock("../src/request-auth.js", async (original) => ({
  ...await original<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: async (request: Request) => request.headers.get("X-Test-User") !== "unauthorized",
  resolveUserId: async (request: Request) => request.headers.get("X-Test-User"),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async (_binding: unknown, name: string) => ({
    fetch: async () => Response.json({ runs: runsByOwner.get(name) ?? [] }),
  }),
}));

const onboarding = vi.hoisted(() => vi.fn(async (_request: Request, _env: unknown) => null as Response | null));
vi.mock("../src/onboarding-progress.js", () => ({ handleOnboardingProgress: onboarding }));

const TEAM = `ws_${"ab".repeat(12)}`;

function database(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE ask_user_pending (
      tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, run_id TEXT NOT NULL, ask_id TEXT NOT NULL,
      request_json TEXT NOT NULL, status TEXT NOT NULL, answer_json TEXT, created_at INTEGER NOT NULL, answered_at INTEGER,
      PRIMARY KEY (tenant_id, owner_id, run_id, ask_id)
    );
    CREATE TABLE run_milestones (
      run_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      payload_json TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (run_id, seq)
    );
  `);
  applyAllMigrations(db);
  const insert = db.prepare("INSERT INTO run_milestones (run_id, seq, kind, text, created_at) VALUES (?, ?, ?, ?, ?)");
  insert.run("run-a", 1, "blocked", "A blocker", 10);
  insert.run("run-a", 2, "status", "A status", 11);
  insert.run("run-a-team", 1, "blocked", "A team blocker", 12);
  insert.run("run-b", 1, "blocked", "B blocker", 13);
  insert.run("run-b", 2, "status", "B status", 14);
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => db.prepare(sql).run(...(values as never[])),
        first: async <T>() => db.prepare(sql).get(...(values as never[])) as T | null,
        all: async <T>() => ({ results: db.prepare(sql).all(...(values as never[])) as T[] }),
      }),
    }),
  } as unknown as D1Database;
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  onboarding.mockReset();
  onboarding.mockResolvedValue(null);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  runsByOwner.clear();
  runsByOwner.set("user-a@example.test", [
    { runId: "run-a", orgId: "self-hosted", createdAt: Date.now() - 1000, status: "error", task: "Fix the build" },
    { runId: "run-a-team", orgId: `team:${TEAM}`, createdAt: 2 },
  ]);
  runsByOwner.set("user-b@example.test", [
    { runId: "run-b", orgId: "self-hosted", createdAt: 3 },
  ]);
});

function environment() { return { AGENT_AUDIT: database(), CodingOrchestrator: {} } as unknown as Env; }

async function needsYou(userId: string, workspaceId?: string, env = environment()) {
  const headers = new Headers({ "X-Test-User": userId });
  if (workspaceId) headers.set("X-Shiba-Workspace", workspaceId);
  const response = await handleTeamWork(new Request("http://127.0.0.1:1/api/needs-you", { headers }), env);
  expect(response?.status).toBe(200);
  return await response!.json() as { blocked: Array<{ runId: string; title: string }>; progress: Record<string, string>; suggestions: Array<{ id: string }> };
}

describe("needs-you milestone scope", () => {
  it("never returns another user's blocked runs or status", async () => {
    const body = await needsYou("user-b@example.test");
    expect(body.blocked.map((row) => row.runId)).toEqual(["run-b"]);
    expect(body.blocked.some((row) => row.title.includes("A "))).toBe(false);
    expect(body.progress).toEqual({ "run-b": "B status" });
    expect(JSON.stringify(body)).not.toContain("A blocker");
    expect(JSON.stringify(body)).not.toContain("A status");
    expect(JSON.stringify(body)).not.toContain("A team blocker");
  });

  it("keeps a caller's other workspace out of this workspace", async () => {
    const personal = await needsYou("user-a@example.test");
    expect(personal.blocked.map((row) => row.runId)).toEqual(["run-a"]);
    const team = await needsYou("user-a@example.test", TEAM);
    expect(team.blocked.map((row) => row.runId)).toEqual(["run-a-team"]);
    expect(team.progress["run-a"]).toBeUndefined();
  });

  it("returns suggestions scoped to the caller's runs", async () => {
    expect((await needsYou("user-a@example.test")).suggestions.map((s) => s.id)).toEqual(["retry:run-a"]);
    expect((await needsYou("user-b@example.test")).suggestions).toEqual([]);
  });
});

describe("needs-you suggestion routes", () => {
  it("returns onboarding for a fresh signed-in owner using the local progress handler", async () => {
    onboarding.mockResolvedValue(Response.json({ status: {
      complete: false, nextStep: { id: "goal", label: "Describe your goal", target: { kind: "setup", outcomeStep: "goal" } },
    } }));
    const body = await needsYou("fresh@example.test");
    expect(body.suggestions).toEqual([expect.objectContaining({ id: "setup:goal", action: { kind: "open", payload: { view: "home", step: "goal" } } })]);
    expect(onboarding).toHaveBeenCalledWith(expect.any(Request), expect.any(Object));
    expect(new URL(onboarding.mock.calls[0]![0].url).pathname).toBe("/api/onboarding/progress");
  });

  it("returns repeat and stale approval suggestions through the endpoint", async () => {
    runsByOwner.set("manual@example.test", ["a", "b", "c"].map((runId) => ({ runId, task: "Summarize open PRs", status: "completed", createdAt: Date.now() })));
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => Response.json(new URL(request.url).pathname === "/api/approvals"
      ? { approvals: [{ createdAt: Date.now() - 2 * 86400000 }] } : {})));
    expect((await needsYou("manual@example.test")).suggestions).toEqual([
      expect.objectContaining({ kind: "approvals" }), expect.objectContaining({ kind: "routine" }),
    ]);
  });

  it("persists dismissal, isolates owners, and rejects unauthorized or cross-origin writes", async () => {
    const env = environment();
    const dismiss = (user: string, origin = "http://localhost") => handleTeamWork(new Request("http://localhost/api/needs-you/dismiss", {
      method: "POST", headers: { "X-Test-User": user, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ id: "retry:run-a" }),
    }), env);
    expect((await dismiss("unauthorized"))?.status).toBe(401);
    expect((await dismiss("user-a@example.test", "https://other.test"))?.status).toBe(403);
    expect((await dismiss("user-b@example.test"))?.status).toBe(200);
    expect((await needsYou("user-a@example.test", undefined, env)).suggestions).toHaveLength(1);
    expect((await dismiss("user-a@example.test"))?.status).toBe(200);
    expect((await needsYou("user-a@example.test", undefined, env)).suggestions).toEqual([]);
  });
});
