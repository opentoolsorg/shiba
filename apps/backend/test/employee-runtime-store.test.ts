import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { EmployeeRuntimeStore, type SqlExec, type SqlRow } from "../src/employee-runtime-store.js";

function makeStore(): EmployeeRuntimeStore {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExec = (sql, ...params) => {
    const sqliteParams = params.map((value) => typeof value === "boolean" ? Number(value) : value);
    const statement = db.prepare(sql);
    if (statement.columns().length) return statement.all(...sqliteParams) as SqlRow[];
    statement.run(...sqliteParams);
    return [];
  };
  const store = new EmployeeRuntimeStore(exec);
  store.init();
  return store;
}

const profile = {
  orgId: "org-1",
  employeeId: "emp-1",
  employeeVersion: 3,
  name: "Riley",
  instructions: "Be concise.",
};

describe("EmployeeRuntimeStore", () => {
  it("persists conversation messages and pinned employee profiles in order", () => {
    const store = makeStore();
    store.pinProfile("default", profile, 10);
    const first = store.appendMessage({ conversationId: "default", role: "user", content: "hello", now: 11 });
    const second = store.appendMessage({ conversationId: "default", role: "assistant", content: "hi", now: 12 });
    store.appendMessage({ conversationId: "other", role: "user", content: "wrong room", now: 13 });

    expect(store.profile("default")).toMatchObject({ employeeId: "emp-1", employeeVersion: 3 });
    expect(store.listMessages("default").map((message) => message.id)).toEqual([first.id, second.id]);
    expect(store.listMessages("other")).toHaveLength(1);
  });

  it("creates searchable essential and thread-scoped memories without leaking other threads", () => {
    const store = makeStore();
    const essential = store.createMemory({ scope: "employee", kind: "preference", content: "Use concise launch updates", essential: true });
    const thread = store.createMemory({ scope: "thread", kind: "summary", content: "Launch plan uses approval gates", essential: false, conversationId: "default" });
    store.createMemory({ scope: "thread", kind: "summary", content: "Other thread secret", essential: false, conversationId: "other" });

    expect(store.searchMemories("approval gates", { conversationId: "default" }).map((memory) => memory.id)).toEqual([thread.id]);
    expect(store.searchMemories("Other thread secret", { conversationId: "default" })).toEqual([]);
    expect(store.listMemories({ essential: true }).map((memory) => memory.id)).toEqual([essential.id]);
  });

  it("updates, searches, and deletes memories through the FTS index", () => {
    const store = makeStore();
    const memory = store.createMemory({ scope: "employee", kind: "fact", content: "initial fact", essential: false });
    expect(store.updateMemory(memory.id, { content: "changed operational fact", essential: true })).toMatchObject({ essential: true });
    expect(store.searchMemories("changed operational").map((row) => row.id)).toEqual([memory.id]);
    expect(store.searchMemories("initial fact")).toEqual([]);
    expect(store.deleteMemory(memory.id)).toBe(true);
    expect(store.searchMemories("changed operational")).toEqual([]);
    expect(store.deleteMemory(memory.id)).toBe(false);
  });

  it("records execution checkpoints and marks interrupted work recoverable", () => {
    const store = makeStore();
    const execution = store.createExecution({ conversationId: "default", mode: "chat", inputJson: "{}", now: 20 });
    expect(store.updateExecution(execution.id, { checkpoint: "inference", now: 21 })).toMatchObject({ status: "running", checkpoint: "inference" });
    expect(store.markInterruptedRunning(22)).toBe(1);
    expect(store.getExecution(execution.id)).toMatchObject({ status: "interrupted", checkpoint: "recovery_required" });
    expect(store.markInterruptedRunning(23)).toBe(0);
  });

  it("does not mix execution history across conversations", () => {
    const store = makeStore();
    const first = store.createExecution({ conversationId: "default", mode: "chat", inputJson: "{}", now: 1 });
    store.createExecution({ conversationId: "other", mode: "work", inputJson: "{}", now: 2 });
    expect(store.listExecutions("default").map((execution) => execution.id)).toEqual([first.id]);
  });

  it("evicts nonessential memories before essential memories at the storage cap", () => {
    const store = makeStore();
    const essential = store.createMemory({ scope: "employee", kind: "fact", content: "must remain", essential: true, now: 1 });
    for (let index = 0; index < 1000; index += 1) {
      store.createMemory({ scope: "employee", kind: "fact", content: `ordinary ${index}`, essential: false, now: index + 2 });
    }
    expect(store.getMemory(essential.id)).toMatchObject({ content: "must remain", essential: true });
    expect(store.listMemories({ limit: 500 }).some((memory) => memory.content === "ordinary 0")).toBe(false);
  });

  it("clears automatic thread memories while preserving manual thread memories", () => {
    const store = makeStore();
    const manual = store.createMemory({ scope: "thread", conversationId: "default", kind: "fact", content: "manual fact", essential: true });
    const automatic = store.createMemory({ scope: "thread", conversationId: "default", kind: "fact", content: "derived fact", essential: false, origin: "automatic" });
    store.clearConversation("default");
    expect(store.getMemory(manual.id)).toMatchObject({ content: "manual fact", origin: "manual" });
    expect(store.getMemory(automatic.id)).toBeNull();
  });

  it("rejects new memories instead of silently dropping them when essential memories fill storage", () => {
    const store = makeStore();
    for (let index = 0; index < 1000; index += 1) {
      store.createMemory({ scope: "employee", kind: "fact", content: `essential ${index}`, essential: true, now: index + 1 });
    }
    expect(() => store.createMemory({ scope: "employee", kind: "fact", content: "would vanish", essential: false })).toThrow(/full of essential memories/);
    expect(store.listMemories({ limit: 500 })).toHaveLength(500);
    expect(() => store.createMemory({ scope: "employee", kind: "fact", content: "another essential", essential: true })).toThrow(/full of essential memories/);
  });

  it("treats user-edited automatic memories as manual provenance", () => {
    const store = makeStore();
    const automatic = store.createMemory({ scope: "thread", conversationId: "default", kind: "fact", content: "derived fact", essential: false, origin: "automatic" });
    expect(store.updateMemory(automatic.id, { essential: true })).toMatchObject({ origin: "manual", essential: true });
    store.clearConversation("default");
    expect(store.getMemory(automatic.id)).toMatchObject({ content: "derived fact", origin: "manual", essential: true });
  });
});
