import type { AuditEnv } from "./audit.js";
import {
  decryptAuthJson,
  encryptAuthJson,
  modelCredentialKeyConfigured,
} from "./subscription-credentials.js";

export interface StoredSecretMeta {
  configured: boolean;
  last4?: string;
  updatedAt?: number;
}

export async function putOrgSecret(
  env: AuditEnv & { MODEL_CREDENTIAL_KEY?: string },
  orgId: string,
  kind: string,
  name: string,
  secretValue: string,
): Promise<StoredSecretMeta> {
  const modelKey = env.MODEL_CREDENTIAL_KEY?.trim();
  if (!modelKey || modelKey.length !== 64) {
    throw new Error("MODEL_CREDENTIAL_KEY is not configured.");
  }
  const trimmed = secretValue.trim();
  const last4 = trimmed.slice(-4);
  const now = Date.now();
  const cipher = await encryptAuthJson(trimmed, modelKey, orgId, name, kind);

  await env.AGENT_AUDIT.prepare(
    `INSERT INTO org_secrets (org_id, kind, name, cipher, last4, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, kind, name) DO UPDATE SET
       cipher = excluded.cipher,
       last4 = excluded.last4,
       updated_at = excluded.updated_at`,
  )
    .bind(orgId, kind, name, cipher, last4, now)
    .run();

  return {
    configured: true,
    last4,
    updatedAt: now,
  };
}

export async function getOrgSecretMeta(
  env: AuditEnv,
  orgId: string,
  kind: string,
  name: string,
): Promise<StoredSecretMeta> {
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT last4, updated_at FROM org_secrets WHERE org_id = ? AND kind = ? AND name = ?`,
  )
    .bind(orgId, kind, name)
    .first<{ last4: string; updated_at: number }>();

  if (!row) return { configured: false };
  return {
    configured: true,
    last4: String(row.last4),
    updatedAt: Number(row.updated_at),
  };
}

export async function getDecryptedOrgSecret(
  env: AuditEnv & { MODEL_CREDENTIAL_KEY?: string },
  orgId: string,
  kind: string,
  name: string,
): Promise<string | null> {
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT cipher FROM org_secrets WHERE org_id = ? AND kind = ? AND name = ?`,
  )
    .bind(orgId, kind, name)
    .first<{ cipher: string }>();

  if (!row) return null;
  // A stored secret that cannot be read must fail, not fall back to a shared credential.
  const modelKey = env.MODEL_CREDENTIAL_KEY?.trim();
  if (!modelKey || modelKey.length !== 64) {
    throw new Error("MODEL_CREDENTIAL_KEY is not configured.");
  }
  return decryptAuthJson(row.cipher, modelKey, orgId, name, kind);
}

export async function deleteOrgSecret(
  env: AuditEnv,
  orgId: string,
  kind: string,
  name: string,
): Promise<void> {
  await env.AGENT_AUDIT.prepare(
    `DELETE FROM org_secrets WHERE org_id = ? AND kind = ? AND name = ?`,
  )
    .bind(orgId, kind, name)
    .run();
}
