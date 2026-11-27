import type { WorkspaceNativeMember } from "../../workspace-native-authority.js";
import { membershipSql, WorkspaceIntegrationError } from "../../workspace-integrations-store.js";
import { FOUNDER_SQL_NOW } from "../founder-connector-context.js";
import { deadlinePassed, nativeSessionFence, nativeSessionProof } from "../native-session.js";
import type { Grant, HumanSession, ReadAdapter, ReadsEnv, SqlFence } from "./adapter.js";
import { assertAvailable, ownerOf } from "./contract.js";

/** Statement tags. Tests key fault injection on these, never on SQL text. */
export const TAG = {
  grantGet: "/*reads:grant-get*/",
  verifyReserve: "/*reads:verify-reserve*/",
  verifySettle: "/*reads:verify-settle*/",
  enable: "/*reads:enable*/",
  dispatchProof: "/*reads:dispatch-proof*/",
  tickDue: "/*reads:tick-due*/",
  reserve: "/*reads:reserve*/",
  settle: "/*reads:settle*/",
  list: "/*reads:grant-list*/",
  report: "/*reads:report*/",
  finalProof: "/*reads:final-proof*/",
  sessionProof: "/*reads:session-proof*/",
} as const;

export const managerFence = (member: WorkspaceNativeMember): SqlFence => membershipSql(member, true);

const EXACT = ["id", "revision", "contract_digest", "ciphertext", "owner_json", "selection_json", "account_id", "expires_at", "max_calls", "executor_digest"] as const;

/**
 * THE exact-row predicate. Every statement that spends, transitions or serves a grant ANDs this in, so a row
 * changed in any bound column since it was read matches nothing. Column names are closed literals; values are bound.
 */
export function exactRow(adapter: ReadAdapter, grant: Grant, alias?: "g"): SqlFence {
  const at = alias ? `${alias}.` : "";
  return {
    sql: [...EXACT, ...adapter.scopeColumns].map((column) => `${at}${column}=?`).concat(adapter.factColumns.map((column) => `${at}${column} IS ?`)).join(" AND "),
    values: [...EXACT, ...adapter.scopeColumns, ...adapter.factColumns].map((column) => grant[column] ?? null),
  };
}

/** The human-session fence for a human step. Refuses a captured session that is absent or already past its expiry. */
export function sessionFence(adapter: ReadAdapter, member: WorkspaceNativeMember, session: HumanSession): SqlFence {
  if (!session?.id || !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Date.now()) throw new WorkspaceIntegrationError(`${adapter.id}_native_session_required`, 403);
  return nativeSessionFence({ ...session, userId: member.accountId });
}

/**
 * The one pre-dispatch proof. Re-reads the exact reserved row under its owner's membership and returns the
 * deadline the provider call must finish by: the grant expiry for a scheduled tick (no session exists), and
 * min(grant, captured session, that session's stored expiry) for a human step, refusing if the session row is gone.
 */
export async function proveDispatch(env: ReadsEnv, adapter: ReadAdapter, grant: Grant, state: "verifying" | "running", session?: HumanSession): Promise<number> {
  const owner = ownerOf(grant), guard = managerFence(owner), row = exactRow(adapter, grant);
  const human = session ? nativeSessionProof({ ...session, userId: owner.accountId }) : undefined;
  const current = await env.AGENT_AUDIT.prepare(`${TAG.dispatchProof} SELECT 1 AS current${human ? `,${human.select}` : ""} FROM ${adapter.tables.grants} WHERE ${row.sql} AND state=? AND expires_at>${FOUNDER_SQL_NOW} AND ${guard.sql}${human ? ` AND ${human.where}` : ""}`)
    .bind(...(human?.selectValues ?? []), ...row.values, state, ...guard.values, ...(human?.whereValues ?? [])).first<{ session_expires?: number | string | null }>();
  assertAvailable(adapter, env);
  const deadline = human ? Math.min(grant.expires_at, human.deadline(current?.session_expires)) : grant.expires_at;
  if (!current || deadlinePassed(deadline)) throw new Error(`${adapter.id}_authority_changed`);
  return deadline;
}

export async function blockGrant(env: ReadsEnv, adapter: ReadAdapter, grant: Grant, state: string) {
  await env.AGENT_AUDIT.prepare(`UPDATE ${adapter.tables.grants} SET state='blocked',updated_at=? WHERE id=? AND revision=? AND state=? AND next_due_at IS ?`).bind(Date.now(), grant.id, grant.revision, state, grant.next_due_at).run();
}
