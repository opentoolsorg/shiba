import type { AuditEnv } from "./audit.js";
import { initAudit } from "./audit.js";

const STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS org_sandbox_settings (
     org_id TEXT PRIMARY KEY,
     provider_id TEXT NOT NULL,
     computesdk_backend TEXT,
     updated_at INTEGER NOT NULL
   )`,
];

const initialized = new WeakSet<D1Database>();

async function ensure(env: AuditEnv): Promise<void> {
  if (initialized.has(env.AGENT_AUDIT)) return;
  await initAudit(env);
  for (const statement of STATEMENTS) {
    await env.AGENT_AUDIT.prepare(statement).run();
  }
  initialized.add(env.AGENT_AUDIT);
}

export interface OrgSandboxSettings {
  orgId: string;
  providerId: string;
  computesdkBackend?: string;
  updatedAt: number;
}

export async function getOrgSandboxProvider(
  env: AuditEnv,
  orgId: string,
): Promise<OrgSandboxSettings | null> {
  await ensure(env);
  const row = await env.AGENT_AUDIT.prepare(`SELECT * FROM org_sandbox_settings WHERE org_id = ?`)
    .bind(orgId)
    .first();
  if (!row) return null;
  return {
    orgId: String(row.org_id),
    providerId: String(row.provider_id),
    ...(row.computesdk_backend != null ? { computesdkBackend: String(row.computesdk_backend) } : {}),
    updatedAt: Number(row.updated_at),
  };
}

export async function setOrgSandboxProvider(
  env: AuditEnv,
  orgId: string,
  providerId: string,
  computesdkBackend?: string,
): Promise<OrgSandboxSettings> {
  await ensure(env);
  const now = Date.now();
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO org_sandbox_settings (org_id, provider_id, computesdk_backend, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET provider_id = excluded.provider_id,
       computesdk_backend = excluded.computesdk_backend, updated_at = excluded.updated_at`,
  )
    .bind(orgId, providerId, computesdkBackend ?? null, now)
    .run();
  return {
    orgId,
    providerId,
    ...(computesdkBackend ? { computesdkBackend } : {}),
    updatedAt: now,
  };
}
