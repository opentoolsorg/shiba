import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { readModelRoute, readToolSetup } from "../src/model-route-status.js";

function kv(records = new Map<string, string>()) {
  return {
    get: async (key: string) => records.get(key) ?? null,
    put: async (key: string, value: string) => { records.set(key, value); },
    delete: async (key: string) => { records.delete(key); },
    list: async () => ({ keys: [] }),
  } as unknown as KVNamespace;
}

function modelConfig(status: string) {
  return {
    idFromName: () => "default",
    get: () => ({
      fetch: async (request: Request) => Response.json(
        new URL(request.url).pathname === "/connections"
          ? { connections: [{ id: "c1", owner: "deployment", service: "openai", authMode: "api-key", status, displayName: "OpenAI", credentialRef: null, createdAt: 1, updatedAt: 1, lastCheckedAt: 1 }], connectionOrder: ["c1"] }
          : {},
      ),
    }),
  };
}

const base = { GATEWAY_ID: "default", MODEL_CREDENTIAL_KEY: "ab".repeat(32) };
const makeEnv = (extra: Record<string, unknown> = {}) => ({ ...base, AGENT_TOKENS: kv(), ...extra }) as unknown as Env;

describe("readModelRoute", () => {
  it("is not ready with no provider, connection or gateway token, and points at Providers", async () => {
    const route = await readModelRoute(makeEnv({ AI_GATEWAY_TOKEN: "" }), "alice");
    expect(route).toEqual({
      ready: false,
      via: null,
      fix: { kind: "connect-provider", label: "Connect ChatGPT or Claude", href: "/settings/?section=providers" },
    });
  });

  it("is ready through a personal default provider", async () => {
    const tokens = new Map<string, string>([
      ["acp_provider:alice:codex", JSON.stringify({ phase: "connected", authMode: "oauth", signInKind: "codex", updatedAt: Date.now() })],
      ["acp_provider_default:alice", "codex"],
    ]);
    const route = await readModelRoute(makeEnv({ AGENT_TOKENS: kv(tokens) }), "alice");
    expect(route).toMatchObject({ ready: true, via: "personal-provider", fix: null });
  });

  it("is ready through the gateway token", async () => {
    expect(await readModelRoute(makeEnv({ AI_GATEWAY_TOKEN: "gw" }), "alice")).toMatchObject({ ready: true, via: "gateway" });
  });

  it("is ready through a ready model connection and ignores a failing one", async () => {
    expect(await readModelRoute(makeEnv({ ModelConfig: modelConfig("ready") }), "alice")).toMatchObject({ ready: true, via: "connection" });
    expect(await readModelRoute(makeEnv({ ModelConfig: modelConfig("error") }), "alice")).toMatchObject({ ready: false });
  });
});

describe("readToolSetup", () => {
  it("marks tools missing their key or binding and names only the env", () => {
    const missing = readToolSetup(makeEnv({ AI: undefined }));
    expect(missing.map((row) => [row.id, row.ready, row.env])).toEqual([
      ["web_search", false, "WEB_SEARCH_API_KEY"],
      ["generate_image", false, "AI"],
      ["browser", false, "BROWSER"],
    ]);
    const ready = readToolSetup(makeEnv({ WEB_SEARCH_API_KEY: "k", AI: {}, BROWSER: {} }));
    expect(ready.every((row) => row.ready)).toBe(true);
    expect(JSON.stringify(ready)).not.toContain('"k"');
  });
});
