import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/employee-run-tools.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/employee-run-tools.js")>(),
  createEmployeeRunTools: vi.fn(() => ({})),
}));

vi.mock("../src/custom-agents-store.js", () => ({
  getCustomAgentById: vi.fn(async (_env: unknown, _orgId: string, employeeId: string) => ({
    id: employeeId,
    version: 2,
    archivedAt: null,
    config: { name: "Riley", instructions: "Be helpful." },
  })),
}));

vi.mock("ai", async (importOriginal) => ({
  ...await importOriginal<typeof import("ai")>(),
  generateText: vi.fn(async () => ({ text: "Recovered deterministic answer." })),
}));

vi.mock("agents", () => ({
  Agent: class {
    initialState = { startedAt: 0 };
    private currentState: { startedAt: number } | undefined;
    constructor(protected ctx: DurableObjectState, protected env: unknown) {}
    get state(): { startedAt: number } { return this.currentState ?? this.initialState; }
    setState(state: { startedAt: number }): void { this.currentState = state; }
    get sessionAffinity(): string { return "test-employee-runtime"; }
    private schedules: Array<{ id: string; callback: string; payload: unknown; type: "interval"; time: number; intervalSeconds: number }> = [];
    private scheduleCounter = 0;
    async scheduleEvery(intervalSeconds: number, callback: string, payload?: unknown): Promise<{ id: string; callback: string; payload: unknown; type: "interval"; time: number; intervalSeconds: number }> {
      const duplicate = this.schedules.find((schedule) => schedule.callback === callback && schedule.intervalSeconds === intervalSeconds && JSON.stringify(schedule.payload) === JSON.stringify(payload));
      if (duplicate) return duplicate;
      this.scheduleCounter += 1;
      const schedule = { id: `schedule_${this.scheduleCounter}`, callback, payload, type: "interval" as const, time: Math.floor(Date.now() / 1000) + intervalSeconds, intervalSeconds };
      this.schedules.push(schedule);
      return schedule;
    }
    async listSchedules(criteria?: { type?: string }): Promise<Array<{ id: string; callback: string; payload: unknown; type: "interval"; time: number; intervalSeconds: number }>> {
      return this.schedules.filter((schedule) => !criteria?.type || schedule.type === criteria.type);
    }
    async getScheduleById(id: string): Promise<{ id: string; callback: string; payload: unknown; type: "interval"; time: number; intervalSeconds: number } | undefined> {
      return this.schedules.find((schedule) => schedule.id === id);
    }
    async cancelSchedule(id: string): Promise<boolean> {
      const before = this.schedules.length;
      this.schedules = this.schedules.filter((schedule) => schedule.id !== id);
      return this.schedules.length !== before;
    }
  },
}));

