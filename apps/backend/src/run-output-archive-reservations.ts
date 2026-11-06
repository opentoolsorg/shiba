import { stableHash, runOutputArchivePolicySchema, RUN_OUTPUT_ARCHIVE_MAX_LEASE_MS, type RunOutputArchivePolicy } from "@shiba/shared";
import type { Env } from "./env.js";

type ArchiveEnv = Pick<Env, "AGENT_AUDIT">;
export type ArchiveReservation = {
  id: string; ownerId: string; ownerAccountId: string; sessionId: string; runId: string; sandboxId: string;
  approvalId: string; inputHash: string; envelopeHash: string; jobId: string; commandIdentity: string;
  policy: RunOutputArchivePolicy; issuedAt: number; writeDeadline: number;
};
/** A native account is an immutable auth-store UUID, never a client/email-derived ID. */
export async function resolveArchiveOwnerAccount(env: ArchiveEnv, ownerId: string): Promise<string | null> {
  try {
    const rows = await env.AGENT_AUDIT.prepare(`SELECT p.account_id FROM shiba_auth_account_policy p JOIN "user" u ON u.id=p.account_id
      WHERE p.kind='bootstrap' AND p.email=? AND lower(u.email)=? AND u.emailVerified=1 LIMIT 2`).bind(ownerId, ownerId).all<{ account_id: string }>();
    return rows.results.length === 1 ? rows.results[0]!.account_id : null;
  } catch { return null; }
}
export const archiveNativeSql = `EXISTS(SELECT 1 FROM shiba_auth_account_policy p JOIN "user" u ON u.id=p.account_id
  WHERE p.account_id=r.owner_account_id AND p.email=r.owner_id AND p.kind='bootstrap' AND lower(u.email)=r.owner_id AND u.emailVerified=1)`;
export function archiveReservationDigest(value: ArchiveReservation): string { return stableHash(value as unknown as import("@shiba/shared").JsonValue); }
export function validateArchiveReservation(value: ArchiveReservation, now = Date.now()): void {
  const policy = runOutputArchivePolicySchema.parse(value.policy);
  if (value.ownerId !== value.ownerId.trim().toLowerCase() || !value.ownerId || value.ownerId.length > 320 ||
    value.ownerAccountId !== policy.ownerAccountId || !value.sessionId || !value.runId || value.runId.length > 200 ||
    !value.sandboxId || !value.approvalId || ![value.id, value.inputHash, value.envelopeHash, value.jobId, value.commandIdentity].every((item) => /^[a-f0-9]{64}$/.test(item)) ||
    !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.writeDeadline) || value.issuedAt > now ||
    value.writeDeadline <= value.issuedAt || value.writeDeadline > value.issuedAt + 45 * 60_000 ||
    policy.expiresAt <= now || policy.expiresAt > value.issuedAt + RUN_OUTPUT_ARCHIVE_MAX_LEASE_MS) throw new Error("Output archive authority is invalid or expired.");
}
/** One SQLite statement reserves the entire lease before any source START. Unknown work never releases it early. */
export async function reserveRunOutputArchive(env: ArchiveEnv, value: ArchiveReservation, now = Date.now()): Promise<void> {
  validateArchiveReservation(value, now);
  const digest = archiveReservationDigest(value), policy = value.policy;
  await env.AGENT_AUDIT.prepare(`INSERT OR IGNORE INTO run_output_archive_reservations
    (id,owner_id,owner_account_id,session_id,run_id,sandbox_id,job_id,digest,contract_json,max_bytes,expires_at,state,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,'reserved',? WHERE EXISTS(SELECT 1 FROM shiba_auth_account_policy p JOIN "user" u ON u.id=p.account_id
      WHERE p.account_id=? AND p.email=? AND p.kind='bootstrap' AND lower(u.email)=? AND u.emailVerified=1)
    AND (SELECT count(*) FROM run_output_archive_reservations WHERE owner_account_id=? AND expires_at>?) < ?
    AND (SELECT coalesce(sum(max_bytes),0) FROM run_output_archive_reservations WHERE owner_account_id=? AND expires_at>?) + ? <= ?
    AND (SELECT count(*) FROM run_output_archive_reservations WHERE owner_account_id=? AND session_id=? AND expires_at>?) < ?
    AND (SELECT coalesce(sum(max_bytes),0) FROM run_output_archive_reservations WHERE owner_account_id=? AND session_id=? AND expires_at>?) + ? <= ?`)
    .bind(value.id, value.ownerId, value.ownerAccountId, value.sessionId, value.runId, value.sandboxId, value.jobId, digest, JSON.stringify(value), policy.maxBytes, policy.expiresAt, now,
      value.ownerAccountId, value.ownerId, value.ownerId, value.ownerAccountId, now, policy.ownerMaxArchives,
      value.ownerAccountId, now, policy.maxBytes, policy.ownerMaxBytes, value.ownerAccountId, value.sessionId, now, policy.roomMaxArchives,
      value.ownerAccountId, value.sessionId, now, policy.maxBytes, policy.roomMaxBytes).run();
  await assertArchiveReservationCurrent(env, value, now);
}
export async function assertArchiveReservationCurrent(env: ArchiveEnv, value: ArchiveReservation, now = Date.now()): Promise<void> {
  validateArchiveReservation(value, now);
  const row = await env.AGENT_AUDIT.prepare(`SELECT r.digest FROM run_output_archive_reservations r WHERE r.id=? AND r.owner_id=?
    AND r.owner_account_id=? AND r.state='reserved' AND r.expires_at>? AND ${archiveNativeSql}`)
    .bind(value.id, value.ownerId, value.ownerAccountId, now).first<{ digest: string }>();
  if (!row || row.digest !== archiveReservationDigest(value)) throw new Error("Output archive capacity or native source authority is unavailable.");
}
export async function revokeRoomOutputArchives(env: ArchiveEnv, ownerId: string, sessionId: string): Promise<void> {
  if (!env.AGENT_AUDIT) return; // No reservation can ever have been made without this binding.
  await env.AGENT_AUDIT.prepare("UPDATE run_output_archive_reservations SET state='revoked' WHERE owner_id=? AND session_id=?")
    .bind(ownerId, sessionId).run();
}
