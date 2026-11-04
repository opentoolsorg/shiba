import type { Env } from "./env.js";
import { isAuthorizedRequest, requireJsonContentType, requireSameOriginBrowserMutation, resolveUserId } from "./request-auth.js";
import {
  acceptTeamWorkspaceInvitation, changeTeamWorkspaceMember, createTeamWorkspace,
  createTeamWorkspaceInvitation, getTeamWorkspace, listTeamWorkspaces,
  normalizeTeamWorkspaceEmail, renameTeamWorkspace, revokeTeamWorkspaceInvitation, TeamWorkspaceError,
} from "./team-workspaces-store.js";

const PREFIX = "/api/workspaces";
const BODY_LIMIT = 4096;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) throw new TeamWorkspaceError("Request body is too large.", 413);
  if (!request.body) throw new TeamWorkspaceError("JSON body is required.");
  const reader = request.body.getReader(), bytes = new Uint8Array(BODY_LIMIT);
  let used = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (used + part.value.length > BODY_LIMIT) throw new TeamWorkspaceError("Request body is too large.", 413);
      bytes.set(part.value, used); used += part.value.length;
    }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes.subarray(0, used))); }
    catch { throw new TeamWorkspaceError("Request body must be a JSON object."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TeamWorkspaceError("Request body must be a JSON object.");
    return value as Record<string, unknown>;
  } finally { await reader.cancel().catch(() => {}); }
}
function exact(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new TeamWorkspaceError("Unknown request field.");
}

/** No bearer/automation grant, anonymous invite lookup, signup, or automatic email send. */
export async function handleTeamWorkspaces(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return null;
  if (request.headers.has("authorization") || !await isAuthorizedRequest(request, env)) return json({ error: "Authenticated human session required." }, 401);
  const identity = await resolveUserId(request, env);
  if (!identity) return json({ error: "Authenticated human session required." }, 401);
  let user: string;
  try { user = normalizeTeamWorkspaceEmail(identity); }
  catch { return json({ error: "Authenticated email identity required." }, 403); }
  const originError = requireSameOriginBrowserMutation(request);
  if (originError) return originError;
  try {
    if (request.method !== "GET" && request.method !== "DELETE") {
      const contentError = requireJsonContentType(request);
      if (contentError) return contentError;
    }
    if (path === PREFIX) {
      if (request.method === "GET") return json({ workspaces: await listTeamWorkspaces(env, user) });
      if (request.method === "POST") {
        const body = await readBody(request); exact(body, ["name"]);
        return json({ workspace: await createTeamWorkspace(env, user, { name: body.name }) }, 201);
      }
    }
    if (path === `${PREFIX}/invitations/accept` && request.method === "POST") {
      const body = await readBody(request); exact(body, ["token"]);
      return json({ workspace: await acceptTeamWorkspaceInvitation(env, user, body.token) });
    }
    const match = /^\/api\/workspaces\/(ws_[a-f0-9]{24})(?:\/(invitations|members)(?:\/([^/]+))?)?$/.exec(path);
    if (!match) return json({ error: "Workspace route not found." }, 404);
    const workspaceId = match[1]!;
    // Uniform 404 before mutation prevents managers learning about another workspace's members/invites.
    const workspace = await getTeamWorkspace(env, workspaceId, user);
    if (!workspace) return json({ error: "Workspace not found." }, 404);
    if (!match[2]) {
      if (request.method === "GET") return json({ workspace });
      if (request.method === "PATCH") {
        const body = await readBody(request); exact(body, ["name", "expectedVersion"]);
        await renameTeamWorkspace(env, workspaceId, user, { name: body.name, expectedVersion: body.expectedVersion });
        return json({ workspace: await getTeamWorkspace(env, workspaceId, user) });
      }
    }
    if (match[2] === "invitations") {
      if (!match[3] && request.method === "POST") {
        const body = await readBody(request); exact(body, ["email", "role"]);
        return json(await createTeamWorkspaceInvitation(env, workspaceId, user, { email: body.email, role: body.role }), 201);
      }
      if (match[3] && request.method === "DELETE") {
        await revokeTeamWorkspaceInvitation(env, workspaceId, user, match[3]);
        return json({ revoked: true });
      }
    }
    if (match[2] === "members" && match[3] && (request.method === "PATCH" || request.method === "DELETE")) {
      const contentError = requireJsonContentType(request);
      if (contentError) return contentError;
      const body = await readBody(request); exact(body, request.method === "DELETE" ? ["expectedVersion"] : ["role", "expectedVersion"]);
      let target: string;
      try { target = decodeURIComponent(match[3]); } catch { throw new TeamWorkspaceError("Invalid member identity."); }
      await changeTeamWorkspaceMember(env, workspaceId, user, target, { role: body.role, expectedVersion: body.expectedVersion, remove: request.method === "DELETE" });
      return json({ changed: true });
    }
    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    if (error instanceof TeamWorkspaceError) return json({ error: error.message }, error.status);
    // Never echo a token, database error, or request payload into a response/log.
    return json({ error: "Workspace operation failed." }, 500);
  }
}
