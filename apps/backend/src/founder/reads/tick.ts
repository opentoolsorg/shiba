import { FOUNDER_SQL_NOW } from "../founder-connector-context.js";
import { deadlinePassed } from "../native-session.js";
import type { Grant, ReadAdapter, ReadsEnv } from "./adapter.js";
import { assertAvailable, digestJson, ownerOf, validContract } from "./contract.js";
import { dispatchReadRequest } from "./dispatch.js";
import { blockGrant, exactRow, managerFence, proveDispatch, TAG } from "./ledger.js";
import { openGrant } from "./lifecycle.js";

const DAY = 86400000;
// Stored report bytes keep the key order each provider has always written; keys an adapter adds through `extras` take their slot here.
const REPORT_KEYS = ["format", "principal", "accountId", "mode", "grantId", "revision", "contractDigest", "executorDigest", "apiVersion", "currency", "timezoneName", "capturedAt", "capturedBytes", "notice", "capture", "summary"];

/** The report has one owner: the engine writes the envelope and binds it to the grant; the adapter supplies the capture, a notice and its extras. */
function envelope(adapter: ReadAdapter, grant: Grant, capturedBytes: number, projected: ReturnType<ReadAdapter["project"]>) {
  const fields: Record<string, unknown> = {
    ...projected.extras,
    format: `shiba.${adapter.id}-read-report.v1`, accountId: grant.account_id, ...Object.fromEntries(adapter.scopeColumns.map((column) => [column, grant[column]])),
    grantId: grant.id, revision: grant.revision, contractDigest: grant.contract_digest, executorDigest: grant.executor_digest, apiVersion: adapter.contract.apiVersion,
    capturedAt: Date.now(), capturedBytes, notice: projected.notice, capture: projected.capture,
  };
  const slot = (key: string) => (REPORT_KEYS.indexOf(key) + 1) || REPORT_KEYS.length + 1;
  const report = Object.fromEntries(Object.entries(fields).sort(([a], [b]) => slot(a) - slot(b)));
  adapter.schemas.report.parse(report);
  return JSON.stringify(report);
}

/** Serial scheduler: at most one due grant per run, one provider call per occurrence, never a retry after the call is reserved. */
export async function tickReads(env: ReadsEnv, adapter: ReadAdapter) {
  try { assertAvailable(adapter, env); } catch { return { created: 0, unavailable: true }; }
  const { grants, receipts } = adapter.tables;
  const due = await env.AGENT_AUDIT.prepare(`${TAG.tickDue} SELECT * FROM ${grants} WHERE state='enabled' AND next_due_at<=${FOUNDER_SQL_NOW} AND expires_at>${FOUNDER_SQL_NOW} AND used_calls<max_calls ORDER BY next_due_at,id LIMIT 1`).all<Grant>();
  let created = 0;
  for (const grant of due.results) {
    if (adapter.factColumns.some((column) => !grant[column]) || !await validContract(adapter, grant)) { await blockGrant(env, adapter, grant, "enabled"); continue; }
    const guard = managerFence(ownerOf(grant)), row = exactRow(adapter, grant);
    if (grant.next_due_at !== null && Date.now() - grant.next_due_at > 900000) {
      const skipped = await env.AGENT_AUDIT.prepare(`UPDATE ${grants} SET next_due_at=?,updated_at=? WHERE ${row.sql} AND state='enabled' AND next_due_at=? AND ${guard.sql}`).bind(Date.now() + DAY, Date.now(), ...row.values, grant.next_due_at, ...guard.values).run();
      if (skipped.meta.changes !== 1) await blockGrant(env, adapter, grant, "enabled");
      continue;
    }
    let secret: string;
    try { secret = await openGrant(adapter, env, grant); } catch { await blockGrant(env, adapter, grant, "enabled"); continue; }
    const id = `${adapter.wire.receiptPrefix}${crypto.randomUUID().replaceAll("-", "")}`, now = Date.now(), expiresAt = Math.min(grant.expires_at, now + DAY);
    const selection = adapter.selection(JSON.parse(grant.selection_json));
    const reserved = await env.AGENT_AUDIT.batch([
      env.AGENT_AUDIT.prepare(`${TAG.reserve} UPDATE ${grants} SET state='running',used_calls=used_calls+1,updated_at=? WHERE ${row.sql} AND state='enabled' AND next_due_at<=${FOUNDER_SQL_NOW} AND used_calls<max_calls AND expires_at>${FOUNDER_SQL_NOW} AND ${guard.sql}`).bind(now, ...row.values, ...guard.values),
      env.AGENT_AUDIT.prepare(`INSERT INTO ${receipts}(id,grant_id,grant_revision,state,selection_json,created_at,expires_at) SELECT ?,?,?,'dispatching',?,?,? WHERE changes()=1`).bind(id, grant.id, grant.revision, grant.selection_json, now, expiresAt),
    ]);
    // A concurrent tick can own this grant; losing the claim must not block it.
    if (reserved[0]?.meta.changes !== 1) continue;
    created++;
    try {
      const deadline = await proveDispatch(env, adapter, grant, "running");
      const response = await dispatchReadRequest(adapter.readRequest(selection, grant, secret), deadline, adapter.id);
      const report = envelope(adapter, grant, response.capturedBytes, adapter.project(selection, response.body, grant));
      if (report.includes(secret)) throw new Error(`${adapter.id}_redaction_required`);
      const digest = await digestJson(report);
      assertAvailable(adapter, env);
      if (deadlinePassed(expiresAt, deadline)) throw new Error(`${adapter.id}_authority_changed`);
      const done = await env.AGENT_AUDIT.batch([
        env.AGENT_AUDIT.prepare(`${TAG.settle} UPDATE ${receipts} SET state='completed',report_json=?,result_digest=? WHERE id=? AND state='dispatching' AND expires_at>${FOUNDER_SQL_NOW} AND EXISTS(SELECT 1 FROM ${grants} WHERE ${row.sql} AND state='running' AND expires_at>${FOUNDER_SQL_NOW}) AND ${guard.sql}`).bind(report, digest, id, ...row.values, ...guard.values),
        env.AGENT_AUDIT.prepare(`UPDATE ${grants} SET state=CASE WHEN used_calls>=max_calls THEN 'exhausted' ELSE 'enabled' END,next_due_at=?,updated_at=? WHERE id=? AND revision=? AND state='running' AND changes()=1`).bind(now + DAY, Date.now(), grant.id, grant.revision),
      ]);
      if (done[0]?.meta.changes !== 1) throw new Error(`${adapter.id}_authority_changed`);
    } catch {
      await env.AGENT_AUDIT.prepare(`UPDATE ${receipts} SET state='unknown' WHERE id=? AND state='dispatching'`).bind(id).run();
      await blockGrant(env, adapter, grant, "running");
    }
  }
  return { created, unavailable: false };
}
