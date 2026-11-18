import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { D1ThreadQueue } from "../src/adapters/thread-queue/d1/index.js";
import { threadQueueContract } from "../src/ports/thread-queue/contract-suite.js";
import { enqueueThreadMessage, listQueuedMessages, removeQueuedMessage } from "../src/v1-message-queue.js";
import { handleV1, type V1RouteDeps } from "../src/v1-routes.js";
import type { Env } from "../src/env.js";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { unstable_splitSqlQuery } = require("wrangler");
let mf: InstanceType<typeof Miniflare>;
let db: D1Database;
let env: Env;
let kv: Map<string, string>;

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: "queue", modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-09-01", d1Databases: ["AGENT_AUDIT"] }));
  db = await mf.getD1Database("AGENT_AUDIT", "queue");
  const sql = readFileSync(new URL("../migrations/0064_thread_queue.sql", import.meta.url), "utf8");
  await db.batch(unstable_splitSqlQuery(sql).map((s: string) => db.prepare(s)));
}, 30_000);
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await db.prepare("DELETE FROM thread_queue").run();
  kv = new Map();
  env = { AGENT_AUDIT: db, AGENT_TOKENS: {
    get: vi.fn(async (key: string) => kv.get(key) ?? null),
    delete: vi.fn(async (key: string) => { kv.delete(key); }),
  } } as unknown as Env;
});

threadQueueContract("local D1", () => new D1ThreadQueue(db));

const deps: V1RouteDeps = {
  isAuthorized: async () => true,
  resolveTarget: async () => ({ agentName: "caller", userId: "u1" }),
  getStub: async () => ({ fetch: async () => Response.json({ run: { runId: "r1", status: "running" } }) }),
};
const send = (body: unknown) => handleV1(new Request("https://worker.test/api/v1/threads/r1/message", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}), env, deps);

describe("v1 queue", () => {
  it("accepts both concurrent follow-ups and lists them", async () => {
    const responses = await Promise.all([send({ text: "one", delivery: "queue" }), send({ text: "two", delivery: "queue" })]);
    expect(responses.map(r => r?.status)).toEqual([200, 200]);
    const list = await handleV1(new Request("https://worker.test/api/v1/threads/r1/queued-messages"), env, deps);
    if (!list) throw new Error("Missing queue response");
    expect((await list.json() as { items: { text: string }[] }).items.map(item => item.text)).toEqual(["one", "two"]);
  });
  it("returns a plain 503 when the write fails", async () => {
    // Simulate a failed D1 write after the legacy KV read.
    env.AGENT_AUDIT = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("write unavailable"); } }) }) } as unknown as D1Database;
    const response = await send({ text: "one", delivery: "queue" });
    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe("Thread message queue unavailable. Please retry.");
    await expect(enqueueThreadMessage(env, "r1", "one")).rejects.toThrow();
  });
  it("imports legacy messages before deleting KV, with retry-safe IDs", async () => {
    const item = { id: "old", threadId: "r1", text: "legacy", createdAt: 1 };
    kv.set("msgq_r1", JSON.stringify([item]));
    expect(await listQueuedMessages(env, "r1")).toEqual([item]);
    expect(kv.has("msgq_r1")).toBe(false);
    expect(await removeQueuedMessage(env, "r1", "old")).toEqual(item);
    kv.set("msgq_r1", JSON.stringify([item]));
    expect(await listQueuedMessages(env, "r1")).toEqual([]);
  });
  it("retains KV if migration fails and retries partial imports without duplication", async () => {
    const item = { id: "old", threadId: "r1", text: "legacy", createdAt: 1 };
    const bad = { ...item, id: "bad", threadId: "wrong" };
    kv.set("msgq_r1", JSON.stringify([item, bad]));
    await expect(listQueuedMessages(env, "r1")).rejects.toThrow();
    expect(kv.has("msgq_r1")).toBe(true);
    kv.set("msgq_r1", JSON.stringify([item]));
    expect(await listQueuedMessages(env, "r1")).toEqual([item]);
  });
  it("steers exactly once for concurrent send-now requests", async () => {
    const { message } = await enqueueThreadMessage(env, "r1", "send once");
    const steer = vi.fn(async () => Response.json({ approvalId: "a1" }));
    const routeDeps = { ...deps, getStub: async () => ({ fetch: async (request: Request) => request.method === "GET"
      ? Response.json({ run: { runId: "r1", status: "running" } })
      : steer() }) };
    const sendNow = () => handleV1(new Request(`https://worker.test/api/v1/threads/r1/messages/${message.id}/send-now`, {
      method: "POST",
    }), env, routeDeps);
    const responses = await Promise.all([sendNow(), sendNow()]);
    expect(responses.map(response => response?.status).sort()).toEqual([200, 404]);
    expect(await responses.find(response => response?.status === 404)?.json()).toEqual({
      _tag: "shiba/MessageNotFound", eventId: message.id,
    });
    expect(steer).toHaveBeenCalledTimes(1);
    expect(await listQueuedMessages(env, "r1")).toEqual([]);
  });
  it("keeps a queued message when send-now is rejected", async () => {
    const { message } = await enqueueThreadMessage(env, "r1", "keep me");
    const response = await handleV1(new Request(`https://worker.test/api/v1/threads/r1/messages/${message.id}/send-now`, {
      method: "POST",
    }), env, { ...deps, getStub: async () => ({ fetch: async request => request.method === "GET"
      ? Response.json({ run: { runId: "r1", status: "running" } })
      : new Response("steer failed", { status: 503 }) }) });
    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe("steer failed");
    expect(await listQueuedMessages(env, "r1")).toEqual([message]);
  });
  it("releases the claim when forwarding send-now throws", async () => {
    const { message } = await enqueueThreadMessage(env, "r1", "retry me");
    const response = await handleV1(new Request(`https://worker.test/api/v1/threads/r1/messages/${message.id}/send-now`, {
      method: "POST",
    }), env, { ...deps, getStub: async () => ({ fetch: async request => {
      if (request.method === "GET") return Response.json({ run: { runId: "r1", status: "running" } });
      throw new Error("forward unavailable");
    } }) });
    expect(response?.status).toBe(503);
    expect(await listQueuedMessages(env, "r1")).toEqual([message]);
  });
  it("retains the KV key on D1 failure and reports read failures as 503", async () => {
    kv.set("msgq_r1", JSON.stringify([{ id: "old", threadId: "r1", text: "legacy", createdAt: 1 }]));
    env.AGENT_AUDIT = { prepare: () => { throw new Error("D1 unavailable"); } } as unknown as D1Database;
    const response = await handleV1(new Request("https://worker.test/api/v1/threads/r1/queued-messages"), env, deps);
    expect(response?.status).toBe(503);
    expect(kv.has("msgq_r1")).toBe(true);
  });
  it("propagates acknowledgment failures", async () => {
    const queue = new D1ThreadQueue({ prepare: () => ({ bind: () => ({ run: async () => ({ success: false }) }) }) } as unknown as D1Database);
    await expect(queue.ack(["a"])).rejects.toThrow();
    await expect(queue.enqueue("r1", { id: "a", threadId: "r1", text: "x", createdAt: 1 })).rejects.toThrow();
  });
});
