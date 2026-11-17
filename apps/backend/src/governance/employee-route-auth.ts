import type { EmployeeAccessLevel } from "@shiba/shared";
import type { Env } from "../env.js";
import { resolveOrgForApiRequest } from "../org-request-auth.js";
import { resolveUserId } from "../request-auth.js";
import { COLLAB_TENANT_ID } from "../collaboration-store.js";
import { employeeAccessDenial, resolveEmployeeAccess } from "./employee-access.js";

type Route = { path: RegExp; required: (method: string) => EmployeeAccessLevel; source: "path" | "body" | "handoff" };
const settings = (method: string): EmployeeAccessLevel => ["GET", "HEAD"].includes(method) ? "view" : "manage";
export const employeeRouteAuth: readonly Route[] = [
  { path: /^\/api\/custom-agents\/([^/]+)(?:\/.*)?$/, required: settings, source: "path" },
  { path: /^\/api\/employee-tools\/(?!approvals(?:\/|$))([^/]+)\/(policy|call)\/?$/, required: settings, source: "path" },
  { path: /^\/api\/governance\/employees\/([^/]+)\/access\/?$/, required: settings, source: "path" },
  { path: /^\/api\/employee-tools\/approvals\/[^/]+\/?$/, required: () => "chat", source: "body" },
  { path: /^\/api\/employee-bundles\/export$/, required: () => "view", source: "body" },
  { path: /^\/api\/collaboration\/rooms\/[^/]+\/handoffs$/, required: () => "chat", source: "body" },
  { path: /^\/api\/collaboration\/rooms\/[^/]+\/handoffs\/([^/]+)(?:\/.*)?$/, required: (method) => method === "GET" ? "view" : "chat", source: "handoff" },
];

/** Additional employee authority; never replaces a route's existing audience or approval checks. */
export async function enforceEmployeeRouteAccess(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const route = employeeRouteAuth.find((entry) => entry.path.test(path));
  if (!route) return null;
  // Agent credentials retain their existing capability-based tool authority.
  if (request.headers.has("authorization")) return null;
  const auth = await resolveOrgForApiRequest(request, env, { allowMemberWrite: true });
  if (auth instanceof Response) return auth;
  if (!auth.workspace) return null;
  const userId = await resolveUserId(request, env);
  if (!userId) return Response.json({ error: "Authentication required." }, { status: 401 });
  let employeeId: string | undefined;
  try {
    if (route.source === "path") employeeId = decodeURIComponent(route.path.exec(path)![1]!);
    if (route.source === "body") {
      const body = await request.clone().json() as Record<string, unknown>;
      employeeId = typeof body.employeeId === "string" ? body.employeeId : typeof body.recipientActorId === "string" && body.recipientActorId.startsWith("agent:") ? body.recipientActorId.slice(6) : undefined;
    }
    if (route.source === "handoff" && env.AGENT_AUDIT) {
      const handoff = await env.AGENT_AUDIT.prepare(`SELECT recipient_actor_id FROM collaboration_handoffs WHERE tenant_id=? AND workspace_id=? AND handoff_id=?`)
        .bind(COLLAB_TENANT_ID, auth.workspace.workspaceId, route.path.exec(path)![1]!).first<{ recipient_actor_id: string }>();
      if (handoff?.recipient_actor_id.startsWith("agent:")) employeeId = handoff.recipient_actor_id.slice(6);
    }
  } catch {
    return Response.json({ error: "Employee access could not be resolved." }, { status: 400 });
  }
  if (!employeeId) return null;
  return employeeAccessDenial(await resolveEmployeeAccess(env, auth.workspace.workspaceId, employeeId, userId), route.required(request.method));
}
