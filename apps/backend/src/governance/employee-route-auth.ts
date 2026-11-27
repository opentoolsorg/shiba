import type { EmployeeAccessLevel } from "@shiba/shared";
import type { Env } from "../env.js";
import { resolveOrgForApiRequest } from "../org-request-auth.js";
import { resolveUserId } from "../request-auth.js";
import { COLLAB_TENANT_ID } from "../collaboration-store.js";
import { orgIdForRecord, verifyToken } from "../agent-tokens.js";
import { getAgentByName } from "agents/routing";
import { resolveTeamCollaborationScope } from "../team-collaboration-scope.js";
import { employeeAccessDenial, resolveEmployeeAccess } from "./employee-access.js";

type Route = { path: RegExp; required: (method: string) => EmployeeAccessLevel; source: "path" | "body" | "handoff" | "turn" | "turn-body" | "session"; bodyKey?: "recipientActorId" | "metadata" | "customAgentId" };
const settings = (method: string): EmployeeAccessLevel => ["GET", "HEAD"].includes(method) ? "view" : "manage";
export const employeeRouteAuth: readonly Route[] = [
  { path: /^\/api\/custom-agents\/([^/]+)\/runtime\/recover\/?$/, required: () => "manage", source: "path" },
  { path: /^\/api\/custom-agents\/([^/]+)\/runtime\/(chat\/stream|chat|state|memory|memory\/search|memory\/update|memory\/delete|cancel|clear)\/?$/, required: (method) => method === "GET" ? "view" : "chat", source: "path" },
  { path: /^\/api\/v1\/org-agents\/([^/]+)\/runtime\/recover\/?$/, required: () => "manage", source: "path" },
  { path: /^\/api\/v1\/org-agents\/([^/]+)\/runtime\/(chat\/stream|chat|state|memory|memory\/search|memory\/update|memory\/delete|cancel|clear)\/?$/, required: (method) => method === "GET" ? "view" : "chat", source: "path" },
  { path: /^\/api\/custom-agents\/([^/]+)(?:\/.*)?$/, required: settings, source: "path" },
  { path: /^\/api\/employee-tools\/(?!approvals(?:\/|$))([^/]+)\/(policy|call)\/?$/, required: settings, source: "path" },
  { path: /^\/api\/governance\/employees\/([^/]+)\/access\/?$/, required: settings, source: "path" },
  { path: /^\/api\/employee-tools\/approvals\/[^/]+\/?$/, required: () => "chat", source: "body" },
  { path: /^\/api\/employee-bundles\/export$/, required: () => "view", source: "body" },
  { path: /^\/api\/collaboration\/rooms\/[^/]+\/handoffs$/, required: () => "chat", source: "body", bodyKey: "recipientActorId" },
  { path: /^\/api\/collaboration\/rooms\/[^/]+\/handoffs\/([^/]+)(?:\/.*)?$/, required: (method) => method === "GET" ? "view" : "chat", source: "handoff" },
  { path: /^\/api\/team-model-sessions\/turns\/prepare$/, required: () => "chat", source: "turn-body" },
  { path: /^\/api\/team-model-sessions\/turns\/([^/]+)\/(approve|execute)$/, required: () => "chat", source: "turn" },
  { path: /^\/api\/sessions(?:\/[^/]+)?$/, required: () => "chat", source: "body", bodyKey: "metadata" },
  { path: /^\/api\/sessions\/([^/]+)\/resume$/, required: () => "chat", source: "session" },
  { path: /^\/api\/runs$/, required: () => "chat", source: "body", bodyKey: "customAgentId" },
];

