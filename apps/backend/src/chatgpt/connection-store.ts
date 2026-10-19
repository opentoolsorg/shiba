/**
 * Encrypted ChatGPT SIWC connection blobs on AGENT_AUDIT D1 (per user).
 */
import type { Env } from "../env.js";
import {
  decryptAuthJson,
  encryptAuthJson,
  ensureSubscriptionCredentialSchema,
  modelCredentialKeyConfigured,
  OPENAI_SUBSCRIPTION_KIND,
  DEFAULT_WORKSPACE_ID,
} from "../subscription-credentials.js";
import type { ChatGptConnectionRecord } from "./siwc.js";

const HOST_KIND = "chatgpt-host-id";

export async function loadHostId(env: Env, userId: string, workspaceId = DEFAULT_WORKSPACE_ID): Promise<string | null> {
  if (!modelCredentialKeyConfigured(env)) return null;
  await ensureSubscriptionCredentialSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT auth_cipher FROM user_subscription_credentials WHERE workspace_id = ? AND user_id = ? AND kind = ?`,
  )
    .bind(workspaceId, userId, HOST_KIND)
    .first<{ auth_cipher: string }>();
  if (!row) return null;
  const plain = await decryptAuthJson(row.auth_cipher, env.MODEL_CREDENTIAL_KEY!, workspaceId, userId, HOST_KIND);
  const parsed = JSON.parse(plain) as { hostId?: string };
  return typeof parsed.hostId === "string" ? parsed.hostId : null;
}

export async function saveHostId(env: Env, userId: string, hostId: string, workspaceId = DEFAULT_WORKSPACE_ID): Promise<void> {
  if (!modelCredentialKeyConfigured(env)) throw new Error("MODEL_CREDENTIAL_KEY not configured.");
  await ensureSubscriptionCredentialSchema(env);
  const cipher = await encryptAuthJson(
    JSON.stringify({ hostId }),
    env.MODEL_CREDENTIAL_KEY!,
    workspaceId,
    userId,
    HOST_KIND,
  );
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO user_subscription_credentials (workspace_id, user_id, kind, auth_cipher, account_email_hash, expires_at, saved_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(workspace_id, user_id, kind) DO UPDATE SET auth_cipher = excluded.auth_cipher, saved_at = excluded.saved_at`,
  )
    .bind(workspaceId, userId, HOST_KIND, cipher, Date.now())
    .run();
}

export async function loadConnection(
  env: Env,
  userId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<ChatGptConnectionRecord | null> {
  if (!modelCredentialKeyConfigured(env)) return null;
  await ensureSubscriptionCredentialSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT auth_cipher FROM user_subscription_credentials WHERE workspace_id = ? AND user_id = ? AND kind = ?`,
  )
    .bind(workspaceId, userId, OPENAI_SUBSCRIPTION_KIND)
    .first<{ auth_cipher: string }>();
  if (!row) return null;
  const plain = await decryptAuthJson(
    row.auth_cipher,
    env.MODEL_CREDENTIAL_KEY!,
    workspaceId,
    userId,
    OPENAI_SUBSCRIPTION_KIND,
  );
  return JSON.parse(plain) as ChatGptConnectionRecord;
}

export async function saveConnection(
  env: Env,
  userId: string,
  record: ChatGptConnectionRecord,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<void> {
  if (!modelCredentialKeyConfigured(env)) throw new Error("MODEL_CREDENTIAL_KEY not configured.");
  await ensureSubscriptionCredentialSchema(env);
  const cipher = await encryptAuthJson(
    JSON.stringify(record),
    env.MODEL_CREDENTIAL_KEY!,
    workspaceId,
    userId,
    OPENAI_SUBSCRIPTION_KIND,
  );
  const emailHash = record.email
    ? await crypto.subtle
        .digest("SHA-256", new TextEncoder().encode(record.email.trim().toLowerCase()))
        .then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""))
    : null;
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO user_subscription_credentials
      (workspace_id, user_id, kind, auth_cipher, account_email_hash, expires_at, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, user_id, kind) DO UPDATE SET
      auth_cipher = excluded.auth_cipher,
      account_email_hash = excluded.account_email_hash,
      expires_at = excluded.expires_at,
      saved_at = excluded.saved_at`,
  )
    .bind(workspaceId, userId, OPENAI_SUBSCRIPTION_KIND, cipher, emailHash, record.expiresAt, Date.now())
    .run();
}

export async function deleteConnection(env: Env, userId: string, workspaceId = DEFAULT_WORKSPACE_ID): Promise<void> {
  await ensureSubscriptionCredentialSchema(env);
  await env.AGENT_AUDIT.prepare(
    `DELETE FROM user_subscription_credentials WHERE workspace_id = ? AND user_id = ? AND kind = ?`,
  )
    .bind(workspaceId, userId, OPENAI_SUBSCRIPTION_KIND)
    .run();
}
