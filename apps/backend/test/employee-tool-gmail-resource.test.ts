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
import { handleEmployeeDraftRequest, type EmployeeDraft, type EmployeeDraftStore, type EmployeeReadReceipt } from "../src/employee-drafts.js";
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

  it("reads a selected message, retains a reviewable immutable internal draft, and rechecks revoked grants", async () => {
    const env = makeEnv();
    let retained: { reads: EmployeeReadReceipt[]; drafts: EmployeeDraft[] } = { reads: [], drafts: [] };
    const draftStore: EmployeeDraftStore = {
      getReadReceipt: (id) => retained.reads.find((receipt) => receipt.id === id) ?? null,
      saveReadReceipt: (receipt) => { retained.reads.push(structuredClone(receipt)); },
      getDraft: (id) => retained.drafts.find((draft) => draft.id === id) ?? null,
      listDrafts: () => retained.drafts,
      saveDraft: (draft) => { retained.drafts = [...retained.drafts.filter((item) => item.id !== draft.id), structuredClone(draft)]; },
    };
    const objects = new Map<string, string>();
    const put = vi.fn(async (key: string, body: string) => { objects.set(key, body); return { key }; });
    env.ATTACHMENTS = { put, get: async (key: string) => {
      const body = objects.get(key);
      if (body === undefined) return null;
      const bytes = new TextEncoder().encode(body);
      return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
    } } as unknown as R2Bucket;
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
      () => "web:employee-mail-reader:11111111-1111-4111-8111-111111111111",
      () => "self-hosted",
      () => actorState.principal,
      draftStore,
    );
    const catalog = tools.employee_tool_catalog as unknown as {
      execute: (input: Record<string, never>) => Promise<{ actions: Array<{ tool: string; resources: string[] }> }>;
    };
    const call = tools.employee_tool_call as unknown as {
      execute: (input: { tool: string; args: Record<string, unknown> }, options?: { toolCallId: string }) => Promise<{ sourceReadId: string; result: { content: Array<{ text: string }> } }>;
    };
    const retain = tools.employee_retain_draft as unknown as {
      execute: (input: { path: string; content: string; sourceReadId: string }, options: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<{ status: string; draft: EmployeeDraft; downloadUrl: string }>;
    };
    expect(await catalog.execute({})).toMatchObject({
      actions: [{ tool: "gmail_read", resources: [MESSAGE_ID] }],
    });

    const selected = await call.execute({ tool: "gmail_read", args: { messageIds: [MESSAGE_ID] } }, { toolCallId: "read-call-1" });
    expect(selected.result.content[0]?.text).toContain("UNTRUSTED");
    expect(selected.result.content[0]?.text).toContain("The exact selected message body.");
    const messageReads = () => provider.calls.filter((url) => url.pathname.endsWith(`/messages/${MESSAGE_ID}`)).length;
    const successfulReads = messageReads();
    expect(successfulReads).toBe(1);

    const input = { path: "reply.md", content: "# Internal reply\nExact résumé draft.\n", sourceReadId: selected.sourceReadId };
    const saved = await retain.execute(input, { toolCallId: "draft-call-1" });
    expect(saved).toMatchObject({ status: "pending_review", draft: {
      actorId: actorState.principal, employeeId: employee.id, employeeVersion: 2,
      deliverable: { version: 1, review: { status: "pending_review", revision: 0 }, provenance: { customAgent: { id: employee.id, version: 2 } } },
      source: { tool: "gmail_read", toolVersion: 1, policyVersion: "1", sourceMessageIds: [MESSAGE_ID], untrusted: true, resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    } });
    expect(JSON.stringify(saved)).not.toContain(input.content);
    expect(saved.downloadUrl).toBe(`/api/employee-drafts/${saved.draft.id}/download?session=11111111-1111-4111-8111-111111111111`);
    expect(await retain.execute(input, { toolCallId: "draft-call-1" })).toEqual(saved);
    expect(put).toHaveBeenCalledTimes(1);
    await expect(retain.execute({ ...input, content: "Changed bytes" }, { toolCallId: "draft-call-1" })).rejects.toThrow("payload changed");
    await expect(retain.execute({ ...input, sourceReadId: `read_${"0".repeat(64)}` }, { toolCallId: "forged-source" })).rejects.toThrow("Read the selected source");
    const assertedApproval = { ...input, review: { status: "approved" } };
    await expect(retain.execute(assertedApproval, { toolCallId: "asserted-approval" })).rejects.toThrow();
    const anotherSession = createEmployeeRunTools(env, () => employee.id,
      () => "web:employee-mail-reader:22222222-2222-4222-8222-222222222222", () => "self-hosted", () => actorState.principal, draftStore)
      .employee_retain_draft as unknown as typeof retain;
    await expect(anotherSession.execute(input, { toolCallId: "other-session" })).rejects.toThrow("Read the selected source");

    // Rehydrate the DO metadata independently of the private object bytes.
    retained = JSON.parse(JSON.stringify(retained));
    const owner = { orgId: "self-hosted", actorId: actorState.principal, executionContextId: "web:employee-mail-reader:11111111-1111-4111-8111-111111111111" };
    const download = await handleEmployeeDraftRequest(new Request(`https://shiba.test${saved.downloadUrl}`), env, draftStore, owner);
    expect(download?.status).toBe(200);
    expect(await download?.text()).toBe(input.content);
    expect(download?.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await handleEmployeeDraftRequest(new Request(`https://shiba.test${saved.downloadUrl}`), env, draftStore, { ...owner, actorId: "another-owner" }))?.status).toBe(404);
    expect((await handleEmployeeDraftRequest(new Request(`https://shiba.test${saved.downloadUrl}`), env, draftStore, { ...owner, executionContextId: "another-session" }))?.status).toBe(404);
    expect((await handleEmployeeDraftRequest(new Request(`https://shiba.test${saved.downloadUrl}`), env, draftStore, { ...owner, orgId: "another-org" }))?.status).toBe(404);
    const review = () => handleEmployeeDraftRequest(new Request(`https://shiba.test/api/employee-drafts/${saved.draft.id}/review`, {
      method: "POST", body: JSON.stringify({ status: "approved", expectedRevision: 0 }),
    }), env, draftStore, owner);
    expect((await review())?.status).toBe(200);
    expect((await review())?.status).toBe(409);
    expect(draftStore.getDraft(saved.draft.id)?.deliverable.review).toMatchObject({ status: "approved", revision: 1 });
    expect([...objects.values()]).toEqual([input.content]);
    const objectKey = [...objects.keys()][0];
    if (!objectKey) throw new Error("Draft body not stored.");
    objects.set(objectKey, "x".repeat(new TextEncoder().encode(input.content).byteLength));
    expect((await handleEmployeeDraftRequest(new Request(`https://shiba.test${saved.downloadUrl}`), env, draftStore, owner))?.status).toBe(409);
    objects.set(objectKey, input.content);
    const stopped = new AbortController();
    stopped.abort();
    await expect(retain.execute(input, { toolCallId: "stopped-before-write", abortSignal: stopped.signal })).rejects.toThrow();
    expect(put).toHaveBeenCalledTimes(1);
    const stoppedAfterWrite = new AbortController();
    put.mockImplementationOnce(async (key: string, body: string) => {
      objects.set(key, body); stoppedAfterWrite.abort(); return { key };
    });
    await expect(retain.execute(input, { toolCallId: "stopped-after-write", abortSignal: stoppedAfterWrite.signal })).rejects.toThrow();
    expect(retained.drafts).toHaveLength(1);
    retained.drafts.push(...Array.from({ length: 49 }, (_, index) => ({ ...saved.draft, id: `capacity-${index}` })));
    await expect(retain.execute(input, { toolCallId: "over-capacity" })).rejects.toThrow("retained draft limit");
    expect(put).toHaveBeenCalledTimes(2);
    const atCapacityReview = await handleEmployeeDraftRequest(new Request(`https://shiba.test/api/employee-drafts/${saved.draft.id}/review`, {
      method: "POST", body: JSON.stringify({ status: "changes_requested", expectedRevision: 1, note: "Revise salutation." }),
    }), env, draftStore, owner);
    expect(atCapacityReview?.status).toBe(200);
    expect(retained.drafts).toHaveLength(50);
    expect(await retain.execute(input, { toolCallId: "draft-call-1" })).toMatchObject({
      status: "changes_requested", draft: { deliverable: { review: { status: "changes_requested", revision: 2 } } },
    });
    expect(put).toHaveBeenCalledTimes(2);
    expect(messageReads()).toBe(successfulReads);

    await expect(call.execute({ tool: "gmail_read", args: { messageIds: ["not-selected-7"] } }))
      .rejects.toThrow("employee_connection_or_resource_grant_missing");
    expect(messageReads()).toBe(successfulReads);

    // Simulate an administrator revoking the selected resource after tool
    // discovery. The normal run tool recomputes policy before dispatch.
    await env.AGENT_AUDIT.prepare(`UPDATE employee_tool_grants SET lifecycle = 'revoked'
      WHERE employee_id = ? AND employee_version = 2 AND capability_id = ? AND resource_id = ?`)
      .bind(employee.id, capability, MESSAGE_ID).run();
    expect(await catalog.execute({})).toMatchObject({ actions: [] });
    await expect(retain.execute(input, { toolCallId: "after-revoke" })).rejects.toThrow("revoked or changed");
    expect(put).toHaveBeenCalledTimes(2);
    await expect(call.execute({ tool: "gmail_read", args: { messageIds: [MESSAGE_ID] } }))
      .rejects.toThrow("unavailable under the current policy");
    expect(messageReads()).toBe(successfulReads);

    const contactedHosts = [...new Set(provider.calls.map((url) => url.host))].sort();
    expect(contactedHosts).toEqual(["gmail.googleapis.com", "oauth2.googleapis.com"]);
  });
});
