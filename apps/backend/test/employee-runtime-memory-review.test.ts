import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock("ai", async (importOriginal) => ({
  ...await importOriginal<typeof import("ai")>(),
  generateText: mocks.generateText,
}));
vi.mock("workers-ai-provider", () => ({ createWorkersAI: () => () => ({ provider: "fixture" }) }));
vi.mock("../src/employee-run-tools.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/employee-run-tools.js")>(),
  createEmployeeRunTools: vi.fn(() => ({})),
}));
vi.mock("agents", () => ({
  Agent: class {
    initialState = { startedAt: 0 };
    constructor(protected ctx: DurableObjectState, protected env: unknown) {}
    get state(): { startedAt: number } { return this.initialState; }
    setState(): void {}
    get sessionAffinity(): string { return "test-employee-runtime"; }
  },
}));

import { EmployeeRuntime } from "../src/employee-runtime-do.js";
import type { Env } from "../src/env.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const ctx = {
    storage: {
      sql: {
        exec(sql: string, ...params: SQLInputValue[]) {
          const statement = db.prepare(sql);
          const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
          return { toArray: () => rows };
        },
      },
    },
    blockConcurrencyWhile(callback: () => Promise<void>) { void callback(); },
  } as unknown as DurableObjectState;
  const env = { AI: {}, SHIBA_VERIFY_STANDIN: undefined } as unknown as Env;
  const runtime = new EmployeeRuntime(ctx, env);
  void runtime.onStart();
  return { runtime, db };
}

const profile = {
  orgId: "self-hosted",
  employeeId: "emp-memory",
  employeeVersion: 1,
  name: "Memory Employee",
  instructions: "Be helpful.",
};

beforeEach(() => {
  mocks.generateText.mockReset();
  mocks.generateText.mockImplementation(async (input: { output?: unknown }) => input.output
    ? { text: "", output: { memories: [
      { kind: "preference", content: "Prefer concise rollout updates" },
      { kind: "fact", content: "Already remembered fact" },
      { kind: "fact", content: "Contains token sk-1234567890abcdef" },
    ] } }
    : { text: "fixture model text" });
});

describe("employee runtime automatic memory review", () => {
  it("stores bounded deduplicated thread memories from consolidated context", async () => {
    const { runtime, db } = fixture();
    const existing = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "thread", conversationId: "default", kind: "fact", content: "Already remembered fact", essential: false }),
    }));
    expect(existing.status).toBe(201);
    for (let index = 0; index < 36; index += 1) {
      db.prepare(`INSERT INTO employee_runtime_messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)`)
        .run(`old_${index}`, "default", index % 2 === 0 ? "user" : "assistant", `old fact ${index}`, index + 1);
    }
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, conversationId: "default", message: "trigger memory review", mode: "chat" }),
    }));
    expect(response.status).toBe(200);
    const rows = db.prepare(`SELECT kind,content,essential,scope,conversation_id AS conversationId FROM employee_runtime_memories ORDER BY created_at,id`).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: "Already remembered fact" }),
      expect.objectContaining({ kind: "preference", content: "Prefer concise rollout updates", essential: 0, scope: "thread", conversationId: "default" }),
    ]));
    expect(rows.some((row) => String(row.content).includes("sk-"))).toBe(false);
    expect(mocks.generateText).toHaveBeenCalledTimes(3);
    expect(mocks.generateText.mock.calls.filter(([input]) => Boolean((input as { output?: unknown }).output))).toHaveLength(1);
  });

  it("skips automatic extraction when the deterministic standin is active", async () => {
    const { runtime, db } = fixture();
    (runtime as unknown as { env: Env }).env.SHIBA_VERIFY_STANDIN = "1";
    (runtime as unknown as { env: Env }).env.GITHUB_API_BASE = "http://127.0.0.1:9";
    for (let index = 0; index < 36; index += 1) {
      db.prepare(`INSERT INTO employee_runtime_messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)`)
        .run(`old_${index}`, "default", index % 2 === 0 ? "user" : "assistant", `old fact ${index}`, index + 1);
    }
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, conversationId: "default", message: "trigger memory review", mode: "chat" }),
    }));
    expect(response.status).toBe(200);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM employee_runtime_memories`).get()).toMatchObject({ n: 0 });
  });
});
