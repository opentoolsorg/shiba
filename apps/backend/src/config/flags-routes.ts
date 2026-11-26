/**
 * GET /api/admin/flags — M04 flag registry surface.
 *
 * Admin-only: mirrors the governance admin console gate
 * (governance/admin-console.ts assertAdminOperator → isTeamDeploymentOperator):
 * Access identity, a Better Auth bootstrap account, or an unauthenticated
 * loopback dev request when no identity system is configured. The Worker's
 * global isAuthorizedRequest gate has already run by the time this handler
 * is reached, so every caller here is authenticated — this check narrows to
 * deployment operators.
 */
import { flagStates } from "./flags.js";
import type { Env } from "../env.js";
import { isTeamDeploymentOperator } from "../team-member-auth.js";

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });

export async function handleAdminFlags(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/admin/flags") return null;
  if (!(await isTeamDeploymentOperator(request, env))) {
    return json({ error: "Deployment operator required." }, 403);
  }
  if (request.method !== "GET") {
    return json({ error: "Method not allowed." }, 405);
  }
  return json({ flags: flagStates(env) });
}
