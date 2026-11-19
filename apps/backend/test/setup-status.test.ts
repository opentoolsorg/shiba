import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleMeta } from "../src/meta-routes.js";
import { readSetupStatus } from "../src/setup-status.js";
import type { Connection } from "../src/model-connections.js";

function setupStatusEnv(overrides: Partial<Env> = {}): Env {
  return {
    GATEWAY_ID: "default",
    ORCHESTRATOR_MODEL: "",
    CODING_MODEL: "",
    ...overrides,
  } as Env;
}

describe("readSetupStatus mailbox signals", () => {
  it("reports mailbox binding booleans without exposing the address", async () => {
    const status = await readSetupStatus(
      setupStatusEnv({ AGENT_MAILBOX: "private@example.test", SEND_EMAIL: {} as never }),
      false,
    );

    expect(status.mailbox).toEqual({ addressOverride: true, sendEnabled: true });
    expect(JSON.stringify(status)).not.toContain("private@example.test");
  });

  it("reports default address and absent sending binding honestly", async () => {
    const status = await readSetupStatus(setupStatusEnv(), false);

    expect(status.mailbox).toEqual({ addressOverride: false, sendEnabled: false });
  });

  it("reports transactional email booleans for auth mail", async () => {
    const status = await readSetupStatus(
      setupStatusEnv({
        BETTER_AUTH_VERIFICATION_FROM: "auth@example.test",
        EMAIL_QUEUE: {} as never,
      }),
      false,
    );
    expect(status.transactionalEmail).toEqual({ senderConfigured: true, queueBound: true });
    expect(JSON.stringify(status)).not.toContain("auth@example.test");
  });
});

