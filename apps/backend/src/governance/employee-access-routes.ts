import type { Env } from "../env.js";
import { resolveOrgForApiRequest } from "../org-request-auth.js";
import { requireJsonContentType, requireSameOriginBrowserMutation, resolveUserId } from "../request-auth.js";
import { getCustomAgentById } from "../custom-agents-store.js";
import { GovernanceError } from "./governance-store.js";
import { employeeAccessDenial, listEmployeeAccess, resolveEmployeeAccess, setEmployeeAccess } from "./employee-access.js";
import { employeeDelegationAccess } from "./employee-delegation-access.js";

export async function handleEmployeeAccess(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/api\/governance\/employees\/([^/]+)\/access\/?$/.exec(url.pathname);
  if (!match) return null;
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  if (request.headers.has("authorization")) return json({ error: "Human workspace session required." }, 403);
  const auth = await resolveOrgForApiRequest(request, env, { allowMemberWrite: true });
  if (auth instanceof Response) return auth;
  if (!auth.workspace) return json({ error: "Select a team workspace to configure employee access." }, 400);
  const userId = await resolveUserId(request, env);
  if (!userId) return json({ error: "Authentication required." }, 401);
  if (!env.AGENT_AUDIT) return json({ error: "Storage unavailable." }, 503);
  try {
    const employeeId = decodeURIComponent(match[1]!);
    const workspaceId = auth.workspace.workspaceId;
    const level = await resolveEmployeeAccess(env, workspaceId, employeeId, userId);
    const denied = employeeAccessDenial(level, request.method === "GET" ? "view" : "manage");
    if (denied) return denied;
    if (!await getCustomAgentById({ AGENT_AUDIT: env.AGENT_AUDIT }, auth.orgId, employeeId)) return json({ error: "Not found." }, 404);
    const canManageIncomingDelegation = auth.workspace.role === "owner" || auth.workspace.role === "admin";
    if (url.searchParams.get("policy") === "incoming-delegation") {
      if (!canManageIncomingDelegation) return json({ error: "Workspace owner or admin permission is required." }, 403);
      const scope = { workspaceId, employeeId, actorId: auth.workspace.userId, membershipVersion: auth.workspace.version };
      if (request.method === "GET") return json(await employeeDelegationAccess(env.AGENT_AUDIT, scope));
      if (request.method !== "PUT") return json({ error: "Method not allowed." }, 405);
      const block = requireSameOriginBrowserMutation(request) ?? requireJsonContentType(request);
      if (block) return block;
      return json(await employeeDelegationAccess(env.AGENT_AUDIT, scope, await request.json().catch(() => null)));
    }
    if (request.method === "PUT") {
      const block = requireSameOriginBrowserMutation(request) ?? requireJsonContentType(request);
      if (block) return block;
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "JSON object required." }, 400);
      await setEmployeeAccess(env, workspaceId, employeeId, userId, body as Record<string, unknown>);
    } else if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
    return json({ level, grants: level === "manage" ? await listEmployeeAccess(env, workspaceId, employeeId) : [], ...(canManageIncomingDelegation ? { canManageIncomingDelegation: true } : {}) });
  } catch (error) {
    if (error instanceof GovernanceError) return json({ error: error.message }, error.status);
    return json({ error: "Employee access unavailable." }, 503);
  }
}
