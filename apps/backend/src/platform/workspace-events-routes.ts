import type { Env } from "../env.js";
import { isTeamWorkspaceMember } from "../team-workspaces-store.js";
import { isAuthorizedRequest, resolveUserId } from "../request-auth.js";
import { workspaceEventsName } from "./workspace-events-do.js";

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
  if (!env.WorkspaceEvents) return unboundEventStream(request);
  if (request.headers.get("Upgrade") !== "websocket") {
    return Response.json({ error: "WebSocket upgrade required." }, { status: 426 });
  }
  const stub = env.WorkspaceEvents.getByName(workspaceEventsName(workspaceId));
  return stub.fetch(new Request(`https://workspace-events.internal/subscribe?userId=${encodeURIComponent(userId)}`, request));
}

/** Used only when the WorkspaceEvents binding is absent. */
function unboundEventStream(request: Request): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const timer = setInterval(() => {
        if (closed || request.signal.aborted) {
          clearInterval(timer);
          if (!closed) controller.close();
          closed = true;
          return;
        }
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);
      controller.enqueue(encoder.encode("event: unbound\ndata: {}\n\n"));
      request.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(timer);
      });
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}