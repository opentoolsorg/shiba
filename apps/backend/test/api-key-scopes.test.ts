import { describe, expect, it, vi } from "vitest";
import {
  apiKeyAllowsHttpMethod,
  authorizeV1Request,
  requireV1Read,
  requireV1Write,
  type V1Principal,
} from "../src/v1-auth.js";
import { createApiKey, revokeApiKeyById } from "../src/agent-tokens.js";
import type { Env } from "../src/env.js";

function kvMemory(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

describe("api key scopes", () => {
  it("allows read keys on GET and blocks POST", () => {
    const principal: V1Principal = {
      principal: "bot",
      orgId: "self-hosted",
      scopes: ["api:read"],
      apiKey: { principal: "bot", scopes: ["api:read"], created: 0, revoked: false, kind: "api_key", keyId: "k" },
    };
    expect(requireV1Read(principal)).toBe(true);
    expect(requireV1Write(principal)).toBe(false);
    expect(apiKeyAllowsHttpMethod(principal, "GET")).toBe(true);
    expect(apiKeyAllowsHttpMethod(principal, "POST")).toBe(false);
  });

  it("returns null for a revoked bearer", async () => {
    const env = { AGENT_TOKENS: kvMemory() } as unknown as Env;
    const minted = await createApiKey(env, { label: "t", principal: "t", scopes: ["api:read"] });
    await revokeApiKeyById(env, "self-hosted", minted.keyId);
    const req = new Request("https://example.test/api/v1/runs", {
      headers: { authorization: `Bearer ${minted.token}` },
    });
    expect(await authorizeV1Request(req, env)).toBeNull();
  });
});