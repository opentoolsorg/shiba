import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ dashboard: false }));
const actorState = vi.hoisted(() => ({ principal: "employee-mail-reader" }));
vi.mock("../src/request-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/request-auth.js")>();
  return {
    ...actual,
    isAuthorizedRequest: vi.fn(async () => authState.dashboard),
    resolveUserId: vi.fn(async () => "owner@example.test"),
  };
});
vi.mock("../src/v1-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/v1-auth.js")>();
  return { ...actual, authorizeV1Request: vi.fn(async () => null) };
});
vi.mock("../src/gmail-routes.js", () => ({
  gmailOwner: async () => '["better-auth","stable-owner-id"]',
}));

import type { Env } from "../src/env.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { createEmployeeRunTools } from "../src/employee-run-tools.js";
import { ensureGmailSchema, encryptGmailToken, GMAIL_SCOPE } from "../src/gmail.js";
import { handleEmployeeTools } from "../src/employee-tool-routes.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const OWNER = '["better-auth","stable-owner-id"]';
const TOKEN_KEY = "b2".repeat(32);
const CONNECTION_ID = "gmail-connection-1";
const MESSAGE_ID = "selected-message-42";

function makeEnv(): Env {
  return {
    AGENT_AUDIT: customAgentD1().database,
    CodingOrchestrator: {},
    GMAIL_CLIENT_ID: "mock-client",
    GMAIL_CLIENT_SECRET: "mock-secret",
    GMAIL_REDIRECT_URI: "https://shiba.test/api/connections/gmail/callback",
    GMAIL_TOKEN_KEY: TOKEN_KEY,
  } as unknown as Env;
}

function policyRequest(employeeId: string, resourcesByCapability: Record<string, string[]>, expectedVersion = 1) {
  return new Request(`https://shiba.test/api/employee-tools/${employeeId}/policy`, {
    method: "PUT",
    headers: { origin: "https://shiba.test", "content-type": "application/json" },
    body: JSON.stringify({
      expectedVersion,
      actorId: actorState.principal,
      role: "operator",
      resourcesByCapability,
    }),
  });
}

function gmailProviderMock() {
  const calls: URL[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url);
    if (url.href === "https://oauth2.googleapis.com/token") {
      expect(init?.method).toBe("POST");
      const params = new URLSearchParams(init?.body as URLSearchParams);
      expect(params.get("refresh_token")).toBe("mock-refresh-token");
      return Response.json({
        access_token: "mock-access-token",
        token_type: "Bearer",
        scope: GMAIL_SCOPE,
      });
    }
    expect(url.origin).toBe("https://gmail.googleapis.com");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mock-access-token");
    if (url.pathname === `/gmail/v1/users/me/messages/${MESSAGE_ID}`) {
      return Response.json({
        id: MESSAGE_ID,
        threadId: "thread-42",
        snippet: "Selected message snippet",
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "Subject", value: "Approved message" }],
          body: { data: Buffer.from("The exact selected message body.").toString("base64url") },
        },
      });
    }
    throw new Error(`Unexpected mocked provider URL: ${url.href}`);
  });
  return { calls, fetchMock };
}

async function seedSelectedMessage(env: Env): Promise<void> {
  await ensureGmailSchema(env);
  const refreshCipher = await encryptGmailToken("mock-refresh-token", TOKEN_KEY, OWNER, CONNECTION_ID);
  await env.AGENT_AUDIT.prepare(`INSERT INTO gmail_connections
    (id, owner, email, refresh_cipher, created_at, active) VALUES (?, ?, ?, ?, ?, 1)`)
    .bind(CONNECTION_ID, OWNER, "owner@example.test", refreshCipher, Date.now()).run();
  await env.AGENT_AUDIT.prepare(`INSERT INTO gmail_resource_candidates
    (owner, connection_id, message_id, thread_id, sender, subject, date, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(OWNER, CONNECTION_ID, MESSAGE_ID, "thread-42", "sender@example.test", "Approved message", "2030-01-01", Date.now() + 600_000).run();
}

describe("employee-run Gmail selected-resource policy", () => {
  beforeEach(() => {
    authState.dashboard = false;
    actorState.principal = "employee-mail-reader";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads only a discovered message, denies unselected IDs, and rechecks a revoked grant", async () => {
    const env = makeEnv();
    await seedSelectedMessage(env);
    const provider = gmailProviderMock();
    vi.stubGlobal("fetch", provider.fetchMock);

    authState.dashboard = true;
    const employee = await createCustomAgent(env, "self-hosted", "owner@example.test", {
      name: "Mail reviewer",
      instructions: "Read only an owner-selected message.",
      harness: "opencode",
    });
    const capability = "mcp:shiba:gmail_read";
    const configured = await handleEmployeeTools(
      policyRequest(employee.id, { [capability]: [MESSAGE_ID] }),
      env,
    );
    expect(configured?.status).toBe(200);
    expect(await configured?.json()).toMatchObject({
      employeeVersion: 2,
      toolScopes: [capability],
    });
    authState.dashboard = false;

    const tools = createEmployeeRunTools(
      env,
      () => employee.id,
      () => "web:owner:mail-review-session",
      () => "self-hosted",
      () => actorState.principal,
    );
    const catalog = tools.employee_tool_catalog as unknown as {
      execute: (input: Record<string, never>) => Promise<{ actions: Array<{ tool: string; resources: string[] }> }>;
    };
    const call = tools.employee_tool_call as unknown as {
      execute: (input: { tool: string; args: Record<string, unknown> }) => Promise<{ result: { content: Array<{ text: string }> } }>;
    };
    expect(await catalog.execute({})).toMatchObject({
      actions: [{ tool: "gmail_read", resources: [MESSAGE_ID] }],
    });

    const selected = await call.execute({ tool: "gmail_read", args: { messageIds: [MESSAGE_ID] } });
    expect(selected.result.content[0]?.text).toContain("UNTRUSTED");
    expect(selected.result.content[0]?.text).toContain("The exact selected message body.");
    const messageReads = () => provider.calls.filter((url) => url.pathname.endsWith(`/messages/${MESSAGE_ID}`)).length;
    const successfulReads = messageReads();
    expect(successfulReads).toBe(1);

    await expect(call.execute({ tool: "gmail_read", args: { messageIds: ["not-selected-7"] } }))
      .rejects.toThrow("employee_connection_or_resource_grant_missing");
    expect(messageReads()).toBe(successfulReads);

    // Simulate an administrator revoking the selected resource after tool
    // discovery. The normal run tool recomputes policy before dispatch.
    await env.AGENT_AUDIT.prepare(`UPDATE employee_tool_grants SET lifecycle = 'revoked'
      WHERE employee_id = ? AND employee_version = 2 AND capability_id = ? AND resource_id = ?`)
      .bind(employee.id, capability, MESSAGE_ID).run();
    expect(await catalog.execute({})).toMatchObject({ actions: [] });
    await expect(call.execute({ tool: "gmail_read", args: { messageIds: [MESSAGE_ID] } }))
      .rejects.toThrow("unavailable under the current policy");
    expect(messageReads()).toBe(successfulReads);

    const contactedHosts = [...new Set(provider.calls.map((url) => url.host))].sort();
    expect(contactedHosts).toEqual(["gmail.googleapis.com", "oauth2.googleapis.com"]);
  });
});
