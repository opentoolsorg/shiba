import type { Env } from "../../env.js";
import type { WorkspaceNativeMember } from "../../workspace-native-authority.js";
import { FOUNDER_SQL_NOW } from "../founder-connector-context.js";
import { deadlinePassed } from "../native-session.js";
import { ADAPTERS, FACT_KEYS, type Grant, type ReadAdapter, type ReadProvider, type ReportOf, type SelectionOf, type SqlFence } from "./adapter.js";
import { digestJson, ownerOf, validContract } from "./contract.js";
import { managerFence } from "./ledger.js";
import { getGrant } from "./lifecycle.js";

export type { SqlFence };
export interface GrantPin<P extends ReadProvider = ReadProvider> {
  v: 1;
  provider: P;
  grantId: string;
  revision: number;
  workspaceId: string;
  ownerId: string;
  ownerAccountId: string;
  ownerJson: string;
  accountId: string;
  fingerprint: string;
  contractDigest: string;
  executorDigest: string;
  selectionJson: string;
  expiresAt: number;
  maxCalls: number;
  facts: P extends "stripe" ? { mode: "live" | "test" } : { currency: string | null; timezoneName: string | null };
}

export interface Evidence<P extends ReadProvider = ReadProvider> {
  pin: GrantPin<P>;
  /** Already validated by the provider's own selection rule. */
  selection: SelectionOf<P>;
  receipt: { id: string; createdAt: number; expiresAt: number; resultDigest: string; reportJson: string };
  /** Already parsed by the provider's strict report schema and bound to `pin`. */
  report: ReportOf<P>;
  expiresAt: number;
  fence: SqlFence;
}

const identityMatches = (row: Grant, owner: WorkspaceNativeMember) => {
  const stored = ownerOf(row);
  return row.owner_json === JSON.stringify(owner) && stored.workspaceId === row.workspace_id && stored.userId === row.owner_id && stored.accountId === row.owner_account_id;
};

export function pinFrom<P extends ReadProvider>(adapter: ReadAdapter, row: Grant): GrantPin<P> {
  return {
    v: 1, provider: adapter.id, grantId: row.id, revision: row.revision, workspaceId: row.workspace_id,
    ownerId: row.owner_id, ownerAccountId: row.owner_account_id, ownerJson: row.owner_json,
    accountId: row.account_id, fingerprint: row.fingerprint, contractDigest: row.contract_digest, executorDigest: row.executor_digest,
    selectionJson: row.selection_json, expiresAt: row.expires_at, maxCalls: row.max_calls,
    facts: { ...Object.fromEntries(adapter.scopeColumns.map((column) => [column, row[column]])), ...Object.fromEntries(adapter.factColumns.map((column) => [FACT_KEYS[column], row[column] ?? null])) },
  } as GrantPin<P>;
}

/** A current, valid, owner-exact grant frozen into values a schedule can persist: no ciphertext, no secret material. */
export async function pinGrant<P extends ReadProvider>(env: Env, owner: WorkspaceNativeMember, ref: { provider: P; grantId: string; need: "capacity" | "serving" }): Promise<GrantPin<P> | null> {
  const adapter = ADAPTERS[ref.provider];
  if (!adapter) return null;
  const row = await getGrant(adapter, env, owner, ref.grantId);
  if (!row || !await validContract(adapter, row) || !identityMatches(row, owner) || !["enabled", "exhausted"].includes(row.state) || Date.now() >= row.expires_at || ref.need === "capacity" && (row.state !== "enabled" || row.used_calls >= row.max_calls)) return null;
  return pinFrom<P>(adapter, row);
}

// Every pinned value travels as ONE bound JSON document read back with json_extract over closed paths,
// so a consumer can AND several fences into one write and stay under D1's 100-parameter cap.
const PIN = "(SELECT ? AS doc) p";
const pinned = (path: string) => `json_extract(p.doc,'$.${path}')`;
function pinPredicate(pin: GrantPin, need: "capacity" | "serving") {
  const base = `g.id=${pinned("grantId")} AND g.workspace_id=${pinned("workspaceId")} AND g.owner_id=${pinned("ownerId")} AND g.owner_account_id=${pinned("ownerAccountId")} AND g.owner_json=${pinned("ownerJson")} AND g.revision=${pinned("revision")} AND g.contract_digest=${pinned("contractDigest")} AND g.executor_digest=${pinned("executorDigest")} AND g.selection_json=${pinned("selectionJson")} AND g.account_id=${pinned("accountId")} AND g.fingerprint=${pinned("fingerprint")} AND g.expires_at=${pinned("expiresAt")} AND g.max_calls=${pinned("maxCalls")} AND g.expires_at>${FOUNDER_SQL_NOW}`;
  const adapter = ADAPTERS[pin.provider];
  const fact = adapter.scopeColumns.map((column) => ` AND g.${column}=${pinned(`facts.${column}`)}`).concat(adapter.factColumns.map((column) => ` AND g.${column} IS ${pinned(`facts.${FACT_KEYS[column]}`)}`)).join("");
  const state = need === "capacity" ? " AND g.state='enabled' AND g.used_calls<g.max_calls" : " AND g.state IN ('enabled','exhausted')";
  const membership = managerFence(ownerOf({ owner_json: pin.ownerJson }));
  return { sql: `${base}${fact}${state} AND ${membership.sql}`, values: membership.values };
}

