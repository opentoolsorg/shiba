import type { Env } from "../env.js";
import { isTeamDeploymentOperator } from "../team-member-auth.js";
import { isAuthorizedRequest } from "../request-auth.js";
import { listEmailDeliveryStatus } from "./outbox.js";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

/** GET /api/email/delivery-status — operator view of suppressions and delivery errors (no content). */
export async function handleEmailDeliveryRoutes(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/email/delivery-status") return null;
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
  if (!(await isAuthorizedRequest(request, env))) return json({ error: "Authentication required." }, 401);
  if (!(await isTeamDeploymentOperator(request, env))) {
    return json({ error: "Deployment operator access required." }, 403);
  }
  return json(await listEmailDeliveryStatus(env));
}