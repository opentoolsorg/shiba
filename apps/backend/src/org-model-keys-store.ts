import type { AuditEnv } from "./audit.js";
import {
  deleteOrgSecret,
  getDecryptedOrgSecret,
  getOrgSecretMeta,
  putOrgSecret,
} from "./org-secrets-store.js";

export const SUPPORTED_MODEL_PROVIDERS = ["anthropic", "openai", "google", "xai"] as const;

export type SupportedModelProvider = (typeof SUPPORTED_MODEL_PROVIDERS)[number];

export function isSupportedModelProvider(raw: string): raw is SupportedModelProvider {
  return (SUPPORTED_MODEL_PROVIDERS as readonly string[]).includes(raw.toLowerCase());
}

export interface OrgModelKeyStatus {
  provider: SupportedModelProvider;
  configured: boolean;
  last4?: string;
  updatedAt?: number;
}

export async function setOrgModelKey(
  env: AuditEnv & { MODEL_CREDENTIAL_KEY?: string },
  orgId: string,
  provider: SupportedModelProvider,
  apiKey: string,
): Promise<OrgModelKeyStatus> {
  const meta = await putOrgSecret(env, orgId, "model_key", provider, apiKey);
  return {
    provider,
    configured: true,
    last4: meta.last4,
    updatedAt: meta.updatedAt,
  };
}

export async function getOrgModelKeyStatus(
  env: AuditEnv,
  orgId: string,
  provider: SupportedModelProvider,
): Promise<OrgModelKeyStatus> {
  const meta = await getOrgSecretMeta(env, orgId, "model_key", provider);
  return {
    provider,
    configured: meta.configured,
    ...(meta.last4 ? { last4: meta.last4 } : {}),
    ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
  };
}

export async function listOrgModelKeyStatuses(
  env: AuditEnv,
  orgId: string,
): Promise<OrgModelKeyStatus[]> {
  const results: OrgModelKeyStatus[] = [];
  for (const provider of SUPPORTED_MODEL_PROVIDERS) {
    results.push(await getOrgModelKeyStatus(env, orgId, provider));
  }
  return results;
}

export async function getDecryptedOrgModelKey(
  env: AuditEnv & { MODEL_CREDENTIAL_KEY?: string },
  orgId: string,
  provider: SupportedModelProvider,
): Promise<string | null> {
  return getDecryptedOrgSecret(env, orgId, "model_key", provider);
}

export async function deleteOrgModelKey(
  env: AuditEnv,
  orgId: string,
  provider: SupportedModelProvider,
): Promise<void> {
  await deleteOrgSecret(env, orgId, "model_key", provider);
}
