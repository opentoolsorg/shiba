import { describe, expect, it, vi } from "vitest";
vi.mock("@cloudflare/sandbox", () => ({ ContainerProxy: class {}, Sandbox: class {}, proxyToSandbox: async () => null, getSandbox: () => ({ destroy: async () => {} }) }));
vi.mock("@cloudflare/think", () => ({ Think: class { onStart() {} getTools() { return {}; } onRequest() { return new Response(null, { status: 404 }); } } }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("agents/routing", () => ({ getAgentByName: async () => ({ fetch: async () => Response.json({}) }) }));
import { Automations } from "../src/automations-do.js";
import { createAutomation } from "../src/automations.js";
import { sealInboundSecret } from "../src/webhooks/secrets.js";
import { generateInboundSecret } from "../src/webhooks/inbound-signing.js";
import { isAuthenticated } from "../src/request-auth.js";
import type { Env } from "../src/env.js";

async function fixture() {
  const secret = generateInboundSecret();
  const env = { MODEL_CREDENTIAL_KEY: "ab".repeat(32), CodingOrchestrator: {} } as unknown as Env;
  const automation = createAutomation({ id: "hook", prompt: "Review event", repoUrl: "https://github.com/owner/repo", triggers: [{ kind: "webhook" }] }).automation;
  automation.hookSecret = await sealInboundSecret(env, automation.id, secret);
  const data = new Map<string, unknown>([["state", { items: [automation] }]]);
  const storage = { get: async (key: string) => structuredClone(data.get(key)), put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); }, transaction: async (fn: (s: unknown) => unknown) => fn(storage) };
  const receipts = new Map<string, { receivedAt: number; state: "pending" | "done" }>();
  env.AGENT_AUDIT = { prepare: (sql: string) => ({ bind: (...args: (string | number)[]) => ({ first: async () => receipts.get(`${args[0]}:${args[1]}`) ?? null, run: async () => {
    const key = `${args[0]}:${args[1]}`;
    if (sql.startsWith("INSERT")) {
      const existing = receipts.get(key);
      if (existing !== undefined && existing.receivedAt > Number(args[3]) && !(existing.state === "pending" && existing.receivedAt <= Number(args[4]))) return { meta: { changes: 0 } };
      receipts.set(key, { receivedAt: Number(args[2]), state: "pending" });
      return { meta: { changes: 1 } };
    }
    if (args.length === 3 && receipts.get(key)?.receivedAt === args[2]) {
      if (sql.startsWith("UPDATE")) receipts.get(key)!.state = "done";
      else receipts.delete(key);
    }
    return { meta: { changes: 1 } };
  } }) }) } as unknown as D1Database;
  const instance = new Automations({ storage } as unknown as DurableObjectState, env);
  const fire = vi.spyOn(instance, "fireEvent").mockResolvedValue({ fired: 1, skipped: 0 });
  async function request(id = "delivery", signingSecret = secret, route = "hook", body = "") {
    const ts = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${id}.${body}`)));
    return instance.fetch(new Request(`https://internal/api/hooks/${route}`, { method: "POST", body, headers: { "x-shiba-timestamp": ts, "x-shiba-delivery-id": id, "x-shiba-signature": `sha256=${Array.from(signature, (b) => b.toString(16).padStart(2, "0")).join("")}` } }));
  }
  return { instance, request, fire, receipts, env, secret };
}