describe("GET /api/setup/status subscription diagnostics", () => {
  it("offers the provider fix on a fresh workspace without a gateway", async () => {
    const response = await handleMeta(new Request("https://app.test/api/setup/status", {
      headers: { "CF-Access-Authenticated-User-Email": "new@example.com" },
    }), setupStatusEnv());
    expect(response?.status).toBe(200);
    const status = await response?.json() as Awaited<ReturnType<typeof readSetupStatus>>;
    expect(status.modelRoute).toMatchObject({ ready: false, via: null, fix: { href: "/settings/?section=providers" } });
  });
  it("checks each user's ChatGPT plan without a gateway token", async () => {
    const checkedUsers: string[] = [];
    const env = setupStatusEnv({
      AGENT_HARNESS: "codex-subscription",
      CODING_MODEL: "openai-subscription/gpt-5.3-codex",
      AI_GATEWAY_TOKEN: "",
      MODEL_CREDENTIAL_KEY: "ab".repeat(32),
      ChatGptAuth: {
        idFromName: (name: string) => { checkedUsers.push(name); return name; },
        get: (id: string) => ({ fetch: async () => Response.json({ connected: id === "ada@example.com", planUsageEnabled: true }) }),
      },
    } as unknown as Partial<Env>);
    const connectedResponse = await handleMeta(new Request("https://app.test/api/setup/status", {
      headers: { "CF-Access-Authenticated-User-Email": "ada@example.com" },
    }), env);
    const connectedStatus = await connectedResponse?.json() as Awaited<ReturnType<typeof readSetupStatus>>;
    const missingResponse = await handleMeta(new Request("https://app.test/api/setup/status", {
      headers: { "CF-Access-Authenticated-User-Email": "grace@example.com" },
    }), env);
    const missingStatus = await missingResponse?.json() as Awaited<ReturnType<typeof readSetupStatus>>;

    expect(connectedResponse?.status).toBe(200);
    expect(missingResponse?.status).toBe(200);
    expect(connectedStatus.modelRoute).toMatchObject({ ready: true, via: "personal-provider" });
    expect(missingStatus.modelRoute).toMatchObject({ ready: false });
    expect(checkedUsers).toContain("ada@example.com");
    expect(checkedUsers).toContain("grace@example.com");
    expect(connectedStatus.doctor.roles.find((row) => row.role === "fixer")).toMatchObject({
      harness: "codex-subscription", ok: true,
    });
    expect(missingStatus.doctor.roles.find((row) => row.role === "fixer")).toMatchObject({
      harness: "codex-subscription", ok: false,
    });
  });

  it("checks a registered ChatGPT connection for the signed-in user", async () => {
    const connection: Connection = {
      id: "conn_chatgpt",
      owner: "deployment",
      service: "openai-subscription",
      authMode: "user-subscription",
      status: "ready",
      displayName: "ChatGPT",
      credentialRef: null,
      createdAt: 1,
      updatedAt: 1,
      lastCheckedAt: 1,
    };
    const env = setupStatusEnv({
      AI_GATEWAY_TOKEN: "",
      INTERNAL_SIGNING_KEY: "fixture-internal-key-at-least-32-characters",
      MODEL_CREDENTIAL_KEY: "ab".repeat(32),
      AGENT_TOKENS: {
        get: async () => null,
        put: async () => undefined,
        delete: async () => undefined,
        list: async () => ({ keys: [] }),
      } as unknown as KVNamespace,
      ModelConfig: {
        idFromName: () => "default",
        get: () => ({
          fetch: async (request: Request) => Response.json(
            new URL(request.url).pathname === "/connections"
              ? { connections: [connection], connectionOrder: [connection.id] }
              : { policy: { version: 0, models: {}, updatedAt: 0 } },
          ),
        }),
      },
      ChatGptAuth: {
        idFromName: (userId: string) => userId,
        get: (userId: string) => ({
          fetch: async () => Response.json({ connected: userId === "ada@example.com", planUsageEnabled: true }),
        }),
      },
    } as unknown as Partial<Env>);

    const noInitiator = await readSetupStatus(env, false);
    const connected = await readSetupStatus(env, false, "ada@example.com");
    const disconnected = await readSetupStatus(env, false, "grace@example.com");
    const fixer = (status: Awaited<ReturnType<typeof readSetupStatus>>) =>
      status.doctor.roles.find((row) => row.role === "fixer");

    expect(fixer(noInitiator)).toMatchObject({
      connectionId: connection.id, ok: false, message: expect.stringMatching(/signed-in user/),
    });
    expect(fixer(connected)).toMatchObject({ connectionId: connection.id, ok: true });
    expect(fixer(disconnected)).toMatchObject({
      connectionId: connection.id, ok: false, message: expect.stringMatching(/Connect this provider in Settings/),
    });
    expect(connected.modelRoute).toMatchObject({ ready: true, via: "connection" });
    expect(disconnected.modelRoute).toMatchObject({ ready: false });
    expect(noInitiator.modelRoute).toMatchObject({ ready: false });
    expect(connected.doctor.ok).toBe(true);
    expect(disconnected.doctor.ok).toBe(false);
  });
});

