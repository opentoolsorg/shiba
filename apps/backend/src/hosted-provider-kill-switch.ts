import type { Env } from "./env.js";

/**
 * Emergency stop for hosted inference: model traffic the deployment pays
 * for through Cloudflare AI Gateway (AI_GATEWAY_TOKEN, gateway BYOK and org
 * keys) and Workers AI team-model turns. Personal provider keys, plan
 * subscriptions and paired local daemons are user-funded and keep working.
 */
export const HOSTED_PROVIDER_KILL_SWITCH_MESSAGE = "Hosted provider access is disabled by the emergency kill switch.";

export function isHostedProviderAccessStopped(env: Pick<Env, "SHIBA_HOSTED_PROVIDER_KILL_SWITCH">): boolean {
  const raw = env.SHIBA_HOSTED_PROVIDER_KILL_SWITCH?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

export function hostedProviderStoppedResponse(): Response {
  return new Response(HOSTED_PROVIDER_KILL_SWITCH_MESSAGE, { status: 503, headers: { "x-shiba-error": "hosted_provider_access_disabled" } });
}
