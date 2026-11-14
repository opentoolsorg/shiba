import { CollaborationStoreError } from "../collaboration-store.js";
import { CollabV2StoreError } from "../collaboration-v2-store.js";
import type { Env } from "../env.js";
import { isAuthorizedRequest, resolveUserId } from "../request-auth.js";
import { resolveTeamCollaborationScope } from "../team-collaboration-scope.js";
import {
  getWorkspaceNotificationPrefs,
  listWorkspaceNotifications,
  markWorkspaceNotificationRead,
  NotificationsStoreError,
  setWorkspaceNotificationPrefs,
} from "./notifications-store.js";

const PREFIX = "/api/workspace-notifications";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleNotifications(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  if (!(await isAuthorizedRequest(request, env))) return json({ error: "Authentication required." }, 401);
  const userId = await resolveUserId(request, env);
  if (!userId?.trim()) return json({ error: "Authenticated user required." }, 401);
  if (!env.AGENT_AUDIT) return json({ error: "Notification storage is unavailable." }, 503);
  let scope;
  try {
    scope = await resolveTeamCollaborationScope(request, env);
  } catch {
    return json({ error: "Workspace scope is unavailable." }, 503);
  }
  if (!scope) return json({ error: "Workspace not found." }, 404);
  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    (request.headers.get("origin") !== url.origin ||
      request.headers.get("sec-fetch-site") === "cross-site")
  ) {
    return json({ error: "Same-origin request required." }, 403);
  }

  const path = url.pathname.slice(PREFIX.length).split("/").filter(Boolean);
  try {
    if (path.length === 0 && request.method === "GET") {
      return json({ notifications: await listWorkspaceNotifications(env, scope) });
    }
    if (path.length === 1 && path[0] === "prefs" && request.method === "GET") {
      return json({ prefs: await getWorkspaceNotificationPrefs(env, scope) });
    }
    if (path.length === 1 && path[0] === "prefs" && request.method === "PUT") {
      const body = await request.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return json({ error: "JSON body required." }, 400);
      const prefs = await setWorkspaceNotificationPrefs(env, scope, {
        ...(typeof body.mentions === "boolean" ? { mentions: body.mentions } : {}),
        ...(typeof body.threadReplies === "boolean" ? { threadReplies: body.threadReplies } : {}),
        ...(typeof body.agentApprovals === "boolean" ? { agentApprovals: body.agentApprovals } : {}),
      }, Date.now());
      return json({ prefs });
    }
    if (path.length === 2 && path[1] === "read" && request.method === "POST") {
      const changed = await markWorkspaceNotificationRead(env, scope, path[0]!, Date.now());
      if (!changed) return json({ error: "Notification not found." }, 404);
      return json({ read: true });
    }
    return json({ error: "Notification route not found." }, 404);
  } catch (error) {
    if (error instanceof CollabV2StoreError || error instanceof NotificationsStoreError) {
      return json({ error: error.message }, error.status);
    }
    if (error instanceof CollaborationStoreError) return json({ error: error.message }, error.status);
    console.error("notification route failed", error instanceof Error ? error.message : String(error));
    return json({ error: "Notification operation failed." }, 503);
  }
}