/** Authoritative account provenance. Cookies and claimed email addresses never grant this policy. */
export interface BetterAuthAccountPolicy {
  accountId: string;
  email: string;
  kind: "bootstrap" | "invited";
  invitationId: string | null;
  workspaceId: string | null;
}

interface PolicyRow {
  account_id: string;
  email: string;
  kind: "bootstrap" | "invited";
  invitation_id: string | null;
  workspace_id: string | null;
}


export async function readBetterAuthAccountPolicy(db: D1Database, accountId: string): Promise<BetterAuthAccountPolicy | null> {
  const row = await db.prepare(`SELECT account_id,email,kind,invitation_id,workspace_id
    FROM shiba_auth_account_policy WHERE account_id=?`).bind(accountId).first<PolicyRow>();
  return row ? { accountId: row.account_id, email: row.email, kind: row.kind,
    invitationId: row.invitation_id, workspaceId: row.workspace_id } : null;
}

export async function recordBetterAuthAccountPolicy(db: D1Database, policy: BetterAuthAccountPolicy): Promise<void> {
  // An orphan policy after a failed account insert is harmless and cannot be
  // reassigned. The unique bootstrap slot also closes concurrent-first-signup races.
  await db.prepare(`INSERT INTO shiba_auth_account_policy(account_id,email,kind,invitation_id,workspace_id)
    VALUES(?,?,?,?,?)`).bind(policy.accountId, policy.email, policy.kind, policy.invitationId, policy.workspaceId).run();
}
