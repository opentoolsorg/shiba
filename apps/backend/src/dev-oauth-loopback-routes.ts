/**
 * Local dev only: OAuth loopback servers POST callback URLs here; the dashboard polls
 * while sign-in is pending (window.opener is null when links use noopener).
 */
import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";

type PendingCallback = { id: number; url: string; at: number };

const pending: PendingCallback[] = [];
let nextId = 1;
const MAX_PENDING = 32;

function devLoopbackHost(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host === "127.0.0.1" || host === "localhost";
}

function isLoopbackCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return false;
    if (parsed.pathname !== "/callback" && parsed.pathname !== "/auth/callback") return false;
    const port = parsed.port;
    return port === "51121" || port === "56121" || port === "" || parsed.pathname === "/auth/callback";
  } catch {
    return false;
  }
}

function pushCallback(url: string): PendingCallback {
  const entry = { id: nextId++, url, at: Date.now() };
  pending.push(entry);
  while (pending.length > MAX_PENDING) pending.shift();
  return entry;
}

export function resetDevOAuthLoopbackForTests(): void {
  pending.length = 0;
  nextId = 1;
}

export async function handleDevOAuthLoopback(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname !== "/api/dev/oauth-loopback") return null;
  if (!devLoopbackHost(request)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  if (request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { url?: string } | null;
    const url = body?.url?.trim() ?? "";
    if (!isLoopbackCallbackUrl(url)) {
      return Response.json({ error: "Invalid callback URL." }, { status: 400 });
    }
    const entry = pushCallback(url);
    return Response.json({ ok: true, id: entry.id });
  }

  if (request.method === "GET") {
    if (!(await isAuthorizedRequest(request, env))) {
      return Response.json({ error: "Authentication required." }, { status: 401 });
    }
    const since = Number.parseInt(new URL(request.url).searchParams.get("since") ?? "0", 10);
    const callbacks = pending.filter((row) => row.id > since);
    return Response.json({ callbacks });
  }

  return Response.json({ error: "Method not allowed." }, { status: 405 });
}
