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

export function sessionExpiryMs(raw: number | string): number | null {
  const value = typeof raw === "number" ? raw : raw.trim() === "" ? NaN : Number.isFinite(Number(raw)) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}