import { EmployeeRuntime } from "../src/employee-runtime-do.js";
import { createEmployeeRunTools } from "../src/employee-run-tools.js";
import { generateText } from "ai";
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
    AGENT_AUDIT: {},
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
    const persisted = await state.json() as { messages: Array<{ role: string }>; executions: Array<{ status: string; resumable?: boolean }> };
    expect(persisted.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(persisted.executions[0]?.status).toBe("completed");
    expect(persisted.executions[0]?.resumable).toBeUndefined();
  });

  it("streams standin chat and persists the completed assistant message", async () => {
    const { runtime } = fixture();
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/chat/stream", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, conversationId: "default", message: "stream hello", mode: "chat" }),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = (await response.text()).trim().split("\n\n").map((event) => JSON.parse(event.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as { type: string; text?: string; answer?: string });
    expect(events[0]?.type).toBe("execution");
    expect(events.filter((event) => event.type === "delta").map((event) => event.text).join("")).toContain("Synthetic employee runtime response");
    expect(events.at(-1)).toMatchObject({ type: "done" });
    const state = await runtime.onRequest(new Request("https://do/internal/employee-runtime/state?conversationId=default"));
    const persisted = await state.json() as { messages: Array<{ role: string; content: string }>; executions: Array<{ resumable?: boolean }> };
    expect(persisted.messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(persisted.executions[0]?.resumable).toBe(true);
  });

  it("does not advertise stream resume while an interrupted stream is replaying through recovery", async () => {
    const { runtime, db } = fixture();
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/chat/stream", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, conversationId: "default", message: "stream hello", mode: "chat" }),
    }));
    expect(response.status).toBe(200);
    await response.text();
    const executionId = String((db.prepare("SELECT id FROM employee_runtime_executions WHERE conversation_id='default' ORDER BY created_at DESC LIMIT 1").get() as { id: string }).id);
    db.prepare("UPDATE employee_runtime_executions SET status='running', checkpoint='recovery_inference' WHERE id=?").run(executionId);
    const state = await runtime.onRequest(new Request("https://do/internal/employee-runtime/state?conversationId=default"));
    const persisted = await state.json() as { executions: Array<{ status: string; checkpoint: string; resumable?: boolean }> };
    expect(persisted.executions[0]).toMatchObject({ status: "running", checkpoint: "recovery_inference" });
    expect(persisted.executions[0]?.resumable).toBeUndefined();
  });

  it("resumes a stream from durable events after the client disconnects", async () => {
    const { runtime, db } = fixture();
    const first = await runtime.onRequest(new Request("https://do/internal/employee-runtime/chat/stream", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, conversationId: "default", message: "disconnect while streaming", mode: "chat" }),
    }));
    expect(first.status).toBe(200);
    const reader = first.body!.getReader();
    await reader.read();
    await reader.cancel();
    const executionId = String((db.prepare("SELECT id FROM employee_runtime_executions WHERE conversation_id='default' ORDER BY created_at DESC LIMIT 1").get() as { id: string }).id);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = (db.prepare("SELECT status FROM employee_runtime_executions WHERE id=?").get(executionId) as { status: string } | undefined)?.status;
      if (status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((db.prepare("SELECT status FROM employee_runtime_executions WHERE id=?").get(executionId) as { status: string }).status).toBe("completed");
    expect((db.prepare("SELECT COUNT(*) AS n FROM employee_runtime_stream_events WHERE execution_id=?").get(executionId) as { n: number }).n).toBeGreaterThan(0);

    const resumed = await runtime.onRequest(new Request("https://do/internal/employee-runtime/chat/stream/resume", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "default", executionId, afterSeq: 0 }),
    }));
    expect(resumed.status).toBe(200);
    const replay = await resumed.text();
    expect(replay).toContain("id: ");
    expect(replay).toContain('"type":"execution"');
    expect(replay).toContain('"type":"done"');
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

  it("scopes manager recovery to the requested conversation", async () => {
    const { runtime, db } = fixture();
    for (const conversationId of ["default", "other"]) {
      db.prepare(`INSERT INTO employee_runtime_profiles(conversation_id,profile_json,updated_at) VALUES(?,?,1)`).run(conversationId, JSON.stringify(profile));
      db.prepare(`INSERT INTO employee_runtime_messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,1)`).run(`msg_${conversationId}`, conversationId, "user", "recover this");
      db.prepare(`INSERT INTO employee_runtime_executions(id,conversation_id,mode,status,checkpoint,input_json,created_at,updated_at)
        VALUES(?,?,'chat','running','inference',?,1,1)`).run(`run_${conversationId}`, conversationId, JSON.stringify({ userMessageId: `msg_${conversationId}` }));
    }
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/recover", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "default" }),
    }));
    expect(await response.json()).toMatchObject({ interrupted: 1, recovered: 1 });
    expect(db.prepare("SELECT status FROM employee_runtime_executions WHERE id='run_default'").get()).toEqual({ status: "completed" });
    expect(db.prepare("SELECT status FROM employee_runtime_executions WHERE id='run_other'").get()).toEqual({ status: "running" });
  });

  it("consolidates older conversation context into a bounded working summary", async () => {
    const { runtime, db } = fixture();
    for (let index = 0; index < 36; index += 1) {
      db.prepare(`INSERT INTO employee_runtime_messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)`)
        .run(`old_${index}`, "default", index % 2 === 0 ? "user" : "assistant", `old fact ${index}`, index + 1);
    }
    const response = await runtime.onRequest(chat("trigger consolidation"));
    expect(response.status).toBe(200);
    const summary = db.prepare(`SELECT * FROM employee_runtime_summaries WHERE conversation_id='default'`).get() as { summary: string; message_count: number } | undefined;
    expect(summary?.summary).toContain("Synthetic summary");
    expect(summary?.message_count).toBe(26);
    const prompt = (runtime as unknown as { inferencePrompt(body: { profile: typeof profile; conversationId: string; message: string; mode: "chat" }): { system: string; history: Array<{ content: string }> } })
      .inferencePrompt({ profile, conversationId: "default", message: "next", mode: "chat" });
    expect(prompt.system).toContain("Conversation summary so far");
    expect(prompt.history.some((message) => message.content === "old fact 0")).toBe(false);
    expect(prompt.history.some((message) => message.content === "trigger consolidation")).toBe(true);
    expect((await runtime.onRequest(chat("one more turn"))).status).toBe(200);
    expect(db.prepare(`SELECT message_count AS n FROM employee_runtime_summaries WHERE conversation_id='default'`).get()).toMatchObject({ n: 26 });
  });

  it("clears conversation summaries with the owning conversation", async () => {
    const { runtime, db } = fixture();
    db.prepare(`INSERT INTO employee_runtime_messages(id,conversation_id,role,content,created_at) VALUES('m','default','user','secret transcript',1)`).run();
    db.prepare(`INSERT INTO employee_runtime_summaries(conversation_id,summary,through_message_id,message_count,created_at,updated_at) VALUES('default','derived secret','m',1,1,1)`).run();
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/clear", { method: "POST", body: JSON.stringify({ conversationId: "default" }) }));
    expect(response.status).toBe(200);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM employee_runtime_summaries`).get()).toMatchObject({ n: 0 });
  });

  it("wires the server-resolved tool actor into runtime tool authority and recovery metadata", async () => {
    const { runtime, db } = fixture();
    const request = new Request("https://do/internal/employee-runtime/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, conversationId: "default", message: "use tools if available", mode: "chat", toolActorId: "owner@example.test" }),
    });
    const response = await runtime.onRequest(request);
    expect(response.status).toBe(200);
    const inputJson = db.prepare(`SELECT input_json AS json, id FROM employee_runtime_executions LIMIT 1`).get() as { json: string; id: string };
    expect(JSON.parse(inputJson.json)).toMatchObject({ toolActorId: "owner@example.test" });
    const valid = await runtime.onRequest(new Request(`https://do/internal/employee-runtime/execution-context?executionId=${inputJson.id}&actorId=owner%40example.test`));
    expect(valid.status).toBe(200);
    const wrongActor = await runtime.onRequest(new Request(`https://do/internal/employee-runtime/execution-context?executionId=${inputJson.id}&actorId=other%40example.test`));
    expect(wrongActor.status).toBe(404);
    const factory = vi.mocked(createEmployeeRunTools);
    (runtime as unknown as { runtimeTools(body: { profile: typeof profile; conversationId: string; message: string; mode: "chat"; toolActorId: string }, executionId: string): unknown }).runtimeTools(
      { profile, conversationId: "default", message: "use tools if available", mode: "chat", toolActorId: "owner@example.test" }, "run_test",
    );
    expect(factory).toHaveBeenCalled();
    const args = factory.mock.calls.at(-1) ?? [];
    expect(args[1]?.()).toBe(profile.employeeId);
    expect(args[2]?.()).toBe("run_test");
    expect(args[3]?.()).toBe(profile.orgId);
    expect(args[4]?.()).toBe("owner@example.test");
  });

  it("marks abandoned running executions recoverable in state", async () => {
    const { runtime, db } = fixture();
    db.prepare(`INSERT INTO employee_runtime_executions(id,conversation_id,mode,status,checkpoint,input_json,created_at,updated_at)
      VALUES('run_abandoned','default','chat','running','inference','{}',1,1)`).run();
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/state?conversationId=default"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ executions: [{ id: "run_abandoned", status: "running", recoverable: true }] });
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

  it("replays only the conversation prefix that existed at the interrupted prompt", async () => {
    const { runtime, db } = fixture({ SHIBA_VERIFY_STANDIN: "0", AI: {} as Env["AI"] });
    db.prepare(`INSERT INTO employee_runtime_profiles(conversation_id,profile_json,updated_at) VALUES('default',?,1)`).run(JSON.stringify(profile));
    db.prepare(`INSERT INTO employee_runtime_messages(id,conversation_id,role,content,origin,created_at) VALUES('msg_interactive','default','user','finish the interactive answer','interactive',1)`).run();
    db.prepare(`INSERT INTO employee_runtime_messages(id,conversation_id,role,content,origin,created_at) VALUES('msg_routine_user','default','user','routine prompt','routine',2)`).run();
    db.prepare(`INSERT INTO employee_runtime_messages(id,conversation_id,role,content,origin,created_at) VALUES('msg_routine_assistant','default','assistant','routine answer','routine',3)`).run();
    db.prepare(`INSERT INTO employee_runtime_summaries(conversation_id,summary,through_message_id,message_count,created_at,updated_at) VALUES('default','summary through the interrupted prompt','msg_interactive',1,1,1)`).run();
    const inputJson = JSON.stringify({ conversationId: "default", mode: "chat", employeeVersion: 2, userMessageId: "msg_interactive", messageLength: 28 });
    db.prepare(`INSERT INTO employee_runtime_executions(id,conversation_id,mode,status,checkpoint,input_json,created_at,updated_at)
      VALUES('run_prefix','default','chat','running','inference',?,1,1)`).run(inputJson);
    vi.mocked(generateText).mockClear();
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/recover", { method: "POST", body: "{}" }));
    expect(await response.json()).toMatchObject({ recovered: 1, failed: 0 });
    const call = vi.mocked(generateText).mock.calls[0]?.[0] as { messages?: Array<{ role: string; content: string }> } | undefined;
    expect(call?.messages).toEqual([{ role: "user", content: "finish the interactive answer" }]);
    expect(JSON.stringify(call?.messages)).not.toContain("routine prompt");
  });

  it("does not let an automatic routine prompt supersede interactive recovery", async () => {
    const { runtime, db } = fixture();
    db.prepare(`INSERT INTO employee_runtime_profiles(conversation_id,profile_json,updated_at) VALUES('default',?,1)`).run(JSON.stringify(profile));
    db.prepare(`INSERT INTO employee_runtime_messages(id,conversation_id,role,content,origin,created_at) VALUES('msg_human','default','user','finish this interactive answer','interactive',1)`).run();
    db.prepare(`INSERT INTO employee_runtime_messages(id,conversation_id,role,content,origin,created_at) VALUES('msg_routine','default','user','Scheduled routine','routine',2)`).run();
    const inputJson = JSON.stringify({ conversationId: "default", mode: "chat", employeeVersion: 2, userMessageId: "msg_human", messageLength: 29 });
    db.prepare(`INSERT INTO employee_runtime_executions(id,conversation_id,mode,status,checkpoint,input_json,created_at,updated_at)
      VALUES('run_interrupted','default','chat','running','inference',?,1,1)`).run(inputJson);
    const response = await runtime.onRequest(new Request("https://do/internal/employee-runtime/recover", { method: "POST", body: "{}" }));
    expect(await response.json()).toMatchObject({ interrupted: 1, recovered: 1, failed: 0, skipped: 0 });
    expect(db.prepare("SELECT status,checkpoint FROM employee_runtime_executions WHERE id='run_interrupted'").get()).toMatchObject({ status: "completed", checkpoint: "terminal" });
  });

  it("creates, deduplicates, lists, and clears actor-scoped routines", async () => {
    const { runtime } = fixture();
    const write = () => runtime.onRequest(new Request("https://do/internal/employee-runtime/routines", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, conversationId: "default", name: "Morning check", prompt: "Summarize the plan", intervalSeconds: 300 }),
    }));
    const created = await write();
    expect(created.status).toBe(201);
    const first = await created.json() as { routine: { id: string } };
    const duplicate = await write();
    expect(await duplicate.json()).toMatchObject({ deduplicated: true, routine: { id: first.routine.id } });
    const list = await runtime.onRequest(new Request("https://do/internal/employee-runtime/routines?conversationId=default"));
    expect(await list.json()).toMatchObject({ routines: [{ id: first.routine.id, name: "Morning check", intervalSeconds: 300 }] });
    const clear = await runtime.onRequest(new Request("https://do/internal/employee-runtime/clear", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "default" }),
    }));
    expect(clear.status).toBe(200);
    const empty = await runtime.onRequest(new Request("https://do/internal/employee-runtime/routines?conversationId=default"));
    expect(await empty.json()).toEqual({ routines: [] });
  });

  it("runs a routine once without tools and persists the completed turn", async () => {
    const { runtime } = fixture();
    const created = await runtime.onRequest(new Request("https://do/internal/employee-runtime/routines", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, conversationId: "default", name: "Morning check", prompt: "Summarize the plan", intervalSeconds: 300 }),
    }));
    const { routine } = await created.json() as { routine: { id: string; prompt: string; name: string } };
    await runtime.runEmployeeRoutine({ conversationId: "default", name: routine.name, prompt: routine.prompt, createdAt: Date.now() }, { id: routine.id });
    const state = await runtime.onRequest(new Request("https://do/internal/employee-runtime/state?conversationId=default"));
    const body = await state.json() as { messages: Array<{ role: string; content: string }>; executions: Array<{ status: string }> };
    expect(body.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(body.messages[0]?.content).toContain("Scheduled routine");
    expect(body.messages[1]?.content).toContain("Synthetic employee runtime response");
    expect(body.executions).toMatchObject([{ status: "completed" }]);
    expect(vi.mocked(createEmployeeRunTools)).not.toHaveBeenCalled();
  });

  it("deletes only routines owned by the exact conversation", async () => {
    const { runtime } = fixture();
    const created = await runtime.onRequest(new Request("https://do/internal/employee-runtime/routines", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, conversationId: "u_actor_one", name: "Private routine", prompt: "Check privately", intervalSeconds: 300 }),
    }));
    const { routine } = await created.json() as { routine: { id: string } };
    const wrong = await runtime.onRequest(new Request("https://do/internal/employee-runtime/routines/delete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "u_actor_two", routineId: routine.id }),
    }));
    expect(wrong.status).toBe(404);
    const owned = await runtime.onRequest(new Request("https://do/internal/employee-runtime/routines/delete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "u_actor_one", routineId: routine.id }),
    }));
    expect(owned.status).toBe(200);
    expect(await owned.json()).toMatchObject({ ok: true, deleted: true });
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
