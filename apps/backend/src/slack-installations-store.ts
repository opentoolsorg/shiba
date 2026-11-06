import { SLACK_BOT_SCOPES, type SlackInstallationSnapshot, type SlackInstallationPublic, type SlackInstallationDecision, type SlackInstallationState } from "@shiba/shared";
import type { Env } from "./env.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
import { ensureTeamWorkspacesSchema } from "./team-workspaces-store.js";
import { assertWorkspaceMemberCurrent, membershipSql } from "./workspace-integrations-store.js";
import { openSlackSecret, SlackInstallationError, slackKeyringConfigured } from "./slack-installations-crypto.js";
import { hashToolArgs } from "./mcp-gateway.js";

export interface SlackInstallationEnv extends Env {
  SLACK_INSTALLATIONS_ENABLED?: string; SLACK_OAUTH_APP_ID?: string; SLACK_OAUTH_CLIENT_ID?: string; SLACK_OAUTH_REDIRECT_URI?: string;
  SLACK_OAUTH_PKCE_ENABLED?: string; SLACK_OAUTH_QUERY_REDACTION_VERIFIED?: string; SLACK_INSTALLATION_KEYRING?: string;
  SLACK_LEGACY_MODE_ENABLED?: string; SLACK_LEGACY_TEAM_ID?: string; SLACK_LEGACY_APP_ID?: string;
}
export interface SlackInstallationRow {
  id: string; workspace_id: string; owner_id: string; owner_account_id: string; owner_member_json: string;
  app_id: string; team_id: string; bot_user_id: string; bot_id: string; installer_slack_user_id: string; scopes_json: string;
  generation: number; version: number; token_revision: number; state: SlackInstallationPublic["state"];
  digest: string; token_key_id: string | null; token_cipher: string | null; token_expires_at: number | null;
  activation_expires_at: number; created_at: number; refresh_claim_id: string | null;
}
export const SLACK_INSTALLATION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS slack_installations (
    id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,owner_account_id TEXT NOT NULL,owner_member_json TEXT NOT NULL,
    app_id TEXT NOT NULL,team_id TEXT NOT NULL,bot_user_id TEXT NOT NULL,bot_id TEXT NOT NULL,installer_slack_user_id TEXT NOT NULL,scopes_json TEXT NOT NULL,
    generation INTEGER NOT NULL,version INTEGER NOT NULL,token_revision INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','active','refreshing','revoked','unknown','blocked')),
    digest TEXT NOT NULL,token_key_id TEXT,token_cipher TEXT,token_expires_at INTEGER,activation_expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,refresh_claim_id TEXT,UNIQUE(app_id,team_id))`,
  `CREATE INDEX IF NOT EXISTS slack_installations_workspace ON slack_installations(workspace_id,owner_account_id)`,
  `CREATE TABLE IF NOT EXISTS slack_installation_oauth (
    id TEXT PRIMARY KEY,state_hash TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL,owner_account_id TEXT NOT NULL,owner_member_json TEXT NOT NULL,
    request_id TEXT NOT NULL,input_hash TEXT NOT NULL,scopes_json TEXT NOT NULL,config_json TEXT NOT NULL,verifier_key_id TEXT NOT NULL,verifier_cipher TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','exchanging','completed','unknown','cancelled')),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
    UNIQUE(workspace_id,owner_account_id,request_id))`,
  `CREATE TABLE IF NOT EXISTS slack_installation_revocations (app_id TEXT NOT NULL,team_id TEXT NOT NULL,received_at INTEGER NOT NULL,epoch INTEGER NOT NULL,PRIMARY KEY(app_id,team_id))`,
  `CREATE TABLE IF NOT EXISTS slack_installation_events (app_id TEXT NOT NULL,team_id TEXT NOT NULL,event_id TEXT NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(app_id,team_id,event_id))`,
  `CREATE TRIGGER IF NOT EXISTS slack_installations_owner_update AFTER UPDATE OF user_id,version,role,status ON team_workspace_memberships
    WHEN OLD.user_id IS NOT NEW.user_id OR OLD.version IS NOT NEW.version OR OLD.role IS NOT NEW.role OR OLD.status IS NOT NEW.status
    BEGIN UPDATE slack_installations SET state='blocked',generation=generation+1,version=version+1,token_cipher=NULL,token_key_id=NULL
      WHERE workspace_id=OLD.workspace_id AND owner_id=OLD.user_id AND state<>'revoked';
      UPDATE slack_installation_oauth SET state='cancelled' WHERE workspace_id=OLD.workspace_id AND json_extract(owner_member_json,'$.userId')=OLD.user_id AND state='pending'; END`,
  `CREATE TRIGGER IF NOT EXISTS slack_installations_owner_delete AFTER DELETE ON team_workspace_memberships
    BEGIN UPDATE slack_installations SET state='blocked',generation=generation+1,version=version+1,token_cipher=NULL,token_key_id=NULL
      WHERE workspace_id=OLD.workspace_id AND owner_id=OLD.user_id AND state<>'revoked';
      UPDATE slack_installation_oauth SET state='cancelled' WHERE workspace_id=OLD.workspace_id AND json_extract(owner_member_json,'$.userId')=OLD.user_id AND state='pending'; END`,
] as const;
const initialized = new WeakSet<D1Database>();
export const installationNowSql = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
export async function ensureSlackInstallations(env: SlackInstallationEnv) {
  if (!env.AGENT_AUDIT) throw new SlackInstallationError("slack_installation_storage_unavailable", 503);
  if (initialized.has(env.AGENT_AUDIT)) return;
  await ensureTeamWorkspacesSchema(env);
  for (const statement of SLACK_INSTALLATION_SCHEMA) await env.AGENT_AUDIT.prepare(statement).run();
  initialized.add(env.AGENT_AUDIT);
}
export function slackOAuthConfiguration(env: SlackInstallationEnv) {
  try {
    const uri = new URL(env.SLACK_OAUTH_REDIRECT_URI ?? "");
    if (env.SLACK_INSTALLATIONS_ENABLED?.trim() !== "true" || env.SLACK_OAUTH_PKCE_ENABLED?.trim() !== "true" || env.SLACK_OAUTH_QUERY_REDACTION_VERIFIED?.trim() !== "true" || !slackKeyringConfigured(env) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(env.SLACK_OAUTH_APP_ID ?? "") || !/^[0-9]+\.[0-9]+$/.test(env.SLACK_OAUTH_CLIENT_ID ?? "") || !env.SLACK_SIGNING_SECRET?.trim() ||
      uri.protocol !== "https:" || uri.username || uri.password || uri.port || uri.search || uri.hash || uri.pathname !== "/api/slack/installations/callback") throw new Error();
    return { appId: env.SLACK_OAUTH_APP_ID!, clientId: env.SLACK_OAUTH_CLIENT_ID!, redirectUri: uri.href, pkce: "S256" as const };
  } catch { throw new SlackInstallationError("slack_installation_operator_setup_required", 503); }
}
export async function requireSlackInstallationOwner(env: SlackInstallationEnv, member: WorkspaceNativeMember) {
  await assertWorkspaceMemberCurrent(env, member, true);
  if (member.role !== "owner") throw new SlackInstallationError("slack_installation_native_owner_required", 403);
}
export function installationSnapshot(row: SlackInstallationRow): SlackInstallationSnapshot {
  const owner = JSON.parse(row.owner_member_json) as WorkspaceNativeMember;
  return { id: row.id, workspaceId: row.workspace_id, ownerId: row.owner_id, ownerAccountId: row.owner_account_id, ownerMembershipVersion: owner.version,
    appId: row.app_id, teamId: row.team_id, enterpriseId: null, botUserId: row.bot_user_id, botId: row.bot_id, installerSlackUserId: row.installer_slack_user_id,
    generation: row.generation, version: row.version, tokenRevision: row.token_revision, scopes: JSON.parse(row.scopes_json), expiresAt: row.token_expires_at };
}
export function installationPurpose(snapshot: SlackInstallationSnapshot): string { return JSON.stringify(["bot", snapshot.ownerAccountId, snapshot.appId, snapshot.teamId, snapshot.botUserId, snapshot.botId, snapshot.installerSlackUserId, snapshot.generation, snapshot.tokenRevision]); }
/** Synchronous trusted final fence, intended to compose with source/action predicates. */
export function slackInstallationGuard(snapshot: SlackInstallationSnapshot) {
  if (snapshot.enterpriseId !== null || !allowedSlackScopes(snapshot.scopes)) return { sql: "0=1", values: [] as unknown[] };
  const member: WorkspaceNativeMember = { workspaceId: snapshot.workspaceId, userId: snapshot.ownerId, accountId: snapshot.ownerAccountId, version: snapshot.ownerMembershipVersion, role: "owner", joinedAt: 0 };
  const owner = membershipSql(member, true);
  return { sql: `${owner.sql} AND EXISTS(SELECT 1 FROM slack_installations WHERE id=? AND workspace_id=? AND owner_id=? AND owner_account_id=?
    AND app_id=? AND team_id=? AND bot_user_id=? AND bot_id=? AND installer_slack_user_id=? AND generation=? AND version=? AND token_revision=? AND state='active'
    AND scopes_json=? AND token_expires_at IS ? AND (token_expires_at IS NULL OR token_expires_at>${installationNowSql}) AND token_cipher IS NOT NULL)`,
    values: [...owner.values, snapshot.id, snapshot.workspaceId, snapshot.ownerId, snapshot.ownerAccountId, snapshot.appId, snapshot.teamId, snapshot.botUserId, snapshot.botId, snapshot.installerSlackUserId,
      snapshot.generation, snapshot.version, snapshot.tokenRevision, JSON.stringify(snapshot.scopes), snapshot.expiresAt] };
}
export async function getSlackInstallation(env: SlackInstallationEnv, id: string): Promise<SlackInstallationRow | null> {
  await ensureSlackInstallations(env); return env.AGENT_AUDIT.prepare("SELECT * FROM slack_installations WHERE id=?").bind(id).first<SlackInstallationRow>();
}
export async function activeSlackInstallationForTeam(env: SlackInstallationEnv, appId: string, teamId: string): Promise<SlackInstallationSnapshot | null> {
  if (env.SLACK_INSTALLATIONS_ENABLED?.trim() !== "true" || env.SLACK_OAUTH_APP_ID !== appId) return null;
  await ensureSlackInstallations(env);
  const row = await env.AGENT_AUDIT.prepare("SELECT * FROM slack_installations WHERE app_id=? AND team_id=? AND state='active'").bind(appId, teamId).first<SlackInstallationRow>();
  if (!row) return null;
  const snapshot = installationSnapshot(row), guard = slackInstallationGuard(snapshot);
  return await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${guard.sql}`).bind(...guard.values).first() ? snapshot : null;
}
export async function slackTeamHasInstallationOrRevocation(env: SlackInstallationEnv, appId: string, teamId: string): Promise<boolean> {
  await ensureSlackInstallations(env);
  return Boolean(await env.AGENT_AUDIT.prepare("SELECT 1 AS owned FROM slack_installations WHERE app_id=? AND team_id=? UNION ALL SELECT 1 AS owned FROM slack_installation_revocations WHERE app_id=? AND team_id=? LIMIT 1").bind(appId, teamId, appId, teamId).first());
}
/** Worker-only plaintext. No route or public DTO returns this value. Caller must compose the final guard after all awaits. */
export async function readSlackInstallationCredential(env: SlackInstallationEnv, snapshot: SlackInstallationSnapshot): Promise<{ token: string }> {
  if (slackOAuthConfiguration(env).appId !== snapshot.appId) throw new SlackInstallationError("slack_installation_changed", 403);
  const row = await getSlackInstallation(env, snapshot.id), guard = slackInstallationGuard(snapshot);
  if (!row?.token_cipher || !row.token_key_id || !await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${guard.sql}`).bind(...guard.values).first()) throw new SlackInstallationError("slack_installation_changed", 403);
  const text = await openSlackSecret(env, { workspaceId: snapshot.workspaceId, subject: snapshot.id, purpose: installationPurpose(snapshot) }, { keyId: row.token_key_id, cipher: row.token_cipher });
  let value: { accessToken?: unknown };
  try { value = JSON.parse(text); } catch { throw new SlackInstallationError("slack_credential_unavailable", 503); }
  if (typeof value.accessToken !== "string" || !value.accessToken || value.accessToken.length > 16_384) throw new SlackInstallationError("slack_credential_unavailable", 503);
  if (!await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${guard.sql}`).bind(...guard.values).first()) throw new SlackInstallationError("slack_installation_changed", 403);
  return { token: value.accessToken };
}
export async function installationDigest(row: SlackInstallationRow): Promise<string> { return hashToolArgs({ ...installationSnapshot(row), activationExpiresAt: row.activation_expires_at }); }
export async function listSlackInstallations(env: SlackInstallationEnv, member: WorkspaceNativeMember): Promise<SlackInstallationState> {
  await ensureSlackInstallations(env); await requireSlackInstallationOwner(env, member);
  let available = true; try { slackOAuthConfiguration(env); } catch { available = false; }
  const owner = membershipSql(member, true);
  const rows = await env.AGENT_AUDIT.prepare(`SELECT * FROM slack_installations WHERE workspace_id=? AND owner_account_id=? AND ${owner.sql} ORDER BY created_at DESC LIMIT 16`)
    .bind(member.workspaceId, member.accountId, ...owner.values).all<SlackInstallationRow>();
  return { ok: true, workspaceId: member.workspaceId, actorId: member.userId, available, ...(!available ? { unavailableReason: "slack_installation_operator_setup_required" } : {}),
    installations: rows.results.map((row) => ({ ...installationSnapshot(row), state: row.state, digest: row.digest, activationExpiresAt: row.activation_expires_at, createdAt: row.created_at,
      canActivate: available && row.state === "pending" && row.activation_expires_at > Date.now(), canRevoke: row.state !== "revoked", canRefresh: available && row.state === "active" && row.token_expires_at !== null })),
    executionAvailable: false, executionUnavailableReason: "native_slack_actor_and_provider_billing_grant_required" };
}
export async function decideSlackInstallation(env: SlackInstallationEnv, member: WorkspaceNativeMember, id: string, input: SlackInstallationDecision, action: "activate" | "revoke") {
  await ensureSlackInstallations(env); await requireSlackInstallationOwner(env, member);
  const row = await getSlackInstallation(env, id);
  if (!row || row.workspace_id !== member.workspaceId || row.owner_account_id !== member.accountId) throw new SlackInstallationError("slack_installation_unavailable", 404);
  if (row.version !== input.expectedVersion || row.digest !== input.digest || !input.reviewed) throw new SlackInstallationError("slack_installation_review_changed");
  if (action === "activate") slackOAuthConfiguration(env);
  const owner = membershipSql(member, true);
  const changed = action === "activate"
    ? await env.AGENT_AUDIT.prepare(`UPDATE slack_installations SET state='active' WHERE id=? AND state='pending' AND version=? AND digest=? AND activation_expires_at>${installationNowSql}
        AND owner_member_json=? AND (token_expires_at IS NULL OR token_expires_at>${installationNowSql}) AND ${owner.sql}`).bind(id, row.version, row.digest, JSON.stringify(member), ...owner.values).run()
    : await env.AGENT_AUDIT.prepare(`UPDATE slack_installations SET state='revoked',version=version+1,generation=generation+1,token_cipher=NULL,token_key_id=NULL WHERE id=? AND version=? AND digest=? AND state<>'revoked' AND ${owner.sql}`).bind(id, row.version, row.digest, ...owner.values).run();
  if (changed.meta.changes !== 1) throw new SlackInstallationError("slack_installation_changed");
}
/** Signed revocation notices never restore state, and never depend on a model/human approximation. */
export async function recordSlackInstallationRevocation(env: SlackInstallationEnv, appId: string, teamId: string, eventId: string, botIds: string[] | null) {
  await ensureSlackInstallations(env);
  const results = await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare("INSERT OR IGNORE INTO slack_installation_events(app_id,team_id,event_id,received_at) VALUES(?,?,?,?)").bind(appId, teamId, eventId, Date.now()),
    env.AGENT_AUDIT.prepare(`INSERT INTO slack_installation_revocations(app_id,team_id,received_at,epoch) SELECT ?,?,?,1 WHERE changes()=1
      ON CONFLICT(app_id,team_id) DO UPDATE SET received_at=excluded.received_at,epoch=slack_installation_revocations.epoch+1`).bind(appId, teamId, Date.now()),
    env.AGENT_AUDIT.prepare(`UPDATE slack_installations SET state='revoked',generation=generation+1,version=version+1,token_cipher=NULL,token_key_id=NULL
      WHERE app_id=? AND team_id=? AND changes()=1 ${botIds ? "AND bot_user_id IN(SELECT value FROM json_each(?))" : ""}`).bind(appId, teamId, ...(botIds ? [JSON.stringify(botIds)] : [])),
    // Capacity never suppresses a revocation. The transaction admits at most
    // one extra event and trims only after its monotonic effects are recorded.
    env.AGENT_AUDIT.prepare(`DELETE FROM slack_installation_events WHERE (app_id,team_id,event_id) IN
      (SELECT app_id,team_id,event_id FROM slack_installation_events ORDER BY received_at,app_id,team_id,event_id LIMIT (SELECT MAX(0,COUNT(*)-10000) FROM slack_installation_events))`),
  ]);
  return results[0]?.meta.changes === 1;
}
export function allowedSlackScopes(scopes: string[]): scopes is (typeof SLACK_BOT_SCOPES)[number][] {
  return scopes.length > 0 && scopes.length <= SLACK_BOT_SCOPES.length && new Set(scopes).size === scopes.length && scopes.includes("chat:write") && scopes.every((scope) => (SLACK_BOT_SCOPES as readonly string[]).includes(scope));
}