describe("readSetupStatus SSO diagnostics", () => {
  const authSecret = "private-auth-secret-".padEnd(40, "x");
  const oidc = { SHIBA_SSO_ENABLED: "1", SSO_OIDC_CLIENT_ID: "private-client-id", SSO_OIDC_CLIENT_SECRET: "private-client-secret" };

  it("does not report SSO ready when the auth lane cannot mount it", async () => {
    const status = await readSetupStatus(setupStatusEnv({ ...oidc, SSO_OIDC_ISSUER: "https://identity.example.test", AGENT_AUDIT: {} as never }), false);
    expect(status.sso).toMatchObject({ enabled: false, missing: ["BETTER_AUTH_SECRET"] });
    const finding = status.doctor.findings.find(row => row.id === "sso.config");
    expect(finding).toMatchObject({ severity: "warn", message: expect.stringContaining("BETTER_AUTH_SECRET") });
    const short = await readSetupStatus(setupStatusEnv({ ...oidc, SSO_OIDC_ISSUER: "https://identity.example.test",
      BETTER_AUTH_SECRET: "too-short-secret", AGENT_AUDIT: {} as never }), false);
    expect(short.sso).toMatchObject({ enabled: false, missing: ["BETTER_AUTH_SECRET"] });
    expect(JSON.stringify(short)).not.toContain("too-short-secret");
  });

  it("reports the Google Workspace preset as ready by setting name", async () => {
    const status = await readSetupStatus(setupStatusEnv({ ...oidc, SSO_OIDC_PRESET: "google-workspace",
      BETTER_AUTH_SECRET: authSecret, AGENT_AUDIT: {} as never }), false);
    expect(status.sso).toEqual({ enabled: true,
      configured: ["SSO_OIDC_PRESET", "SSO_OIDC_CLIENT_ID", "SSO_OIDC_CLIENT_SECRET", "BETTER_AUTH_SECRET", "AGENT_AUDIT"],
      missing: [], conflicting: [] });
    expect(status.doctor.findings.find(row => row.id === "sso.config")).toMatchObject({
      severity: "ok", message: expect.stringContaining("google-workspace") });
    for (const value of [authSecret, "private-client-id", "private-client-secret"]) expect(JSON.stringify(status)).not.toContain(value);
  });

  it("reports a preset and a different explicit issuer as conflicting", async () => {
    const status = await readSetupStatus(setupStatusEnv({ ...oidc, SSO_OIDC_PRESET: "google-workspace",
      SSO_OIDC_ISSUER: "https://identity.example.test", BETTER_AUTH_SECRET: authSecret, AGENT_AUDIT: {} as never }), false);
    expect(status.sso).toMatchObject({ enabled: false, missing: [], conflicting: ["SSO_OIDC_PRESET", "SSO_OIDC_ISSUER"],
      configured: ["SSO_OIDC_CLIENT_ID", "SSO_OIDC_CLIENT_SECRET", "BETTER_AUTH_SECRET", "AGENT_AUDIT"] });
    expect(status.doctor.findings.find(row => row.id === "sso.config")).toMatchObject({
      severity: "warn", message: expect.stringContaining("Conflicting: SSO_OIDC_PRESET, SSO_OIDC_ISSUER") });
    expect(JSON.stringify(status)).not.toContain("identity.example.test");
  });

  it("keeps SSO disabled by default", async () => {
    const status = await readSetupStatus(setupStatusEnv(), false);
    expect(status.sso.enabled).toBe(false);
    expect(status.doctor.findings.some(row => row.id === "sso.config")).toBe(false);
  });

  it("reports missing setting names when SSO is requested", async () => {
    const status = await readSetupStatus(setupStatusEnv({ SHIBA_SSO_ENABLED: "1", SSO_OIDC_ISSUER: "https://identity.example.test" }), false);
    expect(status.sso).toMatchObject({ enabled: false,
      configured: ["SSO_OIDC_ISSUER"],
      missing: expect.arrayContaining(["SSO_OIDC_CLIENT_ID", "SSO_OIDC_CLIENT_SECRET"]),
    });
    expect(status.doctor.findings.find(row => row.id === "sso.config")).toMatchObject({
      severity: "warn", message: expect.stringContaining("SSO_OIDC_CLIENT_SECRET"),
    });
  });

  it("reports configured setting names without identity provider values", async () => {
    const configured = {
      SHIBA_SSO_ENABLED: "1", SSO_OIDC_ISSUER: "https://identity.example.test",
      SSO_OIDC_CLIENT_ID: "private-client-id", SSO_OIDC_CLIENT_SECRET: "private-client-secret",
      SSO_ALLOWED_DOMAINS: "example.test",
    };
    const status = await readSetupStatus(setupStatusEnv({ ...configured, BETTER_AUTH_SECRET: authSecret, AGENT_AUDIT: {} as never }), false);
    expect(status.sso).toEqual({ enabled: true,
      configured: ["SSO_OIDC_ISSUER", "SSO_OIDC_CLIENT_ID", "SSO_OIDC_CLIENT_SECRET", "BETTER_AUTH_SECRET", "AGENT_AUDIT"],
      missing: [], conflicting: [],
    });
    expect(JSON.stringify(status)).not.toContain(authSecret);
    expect(status.doctor.findings.find(row => row.id === "sso.config")).toMatchObject({ severity: "ok" });
    for (const name of ["SSO_OIDC_ISSUER", "SSO_OIDC_CLIENT_ID", "SSO_OIDC_CLIENT_SECRET"] as const) {
      expect(JSON.stringify(status)).not.toContain(configured[name]);
    }
  });
});
