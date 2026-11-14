import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { readProviderSnapshot, resetProvider } from "../src/acp-providers.js";

function kvStore(): KVNamespace {
  const data = new Map<string, string>();
  return {
    get: async (key: string) => data.get(key) ?? null,
    put: async (key: string, value: string) => {
      data.set(key, value);
    },
    delete: async (key: string) => {
      data.delete(key);
    },
    list: async () => ({ keys: [] }),
  } as unknown as KVNamespace;
}

describe("acp provider stale failure", () => {
  it("clears a stale failed record when credentials are present", async () => {
    const env = {
      AGENT_TOKENS: kvStore(),
      AI_GATEWAY_TOKEN: "gateway-token",
      CF_VERSION_METADATA: { id: "00000000-0000-0000-0000-000000000001", tag: "abc", timestamp: "2026-11-14T00:00:00.000Z" },
    } as unknown as Env;
    const org = "owner@example.test";
    const kv = env.AGENT_TOKENS!;
    await kv.put(
      `acp_provider:${encodeURIComponent(org)}:claude`,
      JSON.stringify({
        phase: "failed",
        authMode: "api-key",
        message: "Connection failed for unrelated reason",
        testedAt: 1,
        updatedAt: 1,
      }),
    );
    const snapshot = await readProviderSnapshot(env, org);
    const card = snapshot.providers.find((p) => p.id === "claude");
    expect(card?.connection.phase).not.toBe("failed");
  });

  it("reset action removes the stored record", async () => {
    const env = { AGENT_TOKENS: kvStore() } as unknown as Env;
    const org = "owner";
    await env.AGENT_TOKENS.put(
      `acp_provider:${encodeURIComponent(org)}:claude`,
      JSON.stringify({ phase: "failed", authMode: "api-key", message: "stuck", updatedAt: 1 }),
    );
    await resetProvider(env, org, "claude");
    const snapshot = await readProviderSnapshot(env, org);
    const card = snapshot.providers.find((p) => p.id === "claude");
    expect(card?.connection.phase).toBe("disconnected");
  });
});