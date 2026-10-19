import type { Env } from "./env.js";
import {
  loadUserSubscriptionAuthJson,
  modelCredentialKeyConfigured,
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
 * Resolve auth.json for legacy T47 verify (/api/auth/codex-subscription).
 * Harness runs mount credentials in the sandbox instead of egress injection.
 */
export async function resolveCodexSubscriptionAuthJson(
  env: Env,
  params: { account?: string; userId?: string },
): Promise<string | null> {
  const account = typeof params.account === "string" && params.account !== "" ? params.account : "default";
  const userId = typeof params.userId === "string" && params.userId !== "" ? params.userId : undefined;
  if (userId && modelCredentialKeyConfigured(env)) {
    return loadUserSubscriptionAuthJson(env, userId);
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
