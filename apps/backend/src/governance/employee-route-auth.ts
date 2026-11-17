import type { EmployeeAccessLevel } from "@shiba/shared";
import type { Env } from "../env.js";
import { resolveOrgForApiRequest } from "../org-request-auth.js";
import { resolveUserId } from "../request-auth.js";
import { COLLAB_TENANT_ID } from "../collaboration-store.js";
import { verifyToken } from "../agent-tokens.js";
import { employeeAccessDenial, resolveEmployeeAccess } from "./employee-access.js";

type Route = { path: RegExp; required: (method: string) => EmployeeAccessLevel; source: "path" | "body" | "handoff" | "turn" | "turn-body"; bodyKey?: "recipientActorId" | "metadata" | "customAgentId" };
const settings = (method: string): EmployeeAccessLevel => ["GET", "HEAD"].includes(method) ? "view" : "manage";
export const employeeRouteAuth: readonly Route[] = [
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
  { path: /^\/api\/runs$/, required: () => "chat", source: "body", bodyKey: "customAgentId" },
];

/** Additional employee authority; never replaces a route's existing audience or approval checks. */
export async function enforceEmployeeRouteAccess(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const route = employeeRouteAuth.find((entry) => entry.path.test(path));
  if (!route) return null;
  // Agent credentials retain their existing capability-based tool authority.
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (bearer && (await verifyToken(env, bearer))?.kind === "agent") return null;
  const auth = await resolveOrgForApiRequest(request, env, { allowMemberWrite: true });
  if (auth instanceof Response) return auth;
  const workspaceId = auth.workspace?.workspaceId ?? /^team:(ws_[a-f0-9]{24})$/.exec(auth.orgId)?.[1];
  if (!workspaceId) return null;
  const userId = auth.principal?.principal ?? await resolveUserId(request, env);
  if (!userId) return Response.json({ error: "Authentication required." }, { status: 401 });
  let employeeId: string | undefined;
  try {
    if (route.source === "path") employeeId = decodeURIComponent(route.path.exec(path)![1]!);
    if (route.source === "body") {
      if (!["POST", "PUT", "PATCH"].includes(request.method)) return null;
      const body = await request.clone().json() as Record<string, unknown>;
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
