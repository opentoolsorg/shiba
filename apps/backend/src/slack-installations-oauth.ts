import type { SlackInstallationStart, SlackInstallationDecision } from "@shiba/shared";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
import { membershipSql } from "./workspace-integrations-store.js";
import { hashToolArgs } from "./mcp-gateway.js";
import { verifySlackBotInstallation } from "./slack.js";
import { openSlackSecret, sealSlackSecret, SlackInstallationError } from "./slack-installations-crypto.js";
import { allowedSlackScopes, ensureSlackInstallations, getSlackInstallation, installationDigest, installationNowSql, installationPurpose, installationSnapshot,
  requireSlackInstallationOwner, slackOAuthConfiguration, type SlackInstallationEnv, type SlackInstallationRow } from "./slack-installations-store.js";

export interface SlackOAuthRow {
  id: string; state_hash: string; workspace_id: string; owner_account_id: string; owner_member_json: string; request_id: string; input_hash: string;
  scopes_json: string; config_json: string; verifier_key_id: string; verifier_cipher: string; state: string; created_at: number; expires_at: number;
}
export interface SlackOAuthDeps { fetch?: typeof fetch; verifyInstallation?: typeof verifySlackBotInstallation }
interface BotCredential { accessToken: string; refreshToken?: string; expiresAt: number | null }
const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
/** Installation metadata stays on the fixed Slack origin, with no redirect or raw error propagation. */
export async function verifySlackInstallationBot(token: string): Promise<{ teamId: string; userId: string; botId: string; scopes?: string[] }> {
  const response = await fetch("https://slack.com/api/auth.test", { method: "POST", redirect: "manual", signal: AbortSignal.timeout(8_000), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" } });
  const reader = response.body?.getReader(), bytes = new Uint8Array(16_384); let used = 0;
  try {
    if (!reader) throw new Error();
    for (;;) { const part = await reader.read(); if (part.done) break; if (used + part.value.length > bytes.length) throw new Error(); bytes.set(part.value, used); used += part.value.length; }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, used)));
    if (!response.ok || !value || value.ok !== true || value.enterprise_id != null || ![value.team_id,value.user_id,value.bot_id].every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error();
    const scopes = response.headers.get("x-oauth-scopes");
    return { teamId: value.team_id, userId: value.user_id, botId: value.bot_id, ...(scopes ? { scopes: scopes.split(",").map((item) => item.trim()).filter(Boolean) } : {}) };
  } catch { throw new SlackInstallationError("slack_installation_identity_unavailable", 503); }
  finally { await reader?.cancel().catch(() => {}); }
}
export async function slackStateHash(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function oauthRequest(env: SlackInstallationEnv, body: URLSearchParams, deps: SlackOAuthDeps): Promise<Record<string, unknown>> {
  const init: RequestInit = { method: "POST", redirect: "manual", signal: AbortSignal.timeout(8_000), headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() };
  const response = await (deps.fetch ? deps.fetch("https://slack.com/api/oauth.v2.access", init) : globalThis.fetch("https://slack.com/api/oauth.v2.access", init));
  const reader = response.body?.getReader(), bytes = new Uint8Array(65_536); let used = 0;
  try {
    if (!reader) throw new Error();
    for (;;) { const part = await reader.read(); if (part.done) break; if (used + part.value.length > bytes.length) throw new Error(); bytes.set(part.value, used); used += part.value.length; }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, used)));
    if (!response.ok || !value || typeof value !== "object" || Array.isArray(value) || value.ok !== true) throw new Error();
    return value;
  } catch { throw new SlackInstallationError("slack_oauth_outcome_unconfirmed", 503); }
  finally { await reader?.cancel().catch(() => {}); }
}
function credential(value: Record<string, unknown>): BotCredential {
  if (value.token_type !== "bot" || typeof value.access_token !== "string" || !value.access_token || value.access_token.length > 16_384 ||
    value.refresh_token !== undefined && (typeof value.refresh_token !== "string" || !value.refresh_token || value.refresh_token.length > 16_384) ||
    value.expires_in !== undefined && (!Number.isSafeInteger(value.expires_in) || Number(value.expires_in) <= 30 || Number(value.expires_in) > 86_400)) throw new SlackInstallationError("slack_oauth_bot_token_required", 400);
  return { accessToken: value.access_token, ...(typeof value.refresh_token === "string" ? { refreshToken: value.refresh_token } : {}), expiresAt: value.expires_in === undefined ? null : Date.now() + Number(value.expires_in) * 1_000 };
}
export async function startSlackInstallation(env: SlackInstallationEnv, member: WorkspaceNativeMember, input: SlackInstallationStart, verifySession: () => Promise<void>) {
  const config = slackOAuthConfiguration(env); await ensureSlackInstallations(env); await requireSlackInstallationOwner(env, member);
  if (!allowedSlackScopes(input.scopes)) throw new SlackInstallationError("slack_oauth_scopes_invalid", 400);
  await env.AGENT_AUDIT.prepare(`UPDATE slack_installation_oauth SET verifier_cipher='',state=CASE WHEN state='pending' THEN 'cancelled' ELSE 'unknown' END WHERE state IN ('pending','exchanging') AND expires_at<=${installationNowSql}`).run();
  const inputHash = await hashToolArgs({ ...input, config });
  const prior = await env.AGENT_AUDIT.prepare("SELECT id,input_hash FROM slack_installation_oauth WHERE workspace_id=? AND owner_account_id=? AND request_id=?").bind(member.workspaceId, member.accountId, input.requestId).first<{ id: string; input_hash: string }>();
  // State is intentionally not recoverable from storage or replayed into a second OAuth launch.
  if (prior) throw new SlackInstallationError(prior.input_hash === inputHash ? "slack_oauth_start_already_requested" : "slack_oauth_request_conflict");
  const state = encode(crypto.getRandomValues(new Uint8Array(32))), verifier = encode(crypto.getRandomValues(new Uint8Array(64)));
  const id = `sio_${crypto.randomUUID().replaceAll("-", "")}`, scope = { workspaceId: member.workspaceId, subject: id, purpose: `pkce:${member.accountId}` };
  const sealed = await sealSlackSecret(env, scope, verifier), stateHash = await slackStateHash(state), now = Date.now();
  const challenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  await verifySession(); const native = membershipSql(member, true);
  const inserted = await env.AGENT_AUDIT.prepare(`INSERT INTO slack_installation_oauth(id,state_hash,workspace_id,owner_account_id,owner_member_json,request_id,input_hash,scopes_json,config_json,verifier_key_id,verifier_cipher,state,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,'pending',?,? WHERE ${native.sql} AND (SELECT COUNT(*) FROM slack_installation_oauth WHERE owner_account_id=? AND created_at>?)<3
      AND (SELECT COUNT(*) FROM slack_installation_oauth WHERE state IN ('pending','exchanging'))<128 AND (SELECT COUNT(*) FROM slack_installations)<16`)
    .bind(id, stateHash, member.workspaceId, member.accountId, JSON.stringify(member), input.requestId, inputHash, JSON.stringify([...input.scopes].sort()), JSON.stringify(config), sealed.keyId, sealed.cipher, now, now + 600_000, ...native.values, member.accountId, now - 600_000).run();
  if (inserted.meta.changes !== 1) throw new SlackInstallationError("slack_oauth_start_unavailable", 403);
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, scope: [...input.scopes].sort().join(","), state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  return { authorizationUrl: url.href, expiresAt: now + 600_000 };
}
export async function findSlackOAuthState(env: SlackInstallationEnv, state: string): Promise<SlackOAuthRow | null> {
  slackOAuthConfiguration(env); await ensureSlackInstallations(env);
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
  return env.AGENT_AUDIT.prepare("SELECT * FROM slack_installation_oauth WHERE state_hash=? AND state='pending' AND expires_at>?").bind(await slackStateHash(state), Date.now()).first<SlackOAuthRow>();
}
export async function completeSlackInstallation(env: SlackInstallationEnv, member: WorkspaceNativeMember, pending: SlackOAuthRow, code: string, verifySession: () => Promise<void>, deps: SlackOAuthDeps = {}) {
  const config = slackOAuthConfiguration(env); await requireSlackInstallationOwner(env, member);
  if (pending.owner_member_json !== JSON.stringify(member) || pending.config_json !== JSON.stringify(config) || !code || code.length > 4_096) throw new SlackInstallationError("slack_oauth_original_owner_required", 403);
  const verifier = await openSlackSecret(env, { workspaceId: member.workspaceId, subject: pending.id, purpose: `pkce:${member.accountId}` }, { keyId: pending.verifier_key_id, cipher: pending.verifier_cipher });
  await verifySession(); const native = membershipSql(member, true);
  const claimed = await env.AGENT_AUDIT.prepare(`UPDATE slack_installation_oauth SET state='exchanging' WHERE id=? AND state='pending' AND state_hash=? AND expires_at>${installationNowSql} AND owner_member_json=? AND ${native.sql}`)
    .bind(pending.id, pending.state_hash, JSON.stringify(member), ...native.values).run();
  if (claimed.meta.changes !== 1) throw new SlackInstallationError("slack_oauth_state_consumed", 403);
  try {
    const value = await oauthRequest(env, new URLSearchParams({ client_id: config.clientId, grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: config.redirectUri }), deps);
    const token = credential(value), team = value.team as { id?: unknown } | null;
    const authedUser = value.authed_user as { access_token?: unknown; id?: unknown } | undefined;
    if (value.app_id !== config.appId || value.is_enterprise_install !== false || value.enterprise != null || !team || typeof team.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(team.id) ||
      typeof value.bot_user_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.bot_user_id) || !authedUser || typeof authedUser.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(authedUser.id) || authedUser.access_token !== undefined || typeof value.scope !== "string") throw new SlackInstallationError("slack_oauth_workspace_bot_required", 400);
    const scopes = value.scope.split(",").filter(Boolean).sort();
    if (!allowedSlackScopes(scopes) || JSON.stringify(scopes) !== pending.scopes_json) throw new SlackInstallationError("slack_oauth_unreviewed_scopes", 403);
    const checked = await (deps.verifyInstallation ?? verifySlackInstallationBot)(token.accessToken);
    if (checked.teamId !== team.id || checked.userId !== value.bot_user_id || !/^[A-Za-z0-9_-]{1,128}$/.test(checked.botId)) throw new SlackInstallationError("slack_oauth_identity_mismatch", 403);
    const prior = await env.AGENT_AUDIT.prepare("SELECT * FROM slack_installations WHERE app_id=? AND team_id=?").bind(config.appId, team.id).first<SlackInstallationRow>();
    if (prior && (prior.owner_account_id !== member.accountId || prior.workspace_id !== member.workspaceId)) throw new SlackInstallationError("slack_team_already_owned", 409);
    const now = Date.now(), row: SlackInstallationRow = { id: prior?.id ?? `sin_${crypto.randomUUID().replaceAll("-", "")}`, workspace_id: member.workspaceId, owner_id: member.userId, owner_account_id: member.accountId,
      owner_member_json: JSON.stringify(member), app_id: config.appId, team_id: team.id, bot_user_id: value.bot_user_id, bot_id: checked.botId, installer_slack_user_id: authedUser.id, scopes_json: JSON.stringify(scopes),
      generation: (prior?.generation ?? 0) + 1, version: (prior?.version ?? 0) + 1, token_revision: (prior?.token_revision ?? 0) + 1, state: "pending", digest: "", token_key_id: null, token_cipher: null,
      token_expires_at: token.expiresAt, activation_expires_at: Math.min(now + 600_000, pending.expires_at, token.expiresAt ?? Number.MAX_SAFE_INTEGER), created_at: now, refresh_claim_id: null };
    row.digest = await installationDigest(row);
    const sealed = await sealSlackSecret(env, { workspaceId: member.workspaceId, subject: row.id, purpose: installationPurpose(installationSnapshot(row)) }, JSON.stringify(token)); row.token_key_id = sealed.keyId; row.token_cipher = sealed.cipher;
    await verifySession();
    if (JSON.stringify(slackOAuthConfiguration(env)) !== pending.config_json) throw new SlackInstallationError("slack_oauth_configuration_changed", 403);
    const keys = Object.keys(row), values = Object.values(row);
    const guard = `${native.sql} AND EXISTS(SELECT 1 FROM slack_installation_oauth WHERE id=? AND state='exchanging' AND expires_at>${installationNowSql})
      AND NOT EXISTS(SELECT 1 FROM slack_installation_revocations WHERE app_id=? AND team_id=? AND received_at>=?)`;
    const statement = prior
      ? env.AGENT_AUDIT.prepare(`UPDATE slack_installations SET ${keys.map((key) => `${key}=?`).join(",")} WHERE id=? AND version=? AND ${guard}`).bind(...values, prior.id, prior.version, ...native.values, pending.id, config.appId, team.id, pending.created_at)
      : env.AGENT_AUDIT.prepare(`INSERT INTO slack_installations(${keys.join(",")}) SELECT ${keys.map(() => "?").join(",")} WHERE ${guard} AND (SELECT COUNT(*) FROM slack_installations)<16`).bind(...values, ...native.values, pending.id, config.appId, team.id, pending.created_at);
    const changed = await env.AGENT_AUDIT.batch([statement, env.AGENT_AUDIT.prepare("UPDATE slack_installation_oauth SET state='completed',verifier_cipher='' WHERE id=? AND state='exchanging' AND changes()=1").bind(pending.id)]);
    if (changed[0]?.meta.changes !== 1) throw new SlackInstallationError("slack_oauth_sources_changed", 403);
    return row.id;
  } catch (error) {
    await env.AGENT_AUDIT.prepare("UPDATE slack_installation_oauth SET state='unknown',verifier_cipher='' WHERE id=? AND state='exchanging'").bind(pending.id).run();
    if (error instanceof SlackInstallationError) throw error;
    throw new SlackInstallationError("slack_oauth_outcome_unconfirmed", 503);
  }
}
export async function refreshSlackInstallation(env: SlackInstallationEnv, member: WorkspaceNativeMember, id: string, input: SlackInstallationDecision, verifySession: () => Promise<void>, deps: SlackOAuthDeps = {}) {
  const config = slackOAuthConfiguration(env); await requireSlackInstallationOwner(env, member);
  const row = await getSlackInstallation(env, id);
  if (!row || row.app_id !== config.appId || row.workspace_id !== member.workspaceId || row.owner_account_id !== member.accountId || row.owner_member_json !== JSON.stringify(member)) throw new SlackInstallationError("slack_installation_unavailable", 404);
  if (row.state !== "active" || row.version !== input.expectedVersion || row.digest !== input.digest || !input.reviewed || !row.token_cipher || !row.token_key_id) throw new SlackInstallationError("slack_installation_review_changed");
  const raw = await openSlackSecret(env, { workspaceId: member.workspaceId, subject: row.id, purpose: installationPurpose(installationSnapshot(row)) }, { keyId: row.token_key_id, cipher: row.token_cipher });
  const old = JSON.parse(raw) as BotCredential;
  if (!old.refreshToken || old.refreshToken.length > 16_384) throw new SlackInstallationError("slack_refresh_unavailable");
  await verifySession(); const owner = membershipSql(member, true), claim = crypto.randomUUID();
  const claimed = await env.AGENT_AUDIT.prepare(`UPDATE slack_installations SET state='refreshing',refresh_claim_id=? WHERE id=? AND state='active' AND version=? AND digest=? AND ${owner.sql}`)
    .bind(claim, id, row.version, row.digest, ...owner.values).run();
  if (claimed.meta.changes !== 1) throw new SlackInstallationError("slack_installation_changed");
  try {
    const value = await oauthRequest(env, new URLSearchParams({ client_id: config.clientId, grant_type: "refresh_token", refresh_token: old.refreshToken }), deps), token = credential(value);
    const scopes = typeof value.scope === "string" ? value.scope.split(",").filter(Boolean).sort() : [];
    const team = value.team as { id?: unknown } | undefined, user = value.authed_user as { access_token?: unknown } | undefined;
    if (JSON.stringify(scopes) !== row.scopes_json || value.app_id !== undefined && value.app_id !== row.app_id || value.is_enterprise_install === true || value.enterprise != null ||
      value.bot_user_id !== undefined && value.bot_user_id !== row.bot_user_id || team?.id !== undefined && team.id !== row.team_id || user?.access_token !== undefined) throw new SlackInstallationError("slack_refresh_identity_changed", 403);
    const checked = await (deps.verifyInstallation ?? verifySlackInstallationBot)(token.accessToken);
    if (checked.teamId !== row.team_id || checked.userId !== row.bot_user_id || checked.botId !== row.bot_id) throw new SlackInstallationError("slack_refresh_identity_changed", 403);
    const next = { ...row, version: row.version + 1, token_revision: row.token_revision + 1, token_expires_at: token.expiresAt };
    next.digest = await installationDigest(next);
    const sealed = await sealSlackSecret(env, { workspaceId: member.workspaceId, subject: id, purpose: installationPurpose(installationSnapshot(next)) }, JSON.stringify(token));
    await verifySession(); if (JSON.stringify(slackOAuthConfiguration(env)) !== JSON.stringify(config)) throw new SlackInstallationError("slack_refresh_configuration_changed", 403);
    const saved = await env.AGENT_AUDIT.prepare(`UPDATE slack_installations SET state='active',version=?,token_revision=?,digest=?,token_key_id=?,token_cipher=?,token_expires_at=?,refresh_claim_id=NULL
      WHERE id=? AND state='refreshing' AND refresh_claim_id=? AND version=? AND generation=? AND ${owner.sql}`)
      .bind(next.version, next.token_revision, next.digest, sealed.keyId, sealed.cipher, token.expiresAt, id, claim, row.version, row.generation, ...owner.values).run();
    if (saved.meta.changes !== 1) throw new SlackInstallationError("slack_refresh_outcome_unconfirmed", 503);
  } catch {
    await env.AGENT_AUDIT.prepare("UPDATE slack_installations SET state='unknown',version=version+1,token_cipher=NULL,token_key_id=NULL WHERE id=? AND state='refreshing' AND refresh_claim_id=?").bind(id, claim).run();
    throw new SlackInstallationError("slack_refresh_outcome_unconfirmed", 503);
  }
}
