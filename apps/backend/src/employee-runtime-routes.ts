import {
  employeeRuntimeCancelSchema,
  employeeRuntimeChatRequestSchema,
  employeeRuntimeMemoryWriteSchema,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { getCustomAgentById } from "./custom-agents-store.js";
import { employeeRuntimeStub } from "./employee-runtime-do.js";

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

/**
 * Authenticated Worker adapter for the employee runtime DO. The profile is
 * loaded from the owning D1 store here; callers cannot invent identity,
 * version, instructions, or permissions. Harness and execution-provider
 * selection remain out of this envelope because they are optional lanes.
 */
export async function handleEmployeeRuntimeRequest(
  request: Request,
  env: Env,
  orgId: string,
  agentId: string,
  action: string,
): Promise<Response> {
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
    const conversationId = new URL(request.url).searchParams.get("conversationId");
    if (conversationId) url.searchParams.set("conversationId", conversationId);
    return forward(await stub.fetch(url));
  }

  if (action === "memory-search") {
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, { status: 405 });
    const incoming = new URL(request.url);
    const url = new URL(internal);
    for (const key of ["q", "conversationId"]) {
      const value = incoming.searchParams.get(key);
      if (value) url.searchParams.set(key, value);
    }
    return forward(await stub.fetch(url));
  }

  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  const body = await parseJson(request);
  if (body instanceof Response) return body;

  if (action === "chat") {
    const parsed = employeeRuntimeChatRequestSchema.safeParse(body);
    if (!parsed.success) return json({ ok: false, error: "invalid_body" }, { status: 400 });
    return forward(await stub.fetch(internal, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...parsed.data, profile }),
    }));
  }

  if (action === "memory") {
    const parsed = employeeRuntimeMemoryWriteSchema.safeParse(body);
    if (!parsed.success) return json({ ok: false, error: "invalid_body" }, { status: 400 });
    return forward(await stub.fetch(internal, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data),
    }));
  }

  if (action === "cancel") {
    const parsed = employeeRuntimeCancelSchema.safeParse(body);
    if (!parsed.success) return json({ ok: false, error: "invalid_body" }, { status: 400 });
    return forward(await stub.fetch(internal, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data),
    }));
  }

  if (action === "recover") {
    return forward(await stub.fetch(internal, { method: "POST", body: "{}" }));
  }

  return json({ ok: false, error: "not_found" }, { status: 404 });
}
