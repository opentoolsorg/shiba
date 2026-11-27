import { resolveBetterAuthSessionAccount } from "@shiba/auth/better-auth";
import type { Env } from "../env.js";
import { redactSecrets } from "../security.js";
import type { WorkspaceNativeMember } from "../workspace-native-authority.js";
import { FOUNDER_SQL_NOW } from "./founder-connector-context.js";

export interface NativeSession { id: string; userId: string; expiresAt: number }

export async function resolveNativeSession(request: Request, env: Env, member: WorkspaceNativeMember): Promise<NativeSession | null> {
  if (!request.headers.has("cookie") || request.headers.has("authorization")) return null;
  const session = await resolveBetterAuthSessionAccount(request, env, redactSecrets);
  if (!session?.emailVerified || !session.sessionId || !session.sessionExpiresAt || session.policy.accountId !== member.accountId || session.policy.email !== member.userId || session.sessionExpiresAt <= Date.now()) return null;
  return { id: session.sessionId, userId: member.accountId, expiresAt: session.sessionExpiresAt };
}

export function nativeSessionFence(session: NativeSession, alias = "ns"): { sql: string; values: [string, string, number, number] } {
  const expiry = `CASE WHEN typeof(${alias}.expiresAt) IN ('integer','real') THEN ${alias}.expiresAt ELSE (CAST(strftime('%s',${alias}.expiresAt) AS INTEGER)*1000+CAST(substr(strftime('%f',${alias}.expiresAt),4,3) AS INTEGER)) END`;
  return {
    sql: `EXISTS(SELECT 1 FROM "session" ${alias} WHERE ${alias}.id=? AND ${alias}.userId=? AND ${expiry}>${FOUNDER_SQL_NOW} AND ${expiry}>=?) AND ?>${FOUNDER_SQL_NOW}`,
    values: [session.id, session.userId, session.expiresAt, session.expiresAt],
  };
}

/**
 * The human-session rule for a statement that must also learn the deadline: the row's own expiry as a SELECT
 * column, the fence for the WHERE clause, and the fold that turns both into one deadline.
 */
export function nativeSessionProof(session: NativeSession) {
  const fence = nativeSessionFence(session);
  return {
    select: '(SELECT expiresAt FROM "session" WHERE id=? AND userId=?) AS session_expires',
    selectValues: [session.id, session.userId] as unknown[],
    where: fence.sql,
    whereValues: fence.values as unknown[],
    /** min(captured expiry, the row's expiry now); NaN when the row is missing or unreadable, so `Date.now() < deadline` refuses. */
    deadline: (raw: number | string | null | undefined) => Math.min(session.expiresAt, raw == null ? NaN : sessionExpiryMs(raw) ?? NaN),
  };
}

export function sessionExpiryMs(raw: number | string): number | null {
  const value = typeof raw === "number" ? raw : raw.trim() === "" ? NaN : Number.isFinite(Number(raw)) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The one way to ask "is it too late?". Passed unless EVERY candidate is a finite time still ahead of the clock:
 * null, undefined, NaN, an unparseable stored expiry, an infinite value or no candidate at all refuse.
 * Never compare `Date.now()` with `Math.min(...)` of an expiry directly; NaN there compares false and lets the step through.
 */
export function deadlinePassed(...candidates: Array<number | null | undefined>): boolean {
  return !candidates.length || candidates.some((candidate) => typeof candidate !== "number" || !Number.isFinite(candidate) || Date.now() >= candidate);
}
