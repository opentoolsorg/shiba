/**
 * Acceptance tests A1–A8 for per-user ChatGPT subscription auth (spec brief).
 */
import { describe, expect, it, vi } from "vitest";
import { forwardCodexSubscription } from "../src/egress.js";
import { refreshCodexAuthJson, accessTokenNeedsRefresh } from "../src/codex-token-refresh.js";
import { codexSubscriptionHarness, codexSubscriptionAuthFile } from "../src/harness/codex-subscription.js";
import { resolveHarness, sandboxHarnessNames, SANDBOX_HARNESS_NAMES } from "../src/harness/index.js";
import { claudeLoginConfigDir } from "../src/harness/claude-login.js";
import { resolveCodingRoute } from "../src/model-policy.js";
import type { Connection } from "../src/model-connections.js";
import { redactSecrets } from "../src/security.js";
import {
  deleteUserSubscriptionCredential,
  encryptAuthJson,
  loadUserSubscriptionAuthJson,
  readUserSubscriptionStatus,
  saveUserSubscriptionAuthJson,
} from "../src/subscription-credentials.js";
import { assertConnectionEligibleForRun, connectionEligibleForRun } from "../src/subscription-routing.js";
import { handleUserOpenAiSubscription } from "../src/subscription-auth-routes.js";
import type { Env } from "../src/env.js";

const KEY = "a1".repeat(32);
const AUTH_JSON = JSON.stringify({
  tokens: {
    access_token: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.sig",
    refresh_token: "rt-secret-value",
    account_id: "acct",
  },
});

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
          if (sql.includes("DELETE FROM")) {
            const [workspaceId, userId, kind] = args as [string, string, string];
            rows.delete(key(workspaceId, userId, kind));
          }
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

describe("A1 paste auth.json encrypted storage", () => {
  it("stores ciphertext without access_token substring and GET omits secrets", async () => {
    const d1 = makeD1();
    const env = envWithD1(d1);
    const status = await saveUserSubscriptionAuthJson(env, "alice", AUTH_JSON);
    expect(status.connected).toBe(true);
    const stored = [...d1._rows.values()][0]?.auth_cipher;
    expect(typeof stored).toBe("string");
    expect(String(stored)).not.toContain("access_token");
    expect(String(stored)).not.toContain("rt-secret-value");
    const getStatus = await readUserSubscriptionStatus(env, "alice");
    expect(getStatus).not.toHaveProperty("access_token");
    expect(getStatus).not.toHaveProperty("authJson");
    expect(getStatus.connected).toBe(true);
  });
});

describe("A2 per-user credential isolation", () => {
  it("resolves only the owner's credential", async () => {
    const d1 = makeD1();
    const env = envWithD1(d1);
    await saveUserSubscriptionAuthJson(env, "alice", AUTH_JSON);
    const alice = await loadUserSubscriptionAuthJson(env, "alice");
    const bob = await loadUserSubscriptionAuthJson(env, "bob");
    expect(alice).toContain("access_token");
    expect(bob).toBeNull();
    const bobStatus = await readUserSubscriptionStatus(env, "bob");
    expect(bobStatus.connected).toBe(false);
  });
});

describe("A3 automation runs skip openai-subscription", () => {
  it("rejects subscription connections without initiator", () => {
    expect(connectionEligibleForRun(openAiConn, {})).toBe(false);
    expect(() => assertConnectionEligibleForRun(openAiConn, {})).toThrow(/signed-in user/);
    expect(connectionEligibleForRun(openAiConn, { initiatorUserId: "alice" })).toBe(true);
  });

  it("resolveCodingRoute refuses openai-subscription for automation context", () => {
    expect(() =>
      resolveCodingRoute(
        { connections: [openAiConn], policy: { version: 0, models: {}, updatedAt: 0 }, connectionOrder: [openAiConn.id] },
        { connectionId: openAiConn.id, model: "openai-subscription/gpt-5.3-codex", harness: "codex-subscription" },
        {},
      ),
    ).toThrow(/signed-in user/);
  });
});

