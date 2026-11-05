import { useEffect, useRef, useState, type JSX } from "react";
import type { FounderReconciliationDraft, FounderReconciliationReport, FounderStripeGrant, FounderStripeReceipt, FounderHubSpotGrant, FounderHubSpotReceipt } from "@shiba/shared";
import { FounderReconciliationClient, type ReconciliationMetadata, type RollingMetric, type RollingReport, type RollingSelection } from "../founder-reconciliation-client";
import { FounderReconciliationSchedules } from "./FounderReconciliationSchedules";
const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const FIELD = "mt-1 min-h-11 min-w-0 w-full border border-[var(--input-line)] bg-[var(--paper)] px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
type Props = { workspaceId: string; actorId: string; onClose: () => void };
type Directory = Awaited<ReturnType<FounderReconciliationClient["sources"]>>;
export function FounderReconciliation(props: Props): JSX.Element { return <ReconciliationContent key={`${props.workspaceId}:${props.actorId}`} {...props} />; }
function ReconciliationContent({ workspaceId, actorId, onClose }: Props): JSX.Element {
  const [showFuture, setShowFuture] = useState(false);
  const [client] = useState(() => new FounderReconciliationClient(workspaceId, actorId));
  const [directory, setDirectory] = useState<Directory | null>(null), [drafts, setDrafts] = useState<ReconciliationMetadata[] | null>(null), [draft, setDraft] = useState<FounderReconciliationDraft | null>(null), [report, setReport] = useState<FounderReconciliationReport | null>(null);
  const [hubspotGrant, setHubspotGrant] = useState<FounderHubSpotGrant | null>(null), [hubspotReceipts, setHubspotReceipts] = useState<FounderHubSpotReceipt[]>([]);
  const [stripeGrant, setStripeGrant] = useState<FounderStripeGrant | null>(null), [receipts, setReceipts] = useState<FounderStripeReceipt[]>([]), [stripeReceipt, setStripeReceipt] = useState(""), [occurrence, setOccurrence] = useState(""), [ordinal, setOrdinal] = useState(""), [unit, setUnit] = useState<"" | "major-decimal" | "minor-integer">(""), [expiry, setExpiry] = useState(""), [basis, setBasis] = useState(false), [review, setReview] = useState("");
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null), pending = useRef<AbortSignal | null>(null), contentEpoch = useRef(0);
  const active = (s: AbortSignal) => controller.current?.signal === s && !s.aborted;
  const clear = () => { contentEpoch.current++; setReport(null); setReview(""); setShowFuture(false); };
  const perform = async (fn: (s: AbortSignal) => Promise<void>) => { const s = controller.current?.signal; if (!s || !active(s) || pending.current) return; pending.current = s; setBusy(true); setError(null); setNotice(null);
    try { await fn(s); } catch (e) { if (active(s)) { clear(); setDraft(null); setUncertain(true); setError(e instanceof Error ? e.message : "Private reconciliation state is unavailable."); } }
    finally { if (pending.current === s) { pending.current = null; if (active(s)) setBusy(false); } }
  };
  const refresh = async (s: AbortSignal) => { const [items, sources] = await Promise.allSettled([client.list(s), client.sources(s)]); if (!active(s)) return;
    setDraft(null); clear(); setStripeGrant(null); setReceipts([]); setStripeReceipt(""); setHubspotGrant(null); setHubspotReceipts([]); setOccurrence(""); setOrdinal(""); setBasis(false);
    if (items.status === "rejected") throw items.reason; setDrafts(items.value.drafts); setDirectory(sources.status === "fulfilled" ? sources.value : null); setUncertain(false);
  };
  useEffect(() => { const c = new AbortController(); controller.current = c; void perform(refresh); return () => { c.abort(); if (pending.current === c.signal) pending.current = null; }; }, []);
  useEffect(() => { if (!draft || !report) return; const end = Math.min(draft.expiresAt, draft.sources.hubspot.expiresAt, draft.sources.stripe.expiresAt); const t = window.setTimeout(clear, Math.max(0, end - Date.now())); return () => window.clearTimeout(t); }, [draft, report]);
  useEffect(() => { const hide = () => { if (document.visibilityState !== "visible") { contentEpoch.current++; setReport(null); if (pending.current) { setUncertain(true); setDraft(null); } } }; document.addEventListener("visibilitychange", hide); return () => document.removeEventListener("visibilitychange", hide); }, []);
  const hub = directory?.hubspot.available && hubspotGrant ? { id: hubspotGrant.id, version: hubspotGrant.revision, contract: { expiresAt: hubspotGrant.expiresAt } } : null;
  const eligible = hubspotGrant ? [{ i: 0 as const, op: { arguments: hubspotGrant.selection } }] : [];
  const selectedOp = ordinal === "0" ? eligible[0] : undefined, args = selectedOp?.op.arguments;
  const sourceOccurrence = hubspotReceipts.find((item) => item.id === occurrence && item.state === "completed" && item.expiresAt > Date.now());
  const selectedReceipt = receipts.find((item) => item.id === stripeReceipt && item.state === "completed" && item.expiresAt > Date.now());
  const props = args && [args.invoiceIdProperty, args.paidAmountProperty, args.currencyProperty];
  const validProps = Boolean(props && props.every((x) => typeof x === "string") && new Set(props).size === 3);
  const reviewKey = draft ? `${draft.id}:${draft.digest}` : "";
  const selectHubSpot = (id: string) => { setHubspotGrant(null); setHubspotReceipts([]); setOccurrence(""); setOrdinal(""); setBasis(false); clear(); if (!id) return; void perform(async (s) => { const value = await client.hubspotReceipts(id, s); if (active(s) && ["enabled", "exhausted"].includes(value.grant.state) && value.grant.expiresAt > Date.now()) { setHubspotGrant(value.grant); setHubspotReceipts(value.receipts); setOrdinal("0"); } }); };
  const selectStripe = (id: string) => { setStripeGrant(null); setReceipts([]); setStripeReceipt(""); setBasis(false); clear(); if (!id) return; void perform(async (s) => { const value = await client.stripeReceipts(id, s); if (active(s) && value.grant.selection.kind === "invoices") { setStripeGrant(value.grant); setReceipts(value.receipts); } }); };
  const prepare = () => { if (!hub || !sourceOccurrence || !selectedOp || !stripeGrant || !selectedReceipt || !props || !validProps || !unit || !basis || uncertain) return; const expiresAt = new Date(expiry).getTime();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 86400000 || expiresAt > sourceOccurrence.expiresAt || expiresAt > selectedReceipt.expiresAt || expiresAt > hub.contract.expiresAt || expiresAt > stripeGrant.expiresAt) { setError("Choose an expiry within 24 hours and no later than either source's authority."); return; }
    clear(); void perform(async (s) => { const next = await client.draft({ hubspot: { grantId: hub.id, grantVersion: hub.version, occurrenceId: sourceOccurrence.id, sourceOrdinal: selectedOp.i }, stripe: { grantId: stripeGrant.id, receiptId: selectedReceipt.id }, mapping: { invoiceIdProperty: String(props[0]), paidAmountProperty: String(props[1]), currencyProperty: String(props[2]), amountUnit: unit, basisAttestation: "crm-property-represents-stripe-invoice-amount-paid" }, expiresAt }, s); if (active(s)) { setDraft(next); setNotice("Private draft created; review the frozen captures and mapping before comparison."); } });
  };
  const open = (id: string) => { clear(); const epoch = contentEpoch.current; void perform(async (s) => { const value = await client.detail(id, s); if (active(s) && epoch === contentEpoch.current) { setDraft(value.draft); setReport(value.report); } }); };
  const compose = () => { if (!draft || uncertain || review !== reviewKey) return; clear(); const epoch = contentEpoch.current; void perform(async (s) => { const result = await client.compose(draft, s); if (active(s) && epoch === contentEpoch.current) { setDraft(result.draft); setReport(result.report); setNotice("Private comparison composed from the reviewed captures."); } }); };
  const revoke = (entry: Pick<ReconciliationMetadata, "id" | "digest">) => { clear(); void perform(async (s) => { await client.revoke(entry, s); if (active(s)) { setDraft(null); setNotice("Comparison revoked."); const next = await client.list(s); if (active(s)) setDrafts(next.drafts); } }); };
  return <section aria-label="Private invoice reconciliation" className="mt-3 min-w-0 border border-[var(--line)] bg-[var(--card)] p-4 text-xs">
    <header className="flex flex-wrap justify-between gap-2"><h4 className="font-semibold">Private invoice reconciliation</h4><button type="button" className={BUTTON} disabled={busy} onClick={onClose}>Close reconciliation</button></header>
    <p className="mt-3">Compare two explicitly selected captured receipts. Missing deals or invoices mean uncaptured data, not proof of absence. Pages and date windows may be incomplete; business success is unverified. No provider read, payment, sharing or Slack action occurs here.</p>
    <button type="button" className={`${BUTTON} mt-3`} disabled={busy} onClick={() => { void perform(refresh); }}>Refresh reconciliation sources</button>
    <p className="mt-2 text-[var(--ink-2)]">Invoice reconciliation is not MRR or churn. MRR requires a defined recurring-revenue basis and subscription intervals; churn requires a defined customer or revenue cohort and period. Comparing invoice totals across capture windows does not establish either metric.</p>
    {error && <p role="alert" className="mt-3 text-[var(--danger)]">{error}</p>}{notice && <p role="status" className="mt-3">{notice}</p>}{uncertain && <p className="mt-2">Refresh before another action. An uncertain action is not retried automatically.</p>}
    {(!directory || !directory.hubspot.available || !directory.hubspot.grants.some((g) => ["enabled", "exhausted"].includes(g.state) && g.expiresAt > Date.now())) && <p className="mt-3">An eligible native HubSpot invoice snapshot is unavailable. This flow requires a current owned, completed, explicitly configured source; live connector support is not assumed.</p>}
    {directory && !directory.stripe.available && <p className="mt-2">Stripe captures are unavailable or disabled. Existing comparisons may still be revoked.</p>}
    {directory && directory.hubspot.available && !uncertain && <details className="mt-3 border border-[var(--line)] p-3"><summary className="min-h-11 cursor-pointer py-3">Prepare an exact private comparison</summary>
      <label className="block">HubSpot portal grant<select className={FIELD} value={hubspotGrant?.id ?? ""} disabled={busy} onChange={(e) => selectHubSpot(e.target.value)}><option value="">Choose an owned HubSpot grant</option>{directory.hubspot.grants.filter((g) => ["enabled", "exhausted"].includes(g.state) && g.expiresAt > Date.now()).map((g) => <option key={g.id} value={g.id}>{g.accountId} · {g.id} · v{g.revision}</option>)}</select></label>
      <label className="mt-2 block">Completed HubSpot occurrence<select className={FIELD} value={occurrence} disabled={busy || !hubspotGrant} onChange={(e) => { setOccurrence(e.target.value); setBasis(false); clear(); }}><option value="">Choose a captured occurrence</option>{hubspotReceipts.filter((x) => x.state === "completed" && x.expiresAt > Date.now()).map((x) => <option key={x.id} value={x.id}>{x.id} · expires {new Date(x.expiresAt).toISOString()}</option>)}</select></label>
      <label className="mt-2 block">Stripe invoice grant<select className={FIELD} value={stripeGrant?.id ?? ""} disabled={busy} onChange={(e) => selectStripe(e.target.value)}><option value="">Choose an owned invoice grant</option>{directory.stripe.grants.filter((g) => directory.stripe.available && g.selection.kind === "invoices" && ["enabled", "exhausted"].includes(g.state) && g.expiresAt > Date.now()).map((g) => <option key={g.id} value={g.id}>{g.accountId} · {g.mode} · {g.id}</option>)}</select></label>
      <label className="mt-2 block">Completed Stripe invoice receipt<select className={FIELD} value={stripeReceipt} disabled={busy || !stripeGrant} onChange={(e) => { setStripeReceipt(e.target.value); setBasis(false); clear(); }}><option value="">Choose a captured receipt</option>{receipts.filter((r) => r.state === "completed" && r.expiresAt > Date.now()).map((r) => <option key={r.id} value={r.id}>{r.id} · expires {new Date(r.expiresAt).toISOString()}</option>)}</select></label>
      {selectedOp && <p className="mt-2 break-words">Configured HubSpot fields: invoice ID {String(props?.[0] ?? "unavailable")}; paid amount {String(props?.[1] ?? "unavailable")}; currency {String(props?.[2] ?? "unavailable")}. These field names come from the selected captured operation.</p>}
      <label className="mt-2 block">CRM paid amount unit<select className={FIELD} value={unit} disabled={busy} onChange={(e) => { setUnit(e.target.value as typeof unit); setBasis(false); clear(); }}><option value="">Choose the actual field unit</option><option value="major-decimal">Major currency decimal</option><option value="minor-integer">Minor currency integer</option></select></label>
      <label className="mt-2 block">Comparison expiry (local time)<input className={FIELD} type="datetime-local" value={expiry} disabled={busy} onChange={(e) => { setExpiry(e.target.value); setBasis(false); clear(); }} /></label>
      <label className="mt-3 flex min-h-11 gap-2"><input type="checkbox" checked={basis} disabled={busy} onChange={(e) => setBasis(e.target.checked)} />I attest the selected CRM field represents the Stripe invoice amount paid, in the selected unit and currency. A deal value alone is not assumed to be cash paid.</label>
      <button type="button" className={BUTTON} disabled={busy || !sourceOccurrence || !selectedReceipt || !validProps || !unit || !basis || !expiry} onClick={prepare}>Prepare exact comparison review</button>
    </details>}
    {drafts && <ul className="mt-3 grid gap-2">{drafts.map((d) => <li key={d.id} className="border border-[var(--line)] p-3">{d.id} · {d.state}<button type="button" className={`${BUTTON} ml-2`} disabled={busy || uncertain} onClick={() => open(d.id)}>Review comparison</button>{d.state !== "revoked" && <button type="button" className={`${BUTTON} ml-2`} disabled={busy || uncertain} onClick={() => revoke(d)}>Revoke comparison {d.id}</button>}</li>)}</ul>}
    {draft && <article className="mt-3 border-t border-[var(--line)] pt-3"><h5 className="font-semibold">Comparison: {draft.state}</h5><p className="mt-2 break-all">Digest {draft.digest} · expires {new Date(draft.expiresAt).toISOString()}</p><details open={draft.state === "draft"} className="mt-2"><summary className="min-h-11 cursor-pointer py-3">Review frozen sources, capture windows, pins and mapping</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify({ sources: draft.sources, mapping: draft.mapping }, null, 2)}</pre></details>
      {draft.state === "draft" && <><label className="mt-2 flex min-h-11 gap-2"><input type="checkbox" checked={review === reviewKey} disabled={busy} onChange={(e) => setReview(e.target.checked ? reviewKey : "")} />I reviewed the exact captured sources, IDs, selected CRM properties, amount unit and basis, time windows, expiry and uncertainty.</label><button type="button" className={BUTTON} disabled={busy || uncertain || review !== reviewKey || draft.expiresAt <= Date.now()} onClick={compose}>Compose private comparison</button></>}
      {draft.state !== "revoked" && <button type="button" className={`${BUTTON} mt-3`} disabled={busy || uncertain} onClick={() => revoke(draft)}>Revoke comparison</button>}
    </article>}
    {draft?.state === "completed" && report && <RollingComparison key={`${draft.id}:${draft.digest}`} draft={draft} busy={busy} uncertain={uncertain} submit={async (selection) => {
      let output: RollingReport | null = null;
      const epoch = contentEpoch.current;
      await perform(async (signal) => { const result = await client.rolling(draft, selection, signal); if (active(signal) && epoch === contentEpoch.current) output = result; });
      return output;
    }} />}
    {draft?.state === "completed" && report && <section className="mt-3"><button type="button" className={BUTTON} onClick={() => setShowFuture((shown) => !shown)}>{showFuture ? "Close standing comparison setup" : "Configure future private comparisons"}</button>{showFuture && <FounderReconciliationSchedules workspaceId={workspaceId} actorId={actorId} sampleId={draft.id} onClose={() => setShowFuture(false)} />}</section>}
    {draft && report && <div className="mt-3 border-t border-[var(--line)] pt-3"><p>Private bounded comparison · dataset completeness unknown · business success unverified. Unmatched means not found in the captured page; an uncaptured deal was not returned by the source.</p><p className="mt-2">Rows distinguish equal matches, differences, duplicate IDs, missing or invalid IDs, uncaptured deals, unmatched invoices and non-comparable amounts. Provider invoice status and creation time are shown where supplied; a numerical match does not prove payment or business success.</p><p className="mt-2 break-all">Report hash {draft.reportHash}</p><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(report, null, 2)}</pre></div>}
  </section>;
}

