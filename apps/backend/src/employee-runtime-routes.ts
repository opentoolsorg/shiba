import {
  employeeRuntimeCancelSchema,
  verifyStandinEnabled,
  employeeRuntimeChatRequestSchema,
  employeeRuntimeMemoryWriteSchema,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { getCustomAgentById } from "./custom-agents-store.js";
import { employeeRuntimeStub } from "./employee-runtime-do.js";
import type { ResolvedOrgAuth } from "./org-request-auth.js";
import { resolveUserId } from "./request-auth.js";

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: { "Cache-Control": "no-store", ...(init?.headers ?? {}) },
  });
}

async function parseJson(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "invalid_body" }, { status: 400 });
    return body as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
}

function forward(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function base64UrlDecode(value: string): string | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch { return null; }
}
function decodeStorageConversationId(value: string): string | null {
  const match = /^u_[a-f0-9]{32}_([A-Za-z0-9_-]+)$/.exec(value);
  return match ? base64UrlDecode(match[1]!) : null;
}
function decodeConversations(value: unknown): unknown {
  if (typeof value === "string") return decodeStorageConversationId(value) ?? value;
  if (Array.isArray(value)) return value.map(decodeConversations);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeConversations(entry)]));
  return value;
}
/** Internal storage keys must never become client conversation ids, and JSON stays valid for arbitrary client ids. */
async function forwardConversation(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.delete("content-length");
  try {
    return new Response(JSON.stringify(decodeConversations(await response.json())), { status: response.status, statusText: response.statusText, headers });
  } catch {
    return new Response(null, { status: response.status, statusText: response.statusText, headers });
  }
}

async function sha256Hex32(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function runtimeActorIdentity(request: Request, env: Env, auth: ResolvedOrgAuth): Promise<string> {
  if (auth.principal) return `api:${auth.principal.apiKey?.keyId ?? auth.principal.principal}`;
  if (auth.workspace) return `user:${auth.workspace.userId}`;
  const userId = await resolveUserId(request, env);
  return userId ? `user:${userId}` : "local:dashboard-owner";
}

/** Server-derived private conversation key: stable for the actor, but leaks neither identity nor client naming. */
async function scopedConversationId(actorIdentity: string, conversationId: string): Promise<string> {
  const actorHash = await sha256Hex32(actorIdentity);
  return `u_${actorHash}_${base64UrlEncode(conversationId)}`;
}

/**
 * Authenticated Worker adapter for the employee runtime DO. The profile is
 * loaded from the owning D1 store here; callers cannot invent identity,
 * version, instructions, or permissions. Harness and execution-provider
 * selection remain out of this envelope because they are optional lanes.
 */
export async function handleEmployeeRuntimeRequest(
  request: Request,
  env: Env,
  auth: ResolvedOrgAuth,
  agentId: string,
  action: string,
): Promise<Response> {
  const orgId = auth.orgId;
  const actorIdentity = await runtimeActorIdentity(request, env, auth);
  if (!env.EmployeeRuntime) return json({ ok: false, error: "employee_runtime_unavailable" }, { status: 503 });
  const agent = await getCustomAgentById(env, orgId, agentId, { includeArchived: true });
  if (!agent) return json({ ok: false, error: "not_found" }, { status: 404 });
  if (agent.archivedAt && !["state", "memory-search"].includes(action)) return json({ ok: false, error: "employee_archived" }, { status: 409 });
  const stub = employeeRuntimeStub(env, orgId, agent.id);
  const internal = `https://internal/internal/employee-runtime${action === "state" ? "/state" : action === "memory" ? "/memory" : action === "memory-search" ? "/memory/search" : action === "cancel" ? "/cancel" : action === "recover" ? "/recover" : "/chat"}`;
  const runtimeModel = agent.config.model;
  const profile = {
    orgId,
    employeeId: agent.id,
    employeeVersion: agent.version,
    name: agent.config.name,
    ...(agent.config.title ? { role: agent.config.title } : {}),
    instructions: agent.config.instructions ?? "",
    ...(runtimeModel ? { model: runtimeModel } : {}),
  };

  if (action === "state") {
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, { status: 405 });
    const url = new URL(internal);
    const conversationId = new URL(request.url).searchParams.get("conversationId") ?? "default";
    const storageId = await scopedConversationId(actorIdentity, conversationId);
    url.searchParams.set("conversationId", storageId);
    return forwardConversation(await stub.fetch(url));
  }

  if (action === "memory-search") {
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, { status: 405 });
    const incoming = new URL(request.url);
    const url = new URL(internal);
    const query = incoming.searchParams.get("q");
    if (query) url.searchParams.set("q", query);
    const conversationId = incoming.searchParams.get("conversationId");
    const storageId = conversationId ? await scopedConversationId(actorIdentity, conversationId) : null;
    if (conversationId && storageId) url.searchParams.set("conversationId", storageId);
    const response = await stub.fetch(url);
    return storageId ? forwardConversation(response) : forward(response);
  }

  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  const body = await parseJson(request);
  if (body instanceof Response) return body;

  if (action === "chat") {
    // Team inference must go through the exact funded team-model turn lane until
    // EmployeeRuntime implements the same grant/budget contract. Verification
    // standin remains available because it performs no deployment inference.
    if (orgId.startsWith("team:") && !verifyStandinEnabled(env)) {
      return json({ ok: false, error: "employee_runtime_funding_required" }, { status: 403 });
    }
    const parsed = employeeRuntimeChatRequestSchema.safeParse(body);
    if (!parsed.success) return json({ ok: false, error: "invalid_body" }, { status: 400 });
    const storageId = await scopedConversationId(actorIdentity, parsed.data.conversationId);
    return forwardConversation(await stub.fetch(internal, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...parsed.data, conversationId: storageId, profile }),
    }));
  }

  if (action === "memory") {
    const parsed = employeeRuntimeMemoryWriteSchema.safeParse(body);
    if (!parsed.success) return json({ ok: false, error: "invalid_body" }, { status: 400 });
    const storageId = parsed.data.conversationId ? await scopedConversationId(actorIdentity, parsed.data.conversationId) : null;
    const memoryBody = storageId && parsed.data.conversationId ? { ...parsed.data, conversationId: storageId } : parsed.data;
    const response = await stub.fetch(internal, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(memoryBody),
    });
    return storageId ? forwardConversation(response) : forward(response);
  }

  if (action === "cancel") {
    const parsed = employeeRuntimeCancelSchema.safeParse(body);
    if (!parsed.success) return json({ ok: false, error: "invalid_body" }, { status: 400 });
    const storageId = await scopedConversationId(actorIdentity, parsed.data.conversationId);
    return forwardConversation(await stub.fetch(internal, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...parsed.data, conversationId: storageId }),
    }));
  }

  if (action === "recover") {
    return forward(await stub.fetch(internal, { method: "POST", body: "{}" }));
  }

  return json({ ok: false, error: "not_found" }, { status: 404 });
}
