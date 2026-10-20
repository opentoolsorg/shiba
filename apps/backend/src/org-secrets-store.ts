import type { AuditEnv } from "./audit.js";
import { initAudit } from "./audit.js";
import {
  decryptAuthJson,
  encryptAuthJson,
  modelCredentialKeyConfigured,
} from "./subscription-credentials.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS org_secrets (
     org_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     name TEXT NOT NULL,
     cipher TEXT NOT NULL,
     last4 TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (org_id, kind, name)
   )`,
];

const initialized = new WeakSet<D1Database>();

async function ensure(env: AuditEnv): Promise<void> {
  if (initialized.has(env.AGENT_AUDIT)) return;
  await initAudit(env);
  for (const statement of SCHEMA) {
    await env.AGENT_AUDIT.prepare(statement).run();
  }
  initialized.add(env.AGENT_AUDIT);
}

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
  await ensure(env);
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
  await ensure(env);
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
  await ensure(env);
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
  await ensure(env);
  await env.AGENT_AUDIT.prepare(
    `DELETE FROM org_secrets WHERE org_id = ? AND kind = ? AND name = ?`,
  )
    .bind(orgId, kind, name)
    .run();
}
