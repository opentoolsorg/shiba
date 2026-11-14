import type { SpineEvent } from "@shiba/shared";
import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { resolveRunStoreTarget } from "./runs-routes.js";
import { isTeamWorkspaceId } from "@shiba/shared";
import { getTeamWorkspaceMembership, normalizeTeamWorkspaceEmail } from "./team-workspaces-store.js";

const POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;
const PUBLIC_KIND = /^(run|approval|ask_user)\./;

const json = (body: unknown, status = 200) =>
  Response.json(body, { headers: { "content-type": "application/json; charset=utf-8" }, status });

function spineToWorkspaceEvent(workspaceId: string, event: SpineEvent) {
  return {
    id: `wse_spine_${event.seq}`,
    workspaceId,
    kind: event.kind.startsWith("run.") ? "run.updated" as const
      : event.kind.startsWith("approval.") ? "approval.updated" as const
      : "run.updated" as const,
    entityId: event.runId ?? event.approvalId ?? String(event.seq),
    at: event.at,
    payload: { spineKind: event.kind, ...(event.payload ?? {}) },
  };
}

/**
 * Dashboard live loop: WebSocket upgrade when WS01 DO is bound; otherwise
 * cookie-auth SSE over the spine (same public kinds as v1/events).
 */
export async function handleWorkspaceEvents(request: Request, env: Env): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const match = pathname.match(/^\/api\/workspaces\/([^/]+)\/events\/stream$/);
  if (!match) return null;
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
  if (!(await isAuthorizedRequest(request, env))) return json({ error: "Authenticated human session required." }, 401);
  let workspaceId: string;
  try {
    workspaceId = decodeURIComponent(match[1]!);
  } catch {
    return json({ error: "Invalid workspace." }, 400);
  }
  if (!isTeamWorkspaceId(workspaceId)) return json({ error: "Workspace not found." }, 404);
  const selected = request.headers.get("X-Shiba-Workspace");
  if (selected !== null && selected !== workspaceId) return json({ error: "Workspace not found." }, 404);
  const identity = await resolveUserId(request, env);
  if (!identity) return json({ error: "Authenticated human session required." }, 401);
  let userId: string;
  try {
    userId = normalizeTeamWorkspaceEmail(identity);
  } catch {
    return json({ error: "Authenticated email identity required." }, 403);
  }
  if (!(await getTeamWorkspaceMembership(env, workspaceId, userId))) {
    return json({ error: "Workspace membership required." }, 403);
  }
  const ns = env.WorkspaceEvents;
  if (ns) {
    const stub = ns.get(ns.idFromName(workspaceId));
    return stub.fetch(request);
  }
  return spineWorkspaceSse(request, env, workspaceId);
}

async function readSpine(env: Env, request: Request, since: number | null) {
  const url = new URL(request.url);
  url.pathname = "/api/spine";
  url.search = since === null ? "" : `since=${since}`;
  const resolved = await resolveRunStoreTarget(request, env, url);
  if ("error" in resolved) return null;
  const stub = await getAgentByName(env.CodingOrchestrator, resolved.agentName);
  const response = await stub.fetch(new Request(url, { headers: request.headers }));
  if (!response.ok) return null;
  return (await response.json()) as { events: SpineEvent[]; earliestSeq: number; latestSeq: number };
}

function spineWorkspaceSse(request: Request, env: Env, workspaceId: string): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const cursorRaw = request.headers.get("Last-Event-ID");
  let cursor = cursorRaw !== null && /^\d+$/.test(cursorRaw) ? Number(cursorRaw) : null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const loop = async () => {
        let lastWrite = Date.now();
        while (!closed) {
          const spine = await readSpine(env, request, cursor);
          if (!spine) break;
          const batch = spine.events
            .filter((event) => PUBLIC_KIND.test(event.kind))
            .map((event) => spineToWorkspaceEvent(workspaceId, event));
          for (const event of batch) {
            controller.enqueue(encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`));
            cursor = spine.latestSeq;
            lastWrite = Date.now();
          }
          if (Date.now() - lastWrite >= HEARTBEAT_MS) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            lastWrite = Date.now();
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          if (request.signal.aborted) break;
        }
        if (!closed) controller.close();
      };
      void loop();
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}