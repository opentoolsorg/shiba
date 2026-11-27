import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({
  Agent: class {
    initialState = { startedAt: 0 };
    private currentState: { startedAt: number } | undefined;
    constructor(protected ctx: DurableObjectState, protected env: unknown) {}
    get state(): { startedAt: number } { return this.currentState ?? this.initialState; }
    setState(state: { startedAt: number }): void { this.currentState = state; }
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
  const env = {
    SHIBA_VERIFY_STANDIN: "1",
    GITHUB_API_BASE: "http://127.0.0.1:9",
  } as Env;
  const runtime = new EmployeeRuntime(ctx, env);
  void runtime.onStart();
  return { runtime, db };
}

const profile = {
  orgId: "self-hosted",
  employeeId: "emp-1",
  employeeVersion: 2,
  name: "Riley",
  instructions: "Be helpful.",
};

function chat(message: string): Request {
  return new Request("https://do/internal/employee-runtime/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile, conversationId: "default", message, mode: "chat" }),
  });
}

describe("EmployeeRuntime Durable Object", () => {
  it("answers standin chat without repository, sandbox, harness, or model inference", async () => {
    const { runtime } = fixture();
    const response = await runtime.onRequest(chat("hello"));
    expect(response.status).toBe(200);
    const body = await response.json() as { answer: string; execution: { status: string; checkpoint: string } };
    expect(body.answer).toContain("No sandbox, repository, harness, or model provider");
    expect(body.execution).toMatchObject({ status: "completed", checkpoint: "terminal" });

    const state = await runtime.onRequest(new Request("https://do/internal/employee-runtime/state?conversationId=default"));
    const persisted = await state.json() as { messages: Array<{ role: string }>; executions: Array<{ status: string }> };
    expect(persisted.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(persisted.executions[0]?.status).toBe("completed");
  });

  it("stores and retrieves employee-private memory through internal routes", async () => {
    const { runtime } = fixture();
    const write = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "employee", kind: "preference", content: "Prefer concise status updates", essential: true }),
    }));
    expect(write.status).toBe(201);
    const search = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory/search?q=concise"));
    expect(await search.json()).toMatchObject({ memories: [{ content: "Prefer concise status updates", essential: true }] });
  });

  it("marks running executions interrupted during recovery", async () => {
    const { runtime, db } = fixture();
    db.prepare(`INSERT INTO employee_runtime_executions(id,conversation_id,mode,status,checkpoint,input_json,created_at,updated_at)
      VALUES('run_test','default','chat','running','inference','{}',1,1)`).run();
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/recover", { method: "POST", body: "{}" }));
    expect(await response.json()).toEqual({ interrupted: 1 });
    expect(db.prepare("SELECT status,checkpoint FROM employee_runtime_executions WHERE id='run_test'").get()).toMatchObject({ status: "interrupted", checkpoint: "recovery_required" });
  });
});
