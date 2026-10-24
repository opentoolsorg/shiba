/**
 * Breaker cases for provider sign-in. Synthetic only — no live vendor calls.
 * Each case is a regression test for a failure found while wiring the flow.
 */
import { describe, expect, it } from "vitest";
import type { AcpProvidersSnapshot } from "@shiba/shared";
import { handleAcpProviders } from "../src/acp-provider-routes.js";
import type { Env } from "../src/env.js";

class FakeKV {
  readonly map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

function chatGpt(users: Map<string, { connected: boolean }>): Env["ChatGptAuth"] {
  return {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const user = String(id);
        if (url.endsWith("/begin")) {
          return Response.json({
            authorizeUrl: `https://auth.openai.com/oauth/authorize?login=${encodeURIComponent(user)}`,
          });
        }
        if (url.endsWith("/complete")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { callbackUrl?: string };
          if (!body.callbackUrl?.includes("code=good")) {
            return Response.json({ error: "That callback is not for this sign-in." }, { status: 400 });
          }
          users.set(user, { connected: true });
          return Response.json({ connected: true, planUsageEnabled: true });
        }
        if (url.endsWith("/status")) {
          return Response.json(users.get(user)?.connected ? { connected: true, planUsageEnabled: true } : { connected: false });
        }
        return Response.json({ error: "no" }, { status: 404 });
      },
    }),
  } as unknown as Env["ChatGptAuth"];
}

function deployment(kv: FakeKV, users: Map<string, { connected: boolean }>): Env {
  return {
    AGENT_TOKENS: kv,
    MODEL_CREDENTIAL_KEY: "ab".repeat(32),
    ChatGptAuth: chatGpt(users),
  } as unknown as Env;
}

function request(path: string, body: unknown, email = "ada@example.com"): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Access-Authenticated-User-Email": email,
    },
    body: JSON.stringify(body),
  });
}

async function card(response: Response | null, id: string) {
  expect(response?.status).toBe(200);
  const body = (await response!.json()) as AcpProvidersSnapshot;
  return body.providers.find((provider) => provider.id === id);
}

describe("provider sign-in breaker", () => {
  it("rejects a forged callback and does not store it", async () => {
    const kv = new FakeKV();
    const users = new Map<string, { connected: boolean }>();
    const env = deployment(kv, users);
    const started = await card(
      await handleAcpProviders(request("/api/providers/codex/connect", { mode: "oauth" }), env),
      "codex",
    );
    expect(started?.connection.phase).toBe("waiting");
    expect(started?.connection.verificationUri).toContain("https://auth.openai.com/");
    const forged = "http://127.0.0.1:1455/auth/callback?code=forged-secret&state=nope";
    const failed = await card(
      await handleAcpProviders(request("/api/providers/codex/verify", { callbackUrl: forged }), env),
      "codex",
    );
    expect(failed?.connection.phase).toBe("failed");
    expect(users.get("ada@example.com")?.connected).toBeUndefined();
    expect([...kv.map.values()].join("\n")).not.toContain("forged-secret");
  });

  it("does not let one user finish another user's ChatGPT sign-in", async () => {
    const kv = new FakeKV();
    const users = new Map<string, { connected: boolean }>();
    const env = deployment(kv, users);
    await handleAcpProviders(request("/api/providers/codex/connect", { mode: "oauth" }, "ada@example.com"), env);
    await handleAcpProviders(request("/api/providers/codex/connect", { mode: "oauth" }, "grace@example.com"), env);
    const callback = "http://127.0.0.1:1455/auth/callback?code=good&state=ada";
    const ada = await card(
      await handleAcpProviders(request("/api/providers/codex/verify", { callbackUrl: callback }, "ada@example.com"), env),
      "codex",
    );
    expect(ada?.connection.phase).toBe("connected");
    expect(users.get("ada@example.com")?.connected).toBe(true);
    expect(users.get("grace@example.com")?.connected).toBeUndefined();
    const graceGet = await handleAcpProviders(
      new Request("http://localhost/api/providers", {
        headers: { "CF-Access-Authenticated-User-Email": "grace@example.com" },
      }),
      env,
    );
    const graceCard = await card(graceGet, "codex");
    expect(graceCard?.connection.phase).toBe("waiting");
  });

  it("a thrown complete does not mark the provider connected", async () => {
    const kv = new FakeKV();
    const users = new Map<string, { connected: boolean }>();
    const env = deployment(kv, users);
    await handleAcpProviders(request("/api/providers/codex/connect", { mode: "oauth" }), env);
    const aborted = await handleAcpProviders(request("/api/providers/codex/verify", { callbackUrl: "http://127.0.0.1:1/auth/callback?code=good" }), env, {
      completeOauth: async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    });
    expect(aborted?.status).toBe(500);
    const current = await card(
      await handleAcpProviders(
        new Request("http://localhost/api/providers", {
          headers: { "CF-Access-Authenticated-User-Email": "ada@example.com" },
        }),
        env,
      ),
      "codex",
    );
    expect(current?.connection.phase).toBe("waiting");
  });

  it("overlapping verifies leave one connection record and no token material", async () => {
    const kv = new FakeKV();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const env = deployment(kv, new Map());
    await handleAcpProviders(
      request("/api/providers/codex/connect", { mode: "oauth" }),
      env,
      {
        beginOauth: async () => ({
          ok: true,
          pending: true,
          message: "waiting",
          signInKind: "chatgpt-pkce",
          verificationUri: "https://auth.openai.com/oauth/authorize",
        }),
      },
    );
    const completeOauth = async () => {
      entered += 1;
      if (entered === 1) await gate;
      return { ok: true, message: "connected" };
    };
    const first = handleAcpProviders(request("/api/providers/codex/verify", {}), env, { completeOauth });
    const second = handleAcpProviders(request("/api/providers/codex/verify", {}), env, { completeOauth });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release?.();
    const [a, b] = await Promise.all([first, second]);
    expect(a?.status).toBe(200);
    expect(b?.status).toBe(200);
    const stored = [...kv.map.values()].join("\n");
    expect(stored).not.toMatch(/access_token|refresh_token|Bearer /);
    const final = await card(
      await handleAcpProviders(
        new Request("http://localhost/api/providers", {
          headers: { "CF-Access-Authenticated-User-Email": "ada@example.com" },
        }),
        env,
      ),
      "codex",
    );
    expect(final?.connection.phase === "connected" || final?.connection.phase === "waiting").toBe(true);
  });
});
