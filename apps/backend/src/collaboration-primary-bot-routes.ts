import type { Env } from "./env.js";
import { COLLAB_TENANT_ID, collaborationEmployeeOrgId, type CollaborationScope } from "./collaboration-store.js";
import { getCustomAgentById, getCustomAgentBySlug } from "./custom-agents-store.js";
import { getWorkspacePrimaryBot, setWorkspacePrimaryBot } from "./collaboration-router.js";
import { isAuthorizedRequest, requireJsonContentType, requireSameOriginBrowserMutation, resolveUserId } from "./request-auth.js";
import { getTeamWorkspaceMembership, normalizeTeamWorkspaceEmail, TeamWorkspaceError } from "./team-workspaces-store.js";

const PATH = /^\/api\/workspaces\/(ws_[a-f0-9]{24})\/primary-bot$/;
const ACTOR = /^agent:[A-Za-z0-9_-]{1,80}$/;
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

/** Workspace owners and admins read and set the primary bot. */
export async function handlePrimaryBot(request: Request, env: Env): Promise<Response | null> {
  const match = PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  if (request.method !== "GET" && request.method !== "PUT") return json({ error: "Method not allowed." }, 405);
  if (request.headers.has("authorization") || !await isAuthorizedRequest(request, env)) {
    return json({ error: "Authenticated human session required." }, 401);
  }
  const originError = requireSameOriginBrowserMutation(request);
  if (originError) return originError;
  const identity = await resolveUserId(request, env);
  if (!identity) return json({ error: "Authenticated human session required." }, 401);
  let user: string;
  try { user = normalizeTeamWorkspaceEmail(identity); }
  catch (error) {
    if (error instanceof TeamWorkspaceError) return json({ error: error.message }, error.status);
    return json({ error: "Authenticated email identity required." }, 403);
  }
  const workspaceId = match[1];
  if (!workspaceId) return null;
  const membership = await getTeamWorkspaceMembership(env, workspaceId, user);
  if (!membership) return json({ error: "Workspace not found." }, 404);
  if (membership.role !== "owner" && membership.role !== "admin") return json({ error: "Workspace admin required." }, 403);
  const scope: CollaborationScope = { tenantId: COLLAB_TENANT_ID, workspaceId, userId: user };
  if (request.method === "GET") return json(await getWorkspacePrimaryBot(env, scope));
  const contentError = requireJsonContentType(request);
  if (contentError) return contentError;
  let body: unknown;
  try { body = await request.json(); }
  catch { return json({ error: "Request body must be a JSON object." }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Request body must be a JSON object." }, 400);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "actorId")) return json({ error: "Unknown request field." }, 400);
  if (typeof record.actorId !== "string" || !ACTOR.test(record.actorId)) return json({ error: "A bot actor id is required." }, 400);
  const profileId = record.actorId.slice("agent:".length);
  const orgId = collaborationEmployeeOrgId(scope);
  const profile = await getCustomAgentById(env, orgId, profileId) ?? await getCustomAgentBySlug(env, orgId, profileId);
  if (!profile) return json({ error: "Choose an active bot in this workspace." }, 404);
  await setWorkspacePrimaryBot(env, scope, record.actorId, Date.now());
  return json(await getWorkspacePrimaryBot(env, scope));
}
