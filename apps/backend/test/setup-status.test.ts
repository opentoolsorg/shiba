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
      connectionId: connection.id, ok: false, message: expect.stringMatching(/no authenticated account/),
    });
    expect(connected.doctor.ok).toBe(true);
    expect(disconnected.doctor.ok).toBe(false);
  });
});
