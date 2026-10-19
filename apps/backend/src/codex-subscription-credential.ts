import type { Env } from "./env.js";
import { refreshCodexAuthJson } from "./codex-token-refresh.js";
import {
  loadUserSubscriptionAuthJson,
  modelCredentialKeyConfigured,
  persistUserSubscriptionAuthJson,
} from "./subscription-credentials.js";
import { parseCodexAuthJson } from "@shiba/shared";

export function codexSubscriptionSecretName(account: string): string {
  return account === "default" ? "CODEX_SUBSCRIPTION_AUTH_JSON" : `CODEX_SUBSCRIPTION_AUTH_JSON_${account.toUpperCase().replace(/-/g, "_")}`;
}

export function workerSecretAuthJson(env: Env, account: string): string | undefined {
  const secretName = codexSubscriptionSecretName(account);
  const value = (env as unknown as Record<string, unknown>)[secretName];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Resolve auth.json for one codex-subscription egress hop. Per-user storage
 * wins when initiatorUserId is set; Worker secrets apply only in SHIBA_SINGLE_USER=1.
 */
export async function resolveCodexSubscriptionAuthJson(
  env: Env,
  params: { account?: string; userId?: string },
): Promise<string | null> {
  const account = typeof params.account === "string" && params.account !== "" ? params.account : "default";
  const userId = typeof params.userId === "string" && params.userId !== "" ? params.userId : undefined;
  if (userId && modelCredentialKeyConfigured(env)) {
    let raw = await loadUserSubscriptionAuthJson(env, userId);
    if (raw === null) return null;
    try {
      const refreshed = await refreshCodexAuthJson(raw);
      if (refreshed.rotated) {
        await persistUserSubscriptionAuthJson(env, userId, refreshed.authJson);
      }
      raw = refreshed.authJson;
    } catch {
      // Expired without refresh — fail closed at parse/forward time.
    }
    return raw;
  }
  if (env.SHIBA_SINGLE_USER === "1") {
    return workerSecretAuthJson(env, account) ?? null;
  }
  return null;
}

export function parseResolvedCodexCredential(raw: string | null) {
  if (raw === null) return null;
  return parseCodexAuthJson(raw);
}
