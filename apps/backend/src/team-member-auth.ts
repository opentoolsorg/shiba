import { isBetterAuthConfigured, resolveBetterAuthSessionAccount } from "@shiba/auth/better-auth";
import { isTeamWorkspaceId } from "@shiba/shared";
import type { Env } from "./env.js";
import { getUserId, isAccessConfigured, isLoopbackRequest } from "./request-auth.js";
import { getTeamWorkspaceMembership } from "./team-workspaces-store.js";
import { redactSecrets } from "./security.js";

/** Access identity headers have already been rebuilt from the verified JWT by the Worker. */
function hasAccessIdentity(request: Request, env: Env): boolean {
  return Boolean(env.ACCESS_AUD && isAccessConfigured(env) && getUserId(request));
}

export async function isRestrictedTeamMember(request: Request, env: Env): Promise<boolean> {
  if (hasAccessIdentity(request, env)) return false;
  return (await resolveBetterAuthSessionAccount(request, env, redactSecrets))?.policy.kind === "invited";
}

/** Occupational/team roles never imply authority over the self-hosted deployment. */
export async function isTeamDeploymentOperator(request: Request, env: Env): Promise<boolean> {
  if (hasAccessIdentity(request, env)) return true;
  const account = await resolveBetterAuthSessionAccount(request, env, redactSecrets);
  if (account) return account.policy.kind === "bootstrap";
  return !isAccessConfigured(env) && !isBetterAuthConfigured(env) && isLoopbackRequest(request);
}

const ownApi = [
  /^\/api\/memory\/(?:facts(?:\/[^/]+)?|sessions|sources(?:\/[^/]+)?|projects(?:\/[^/]+)?|recall)\/?$/,
];
const workspaceApi = [
  /^\/api\/collaboration(?:\/|$)/,
  /^\/api\/personal-execution(?:\/|$)/,
  /^\/api\/team-model-sessions(?:\/|$)/,
  /^\/api\/shared-computers(?:\/|$)/,
  /^\/api\/slack\/installations(?:\/|$)/,
  /^\/api\/founder-skills(?:\/|$)/,
  /^\/api\/workspace-integrations(?:\/|$)/,
  /^\/api\/(?:custom-agents|employee-bundles|skills)(?:\/|$)/,
  /^\/api\/v1\/extensions\/skills(?:\/|$)/,
  /^\/api\/onboarding\/progress\/?$/,
];

/**
 * Mount after surface authentication and before API dispatch. Unknown APIs deny
 * restricted native members; route-local ownership/approval checks still apply.
 */
export async function enforceTeamMemberApiPolicy(request: Request, env: Env): Promise<Response | null> {
  if (!await isRestrictedTeamMember(request, env)) return null;
  const path = new URL(request.url).pathname;
  const deny = (code: string, message: string, status = 403) => Response.json({ error: message, code },
    { status, headers: { "Cache-Control": "no-store" } });
  if (request.headers.has("authorization")) return deny("team_member_credential_conflict", "Use your team session without a deployment API credential.");
  // The legacy OAuth consent grants deployment MCP scopes, including admin:tokens.
  // It cannot be used as a second path around the API-key administrator boundary.
  if (/^\/(?:oauth|mcp)(?:\/|$)/.test(path)) return deny("deployment_operator_required", "Deployment MCP and OAuth grants require a deployment operator.");
  // Auth library verbs are served before this policy. Legacy subscription
  // helpers below the API gate may adopt deployment credentials and stay denied.
  if ((path === "/api/whoami" && request.method === "GET") || /^\/api\/workspaces(?:\/|$)/.test(path)) return null;
  if (ownApi.some((rule) => rule.test(path))) return null;
  if (path === "/api/providers" && request.method === "GET") return null;
  if (/^\/api\/providers(?:\/|$)/.test(path)) return deny("team_provider_setup_unavailable", "Provider setup for team members is unavailable until every connection requires an owned account or explicit personal credential.");
  // Revoking execution or workspace access must not remove the native owner's
  // ability to stop their existing local process or unpair their computer. These
  // exact handlers independently verify native account UUID, origin and the
  // immutable stored owner; the exception grants no reads, queue or decisions.
  if ((request.method === "POST" && path === "/api/personal-execution/harness/control") ||
    (request.method === "POST" && /^\/api\/shared-computers\/sessions\/scs_[a-f0-9]{32}\/stop$/.test(path)) ||
    (request.method === "DELETE" && /^\/api\/personal-execution\/computers\/[A-Za-z0-9_-]{1,128}$/.test(path))) return null;
  if (workspaceApi.some((rule) => rule.test(path))) {
    const url = new URL(request.url), selectors = url.searchParams.getAll("workspaceId");
    const queryAllowed = request.method === "GET" && (
      (/^\/api\/collaboration\/rooms\/room_[a-f0-9]{24}\/realtime$/.test(path) && request.headers.get("Upgrade")?.toLowerCase() === "websocket") ||
      /^\/api\/collaboration\/rooms\/room_[a-f0-9]{24}\/handoffs\/[A-Za-z0-9_-]{1,100}\/artifacts\/[0-7]$/.test(path));
    const header = request.headers.get("X-Shiba-Workspace"), query = selectors[0];
    if (selectors.length > 1 || (query !== undefined && !queryAllowed) ||
      (header !== null && query !== undefined && header !== query)) return deny("team_workspace_required", "Use one consistent workspace selector for this route.");
    const workspaceId = header ?? query;
    if (!workspaceId || !isTeamWorkspaceId(workspaceId)) {
      return deny("team_workspace_required", "Select an active team workspace to use this feature.");
    }
    const account = await resolveBetterAuthSessionAccount(request, env, redactSecrets);
    if (!account || !account.emailVerified || !await getTeamWorkspaceMembership(env, workspaceId, account.policy.email)) {
      return deny("team_workspace_unavailable", "Workspace access is unavailable or was removed.", 404);
    }
    return null;
  }
  if (!path.startsWith("/api/") && !path.startsWith("/agents/") && !path.startsWith("/internal/")) return null;
  return deny("deployment_operator_required", "This feature requires a deployment operator. Your team membership does not grant deployment administration.");
}
