/**
 * `/api/automations` + automation webhook paths → the Automations DO.
 * Extracted from index.ts.
 */
import { automationsStub } from "./automations-stub.js";
import type { Env } from "./env.js";
import { isAutomationWebhookPath } from "./request-auth.js";
import { resolveOrgForApiRequest } from "./org-request-auth.js";

export async function handleAutomations(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/automations" || /^\/api\/automations\/[^/]+\/?$/.test(url.pathname)
    || isAutomationWebhookPath(url.pathname)
    || /^\/api\/automations\/[^/]+\/run\/?$/.test(url.pathname)) {
    if (env.SHIBA_SCOPED_DO !== "1" || isAutomationWebhookPath(url.pathname)) return automationsStub(env).fetch(request);
    const scope = await resolveOrgForApiRequest(request, env);
    if (scope instanceof Response) return scope;
    return automationsStub(env, scope.orgId).fetch(request);
  }
  return null;
}
