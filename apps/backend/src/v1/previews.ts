import type { V1Context } from "./context.js";
import { readRun } from "./runs.js";

const UNSUPPORTED = "Run sandboxes are destroyed when a run settles; live previews need a persistent sandbox.";

export async function handlePreviews(ctx: V1Context): Promise<Response | null> {
  const match = ctx.url.pathname.match(/^\/api\/v1\/threads\/([^/]+)\/preview(?:\/(start|access))?$/);
  if (!match) return null;
  if (ctx.request.method !== (match[2] === "start" ? "POST" : "GET")) return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  let id: string;
  try { id = decodeURIComponent(match[1]!); }
  catch { return Response.json({ ok: false, error: "invalid_thread" }, { status: 400 }); }
  const port = ctx.url.searchParams.get("port");
  if (port !== null && (!/^\d+$/.test(port) || Number(port) < 3000 || Number(port) > 9999)) {
    return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  if (match[2] === "access") {
    try { new URL(ctx.url.searchParams.get("frameOrigin") ?? ""); }
    catch { return Response.json({ ok: false, error: "invalid_request" }, { status: 400 }); }
  }
  const run = await readRun(ctx, id);
  if (run instanceof Response) return run;
  if (match[2] === "start") {
    return Response.json({ ok: false, error: "not_implemented", code: "not_implemented", detail: UNSUPPORTED }, { status: 501 });
  }
  const name = ctx.url.searchParams.get("name") || "default";
  return Response.json({ ok: true, preview: { name, status: "unsupported", reason: UNSUPPORTED,
    ...(port !== null ? { port: Number(port) } : {}), ...(match[2] === "access" ? { gateway: null } : {}) } });
}
