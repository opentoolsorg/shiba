import type { Env } from "../env.js";
import { isTeamWorkspaceId } from "@shiba/shared";
import { getAgentByName } from "agents/routing";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "../dashboard-mutation.js";
import { resolveRequestIdentity } from "../request-auth.js";
import { getTeamWorkspaceMembership } from "../team-workspaces-store.js";
import { isRestrictedTeamMember } from "../team-member-auth.js";
import { buildSessionAgentName, DEFAULT_SESSION_ID, isValidSessionId, validateSessionRecordIntegrity, type WebSessionRecord } from "../web-sessions.js";
import {
  browserLoginCreateSchema, browserLoginUpdateSchema, BrowserLoginUpdateError, createBrowserLogin, deleteBrowserLogin,
  getBrowserLogin, listBrowserLogins, loginIdSchema, updateBrowserLogin, type BrowserLoginScope,
} from "./browser-logins.js";
import { browserCommand, browserControlSchema, BrowserSessionError, chatBrowserKey } from "./browser-sessions.js";

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function actorFor(request: Request, env: Env) {
  if (request.headers.has("authorization")) return null;
  const identity = await resolveRequestIdentity(request, env);
  return identity.authorized ? identity.userId : null;
}

function selectedWorkspace(request: Request, url: URL) {
  const query = url.searchParams.getAll("workspaceId");
  const header = request.headers.get("X-Shiba-Workspace");
  if (query.length > 1 || (query[0] !== undefined && header !== null && query[0] !== header)) return false;
  const workspace = header ?? query[0];
  if (workspace === undefined) return null;
  return isTeamWorkspaceId(workspace) ? workspace : false;
}

export async function handleBrowserLogins(request: Request, env: Env) {
  const actor = await actorFor(request, env);
  if (!actor || actor === "default") return json({ error: "A signed-in human is required." }, 401);
  if (!env.AGENT_AUDIT) return json({ error: "Saved login storage is unavailable." }, 503);
  const url = new URL(request.url);
  const workspace = selectedWorkspace(request, url);
  if (workspace === false) return json({ error: "Workspace not found." }, 404);
  const db = env.AGENT_AUDIT;
  if (workspace) {
    const membership = await getTeamWorkspaceMembership({ AGENT_AUDIT: db }, workspace, actor);
    if (!membership) return json({ error: "Workspace not found." }, 404);
    if (membership.role !== "owner" && membership.role !== "admin") {
      return json({ error: "Only workspace owners and admins can manage saved logins." }, 403);
    }
  } else if (await isRestrictedTeamMember(request, env)) {
    return json({ error: "Select a workspace to manage saved logins." }, 403);
  }
  const scope: BrowserLoginScope = workspace ? { kind: "workspace", id: workspace } : { kind: "personal", id: actor };
  const id = url.pathname.split("/")[3];
  if (id !== undefined && !loginIdSchema.safeParse(id).success) return json({ error: "Saved login not found." }, 404);
  if (request.method === "GET") {
    if (!id) return json({ logins: await listBrowserLogins(db, scope) });
    const login = await getBrowserLogin(db, scope, id);
    return login ? json({ login }) : json({ error: "Saved login not found." }, 404);
  }
  const originRefusal = rejectCrossOriginMutation(request);
  if (originRefusal) return originRefusal;
  if (request.method === "DELETE" && id) {
    return await deleteBrowserLogin(db, scope, id) ? json({ deleted: true }) : json({ error: "Saved login not found." }, 404);
  }
  if ((request.method !== "POST" || id) && (request.method !== "PATCH" || !id)) {
    return json({ error: "Method not allowed." }, 405);
  }
  const mediaRefusal = rejectNonJsonMutation(request);
  if (mediaRefusal) return mediaRefusal;
  const raw = await request.json().catch(() => null);
  try {
    if (request.method === "POST") {
      const parsed = browserLoginCreateSchema.safeParse(raw);
      if (!parsed.success) return json({ error: "Provide a label, exact public HTTPS origin, username, password, and optional base32 TOTP secret." }, 400);
      return json({ login: await createBrowserLogin({ ...env, AGENT_AUDIT: db }, scope, parsed.data) }, 201);
    }
    const parsed = browserLoginUpdateSchema.safeParse(raw);
    if (!parsed.success) return json({ error: "Provide valid changed fields, using an exact HTTPS origin and a base32 TOTP secret if included." }, 400);
    if (!id) return json({ error: "Saved login not found." }, 404);
    const login = await updateBrowserLogin({ ...env, AGENT_AUDIT: db }, scope, id, parsed.data);
    return login ? json({ login }) : json({ error: "Saved login not found." }, 404);
  } catch (error) {
    if (error instanceof BrowserLoginUpdateError) return json({ error: error.message }, 409);
    return json({ error: "The vault could not save this login. Check the deployment vault configuration." }, 503);
  }
}

export async function handleBrowserSession(request: Request, env: Env) {
  const actor = await actorFor(request, env);
  if (!actor) return json({ error: "A signed-in human is required." }, 401);
  const url = new URL(request.url);
  if (selectedWorkspace(request, url) !== null || await isRestrictedTeamMember(request, env)) {
    return json({ error: "Browser live view requires a private dashboard thread." }, 403);
  }
  const params = url.searchParams.getAll("session");
  const id = params[0] ?? DEFAULT_SESSION_ID;
  if (params.length > 1 || !isValidSessionId(id)) return json({ error: "Session not found." }, 404);
  const name = buildSessionAgentName(actor, id);
  if (id !== DEFAULT_SESSION_ID) {
    let session: WebSessionRecord | undefined;
    try {
      const stub = await getAgentByName(env.CodingOrchestrator, actor);
      const check = await stub.fetch(`https://internal/internal/web-sessions/${encodeURIComponent(id)}`);
      if (check.ok) session = (await check.json<{ session?: WebSessionRecord }>()).session;
      else if (check.status !== 404) return json({ error: "Thread registry is unavailable." }, 503);
    } catch {
      return json({ error: "Thread registry is unavailable." }, 503);
    }
    if (!session || validateSessionRecordIntegrity(session, actor) !== null || session.id !== id || session.agentName !== name || session.deletingAt ||
        Boolean(session.metadata?.teamWorkspaceId) || String(session.metadata?.orgId ?? "").startsWith("team:")) {
      return json({ error: "Session not found." }, 404);
    }
  }
  if ((!env.BrowserSession || !env.BROWSER) && request.method === "GET") return json({ state: "none" });
  const key = chatBrowserKey(name);
  try {
    if (request.method === "GET") return json(await browserCommand(env, key, { kind: "frame", actor }));
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    const refusal = rejectCrossOriginMutation(request) ?? rejectNonJsonMutation(request);
    if (refusal) return refusal;
    const parsed = browserControlSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "Invalid browser control." }, 400);
    return json(await browserCommand(env, key, { kind: "control", actor, runId: name, control: parsed.data }));
  } catch (error) {
    return json({ error: error instanceof BrowserSessionError ? error.message : "Browser session is unavailable." }, 409);
  }
}
