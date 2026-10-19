import { requireV1Read, v1Forbidden } from "../v1-auth.js";
import type { V1Context } from "./context.js";
import { handleEvents } from "./events.js";

/** Thread-scoped SSE — forwards to the org events stream with threadId pinned. */
export async function handleThreadStream(ctx: V1Context): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/api\/v1\/threads\/([^/]+)\/stream$/);
  if (!match || ctx.request.method !== "GET") return null;
  if (!requireV1Read(ctx.principal)) return v1Forbidden();
  let threadId: string;
  try { threadId = decodeURIComponent(match[1]!); }
  catch { return Response.json({ ok: false, error: "invalid_thread" }, { status: 400 }); }
  const url = new URL(ctx.url);
  url.pathname = "/api/v1/events/stream";
  url.searchParams.set("threadId", threadId);
  const request = new Request(url, ctx.request);
  const scoped: V1Context = { ...ctx, request, url };
  return handleEvents(scoped);
}
