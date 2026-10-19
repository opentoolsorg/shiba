/**
 * WebSocket proxy for noVNC — same-origin entry with a verified stream token.
 */
import { getAgentByName } from "agents/routing";
import type { Env } from "./env.js";
import { verifyDesktopStreamToken } from "./sandbox/desktop-tokens.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { resolveRunStoreTarget } from "./runs-routes.js";

const WS_PATH =
  /^\/api\/runs\/([^/]+)\/workspace\/desktop\/ws$/;

export async function handleRunWorkspaceWebSocket(request: Request, env: Env): Promise<Response | null> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return null;
  }
  const url = new URL(request.url);
  const match = WS_PATH.exec(url.pathname);
  if (!match) return null;

  let runId: string;
  try {
    runId = decodeURIComponent(match[1]!);
  } catch {
    return new Response("Invalid run id.", { status: 400 });
  }

  const token = url.searchParams.get("token") ?? "";
  const claims = await verifyDesktopStreamToken(env, token);
  if (!claims || claims.runId !== runId) {
    return new Response("Unauthorized.", { status: 401 });
  }

  const userId = (await resolveUserId(request, env)) ?? "default";
  if (claims.userId !== userId && !(await isAuthorizedRequest(request, env))) {
    return new Response("Unauthorized.", { status: 401 });
  }

  const resolved = await resolveRunStoreTarget(request, env, url);
  if ("error" in resolved) {
    return resolved.error;
  }
  const stub = await getAgentByName(env.CodingOrchestrator, resolved.agentName);
  const sessionRes = await stub.fetch(
    new Request(`https://internal/internal/runs/${encodeURIComponent(runId)}/desktop-ws`, {
      headers: { "X-Shiba-Desktop-Token": token },
    }),
  );
  if (!sessionRes.ok) {
    return new Response("Desktop session unavailable.", { status: sessionRes.status });
  }
  const body = (await sessionRes.json()) as { wsUrl?: string };
  const upstream = body.wsUrl;
  if (!upstream) {
    return new Response("Desktop session unavailable.", { status: 502 });
  }

  const upstreamRes = await fetch(upstream, { headers: { Upgrade: "websocket" } });
  const upstreamSocket = upstreamRes.webSocket;
  if (!upstreamSocket) {
    return new Response("Upstream WebSocket unavailable.", { status: 502 });
  }
  upstreamSocket.accept();

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const forward = (from: WebSocket, to: WebSocket) => {
    from.addEventListener("message", (event) => {
      if (typeof event.data === "string") to.send(event.data);
      else to.send(event.data);
    });
    from.addEventListener("close", (event) => to.close(event.code, event.reason));
    from.addEventListener("error", () => to.close(1011, "socket error"));
  };
  forward(upstreamSocket, server);
  forward(server, upstreamSocket);

  return new Response(null, { status: 101, webSocket: client });
}
