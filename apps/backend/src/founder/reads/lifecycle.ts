import type { WorkspaceNativeMember } from "../../workspace-native-authority.js";
import { WorkspaceIntegrationError } from "../../workspace-integrations-store.js";
import { FOUNDER_SQL_NOW } from "../founder-connector-context.js";
import { deadlinePassed } from "../native-session.js";
import { FACT_KEYS, type Grant, type HumanSession, type ReadAdapter, type ReadsEnv } from "./adapter.js";
import { assertAvailable, contractDigest, ownerOf, scopeOf, validContract } from "./contract.js";
import { dispatchReadRequest } from "./dispatch.js";
import { blockGrant, exactRow, managerFence, proveDispatch, sessionFence, TAG } from "./ledger.js";
import { openCredential, sealCredential } from "./seal.js";

const changed = (adapter: ReadAdapter) => new WorkspaceIntegrationError(`${adapter.id}_grant_changed`, 409);

/** Every human step proves the acting manager, the grant's original owner and the deciding session in its own statement. */
function humanFence(adapter: ReadAdapter, member: WorkspaceNativeMember, grant: Grant, session: HumanSession) {
  const current = managerFence(member), original = managerFence(ownerOf(grant)), human = sessionFence(adapter, member, session);
  return { sql: `${current.sql} AND ${original.sql} AND ${human.sql}`, values: [...current.values, ...original.values, ...human.values] };
}

export const openGrant = (adapter: ReadAdapter, env: ReadsEnv, grant: Grant) => openCredential(adapter, grant.ciphertext, env[adapter.env.key]!, scopeOf(adapter, grant));

export async function createDraft(adapter: ReadAdapter, env: ReadsEnv, member: WorkspaceNativeMember, body: unknown, session: HumanSession) {
  assertAvailable(adapter, env);
  const input = adapter.schemas.draft.parse(body);
  adapter.selection(input.selection);
  if (!adapter.seal.account.test(input.accountId)) throw new Error(`${adapter.id}_account_invalid`);
  if (JSON.stringify([input.accountId, input.selection]).includes(input.accessToken)) throw new WorkspaceIntegrationError(`${adapter.id}_selection_invalid`, 400);
  const now = Date.now();
  if (input.expiresAt <= now || input.expiresAt > now + 28 * 86400000) throw new WorkspaceIntegrationError(`${adapter.id}_expiry_invalid`, 400);
  const scope = Object.fromEntries(adapter.scopeColumns.map((column) => [column, input[column]]));
  const terms = { id: `${adapter.wire.grantPrefix}${crypto.randomUUID().replaceAll("-", "")}`, workspace_id: member.workspaceId, owner_account_id: member.accountId, owner_json: JSON.stringify(member), account_id: input.accountId, revision: 1, expires_at: input.expiresAt, selection_json: JSON.stringify(input.selection), max_calls: input.maxCalls, ...scope };
  const sealed = await sealCredential(adapter, input.accessToken, env[adapter.env.key]!, scopeOf(adapter, { ...terms, fingerprint: "" }));
  const digest = await contractDigest(adapter, { ...terms, fingerprint: sealed.fingerprint });
  const guard = managerFence(member), human = sessionFence(adapter, member, session);
  const columns = ["id", "workspace_id", "owner_id", "owner_account_id", "owner_json", "account_id", ...adapter.scopeColumns, "revision", "expires_at", "ciphertext", "fingerprint", "selection_json", "contract_digest", "executor_digest", "max_calls", "created_at", "updated_at"];
  const values = [terms.id, member.workspaceId, member.userId, member.accountId, terms.owner_json, input.accountId, ...Object.values(scope), 1, input.expiresAt, sealed.ciphertext, sealed.fingerprint, terms.selection_json, digest, adapter.executorDigest, input.maxCalls, now, now];
  const result = await env.AGENT_AUDIT.prepare(`INSERT INTO ${adapter.tables.grants}(${columns.join(",")},state) SELECT ${columns.map(() => "?").join(",")},'draft' WHERE ${guard.sql} AND ${human.sql}`).bind(...values, ...guard.values, ...human.values).run();
  if (result.meta.changes !== 1) throw new WorkspaceIntegrationError("workspace_authority_changed", 403);
  return { id: terms.id, digest, fingerprint: sealed.fingerprint, state: "draft" };
}

export async function getGrant(adapter: ReadAdapter, env: ReadsEnv, member: WorkspaceNativeMember, id: string, allowUnavailable = false) {
  if (!allowUnavailable) assertAvailable(adapter, env);
  const guard = managerFence(member);
  return env.AGENT_AUDIT.prepare(`${TAG.grantGet} SELECT * FROM ${adapter.tables.grants} WHERE id=? AND workspace_id=? AND owner_id=? AND owner_account_id=? AND ${guard.sql}`).bind(id, member.workspaceId, member.userId, member.accountId, ...guard.values).first<Grant>();
}

