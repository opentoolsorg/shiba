import type { V1Context } from "./context.js";
import openApi from "./openapi.json";

export async function handleOpenApi(ctx: V1Context): Promise<Response | null> {
  if (ctx.url.pathname !== "/api/v1/openapi.json") return null;
  if (ctx.request.method !== "GET") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  return Response.json(openApi, { headers: { "cache-control": "no-store" } });
}
