import type { AuditEnv } from "./audit.js";
import { initAudit } from "./audit.js";
import {
  getDecryptedOrgSecret,
  getOrgSecretMeta,
  putOrgSecret,
  type StoredSecretMeta,
} from "./org-secrets-store.js";
import { InputError, validateRunnerUrl } from "./security.js";

const STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS org_sandbox_settings (
     org_id TEXT PRIMARY KEY,
     provider_id TEXT NOT NULL,
     computesdk_backend TEXT,
     runner_url TEXT,
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
  // Safe migration: add runner_url column if table already existed without it
  try {
    await env.AGENT_AUDIT.prepare(
      `ALTER TABLE org_sandbox_settings ADD COLUMN runner_url TEXT`,
    ).run();
  } catch (error) {
    if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
  initialized.add(env.AGENT_AUDIT);
}

export interface OrgSandboxSettings {
  orgId: string;
  providerId: string;
  computesdkBackend?: string;
  runnerUrl?: string;
  runnerTokenMeta?: StoredSecretMeta;
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
  const tokenMeta = await getOrgSecretMeta(env, orgId, "sandbox", "runner_token");
  return {
    orgId: String(row.org_id),
    providerId: String(row.provider_id),
    ...(row.computesdk_backend != null
      ? { computesdkBackend: String(row.computesdk_backend) }
      : {}),
    ...(row.runner_url != null ? { runnerUrl: String(row.runner_url) } : {}),
    runnerTokenMeta: tokenMeta,
    updatedAt: Number(row.updated_at),
  };
}

export interface SetOrgSandboxParams {
  providerId: string;
  computesdkBackend?: string;
  runnerUrl?: string;
  runnerToken?: string;
}

export async function setOrgSandboxProvider(
  env: AuditEnv & { MODEL_CREDENTIAL_KEY?: string },
  orgId: string,
  params: SetOrgSandboxParams | string,
  legacyBackend?: string,
): Promise<OrgSandboxSettings> {
  await ensure(env);
  const now = Date.now();
  const providerId = typeof params === "string" ? params : params.providerId;
  const computesdkBackend = typeof params === "string" ? legacyBackend : params.computesdkBackend;
  let runnerUrl = typeof params === "object" ? params.runnerUrl : undefined;
  if (runnerUrl) {
    runnerUrl = validateRunnerUrl(runnerUrl);
  }
  const runnerToken = typeof params === "object" ? params.runnerToken : undefined;

  if (runnerUrl && !runnerToken?.trim()) {
    // A stored token must never be re-bound to a different URL.
    const existing = await getOrgSandboxProvider(env, orgId);
    if (existing?.runnerUrl !== runnerUrl) {
      throw new InputError("runnerToken is required when setting or changing runnerUrl.");
    }
  }

  if (runnerToken?.trim()) {
    await putOrgSecret(env, orgId, "sandbox", "runner_token", runnerToken.trim());
  }

  await env.AGENT_AUDIT.prepare(
    `INSERT INTO org_sandbox_settings (org_id, provider_id, computesdk_backend, runner_url, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET
       provider_id = excluded.provider_id,
       computesdk_backend = COALESCE(excluded.computesdk_backend, org_sandbox_settings.computesdk_backend),
       runner_url = COALESCE(excluded.runner_url, org_sandbox_settings.runner_url),
       updated_at = excluded.updated_at`,
  )
    .bind(orgId, providerId, computesdkBackend ?? null, runnerUrl ?? null, now)
    .run();

  const tokenMeta = await getOrgSecretMeta(env, orgId, "sandbox", "runner_token");

  return {
    orgId,
    providerId,
    ...(computesdkBackend ? { computesdkBackend } : {}),
    ...(runnerUrl ? { runnerUrl } : {}),
    runnerTokenMeta: tokenMeta,
    updatedAt: now,
  };
}

export async function getDecryptedOrgRunnerToken(
  env: AuditEnv & { MODEL_CREDENTIAL_KEY?: string },
  orgId: string,
): Promise<string | null> {
  return getDecryptedOrgSecret(env, orgId, "sandbox", "runner_token");
}