describe("A4 stub auth.json and egress bearer", () => {
  it("mounts stub in container and attaches bearer only on chatgpt.com", async () => {
    const stub = codexSubscriptionAuthFile("/tmp/codex-home");
    expect(stub.contents).toContain("shiba-egress-placeholder");
    expect(stub.contents).toContain("access_token");
    const parsed = JSON.parse(stub.contents) as { tokens: { refresh_token: string } };
    expect(parsed.tokens.refresh_token).toBe("");

    const d1 = makeD1();
    const env = {
      ...envWithD1(d1),
      SHIBA_SINGLE_USER: "0",
    } as Env;
    await saveUserSubscriptionAuthJson(env, "alice", AUTH_JSON);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      const response = await forwardCodexSubscription(
        new Request("https://chatgpt.com/backend-api/wham/usage"),
        env,
        { params: { userId: "alice" } },
      );
      expect(response.status).toBe(200);
      const init = fetch.mock.calls[0]?.[1];
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer eyJ/);
      const refreshAttempt = await forwardCodexSubscription(
        new Request("https://auth.openai.com/oauth/token", { method: "POST" }),
        env,
        { params: { userId: "alice" } },
      );
      expect(refreshAttempt.status).toBe(403);
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("A5 worker-side token refresh", () => {
  it("persists rotated refresh token without container involvement", async () => {
    const nearExpiry = JSON.stringify({
      tokens: {
        access_token: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.x",
        refresh_token: "old-refresh",
      },
    });
    expect(accessTokenNeedsRefresh(JSON.parse(nearExpiry).tokens.access_token)).toBe(true);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh" }), { status: 200 }),
    );
    const { authJson, rotated } = await refreshCodexAuthJson(nearExpiry, fetchImpl as typeof fetch);
    expect(rotated).toBe(true);
    const parsed = JSON.parse(authJson) as { tokens: { refresh_token: string; access_token: string } };
    expect(parsed.tokens.refresh_token).toBe("new-refresh");
    expect(parsed.tokens.access_token).toBe("new-access");
    const stubFile = codexSubscriptionHarness.configFile({
      codingModel: "openai-subscription/gpt-5.3-codex",
      repoUrl: "https://github.com/o/r",
      task: "t",
      baseBranch: "main",
      publishPullRequest: false,
      sandboxId: "sb",
    })[0]!;
    expect(stubFile.contents).not.toContain("new-refresh");
  });
});

describe("A6 log redactor", () => {
  it("strips JWTs and token fields from logs and errors", () => {
    const log = `failed {"tokens":{"access_token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig","refresh_token":"secret"}}`;
    const redacted = redactSecrets(log);
    expect(redacted).not.toContain("eyJhbGciOi");
    expect(redacted).not.toContain("secret");
    expect(redactSecrets(new Error(log).message)).not.toContain("access_token");
  });
});

describe("A7 claude-subscription default off", () => {
  it("omits claude-subscription from catalog when flag is off", () => {
    expect(() => resolveHarness("claude-subscription", { SHIBA_CLAUDE_SUBSCRIPTION: "0" })).toThrow();
    expect(SANDBOX_HARNESS_NAMES).not.toContain("claude-subscription");
    expect(sandboxHarnessNames({ SHIBA_CLAUDE_SUBSCRIPTION: "0" })).not.toContain("claude-subscription");
  });
});

describe("A8 claude-login per-user config dir", () => {
  it("isolates CLAUDE_CONFIG_DIR per initiator", () => {
    const alice = claudeLoginConfigDir({ initiatorUserId: "alice" });
    const bob = claudeLoginConfigDir({ initiatorUserId: "bob" });
    expect(alice).not.toBe(bob);
    expect(alice).toContain("alice");
  });
});

describe("A9 disconnect API", () => {
  it("DELETE clears stored credential", async () => {
    const d1 = makeD1();
    const env = envWithD1(d1);
    await saveUserSubscriptionAuthJson(env, "alice", AUTH_JSON);
    await deleteUserSubscriptionCredential(env, "alice");
    expect((await readUserSubscriptionStatus(env, "alice")).connected).toBe(false);
    const response = await handleUserOpenAiSubscription(
      new Request("https://app.test/api/subscription/openai", { method: "DELETE" }),
      env,
    );
    expect(response?.status).toBe(401);
  });
});

describe("encrypt round-trip", () => {
  it("uses distinct ciphertext per user", async () => {
    const a = await encryptAuthJson(AUTH_JSON, KEY, "default", "alice", "openai-subscription");
    const b = await encryptAuthJson(AUTH_JSON, KEY, "default", "bob", "openai-subscription");
    expect(a).not.toBe(b);
  });
});