/** The pinned grant is still exactly this row, in a state that satisfies `need`, and its owner is still an active manager. Always 9 binds. */
export function grantFence(pin: GrantPin, need: "capacity" | "serving"): SqlFence {
  const pred = pinPredicate(pin, need);
  return { sql: `EXISTS(SELECT 1 FROM ${PIN} JOIN ${ADAPTERS[pin.provider].tables.grants} g ON g.id=${pinned("grantId")} WHERE ${pred.sql})`, values: [JSON.stringify(pin), ...pred.values] };
}

export function completedReceipts(pin: GrantPin): SqlFence {
  const pred = pinPredicate(pin, "serving");
  return {
    sql: `(SELECT r.id,r.created_at,r.expires_at FROM ${PIN} JOIN ${ADAPTERS[pin.provider].tables.receipts} r ON r.grant_id=${pinned("grantId")} WHERE r.grant_revision=${pinned("revision")} AND r.selection_json=${pinned("selectionJson")} AND r.state='completed' AND r.expires_at>${FOUNDER_SQL_NOW} AND EXISTS(SELECT 1 FROM ${ADAPTERS[pin.provider].tables.grants} g WHERE ${pred.sql}))`,
    values: [JSON.stringify(pin), ...pred.values],
  };
}

/** One schema per provider, then the engine binds the envelope to the pin: a valid report of another grant, revision or selection is not evidence. */
export function boundReport(adapter: ReadAdapter, raw: unknown, pin: GrantPin) {
  adapter.schemas.report.parse(raw);
  const report = raw as Record<string, unknown>, capture = report.capture as Record<string, unknown>, facts = pin.facts as Record<string, unknown>;
  if (report.grantId !== pin.grantId || report.revision !== pin.revision || report.accountId !== pin.accountId || report.contractDigest !== pin.contractDigest || report.executorDigest !== pin.executorDigest
    || adapter.scopeColumns.some((column) => report[column] !== facts[column])
    || adapter.factColumns.some((column) => !facts[FACT_KEYS[column]] || FACT_KEYS[column] in report && report[FACT_KEYS[column]] !== facts[FACT_KEYS[column]])
    || "selection" in capture && JSON.stringify(capture.selection) !== pin.selectionJson) throw new Error("read_evidence_invalid");
  return raw;
}

export async function loadEvidence<P extends ReadProvider>(env: Env, owner: WorkspaceNativeMember, ref: { provider: P; grantId: string; receiptId: string; grantRevision?: number }): Promise<Evidence<P> | null> {
  const pin = await pinGrant(env, owner, { provider: ref.provider, grantId: ref.grantId, need: "serving" });
  if (!pin || ref.grantRevision !== undefined && pin.revision !== ref.grantRevision) return null;
  const adapter = ADAPTERS[pin.provider], table = adapter.tables;
  const guard = grantFence(pin, "serving");
  const receipt = await env.AGENT_AUDIT.prepare(`SELECT r.id,r.created_at,r.expires_at,r.result_digest,r.report_json FROM ${table.receipts} r WHERE r.id=? AND r.grant_id=? AND r.grant_revision=? AND r.selection_json=? AND r.state='completed' AND r.expires_at>${FOUNDER_SQL_NOW} AND ${guard.sql}`).bind(ref.receiptId, pin.grantId, pin.revision, pin.selectionJson, ...guard.values).first<{id:string;created_at:number;expires_at:number;result_digest:string;report_json:string}>();
  if (!receipt || !receipt.report_json || deadlinePassed(pin.expiresAt, receipt.expires_at)) return null;
  if (await digestJson(receipt.report_json) !== receipt.result_digest) return null;
  try {
    const report = boundReport(adapter, JSON.parse(receipt.report_json), pin);
    const selection = adapter.selection(JSON.parse(pin.selectionJson));
    const proven = { id: receipt.id, createdAt: receipt.created_at, expiresAt: receipt.expires_at, resultDigest: receipt.result_digest, reportJson: receipt.report_json };
    const pred = pinPredicate(pin, "serving");
    const stored = (path: string) => `json_extract(e.doc,'$.${path}')`;
    const fence = {
      sql: `EXISTS(SELECT 1 FROM ${PIN} JOIN (SELECT ? AS doc) e JOIN ${table.grants} g ON g.id=${pinned("grantId")} JOIN ${table.receipts} r ON r.id=${stored("id")} AND r.grant_id=g.id AND r.grant_revision=g.revision WHERE r.created_at=${stored("createdAt")} AND r.selection_json=${pinned("selectionJson")} AND r.state='completed' AND r.report_json=${stored("reportJson")} AND r.result_digest=${stored("resultDigest")} AND r.expires_at=${stored("expiresAt")} AND r.expires_at>${FOUNDER_SQL_NOW} AND ${pred.sql})`,
      values: [JSON.stringify(pin), JSON.stringify(proven), ...pred.values],
    };
    return { pin, selection, receipt: proven, report, expiresAt: Math.min(pin.expiresAt, receipt.expires_at), fence } as Evidence<P>;
  } catch {
    return null;
  }
}
