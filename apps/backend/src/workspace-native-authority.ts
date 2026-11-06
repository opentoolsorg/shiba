import { resolveBetterAuthSessionAccount } from "@shiba/auth/better-auth";
import type { TeamWorkspaceMembership } from "@shiba/shared";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";

export type WorkspaceNativeMember = TeamWorkspaceMembership & { accountId: string };
export function nativeWorkspaceAccountSql(member: Pick<WorkspaceNativeMember, "accountId" | "userId">) {
  if (!member.accountId) throw new Error("workspace_native_identity_required");
  return { sql: `EXISTS(SELECT 1 FROM shiba_auth_account_policy p JOIN "user" u ON u.id=p.account_id
    WHERE p.account_id=? AND p.email=? AND lower(u.email)=? AND u.emailVerified=1)`,
    values: [member.accountId, member.userId, member.userId] };
}
export async function isWorkspaceNativeAccountCurrent(env: Env, member: WorkspaceNativeMember): Promise<boolean> {
  if (!env.AGENT_AUDIT || !member.accountId) return false;
  try {
    const guard = nativeWorkspaceAccountSql(member);
    return Boolean(await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${guard.sql}`).bind(...guard.values).first());
  } catch { return false; }
}
/** The native account ID is an auth-store identity, never a hash or a client assertion. */
export async function resolveWorkspaceNativeMember(request: Request, env: Env, member: TeamWorkspaceMembership): Promise<WorkspaceNativeMember | null> {
  if (request.headers.has("authorization")) return null;
  const account = await resolveBetterAuthSessionAccount(request, env, redactSecrets);
  if (!account?.emailVerified || account.policy.email !== member.userId) return null;
  const native = { ...member, accountId: account.policy.accountId };
  return await isWorkspaceNativeAccountCurrent(env, native) ? native : null;
}
/** Grant selection resolves the target's current verified account from the server store. */
export async function resolveWorkspaceNativeGrantTarget(env: Env, member: TeamWorkspaceMembership): Promise<WorkspaceNativeMember | null> {
  try {
    const rows = await env.AGENT_AUDIT.prepare(`SELECT p.account_id FROM shiba_auth_account_policy p JOIN "user" u ON u.id=p.account_id
      WHERE p.email=? AND lower(u.email)=? AND u.emailVerified=1 LIMIT 2`).bind(member.userId, member.userId).all<{ account_id: string }>();
    return rows.results.length === 1 ? { ...member, accountId: rows.results[0]!.account_id } : null;
  } catch { return null; }
}
