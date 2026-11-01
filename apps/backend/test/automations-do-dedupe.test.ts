import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
vi.mock("@cloudflare/think", () => ({
  Think: class {
    onStart() {}
    getTools() {
      return {};
    }
    onRequest() {
      return new Response(null, { status: 404 });
    }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({ fetch: async () => new Response("{}", { status: 404 }) }),
}));

import { Automations } from "../src/automations-do.js";
import type { Env } from "../src/env.js";

class FakeDurableStorage {
  readonly data = new Map<string, unknown>();
  listCalls = 0;
  deleteCalls: string[][] = [];
  failNextList = false;
  failNextDelete = false;

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async list<T>(opts?: { prefix?: string }): Promise<Map<string, T>> {
    this.listCalls += 1;
    if (this.failNextList) {
      this.failNextList = false;
      throw new Error("dedupe list failed");
    }
    return new Map(
      [...this.data.entries()].filter(([key]) =>
        opts?.prefix ? key.startsWith(opts.prefix) : true,
      ),
    ) as Map<string, T>;
  }

  async delete(keys: string[]): Promise<void> {
    this.deleteCalls.push(keys);
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("dedupe delete failed");
    }
    for (const key of keys) this.data.delete(key);
  }
}

function makeDo(storage = new FakeDurableStorage()) {
  const ctx = { storage } as unknown as DurableObjectState;
  const env = {
    CodingOrchestrator: {},
    AUTOMATIONS_ENABLED: "true",
    AI: {},
    ORCHESTRATOR_MODEL: "@cf/test/model",
  } as unknown as Env;
  return { do: new Automations(ctx, env), storage };
}

function dedupeRequest(key: string) {
  return new Request("https://internal/internal/dedupe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
}

describe("Automations DO dedupe storage", () => {
  it("durably dedupes a repeated delivery, even when the key is older than one hour", async () => {
    const { do: automation, storage } = makeDo();
    const staleKey = "dedupe:stale-delivery";
    storage.data.set(staleKey, Date.now() - 3_600_001);
    expect(await (await automation.fetch(dedupeRequest("stale-delivery"))).json()).toEqual({
      seen: true,
    });
    await automation.fetch(dedupeRequest("sweep-trigger"));
    expect(storage.data.has(staleKey)).toBe(false);
    storage.data.set(staleKey, Date.now());
    expect(await (await automation.fetch(dedupeRequest("stale-delivery"))).json()).toEqual({
      seen: true,
    });
  });

  it("keeps GitHub payload replay keys outside sweeps and migrates legacy keys", async () => {
    const { do: automation, storage } = makeDo();
    storage.data.set("dedupe:gh-payload:legacy", Date.now() - 3_600_001);
    expect(await (await automation.fetch(dedupeRequest("gh-payload:legacy"))).json()).toEqual({ seen: true });
    await automation.fetch(dedupeRequest("gh-payload:new"));
    expect(storage.data.has("dedupe:gh-payload:new")).toBe(false);
    expect(storage.data.has("dedupe:gh-payload:legacy")).toBe(false);
    expect(storage.data.has("github-payload-replay:gh-payload:legacy")).toBe(true);
    expect(storage.data.has("github-payload-replay:gh-payload:new")).toBe(true);
    expect(await (await automation.fetch(dedupeRequest("gh-payload:legacy"))).json()).toEqual({ seen: true });
  });

  it("throttles sweeps under separate metadata and preserves it across DO recreation", async () => {
    const storage = new FakeDurableStorage();
    const first = makeDo(storage).do;
    storage.data.set("dedupe:old", Date.now() - 3_600_001);
    await first.fetch(dedupeRequest("first"));
    expect(storage.listCalls).toBe(1);

    const recreated = makeDo(storage).do;
    await recreated.fetch(dedupeRequest("second"));
    await recreated.fetch(dedupeRequest("third"));
    expect(storage.listCalls).toBe(1);
    const metadataKeys = [...storage.data.keys()].filter((key) => key.includes("gc"));
    expect(metadataKeys).toHaveLength(1);
    expect(metadataKeys[0]).not.toContain("dedupe:");
  });

  it("deletes at most 128 stale keys per sweep and keeps fresh keys", async () => {
    const { do: automation, storage } = makeDo();
    const now = Date.now();
    for (let i = 0; i < 130; i += 1) {
      storage.data.set("dedupe:old-" + String(i).padStart(3, "0"), now - 3_600_001);
    }
    storage.data.set("dedupe:fresh", now);
    await automation.fetch(dedupeRequest("new"));
    expect(storage.deleteCalls).toHaveLength(1);
    expect(storage.deleteCalls[0]).toHaveLength(128);
    expect(storage.data.has("dedupe:fresh")).toBe(true);
    expect(storage.data.has("dedupe:new")).toBe(true);
    expect([...storage.data.keys()].filter((key) => key.startsWith("dedupe:old-"))).toHaveLength(2);
  });

  it("isolates cleanup failures from delivery acceptance and retries the sweep", async () => {
    const { do: automation, storage } = makeDo();
    storage.data.set("dedupe:old", Date.now() - 3_600_001);
    storage.failNextList = true;
    const response = await automation.fetch(dedupeRequest("accepted"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ seen: false });
    expect(storage.data.has("dedupe:accepted")).toBe(true);
    expect(storage.data.has("dedupe:old")).toBe(true);

    await automation.fetch(dedupeRequest("retry-cleanup"));
    expect(storage.listCalls).toBe(2);
    expect(storage.data.has("dedupe:old")).toBe(false);
  });

  it("does not advance successful-sweep metadata when deletion is interrupted", async () => {
    const { do: automation, storage } = makeDo();
    storage.data.set("dedupe:old", Date.now() - 3_600_001);
    storage.failNextDelete = true;
    await automation.fetch(dedupeRequest("accepted"));
    const metadataKey = [...storage.data.keys()].find((key) => key.includes("gc"));
    expect(metadataKey).toBeUndefined();

    await automation.fetch(dedupeRequest("again"));
    expect(storage.listCalls).toBe(2);
    expect(storage.data.has("dedupe:old")).toBe(false);
  });
});
