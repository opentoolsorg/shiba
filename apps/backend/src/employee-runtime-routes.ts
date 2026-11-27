import {
  employeeRuntimeCancelSchema,
  verifyStandinEnabled,
  employeeRuntimeChatRequestSchema,
  employeeRuntimeConversationRequestSchema,
  employeeRuntimeMemoryDeleteSchema,
  employeeRuntimeMemoryUpdateSchema,
  employeeRuntimeMemoryWriteSchema,
  employeeRuntimeRecoveryRequestSchema,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { getCustomAgentById } from "./custom-agents-store.js";
import { employeeRuntimeStub } from "./employee-runtime-do.js";
import type { ResolvedOrgAuth } from "./org-request-auth.js";
import { resolveUserId } from "./request-auth.js";
import { resolveEmployeeAccess } from "./governance/employee-access.js";

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
async function forwardConversation(response: Response, extra?: Record<string, unknown>): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.delete("content-length");
  try {
    const decoded = decodeConversations(await response.json());
    const body = extra && decoded && typeof decoded === "object" && !Array.isArray(decoded) ? { ...decoded, ...extra } : decoded;
    return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers });
  } catch {
    return new Response(null, { status: response.status, statusText: response.statusText, headers });
  }
}

function forwardStreamConversations(response: Response): Response {
  if (!response.body) return response;
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let pending = "";
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const events = pending.split("\n\n");
      pending = events.pop() ?? "";
      for (const event of events) {
        if (!event.startsWith("data: ")) { controller.enqueue(encoder.encode(`${event}\n\n`)); continue; }
        try {
          const decoded = decodeConversations(JSON.parse(event.slice(6)));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(decoded)}\n\n`));
        } catch {
          controller.enqueue(encoder.encode(`${event}\n\n`));
        }
      }
    },
    flush(controller) {
      if (pending) controller.enqueue(encoder.encode(pending));
    },
  });
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.delete("content-length");
  return new Response(response.body.pipeThrough(transform), { status: response.status, statusText: response.statusText, headers });
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

async function runtimeToolActorId(request: Request, env: Env, auth: ResolvedOrgAuth): Promise<string | null> {
  if (auth.principal) return auth.principal.principal;
  if (auth.workspace) return auth.workspace.userId;
  return await resolveUserId(request, env);
}

async function canManageEmployee(env: Env, auth: ResolvedOrgAuth, employeeId: string): Promise<boolean> {
  if (!auth.workspace) return true;
  const userId = auth.principal?.principal ?? auth.workspace.userId;
  return await resolveEmployeeAccess(env, auth.workspace.workspaceId, employeeId, userId) === "manage";
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
  if (agent.archivedAt && !["state", "memory-search", "clear"].includes(action)) return json({ ok: false, error: "employee_archived" }, { status: 409 });
  const stub = employeeRuntimeStub(env, orgId, agent.id);
  const internal = `https://internal/internal/employee-runtime${action === "state" ? "/state" : action === "memory" ? "/memory" : action === "memory-update" ? "/memory/update" : action === "memory-delete" ? "/memory/delete" : action === "memory-search" ? "/memory/search" : action === "cancel" ? "/cancel" : action === "clear" ? "/clear" : action === "recover" ? "/recover" : action === "chat-stream" ? "/chat/stream" : "/chat"}`;
  const manager = await canManageEmployee(env, auth, agent.id);
  const toolActorId = await runtimeToolActorId(request, env, auth);
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
    const incoming = new URL(request.url);
    const conversationId = incoming.searchParams.get("conversationId") ?? "default";
    const storageId = await scopedConversationId(actorIdentity, conversationId);
    url.searchParams.set("conversationId", storageId);
    for (const key of ["memoryLimit", "memoryOffset"]) {
      const value = incoming.searchParams.get(key);
      if (value) url.searchParams.set(key, value);
    }
    return forwardConversation(await stub.fetch(url), { permissions: { canRecover: manager && !agent.archivedAt } });
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

  if (action === "chat" || action === "chat-stream") {
    // Team inference must go through the exact funded team-model turn lane until
    // EmployeeRuntime implements the same grant/budget contract. Verification
    // standin remains available because it performs no deployment inference.
    if (orgId.startsWith("team:") && !verifyStandinEnabled(env)) {
      return json({ ok: false, error: "employee_runtime_funding_required" }, { status: 403 });
    }
    const parsed = employeeRuntimeChatRequestSchema.safeParse(body);
    if (!parsed.success) return json({ ok: false, error: "invalid_body" }, { status: 400 });
    const storageId = await scopedConversationId(actorIdentity, parsed.data.conversationId);
    const streamed = await stub.fetch(internal, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...parsed.data, conversationId: storageId, profile, ...(toolActorId ? { toolActorId } : {}) }),
    });
    return action === "chat-stream" ? forwardStreamConversations(streamed) : forwardConversation(streamed);
  }

  if (action === "clear") {
    const parsed = employeeRuntimeConversationRequestSchema.safeParse(body);
    if (!parsed.success) return json({ ok: false, error: "invalid_body" }, { status: 400 });
    const storageId = await scopedConversationId(actorIdentity, parsed.data.conversationId);
    const response = await stub.fetch(internal, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: storageId }),
    });
    return forwardConversation(response);
  }

  if (action === "memory") {
    const parsed = employeeRuntimeMemoryWriteSchema.safeParse(body);
    if (!parsed.success) return json({ ok: false, error: "invalid_body" }, { status: 400 });
    if (parsed.data.scope === "employee" && !manager) return json({ ok: false, error: "employee_memory_manage_required" }, { status: 403 });
    const storageId = parsed.data.conversationId ? await scopedConversationId(actorIdentity, parsed.data.conversationId) : null;
    const memoryBody = { ...(storageId && parsed.data.conversationId ? { ...parsed.data, conversationId: storageId } : parsed.data), manager };
    const response = await stub.fetch(internal, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(memoryBody),
    });
    return storageId ? forwardConversation(response) : forward(response);
  }

  if (action === "memory-update" || action === "memory-delete") {
    const schema = action === "memory-update" ? employeeRuntimeMemoryUpdateSchema : employeeRuntimeMemoryDeleteSchema;
    const parsed = schema.safeParse(body);
    if (!parsed.success) return json({ ok: false, error: "invalid_body" }, { status: 400 });
    const forwarded = parsed.data.conversationId
      ? { ...parsed.data, conversationId: await scopedConversationId(actorIdentity, parsed.data.conversationId) }
      : parsed.data;
    return forwardConversation(await stub.fetch(internal, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...forwarded, manager }),
    }));
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
    const parsed = employeeRuntimeRecoveryRequestSchema.safeParse(body);
    if (!parsed.success) return json({ ok: false, error: "invalid_body" }, { status: 400 });
    const recoveryBody = parsed.data.conversationId ? { conversationId: await scopedConversationId(actorIdentity, parsed.data.conversationId) } : {};
    return forwardConversation(await stub.fetch(internal, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(recoveryBody),
    }));
  }

  return json({ ok: false, error: "not_found" }, { status: 404 });
}
