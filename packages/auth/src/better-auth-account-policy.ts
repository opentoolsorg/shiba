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

export async function ensureBetterAuthAccountPolicy(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS shiba_auth_account_policy (
    account_id TEXT NOT NULL PRIMARY KEY, email TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('bootstrap','invited')),
    invitation_id TEXT, workspace_id TEXT,
    CHECK((kind='bootstrap' AND invitation_id IS NULL AND workspace_id IS NULL)
      OR (kind='invited' AND invitation_id IS NOT NULL AND workspace_id IS NOT NULL)))`).run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS shiba_auth_one_bootstrap
    ON shiba_auth_account_policy(kind) WHERE kind='bootstrap'`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS shiba_auth_policy_migrations (
    migration_id TEXT NOT NULL PRIMARY KEY)`).run();
  // D1 batch is transactional. Only the one existing bootstrap account may retain
  // its old unverified-email identity. An unexpected multi-user database trusts none.
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO shiba_auth_account_policy(account_id,email,kind)
      SELECT id,lower(trim(email)),'bootstrap' FROM "user"
      WHERE (SELECT COUNT(*) FROM "user")=1
      AND NOT EXISTS(SELECT 1 FROM shiba_auth_policy_migrations WHERE migration_id='legacy-bootstrap-v1')`),
    db.prepare(`INSERT OR IGNORE INTO shiba_auth_policy_migrations(migration_id) VALUES('legacy-bootstrap-v1')`),
  ]);
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
