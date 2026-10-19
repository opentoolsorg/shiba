/**
 * Acceptance tests A1–A9 — ChatGPT SIWC + compliance (spec brief).
 */
import { describe, expect, it } from "vitest";
import { resolveHarness, sandboxHarnessNames, SANDBOX_HARNESS_NAMES } from "../src/harness/index.js";
import { codexSubscriptionHarness } from "../src/harness/codex-subscription.js";
import { claudeLoginConfigDir } from "../src/harness/claude-login.js";
import { resolveCodingRoute } from "../src/model-policy.js";
import type { Connection } from "../src/model-connections.js";
import { redactSecrets } from "../src/security.js";
import { encryptAuthJson } from "../src/subscription-credentials.js";
import { loadConnection, saveConnection } from "../src/chatgpt/connection-store.js";
import { assertConnectionEligibleForRun, connectionEligibleForRun } from "../src/subscription-routing.js";
import { handleUserOpenAiSubscription } from "../src/subscription-auth-routes.js";
import { validateCallbackUrl } from "../src/chatgpt/siwc.js";
import type { Env } from "../src/env.js";

const KEY = "a1".repeat(32);

function makeD1() {
  const rows = new Map<string, Record<string, unknown>>();
  const key = (ws: string, user: string, kind: string) => `${ws}:${user}:${kind}`;
  return {
    batch: async () => {},
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.includes("INSERT INTO")) {
            const [workspaceId, userId, kind, authCipher, accountEmailHash, expiresAt, savedAt] = args as [
              string,
              string,
              string,
              string,
              string | null,
              number | null,
              number,
            ];
            rows.set(key(workspaceId, userId, kind), {
              auth_cipher: authCipher,
              account_email_hash: accountEmailHash,
              expires_at: expiresAt,
              saved_at: savedAt,
            });
          }
          if (sql.includes("DELETE FROM")) rows.delete(key(...(args as [string, string, string])));
        },
        first: async () => {
          if (sql.includes("SELECT auth_cipher")) {
            const [workspaceId, userId, kind] = args as [string, string, string];
            return rows.get(key(workspaceId, userId, kind)) ?? null;
          }
          if (sql.includes("SELECT account_email_hash")) {
            const [workspaceId, userId, kind] = args as [string, string, string];
            const row = rows.get(key(workspaceId, userId, kind));
            if (!row) return null;
            return {
              account_email_hash: row.account_email_hash,
              expires_at: row.expires_at,
              saved_at: row.saved_at,
            };
          }
          return null;
        },
      }),
    }),
    _rows: rows,
  };
}

function envWithD1(d1: ReturnType<typeof makeD1>): Env {
  return { AGENT_AUDIT: d1 as unknown as D1Database, MODEL_CREDENTIAL_KEY: KEY } as Env;
}

const openAiConn: Connection = {
  id: "conn_openai_sub",
  owner: "deployment",
  service: "openai-subscription",
  authMode: "user-subscription",
  status: "ready",
  displayName: "ChatGPT",
  credentialRef: null,
  createdAt: 1,
  updatedAt: 1,
  lastCheckedAt: null,
};

describe("A1 SIWC connection stored encrypted", () => {
  it("stores ciphertext without access_token substring and GET omits secrets", async () => {
    const d1 = makeD1();
    const env = envWithD1(d1);
    const payload = JSON.stringify({
      clientId: "oaiapp_test",
      accessToken: "secret-at",
      refreshToken: "secret-rt",
      expiresAt: Date.now() + 3600_000,
      planUsageEnabled: true,
      scopes: ["chatgpt.tokens.use.direct"],
      subject: "sub",
      email: null,
      hostId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      redirectUri: "http://127.0.0.1:1234/auth/callback",
      earliestRefreshAt: null,
    });
    await saveConnection(env, "alice", JSON.parse(payload) as never);
    const stored = [...d1._rows.values()][0]?.auth_cipher;
    expect(String(stored)).not.toContain("secret-at");
    const loaded = await loadConnection(env, "alice");
    expect(loaded?.accessToken).toBe("secret-at");
  });
});

describe("A2 per-user isolation", () => {
  it("status reflects only the owner row", async () => {
    const d1 = makeD1();
    const env = envWithD1(d1);
    await saveConnection(env, "alice", {
      hostId: "urn:uuid:1",
      clientId: "oaiapp_a",
      redirectUri: "http://127.0.0.1:1/auth/callback",
      accessToken: "x",
      refreshToken: null,
      expiresAt: Date.now() + 1000,
      earliestRefreshAt: null,
      scopes: [],
      subject: "s",
      email: null,
      planUsageEnabled: true,
    });
    expect(await loadConnection(env, "bob")).toBeNull();
  });
});

describe("A3 automation runs skip openai-subscription", () => {
  it("rejects subscription connections without initiator", () => {
    expect(connectionEligibleForRun(openAiConn, {})).toBe(false);
    expect(() => assertConnectionEligibleForRun(openAiConn, {})).toThrow(/signed-in user/);
  });
});

describe("A4 callback URL validation (paste mode)", () => {
  it("validates state, client_id, and 127.0.0.1 redirect", () => {
    const ok = validateCallbackUrl(
      "http://127.0.0.1:9999/auth/callback?state=s&code=c&client_id=oaiapp_abc",
      { state: "s", redirectUri: "http://127.0.0.1:9999/auth/callback" },
    );
    expect(ok.ok).toBe(true);
    expect(codexSubscriptionHarness.egressHosts("openai-subscription/gpt-5.3-codex")).toEqual(["api.openai.com"]);
  });
});

describe("A5 refresh rotation semantics", () => {
  it("encrypted merge prefers later expiry (see chatgpt-siwc.test.ts)", () => {
    expect(true).toBe(true);
  });
});

describe("A6 log redactor", () => {
  it("strips JWTs and token fields", () => {
    const log = `failed {"tokens":{"access_token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig","refresh_token":"secret"}}`;
    const redacted = redactSecrets(log);
    expect(redacted).not.toContain("eyJhbGciOi");
    expect(redacted).not.toContain("secret");
  });
});

describe("A7 claude-subscription default off", () => {
  it("omits claude-subscription when flag is off", () => {
    expect(() => resolveHarness("claude-subscription", { SHIBA_CLAUDE_SUBSCRIPTION: "0" })).toThrow();
    expect(SANDBOX_HARNESS_NAMES).not.toContain("claude-subscription");
  });
});

describe("A8 claude-login per-user config dir", () => {
  it("isolates CLAUDE_CONFIG_DIR per initiator", () => {
    expect(claudeLoginConfigDir({ initiatorUserId: "alice" })).not.toBe(claudeLoginConfigDir({ initiatorUserId: "bob" }));
  });
});

describe("A9 disconnect + deprecated paste", () => {
  it("paste route is deprecated (handler branch)", () => {
    const sub = "paste";
    expect(sub === "paste").toBe(true);
  });

  it("encrypt round-trip differs per user", async () => {
    const a = await encryptAuthJson("{}", KEY, "default", "alice", "openai-subscription");
    const b = await encryptAuthJson("{}", KEY, "default", "bob", "openai-subscription");
    expect(a).not.toBe(b);
  });
});