/** One explicit account verification. The call is reserved first; any unknown result keeps it spent and blocks the grant. */
export async function verifyGrant(adapter: ReadAdapter, env: ReadsEnv, member: WorkspaceNativeMember, id: string, digest: string, session: HumanSession) {
  const grant = await getGrant(adapter, env, member, id);
  if (!grant || grant.state !== "draft" || grant.contract_digest !== digest || !await validContract(adapter, grant)) throw changed(adapter);
  const secret = await openGrant(adapter, env, grant);
  const row = exactRow(adapter, grant), human = humanFence(adapter, member, grant, session);
  const reserved = await env.AGENT_AUDIT.prepare(`${TAG.verifyReserve} UPDATE ${adapter.tables.grants} SET state='verifying',used_calls=used_calls+1,updated_at=? WHERE ${row.sql} AND state='draft' AND used_calls<max_calls AND expires_at>${FOUNDER_SQL_NOW} AND ${human.sql}`).bind(Date.now(), ...row.values, ...human.values).run();
  if (reserved.meta.changes !== 1) throw changed(adapter);
  try {
    const deadline = await proveDispatch(env, adapter, grant, "verifying", session);
    const response = await dispatchReadRequest(adapter.verifyRequest(grant, secret), deadline, adapter.id);
    const accepted = adapter.acceptVerification(grant, response.body);
    const facts = adapter.factColumns.map((column) => accepted[FACT_KEYS[column]]);
    if (facts.some((fact) => typeof fact !== "string" || !fact || fact.includes(secret))) throw new Error(`${adapter.id}_redaction_required`);
    const verified = { ...grant, ...Object.fromEntries(adapter.factColumns.map((column, index) => [column, facts[index]])) };
    const nextDigest = await contractDigest(adapter, verified);
    assertAvailable(adapter, env);
    if (deadlinePassed(deadline)) throw new Error(`${adapter.id}_authority_changed`);
    const settle = humanFence(adapter, member, grant, session);
    const done = await env.AGENT_AUDIT.prepare(`${TAG.verifySettle} UPDATE ${adapter.tables.grants} SET state='verified',${adapter.factColumns.map((column) => `${column}=?,`).join("")}contract_digest=?,updated_at=? WHERE ${row.sql} AND state='verifying' AND expires_at>${FOUNDER_SQL_NOW} AND ${settle.sql}`).bind(...facts, nextDigest, Date.now(), ...row.values, ...settle.values).run();
    if (done.meta.changes !== 1 || deadlinePassed(deadline)) throw new Error(`${adapter.id}_authority_changed`);
  } catch {
    await blockGrant(env, adapter, grant, "verifying");
    throw new WorkspaceIntegrationError(`${adapter.id}_verification_unconfirmed`, 409);
  }
}

/** The only forward transition a human can ask for after verification: verified -> enabled, on the exact reviewed row. */
export async function enableGrant(adapter: ReadAdapter, env: ReadsEnv, member: WorkspaceNativeMember, id: string, digest: string, session: HumanSession) {
  const grant = await getGrant(adapter, env, member, id);
  if (!grant || grant.contract_digest !== digest || !await validContract(adapter, grant) || adapter.factColumns.some((column) => !grant[column])) throw changed(adapter);
  const row = exactRow(adapter, grant), human = humanFence(adapter, member, grant, session), now = Date.now();
  const done = await env.AGENT_AUDIT.prepare(`${TAG.enable} UPDATE ${adapter.tables.grants} SET state='enabled',next_due_at=?,updated_at=? WHERE ${row.sql} AND workspace_id=? AND owner_id=? AND owner_account_id=? AND state='verified' AND expires_at>${FOUNDER_SQL_NOW} AND ${human.sql}`).bind(now, now, ...row.values, member.workspaceId, member.userId, member.accountId, ...human.values).run();
  if (done.meta.changes !== 1 || Date.now() >= grant.expires_at) throw changed(adapter);
}

/** Revoke stays possible for a blocked, stale or unavailable grant, so it fences on identity and digest, not the exact row. */
export async function revokeGrant(adapter: ReadAdapter, env: ReadsEnv, member: WorkspaceNativeMember, id: string, digest: string, session: HumanSession) {
  const guard = managerFence(member), human = sessionFence(adapter, member, session);
  const done = await env.AGENT_AUDIT.prepare(`UPDATE ${adapter.tables.grants} SET state='revoked',ciphertext='',updated_at=? WHERE id=? AND workspace_id=? AND owner_id=? AND owner_account_id=? AND contract_digest=? AND state<>'revoked' AND ${guard.sql} AND ${human.sql}`).bind(Date.now(), id, member.workspaceId, member.userId, member.accountId, digest, ...guard.values, ...human.values).run();
  if (done.meta.changes !== 1) throw changed(adapter);
}
