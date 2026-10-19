import type { V1Context } from "./context.js";

/** Public API alias for dashboard custom agents (`/api/custom-agents`). */
export async function handleOrgAgents(ctx: V1Context): Promise<Response | null> {
  if (!ctx.url.pathname.startsWith("/api/v1/org-agents")) return null;
  const rewritten = new URL(ctx.request.url);
  rewritten.pathname = ctx.url.pathname.replace("/api/v1/org-agents", "/api/custom-agents");
  const { handleCustomAgents } = await import("../custom-agents-routes.js");
  return handleCustomAgents(new Request(rewritten, ctx.request), ctx.env);
}