describe("signed hook ingress", () => {
  it("creates an encrypted secret once and refuses creation without encryption", async () => {
    const f = await fixture();
    const create = (id: string) => f.instance.fetch(new Request("https://internal/api/automations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, prompt: "Review event", repoUrl: "https://github.com/owner/repo", triggers: [{ kind: "webhook" }] }) }));
    const response = await create("new-hook");
    expect(response.status).toBe(201);
    const body = await response.json() as { hookSecret: string; automation: Record<string, unknown> };
    expect(body.hookSecret).toMatch(/^whsec_/);
    expect(body.automation.hasHookSecret).toBe(true);
    expect(body.automation).not.toHaveProperty("hookSecret");
    expect((await f.request("created", body.hookSecret, "new-hook")).status).toBe(200);
    f.env.MODEL_CREDENTIAL_KEY = undefined;
    expect((await create("no-key")).status).toBe(503);
  });
  it("dedupes a delivery for seven days, scoped by route, and forwards empty external data", async () => {
    const f = await fixture();
    expect((await f.request()).status).toBe(200);
    expect(await (await f.request()).json()).toEqual({ ok: true, duplicate: true });
    expect(f.fire).toHaveBeenCalledTimes(1);
    expect(f.fire).toHaveBeenCalledWith({ kind: "hook", deliveryId: "delivery", body: "" }, expect.anything(), expect.any(Number), "hook");
    f.receipts.set("hook:delivery", { receivedAt: Date.now() - 7 * 86400000 - 1, state: "done" });
    expect((await f.request()).status).toBe(200);
    expect(f.fire).toHaveBeenCalledTimes(2);
  });
  it("retries fresh pending claims and reclaims stale pending receipts", async () => {
    const f = await fixture();
    f.receipts.set("hook:delivery", { receivedAt: Date.now(), state: "pending" });
    expect((await f.request()).status).toBe(409);
    expect(f.fire).not.toHaveBeenCalled();
    f.receipts.set("hook:delivery", { receivedAt: Date.now() - 60001, state: "pending" });
    expect((await f.request()).status).toBe(200);
    expect(f.receipts.get("hook:delivery")?.state).toBe("done");
    expect(f.fire).toHaveBeenCalledOnce();
    expect(await (await f.request()).json()).toEqual({ ok: true, duplicate: true });
  });
  it("rejects oversized final tasks before claiming a receipt, including escaping overhead", async () => {
    const f = await fixture();
    const response = await f.request("large", f.secret, "hook", "<".repeat(1000));
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("4000-character task limit");
    expect(f.receipts.size).toBe(0);
    expect(f.fire).not.toHaveBeenCalled();
    expect((await f.request("large", f.secret, "hook", "small")).status).toBe(200);
  });
  it("returns the same auth denial for unknown and revoked routes, and rotates once", async () => {
    const f = await fixture();
    expect((await f.request("one", f.secret, "missing")).status).toBe(401);
    const rotated = await f.instance.fetch(new Request("https://internal/api/automations/hook/hook-secret", { method: "POST" }));
    const body = await rotated.json() as { hookSecret: string };
    expect(body.hookSecret).not.toBe(f.secret);
    expect((await f.request()).status).toBe(401);
    expect((await f.request("two", body.hookSecret)).status).toBe(200);
    const listed = await f.instance.fetch(new Request("https://internal/api/automations"));
    const text = await listed.text();
    expect(text).not.toContain(body.hookSecret);
    expect(text).not.toContain('"cipher"');
    expect(text).toContain('"hasHookSecret":true');
    await f.instance.fetch(new Request("https://internal/api/automations/hook/hook-secret", { method: "DELETE" }));
    expect((await f.request("three", body.hookSecret)).status).toBe(401);
  });
  it("releases failed queue receipts and fails closed without D1 or encryption", async () => {
    const f = await fixture();
    f.fire.mockRejectedValueOnce(new Error("queue down"));
    expect((await f.request()).status).toBe(503);
    expect((await f.request()).status).toBe(200);
    Object.assign(f.env, { AGENT_AUDIT: undefined });
    expect((await f.request("two")).status).toBe(503);
    f.env.MODEL_CREDENTIAL_KEY = undefined;
    expect((await f.request("three")).status).toBe(503);
  });
  it("bypasses dashboard auth only for the signed ingress, never secret management", () => {
    const env = {} as Env;
    expect(isAuthenticated(new Request("https://app.example/api/hooks/hook", { method: "POST" }), env)).toBe(true);
    expect(isAuthenticated(new Request("https://app.example/api/automations/hook/hook-secret", { method: "POST" }), env)).toBe(false);
  });
});
