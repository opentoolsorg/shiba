import { loadEvidence, type GrantPin } from "./reads/index.js";
import type { WorkspaceNativeMember } from "../workspace-native-authority.js";
import { assertReadsAvailable, type FounderReadsEnv } from "./reads/index.js";
import { renderAutomaticSlackReport, type AutomaticSlackGuard } from "./founder-automatic-slack-store.js";
import { WorkspaceIntegrationError } from "../workspace-integrations-store.js";

export interface StripeEvidencePin {
  id: string; workspace_id: string; owner_id: string; owner_account_id: string; owner_json: string;
  account_id: string; mode: "live" | "test"; revision: number; expires_at: number; fingerprint: string;
  selection_json: string; contract_digest: string; executor_digest: string; max_calls: number;
}
export interface StripeSlackReceipt { id: string; grant_id: string; grant_revision: number; state: string; selection_json: string; report_json: string; result_digest: string; created_at: number; expires_at: number }
export interface StripeSlackSource { grant: StripeEvidencePin; receipt: StripeSlackReceipt; content: string; guard: AutomaticSlackGuard }
const deny = (): never => { throw new WorkspaceIntegrationError("automatic_slack_stripe_source_unavailable", 403); };

export function stripeSlackReadPin(pin: StripeEvidencePin): GrantPin<"stripe"> {
  return { v: 1, provider: "stripe", grantId: pin.id, revision: pin.revision, workspaceId: pin.workspace_id, ownerId: pin.owner_id, ownerAccountId: pin.owner_account_id, ownerJson: pin.owner_json, accountId: pin.account_id, fingerprint: pin.fingerprint, contractDigest: pin.contract_digest, executorDigest: pin.executor_digest, selectionJson: pin.selection_json, expiresAt: pin.expires_at, maxCalls: pin.max_calls, facts: { mode: pin.mode } };
}

/** One complete owner-private Stripe receipt, loaded and re-fenced by founder/reads. */
export async function loadStripeSlackSource(env: FounderReadsEnv, owner: WorkspaceNativeMember, grantId: string, receiptId: string): Promise<StripeSlackSource> {
  assertReadsAvailable(env,"stripe");
  const evidence = await loadEvidence(env, owner, { provider: "stripe", grantId, receiptId });
  if (!evidence || evidence.receipt.reportJson.length > 100000) return deny();
  const pin = evidence.pin;
  const grant: StripeEvidencePin = { id: pin.grantId, workspace_id: pin.workspaceId, owner_id: pin.ownerId, owner_account_id: pin.ownerAccountId, owner_json: pin.ownerJson, account_id: pin.accountId, mode: pin.facts.mode, revision: pin.revision, expires_at: pin.expiresAt, fingerprint: pin.fingerprint, selection_json: pin.selectionJson, contract_digest: pin.contractDigest, executor_digest: pin.executorDigest, max_calls: pin.maxCalls };
  const receipt: StripeSlackReceipt = { id: evidence.receipt.id, grant_id: pin.grantId, grant_revision: pin.revision, state: "completed", selection_json: pin.selectionJson, report_json: evidence.receipt.reportJson, result_digest: evidence.receipt.resultDigest, created_at: evidence.receipt.createdAt, expires_at: evidence.receipt.expiresAt };
  // Evidence arrives parsed by the strict Stripe report schema and bound to its pin; only this disclosure's own rules are checked here.
  const report = evidence.report, capture = report.capture, selection = evidence.selection, interval = capture.interval;
  if (interval.createdGte !== selection.createdGte || interval.createdLt !== selection.createdLt) return deny();
  if (report.principal.id !== `schedule:${pin.grantId}` || report.capturedAt < receipt.created_at || report.capturedAt >= receipt.expires_at || capture.kind !== selection.kind || capture.rows.length > selection.limit) return deny();
  const seen = new Set<string>();
  const rows = capture.rows.map((row) => {
    if (seen.has(row.id) || row.created < selection.createdGte || row.created >= selection.createdLt) return deny();
    seen.add(row.id);
    if (capture.kind === "invoices") {
      if (!("amountPaid" in row) || row.livemode !== (grant.mode === "live")) return deny();
      return `${row.id} created=${row.created} ${row.currency} amount_paid_minor=${row.amountPaid} status=${row.status ?? "unknown"}`;
    }
    if (!("amount" in row) || BigInt(row.amount) - BigInt(row.fee) !== BigInt(row.net)) return deny();
    return `${row.id} created=${row.created} ${row.currency} amount_minor=${row.amount} fee_minor=${row.fee} net_minor=${row.net} type=${row.type} source=${row.source ?? "unknown"}`;
  });
  const text = ["Stripe scheduled captured evidence (fixed qualified row summary v1).", `Grant ${grant.id} revision ${grant.revision} contract ${grant.contract_digest}. Executor ${grant.executor_digest}.`, `Receipt ${receipt.id} digest ${receipt.result_digest}. Account ${grant.account_id} mode ${grant.mode}.`, `Captured ${new Date(report.capturedAt).toISOString()}; window [${selection.createdGte}, ${selection.createdLt}) UTC epoch seconds; ${capture.kind}; page has_more=${String(capture.hasMore)}.`, `Captured rows=${rows.length}; captured bytes=${report.capturedBytes}; bounded response, dataset completeness unknown, business success unverified. This is not a payment, revenue, MRR, churn or full-ledger reconciliation claim.`, `Currency amounts are integer minor units per row. ${capture.hasMore ? "The source reports further pages; captured coverage is incomplete." : "One page was captured; full dataset coverage remains unknown."}`, ...rows].join("\n");
  const content = renderAutomaticSlackReport(text);
  const guard = stripeSlackSourceGuard({ grant, receipt, content, guard: evidence.fence });
  const current = await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${guard.sql}`).bind(...guard.values).first();
  assertReadsAvailable(env,"stripe");
  if (!current || Date.now() >= Math.min(grant.expires_at, receipt.expires_at)) return deny();
  return { grant, receipt, content, guard };
}

/** Reuses Evidence's same grant, owner, receipt, digest and lease re-proof fence. */
export function stripeSlackSourceGuard(source: StripeSlackSource): AutomaticSlackGuard { return source.guard; }
