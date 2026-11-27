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

function fixture(envOverrides: Partial<Env> = {}) {
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
    ...envOverrides,
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

  it("streams standin chat and persists the completed assistant message", async () => {
    const { runtime } = fixture();
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/chat/stream", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, conversationId: "default", message: "stream hello", mode: "chat" }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = (await response.text()).trim().split("\n\n").map((event) => JSON.parse(event.slice(6)) as { type: string; text?: string; answer?: string });
    expect(events[0]?.type).toBe("execution");
    expect(events.filter((event) => event.type === "delta").map((event) => event.text).join("")).toContain("Synthetic employee runtime response");
    expect(events.at(-1)).toMatchObject({ type: "done" });
    const state = await runtime.onRequest(new Request("https://do/internal/employee-runtime/state?conversationId=default"));
    const persisted = await state.json() as { messages: Array<{ role: string; content: string }> };
    expect(persisted.messages.at(-1)).toMatchObject({ role: "assistant" });
  });

  it("stores and retrieves employee-private memory through internal routes", async () => {
    const { runtime } = fixture();
    const write = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "employee", kind: "preference", content: "Prefer concise status updates", essential: true, manager: true }),
    }));
    expect(write.status).toBe(201);
    const search = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory/search?q=concise"));
    expect(await search.json()).toMatchObject({ memories: [{ content: "Prefer concise status updates", essential: true }] });
  });

  it("fails recovery clearly when the interrupted input cannot be replayed", async () => {
    const { runtime, db } = fixture();
    db.prepare(`INSERT INTO employee_runtime_executions(id,conversation_id,mode,status,checkpoint,input_json,created_at,updated_at)
      VALUES('run_test','default','chat','running','inference','{}',1,1)`).run();
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/recover", { method: "POST", body: "{}" }));
    expect(await response.json()).toMatchObject({ interrupted: 1, recovered: 0, completed: 0, failed: 1 });
    expect(db.prepare("SELECT status,checkpoint FROM employee_runtime_executions WHERE id='run_test'").get()).toMatchObject({ status: "failed", checkpoint: "recovery_input_missing" });
  });
  it("replays an interrupted execution from its pinned profile and exact user message", async () => {
    const { runtime, db } = fixture();
    db.prepare(`INSERT INTO employee_runtime_profiles(conversation_id,profile_json,updated_at) VALUES('default',?,1)`).run(JSON.stringify(profile));
    db.prepare(`INSERT INTO employee_runtime_messages(id,conversation_id,role,content,created_at) VALUES('msg_user','default','user','recover this',1)`).run();
    const inputJson = JSON.stringify({ conversationId: "default", mode: "chat", employeeVersion: 2, userMessageId: "msg_user", messageLength: 12 });
    db.prepare(`INSERT INTO employee_runtime_executions(id,conversation_id,mode,status,checkpoint,input_json,created_at,updated_at)
      VALUES('run_replay','default','chat','running','inference',?,1,1)`).run(inputJson);
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/recover", { method: "POST", body: "{}" }));
    expect(await response.json()).toMatchObject({ interrupted: 1, recovered: 1, failed: 0 });
    expect(db.prepare("SELECT status,checkpoint FROM employee_runtime_executions WHERE id='run_replay'").get()).toMatchObject({ status: "completed", checkpoint: "terminal" });
    const messages = db.prepare("SELECT role,content FROM employee_runtime_messages WHERE conversation_id='default' ORDER BY rowid").all() as Array<{ role: string; content: string }>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("Synthetic employee runtime response");
  });

  it("marks interrupted work completed without duplicating an already persisted assistant", async () => {
    const { runtime, db } = fixture();
    db.prepare(`INSERT INTO employee_runtime_profiles(conversation_id,profile_json,updated_at) VALUES('default',?,1)`).run(JSON.stringify(profile));
    db.prepare(`INSERT INTO employee_runtime_messages(id,conversation_id,role,content,execution_id,created_at) VALUES
      ('msg_user','default','user','recover this',NULL,1),('msg_assistant','default','assistant','already saved','run_persisted',2)`).run();
    const inputJson = JSON.stringify({ conversationId: "default", mode: "chat", employeeVersion: 2, userMessageId: "msg_user" });
    db.prepare(`INSERT INTO employee_runtime_executions(id,conversation_id,mode,status,checkpoint,input_json,created_at,updated_at)
      VALUES('run_persisted','default','chat','running','inference',?,1,1)`).run(inputJson);
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/recover", { method: "POST", body: "{}" }));
    expect(await response.json()).toMatchObject({ interrupted: 1, recovered: 0, completed: 1, failed: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM employee_runtime_messages WHERE conversation_id='default'").get()).toMatchObject({ count: 2 });
    expect(db.prepare("SELECT status,checkpoint FROM employee_runtime_executions WHERE id='run_persisted'").get()).toMatchObject({ status: "completed", checkpoint: "terminal" });
  });

  it("fails closed instead of replaying direct inference for a team employee", async () => {
    const { runtime, db } = fixture({ SHIBA_VERIFY_STANDIN: undefined });
    const teamProfile = { ...profile, orgId: "team:ws_test" };
    db.prepare(`INSERT INTO employee_runtime_profiles(conversation_id,profile_json,updated_at) VALUES('default',?,1)`).run(JSON.stringify(teamProfile));
    db.prepare(`INSERT INTO employee_runtime_messages(id,conversation_id,role,content,created_at) VALUES('msg_user','default','user','recover this',1)`).run();
    const inputJson = JSON.stringify({ conversationId: "default", mode: "chat", employeeVersion: 2, userMessageId: "msg_user" });
    db.prepare(`INSERT INTO employee_runtime_executions(id,conversation_id,mode,status,checkpoint,input_json,created_at,updated_at)
      VALUES('run_team','default','chat','running','inference',?,1,1)`).run(inputJson);
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/recover", { method: "POST", body: "{}" }));
    expect(await response.json()).toMatchObject({ interrupted: 1, recovered: 0, failed: 1 });
    expect(db.prepare("SELECT status,checkpoint,error FROM employee_runtime_executions WHERE id='run_team'").get()).toMatchObject({ status: "failed", checkpoint: "funding_required" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM employee_runtime_messages WHERE conversation_id='default'").get()).toMatchObject({ count: 1 });
  });

  it("does not cancel an execution from a different conversation", async () => {
    const { runtime, db } = fixture();
    db.prepare(`INSERT INTO employee_runtime_executions(id,conversation_id,mode,status,checkpoint,input_json,created_at,updated_at)
      VALUES('run_scoped','u_actor_conv','chat','running','inference','{}',1,1)`).run();
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/cancel", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionId: "run_scoped", conversationId: "u_actor_other" }),
    }));
    expect(response.status).toBe(404);
    expect(db.prepare("SELECT status FROM employee_runtime_executions WHERE id='run_scoped'").get()).toEqual({ status: "running" });
  });

  it("stores bounded structured input metadata for execution checkpoints", async () => {
    const { runtime, db } = fixture();
    const response = await runtime.onRequest(chat("hello"));
    expect(response.status).toBe(200);
    const row = db.prepare("SELECT input_json FROM employee_runtime_executions").get() as { input_json: string };
    const input = JSON.parse(row.input_json) as Record<string, unknown>;
    expect(input).toMatchObject({ conversationId: "default", mode: "chat", employeeVersion: 2, messageLength: 5, messagePreview: "hello" });
    expect(input).not.toHaveProperty("message");
  });
  it("updates and deletes employee memory through internal routes", async () => {
    const { runtime } = fixture();
    const write = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "employee", kind: "preference", content: "Prefer concise updates", essential: false, manager: true }),
    }));
    const { memory } = await write.json() as { memory: { id: string } };
    const update = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory/update", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ memoryId: memory.id, content: "Prefer detailed evidence", essential: true, manager: true }),
    }));
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ memory: { content: "Prefer detailed evidence", essential: true } });
    const remove = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory/delete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memoryId: memory.id, manager: true }),
    }));
    expect(remove.status).toBe(200);
    const search = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory/search?q=detailed"));
    expect(await search.json()).toEqual({ memories: [] });
  });

  it("clears runtime messages, executions, and pinned profile without deleting memories", async () => {
    const { runtime } = fixture();
    expect((await runtime.onRequest(chat("clear me"))).status).toBe(200);
    const memory = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "thread", kind: "fact", conversationId: "default", content: "Remember this thread fact" }),
    }));
    expect(memory.status).toBe(201);
    const clear = await runtime.onRequest(new Request("https://do/internal/employee-runtime/clear", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "default" }),
    }));
    expect(clear.status).toBe(200);
    const state = await runtime.onRequest(new Request("https://do/internal/employee-runtime/state?conversationId=default"));
    const body = await state.json() as { messages: unknown[]; executions: unknown[]; memories: Array<{ content: string }> };
    expect(body.messages).toEqual([]);
    expect(body.executions).toEqual([]);
    expect(body.memories).toMatchObject([{ content: "Remember this thread fact" }]);
  });

  it("pages runtime state memories beyond the first hundred", async () => {
    const { runtime } = fixture();
    for (let index = 0; index < 105; index += 1) {
      const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "thread", kind: "fact", conversationId: "default", content: `memory-${String(index).padStart(3, "0")}` }),
      }));
      expect(response.status).toBe(201);
    }
    const first = await runtime.onRequest(new Request("https://do/internal/employee-runtime/state?conversationId=default&memoryLimit=100"));
    const firstBody = await first.json() as { memories: Array<{ content: string }> };
    expect(firstBody.memories).toHaveLength(100);
    const second = await runtime.onRequest(new Request("https://do/internal/employee-runtime/state?conversationId=default&memoryLimit=100&memoryOffset=100"));
    const secondBody = await second.json() as { memories: Array<{ content: string }> };
    expect(secondBody.memories.length).toBeGreaterThan(0);
    expect(secondBody.memories.some((memory) => firstBody.memories.some((item) => item.content === memory.content))).toBe(false);
  });

  it("accepts encoded internal conversation ids on memory mutations", async () => {
    const { runtime } = fixture();
    const conversationId = `u_${"a".repeat(32)}_${"x".repeat(500)}`;
    const write = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "thread", kind: "fact", conversationId, content: "Encoded thread fact" }),
    }));
    const { memory } = await write.json() as { memory: { id: string } };
    const update = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory/update", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ memoryId: memory.id, conversationId, content: "Updated encoded thread fact" }),
    }));
    expect(update.status).toBe(200);
  });

  it("does not update or delete thread memory from another conversation", async () => {
    const { runtime } = fixture();
    const write = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "thread", kind: "fact", conversationId: "u_actor_one", content: "Private thread fact" }),
    }));
    const { memory } = await write.json() as { memory: { id: string } };
    for (const action of ["update", "delete"]) {
      const body: Record<string, unknown> = { memoryId: memory.id, conversationId: "u_actor_two" };
      if (action === "update") body.content = "tampered";
      const response = await runtime.onRequest(new Request(`https://do/internal/employee-runtime/memory/${action}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      expect(response.status).toBe(404);
    }
    const search = await runtime.onRequest(new Request("https://do/internal/employee-runtime/memory/search?q=Private&conversationId=u_actor_one"));
    expect(await search.json()).toMatchObject({ memories: [{ content: "Private thread fact" }] });
  });

});
