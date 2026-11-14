import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleTeamWork } from "../src/team-work-routes.js";

const runsByOwner = vi.hoisted(() => new Map<string, Array<{ runId: string; orgId?: string; createdAt?: number }>>());
vi.mock("../src/request-auth.js", async (original) => ({
  ...await original<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: async () => true,
  resolveUserId: async (request: Request) => request.headers.get("X-Test-User"),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async (_binding: unknown, name: string) => ({
    fetch: async () => Response.json({ runs: runsByOwner.get(name) ?? [] }),
  }),
}));

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

beforeEach(() => {
  runsByOwner.clear();
  runsByOwner.set("user-a@example.test", [
    { runId: "run-a", orgId: "self-hosted", createdAt: 1 },
    { runId: "run-a-team", orgId: `team:${TEAM}`, createdAt: 2 },
  ]);
  runsByOwner.set("user-b@example.test", [
    { runId: "run-b", orgId: "self-hosted", createdAt: 3 },
  ]);
});

async function needsYou(userId: string, workspaceId?: string) {
  const env = { AGENT_AUDIT: database(), CodingOrchestrator: {} } as unknown as Env;
  const headers = new Headers({ "X-Test-User": userId });
  if (workspaceId) headers.set("X-Shiba-Workspace", workspaceId);
  const response = await handleTeamWork(new Request("http://127.0.0.1:1/api/needs-you", { headers }), env);
  expect(response?.status).toBe(200);
  return await response!.json() as { blocked: Array<{ runId: string; title: string }>; progress: Record<string, string> };
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
});
