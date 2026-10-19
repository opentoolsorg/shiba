import type { V1Principal } from "../v1-auth.js";

/** Stamp org scope on orchestrator queue bodies so custom agents resolve per principal. */
export function v1RunQueueBody(
  principal: V1Principal,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return { ...body, orgId: principal.orgId };
}
