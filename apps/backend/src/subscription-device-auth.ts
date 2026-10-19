/**
 * Per-user OpenAI auth mode — SIWC (Worker) vs device-auth (sandbox volume only).
 */
import type { Env } from "./env.js";
import { codexDeviceAuthVolumeForUser } from "./harness/codex-device-auth.js";

export type OpenAiUserAuthMode = "siwc" | "device-auth";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS user_openai_auth_mode (
    user_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];
const initialized = new WeakSet<D1Database>();

async function ensureSchema(env: Pick<Env, "AGENT_AUDIT">): Promise<void> {
  if (!env.AGENT_AUDIT) throw new Error("Auth mode storage unavailable.");
  if (initialized.has(env.AGENT_AUDIT)) return;
  await env.AGENT_AUDIT.batch(SCHEMA.map((sql) => env.AGENT_AUDIT.prepare(sql)));
  initialized.add(env.AGENT_AUDIT);
}

export async function readUserOpenAiAuthMode(
  env: Env,
  userId: string,
): Promise<OpenAiUserAuthMode | null> {
  if (!env.AGENT_AUDIT) return null;
  await ensureSchema(env);
  const row = await env.AGENT_AUDIT.prepare(`SELECT mode FROM user_openai_auth_mode WHERE user_id = ?`)
    .bind(userId)
    .first<{ mode: string }>();
  if (!row) return null;
  return row.mode === "device-auth" ? "device-auth" : row.mode === "siwc" ? "siwc" : null;
}

export async function setUserOpenAiAuthMode(
  env: Env,
  userId: string,
  mode: OpenAiUserAuthMode,
): Promise<void> {
  await ensureSchema(env);
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO user_openai_auth_mode (user_id, mode, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
  )
    .bind(userId, mode, Date.now())
    .run();
}

export async function clearUserOpenAiAuthMode(env: Env, userId: string): Promise<void> {
  if (!env.AGENT_AUDIT) return;
  await ensureSchema(env);
  await env.AGENT_AUDIT.prepare(`DELETE FROM user_openai_auth_mode WHERE user_id = ?`).bind(userId).run();
}

export function deviceAuthVolumeHint(userId: string): string | null {
  return codexDeviceAuthVolumeForUser(userId)?.containerPath ?? null;
}