function RollingComparison({ draft, busy, uncertain, submit }: { draft: FounderReconciliationDraft; busy: boolean; uncertain: boolean; submit: (selection: RollingSelection) => Promise<RollingReport | null> }): JSX.Element {
  const [periodDays, setPeriodDays] = useState("7"), [metric, setMetric] = useState<RollingMetric>("invoice-paid-snapshot");
  const [asOf, setAsOf] = useState(() => new Date(Math.min(Math.floor(Date.now() / 1000), draft.sources.stripe.createdLt) * 1000).toISOString().slice(0, 19));
  const [reviewed, setReviewed] = useState(false), [output, setOutput] = useState<RollingReport | null>(null);
  const epoch = useRef(0), inFlight = useRef(false);
  useEffect(() => () => { epoch.current++; }, []);
  const reset = () => { epoch.current++; setReviewed(false); setOutput(null); };
  const end = Date.parse(`${asOf}Z`) / 1000, days = Number(periodDays), start = end - days * 86400;
  const valid = Number.isSafeInteger(end) && Number.isSafeInteger(days) && days >= 1 && days <= 28 && start >= draft.sources.stripe.createdGte && end <= draft.sources.stripe.createdLt && end <= Math.floor(Date.now() / 1000);
  const unavailable = metric !== "invoice-paid-snapshot";
  const compose = async () => {
    if (!reviewed || !valid || busy || uncertain || inFlight.current) return;
    const current = ++epoch.current; inFlight.current = true; setOutput(null); setReviewed(false);
    try { const result = await submit({ asOf: end, periodDays: days, metric }); if (epoch.current === current) setOutput(result); }
    finally { inFlight.current = false; }
  };
  return <section aria-label="Rolling-period reconciliation" className="mt-4 border border-[var(--line)] p-3">
    <h5 className="font-semibold">Reviewed rolling-period reconciliation</h5>
    <p className="mt-2">Private captured inputs only. No provider fetch, future consent, automatic refresh, or Slack sharing. Each submission needs a new review.</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      <label>Period length (days)<input className={FIELD} type="number" min="1" max="28" step="1" value={periodDays} disabled={busy} onChange={(e) => { reset(); setPeriodDays(e.target.value); }} /></label>
      <label>Period end (UTC, exclusive)<input className={FIELD} type="datetime-local" step="1" value={asOf} disabled={busy} onChange={(e) => { reset(); setAsOf(e.target.value); }} /></label>
      <label>Metric definition<select className={FIELD} value={metric} disabled={busy} onChange={(e) => { reset(); setMetric(e.target.value as RollingMetric); }}><option value="invoice-paid-snapshot">Invoice paid snapshot (qualified)</option><option value="mrr">MRR (unavailable)</option><option value="churn">Churn (unavailable)</option></select></label>
    </div>
    <p className="mt-2">{valid ? `${new Date(start * 1000).toISOString()} inclusive → ${new Date(end * 1000).toISOString()} exclusive · UTC · ${days * 86400} seconds` : "Choose 1–28 whole days wholly within the captured Stripe window, ending no later than now."}</p>
    <p className="mt-2">{unavailable ? metric === "mrr" ? "MRR is unavailable: subscription lifecycle snapshots, recurring price, quantity, intervals and effective dates, and an explicitly reviewed normalization definition are missing." : "Churn is unavailable: subscription lifecycle events, a period-start cohort, cancellation/reactivation effective dates, and a reviewed denominator and definition are missing." : "Invoice paid snapshot: sum amount_paid and attested CRM amounts for unique comparable matched invoices created in this window. Snapshot amounts are not payments received during the period, revenue, MRR or churn. Currencies are never combined."}</p>
    <dl className="mt-3 space-y-2 break-words">
      <div><dt className="font-semibold">Source dates and basis</dt><dd>HubSpot captured {new Date(draft.sources.hubspot.capturedAt).toISOString()} · account timezone {draft.sources.hubspot.timezoneName}; Stripe captured {new Date(draft.sources.stripe.capturedAt).toISOString()}. Period basis: Stripe invoice created timestamp, not payment date.</dd></div>
      <div><dt className="font-semibold">Captured window and completeness</dt><dd>{new Date(draft.sources.stripe.createdGte * 1000).toISOString()} inclusive → {new Date(draft.sources.stripe.createdLt * 1000).toISOString()} exclusive. Stripe more pages: {draft.sources.stripe.hasMore ? "yes — partial input" : "no"}. Selected CRM deals are not a complete ledger. Independently timed captures may be stale; undated and duplicate rows remain unassigned.</dd></div>
      <div><dt className="font-semibold">Reviewed mapping</dt><dd>Invoice ID: {draft.mapping.invoiceIdProperty}; paid amount: {draft.mapping.paidAmountProperty}; currency: {draft.mapping.currencyProperty}; amount unit: {draft.mapping.amountUnit}; basis: {draft.mapping.basisAttestation}.</dd></div>
      <div><dt className="font-semibold">Frozen provenance</dt><dd className="break-all">Comparison {draft.id} · review digest {draft.digest} · report hash {draft.reportHash} · executor {draft.executorDigest}. Full source pins are in the frozen-source review above.</dd></div>
    </dl>
    <label className="mt-3 flex min-h-11 gap-2"><input type="checkbox" checked={reviewed} disabled={busy || uncertain || !valid} onChange={(e) => { epoch.current++; setReviewed(e.target.checked); setOutput(null); }} />I reviewed this exact UTC period, metric definition, captured source dates, mapping, provenance and incomplete-data limitations. This review does not authorize future capture reuse.</label>
    <button type="button" className={BUTTON} disabled={busy || uncertain || !valid || !reviewed} onClick={() => { void compose(); }}>Compose reviewed rolling report</button>
    {output && <section aria-label="Rolling report result" className="mt-3 border-t border-[var(--line)] pt-3">
      <h6 className="font-semibold">{output.selectedMetric} · {output.metricAvailability.status}</h6>
      <p className="mt-2">{output.metricDefinition}</p>
      {output.metricAvailability.status === "unavailable" && <><p className="mt-2">Missing data — no metric totals available:</p><ul className="list-disc pl-5">{output.metricAvailability.missingDataReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></>}
      {output.metricAvailability.status === "qualified" && <><p className="mt-2">Exact integer minor units, per currency; not a complete ledger.</p>{output.perCurrency.length ? <div className="overflow-x-auto"><table className="mt-2 w-full text-left"><thead><tr>{["Currency", "Matched invoices", "CRM minor units", "Stripe minor units", "Difference (CRM − Stripe)"].map((label) => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{output.perCurrency.map((total) => <tr key={total.currency}>{[total.currency, total.matchedCount, total.crmMinor, total.stripeMinor, total.differenceMinor].map((value, i) => <td key={i} className="break-all p-2">{value}</td>)}</tr>)}</tbody></table></div> : <p>No comparable matched invoices in this captured period; this is not proof of zero activity.</p>}</>}
      <p className="mt-2">Dataset completeness: {output.datasetCompleteness} · business success: {output.businessSuccess}. Assigned rows: {output.rows.length}; unassigned/ambiguous: {output.unassignedRows.length}; outside period: {output.outsidePeriodRowCount}.</p>
      <p className="mt-2">Source ages at composition: HubSpot {output.completeness.sourceAgesMs.hubspot} ms; Stripe {output.completeness.sourceAgesMs.stripe} ms. Capture skew: {output.completeness.captureSkewMs} ms.</p>
      <ul className="mt-2 list-disc pl-5">{output.completeness.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <p className="mt-2">{output.notice}</p>
      <details className="mt-2"><summary className="min-h-11 cursor-pointer py-3">Inspect reproducible provenance, status counts and row evidence</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(output, null, 2)}</pre></details>
    </section>}
  </section>;
}