/** Additional employee authority; never replaces a route's existing audience or approval checks. */
export async function enforceEmployeeRouteAccess(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const route = employeeRouteAuth.find((entry) => entry.path.test(path));
  if (!route) return null;
  if (request.method === "GET" && /^\/api\/collaboration\/rooms\/[^/]+\/handoffs\/[^/]+\/artifacts\/[^/]+$/.test(path)) {
    const scope = await resolveTeamCollaborationScope(request, env);
    if (!scope) return Response.json({ error: "Not found." }, { status: 404 });
    if (scope.workspaceId.startsWith("ws_")) {
      const headers = new Headers(request.headers);
      headers.set("X-Shiba-Workspace", scope.workspaceId);
      request = new Request(request, { headers });
    }
  }
  // Agent credentials retain their existing capability-based tool authority.
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (bearer && (await verifyToken(env, bearer))?.kind === "agent") return null;
  // This is additional authorization, not primary authentication. Reusing the
  // bearer record avoids charging the public API-key minute budget a second
  // time before the owning route authenticates the same request.
  const apiKeyRecord = bearer ? await verifyToken(env, bearer) : null;
  if (apiKeyRecord?.kind === "api_key" && request.headers.has("X-Shiba-Workspace")) {
    return Response.json({ error: "Workspace selectors cannot override an API credential." }, { status: 403 });
  }
  const auth = apiKeyRecord?.kind === "api_key"
    ? {
      orgId: orgIdForRecord(apiKeyRecord),
      principal: {
        principal: apiKeyRecord.principal,
        orgId: orgIdForRecord(apiKeyRecord),
        scopes: apiKeyRecord.scopes,
        apiKey: apiKeyRecord,
      },
    }
    : await resolveOrgForApiRequest(request, env, { allowMemberWrite: true });
  if (auth instanceof Response) return auth;
  const workspaceId = auth.workspace?.workspaceId ?? /^team:(ws_[a-f0-9]{24})$/.exec(auth.orgId)?.[1];
  if (!workspaceId) return null;
  const userId = auth.principal?.principal ?? await resolveUserId(request, env);
  if (!userId) return Response.json({ error: "Authentication required." }, { status: 401 });
  let employeeId: string | undefined;
  try {
    if (route.source === "session") {
      const stub = await getAgentByName(env.CodingOrchestrator, userId);
      const response = await stub.fetch(`https://internal/internal/web-sessions/${encodeURIComponent(decodeURIComponent(route.path.exec(path)![1]!))}`);
      if (!response.ok) return Response.json({ error: "Session not found." }, { status: 404 });
      const body = await response.json() as { session?: { metadata?: Record<string, unknown> } };
      const metadata = body.session?.metadata;
      if (!metadata || metadata.orgId !== auth.orgId || metadata.teamWorkspaceId !== workspaceId) return Response.json({ error: "Session not found." }, { status: 404 });
      employeeId = typeof metadata.customAgentId === "string" ? metadata.customAgentId : undefined;
    }
    if (route.source === "path") employeeId = decodeURIComponent(route.path.exec(path)![1]!);
    if (route.source === "body") {
      if (!["POST", "PUT", "PATCH"].includes(request.method)) return null;
      const body = await request.clone().json().catch((error: unknown) => {
        if (route.bodyKey === "metadata" && request.method === "POST" && path === "/api/sessions") return {};
        throw error;
      }) as Record<string, unknown>;
      const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata as Record<string, unknown> : {};
      const value = route.bodyKey === "metadata" ? metadata.customAgentId : body[route.bodyKey ?? "employeeId"];
      employeeId = typeof value === "string" ? route.bodyKey === "recipientActorId" ? value.startsWith("agent:") ? value.slice(6) : undefined : value : undefined;
    }
    if (route.source === "handoff" && env.AGENT_AUDIT) {
      const handoff = await env.AGENT_AUDIT.prepare(`SELECT recipient_actor_id FROM collaboration_handoffs WHERE tenant_id=? AND workspace_id=? AND handoff_id=?`)
        .bind(COLLAB_TENANT_ID, workspaceId, route.path.exec(path)![1]!).first<{ recipient_actor_id: string }>();
      if (handoff?.recipient_actor_id.startsWith("agent:")) employeeId = handoff.recipient_actor_id.slice(6);
    }
    if ((route.source === "turn" || route.source === "turn-body") && env.AGENT_AUDIT) {
      let grantId: unknown;
      if (route.source === "turn-body") grantId = (await request.clone().json() as Record<string, unknown>).grantId;
      const funding = route.source === "turn-body"
        ? await env.AGENT_AUDIT.prepare(`SELECT json_extract(contract_json,'$.employeeId') AS employeeId FROM team_model_funding WHERE workspace_id=? AND id=?`)
          .bind(workspaceId, typeof grantId === "string" ? grantId : "").first<{ employeeId: string }>()
        : await env.AGENT_AUDIT.prepare(`SELECT json_extract(f.contract_json,'$.employeeId') AS employeeId FROM team_model_turns t JOIN team_model_funding f ON f.id=t.grant_id AND f.workspace_id=t.workspace_id WHERE t.workspace_id=? AND t.id=?`)
          .bind(workspaceId, route.path.exec(path)![1]!).first<{ employeeId: string }>();
      if (!funding) return Response.json({ error: "Not found." }, { status: 404 });
      employeeId = funding.employeeId;
    }
  } catch {
    return Response.json({ error: "Employee access could not be resolved." }, { status: 400 });
  }
  if (!employeeId) return null;
  return employeeAccessDenial(await resolveEmployeeAccess(env, workspaceId, employeeId, userId), route.required(request.method));
}
