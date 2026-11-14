import type { Env } from "../env.js";
import { isTeamWorkspaceMember } from "../team-workspaces-store.js";
import { isAuthorizedRequest, resolveUserId } from "../request-auth.js";
import { VERIFIED_SUBSCRIBER_HEADER, workspaceEventsName } from "./workspace-events-do.js";

const PATH = /^\/api\/workspaces\/([^/]+)\/events$/;

export async function handleWorkspaceEvents(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = PATH.exec(url.pathname);
  if (!match) return null;
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405, headers: { Allow: "GET" } });
  }
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const userId = (await resolveUserId(request, env))?.trim().toLowerCase();
  if (!userId) return Response.json({ error: "Authentication required." }, { status: 401 });
  const workspaceId = decodeURIComponent(match[1]!);
  if (!await isTeamWorkspaceMember(env, workspaceId, userId)) {
    return Response.json({ error: "Forbidden.", code: "workspace_membership_required" }, { status: 403 });
  }
  if (!env.WorkspaceEvents) {
    return Response.json({ error: "Live updates are not enabled on this deployment.", code: "workspace_events_unbound" }, { status: 503 });
  }
  if (request.headers.get("Upgrade") !== "websocket") {
    return Response.json({ error: "WebSocket upgrade required." }, { status: 426 });
  }
  const stub = env.WorkspaceEvents.getByName(workspaceEventsName(workspaceId));
  const headers = new Headers(request.headers);
  headers.delete(VERIFIED_SUBSCRIBER_HEADER);
  headers.set(VERIFIED_SUBSCRIBER_HEADER, userId);
  return stub.fetch(new Request("https://workspace-events.internal/subscribe", { method: "GET", headers }));
}