import { useEffect, useRef, useState, type JSX } from "react";
import type { FounderReconciliationSchedule } from "@shiba/shared";
import { FounderReconciliationClient, type ReconciliationMetadata } from "../founder-reconciliation-client";
import { FounderReconciliationAutomaticSlack } from "./FounderReconciliationAutomaticSlack";
import { FounderReconciliationSchedulesClient, type ReconciliationScheduleMetadata, type ReconciliationScheduledResult } from "../founder-reconciliation-schedules-client";

const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const FIELD = "mt-1 min-h-11 min-w-0 w-full border border-[var(--input-line)] bg-[var(--paper)] px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
type Props = { workspaceId: string; actorId: string; onClose: () => void; sampleId?: string };
export function FounderReconciliationSchedules(props: Props): JSX.Element { return <ScheduleContent key={`${props.workspaceId}:${props.actorId}:${props.sampleId ?? ""}`} {...props} />; }
function ScheduleContent({ workspaceId, actorId, sampleId, onClose }: Props): JSX.Element {
  const [showSharing, setShowSharing] = useState(false);
  const [client] = useState(() => new FounderReconciliationSchedulesClient(workspaceId, actorId));
  const [samplesClient] = useState(() => new FounderReconciliationClient(workspaceId, actorId));
  const [items, setItems] = useState<ReconciliationScheduleMetadata[] | null>(null), [samples, setSamples] = useState<ReconciliationMetadata[]>([]), [available, setAvailable] = useState(false);
  const [comparison, setComparison] = useState(sampleId ?? ""), [expiry, setExpiry] = useState(""), [cap, setCap] = useState(""), [skew, setSkew] = useState("");
  const [schedule, setSchedule] = useState<FounderReconciliationSchedule | null>(null), [results, setResults] = useState<ReconciliationScheduledResult[]>([]), [review, setReview] = useState("");
  const [report, setReport] = useState<{ text: string; expiresAt: number; digest: string; resultId: string } | null>(null), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [now, setNow] = useState(Date.now());
  const controller = useRef<AbortController | null>(null), pending = useRef<AbortSignal | null>(null), epoch = useRef(0);
  const active = (signal: AbortSignal) => controller.current?.signal === signal && !signal.aborted;
  const clear = () => { epoch.current++; setReport(null); setReview(""); setShowSharing(false); };
  const perform = async (work: (signal: AbortSignal) => Promise<void>) => {
    const signal = controller.current?.signal; if (!signal || !active(signal) || pending.current) return;
    pending.current = signal; setBusy(true); setError(null); setNotice(null);
    try { await work(signal); } catch (cause) { if (active(signal)) { clear(); setSchedule(null); setResults([]); setUncertain(true); setError(cause instanceof Error ? cause.message : "Future comparison state could not be confirmed."); } }
    finally { if (pending.current === signal) { pending.current = null; if (active(signal)) setBusy(false); } }
  };
  const refresh = async (signal: AbortSignal) => {
    clear(); const current = epoch.current; setSchedule(null); setResults([]);
    const [listing, source] = await Promise.allSettled([client.list(signal), samplesClient.list(signal)]);
    if (!active(signal) || current !== epoch.current) return; if (listing.status === "rejected") throw listing.reason;
    setItems(listing.value.schedules); setAvailable(listing.value.available); setSamples(source.status === "fulfilled" ? source.value.drafts.filter((d) => d.state === "completed" && d.expiresAt > Date.now()) : []); setUncertain(false); setNow(Date.now());
  };
  useEffect(() => { const c = new AbortController(); controller.current = c; void perform(refresh); return () => { c.abort(); if (pending.current === c.signal) pending.current = null; }; }, []);
  useEffect(() => {
    if (!schedule && !report) return;
    const deadline = Math.min(schedule?.expiresAt ?? Infinity, schedule?.state === "draft" ? schedule.reviewExpiresAt : Infinity, report?.expiresAt ?? Infinity);
    const timer = setTimeout(() => { setNow(Date.now()); clear(); }, Math.max(0, Math.min(deadline - Date.now() + 1, 2147483647)));
    return () => clearTimeout(timer);
  }, [schedule, report]);
  useEffect(() => { const hide = () => { if (document.visibilityState !== "visible") { clear(); setSchedule(null); setResults([]); setUncertain(true); } }; document.addEventListener("visibilitychange", hide); return () => document.removeEventListener("visibilitychange", hide); }, []);
  const show = (id: string) => { clear(); const current = epoch.current; void perform(async (signal) => { const value = await client.read(id, signal); if (active(signal) && current === epoch.current) { setSchedule(value.schedule); setResults(value.results); setNow(Date.now()); setUncertain(false); } }); };
  const prepare = () => {
    const expiresAt = new Date(expiry).getTime(), maxComparisons = Number(cap), maxSkewMinutes = Number(skew);
    if (!samples.some((d) => d.id === comparison && d.expiresAt > Date.now()) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 28 * 86400000 || !Number.isInteger(maxComparisons) || maxComparisons < 1 || maxComparisons > 8 || !Number.isInteger(maxSkewMinutes) || maxSkewMinutes < 1 || maxSkewMinutes > 1440) { setError("Choose a current completed comparison, expiry within 28 days, at most eight results and a skew of 1–1,440 minutes."); return; }
    clear(); const current = epoch.current; void perform(async (signal) => { const value = await client.prepare({ comparisonId: comparison, expiresAt, maxComparisons, maxSkewMinutes }, signal); if (active(signal) && current === epoch.current) { setSchedule(value); setResults([]); setNow(Date.now()); setNotice("Standing draft prepared. Review the exact future authority before enabling."); } });
  };
  const reviewKey = schedule ? `${schedule.id}:${schedule.digest}` : "";
  const enable = () => { if (!schedule || uncertain || review !== reviewKey || schedule.reviewExpiresAt <= Date.now()) return; clear(); const current = epoch.current; void perform(async (signal) => { const value = await client.enable(schedule, signal); if (active(signal) && current === epoch.current) { setSchedule(value); setNow(Date.now()); setNotice("Future private comparisons enabled within this exact standing contract."); } }); };
  const reduce = (entry: Pick<ReconciliationScheduleMetadata, "id" | "digest">, action: "pause" | "revoke") => { clear(); void perform(async (signal) => { await client.reduce(entry, action, signal); if (active(signal)) { setSchedule(null); setResults([]); const value = await client.list(signal); if (active(signal)) { setItems(value.schedules); setAvailable(value.available); setNotice(action === "pause" ? "Future work stopped. Restarting requires a new reviewed grant." : "Standing grant revoked."); } } }); };
  const openReport = (receipt: ReconciliationScheduledResult) => { if (!schedule || uncertain) return; clear(); const current = epoch.current; void perform(async (signal) => { const value = await client.report(schedule, receipt, signal); if (active(signal) && current === epoch.current) setReport({ text: JSON.stringify(value.report, null, 2), expiresAt: value.expiresAt, digest: value.digest, resultId: receipt.id }); }); };
  return <section aria-label="Automatic private comparisons" className="mt-3 min-w-0 border border-[var(--line)] bg-[var(--card)] p-4 text-xs">
    <header className="flex flex-wrap justify-between gap-2"><h4 className="font-semibold">Automatic private comparisons</h4><button type="button" className={BUTTON} disabled={busy} onClick={onClose}>Close future comparisons</button></header>
    <p className="mt-3">A separate human consent permits future private comparisons of the same two owned source grants and mapping. It does not extend provider reads, payments, model calls or Slack sharing. The ordinary per-comparison approval remains separate. An enabled standing grant continues after this panel or browser session closes, until its cap, expiry, explicit stop or loss of source/owner authority.</p>
    <p className="mt-2">Only new captures made after consent are eligible. The oldest eligible HubSpot capture pairs with the nearest unused Stripe capture within your skew limit, with fixed timestamp/ID tie breaks. Successful reports are at least 24 hours apart; missing pairs are checked hourly without creating a result. No capture is reused within a grant. Results are bounded, independently timed and not a complete ledger or proof of payment or business success.</p>
    <p className="mt-2">Source selections stay fixed, including the selected HubSpot deal IDs and Stripe invoice-created interval. New captures do not create a rolling financial period or extend provider access. Changing those selections requires new source grants and a new comparison consent.</p>
    <button type="button" className={`${BUTTON} mt-3`} disabled={busy} onClick={() => { void perform(refresh); }}>Refresh future comparisons</button>
    {error && <p role="alert" className="mt-3 text-[var(--danger)]">{error}</p>}{notice && <p role="status" className="mt-3">{notice}</p>}{uncertain && <p className="mt-2">Refresh before another action. No uncertain action is retried automatically.</p>}
    {items && !available && <p className="mt-3">Automatic comparisons are unavailable or disabled. Existing grants can still be revoked.</p>}
    {available && !uncertain && <details className="mt-3 border border-[var(--line)] p-3"><summary className="min-h-11 cursor-pointer py-3">Prepare a standing comparison review</summary>
      <label className="block">Completed reference comparison<select className={FIELD} value={comparison} disabled={busy} onChange={(e) => { setComparison(e.target.value); clear(); }}><option value="">Choose a current owned comparison</option>{samples.map((d) => <option key={d.id} value={d.id}>{d.id} · expires {new Date(d.expiresAt).toISOString()}</option>)}</select></label>
      <label className="mt-2 block">Standing expiry (local time)<input className={FIELD} type="datetime-local" value={expiry} disabled={busy} onChange={(e) => { setExpiry(e.target.value); clear(); }} /></label>
      <label className="mt-2 block">Maximum future results<input className={FIELD} type="number" min="1" max="8" value={cap} disabled={busy} onChange={(e) => { setCap(e.target.value); clear(); }} /></label>
      <label className="mt-2 block">Maximum capture skew (minutes)<input className={FIELD} type="number" min="1" max="1440" value={skew} disabled={busy} onChange={(e) => { setSkew(e.target.value); clear(); }} /></label>
      <button type="button" className={`${BUTTON} mt-3`} disabled={busy || !comparison || !expiry || !cap || !skew} onClick={prepare}>Prepare future comparison review</button>
    </details>}
    {items && <ul className="mt-3 grid gap-2">{items.map((entry) => <li className="border border-[var(--line)] p-3" key={entry.id}>{entry.id} · {entry.state}<button type="button" className={`${BUTTON} ml-2`} disabled={busy} onClick={() => show(entry.id)}>Review standing comparison</button>{!["revoked", "exhausted"].includes(entry.state) && <button type="button" className={`${BUTTON} ml-2`} disabled={busy} onClick={() => reduce(entry, "revoke")}>Revoke standing grant {entry.id}</button>}</li>)}</ul>}
    {schedule && <article className="mt-3 space-y-2 border-t border-[var(--line)] pt-3"><h5 className="font-semibold">Standing comparison: {schedule.state}</h5><p className="break-all">Digest {schedule.digest} · executor {schedule.executorDigest} · {schedule.usedComparisons}/{schedule.maxComparisons} reserved results · expires {new Date(schedule.expiresAt).toISOString()}.</p>
      <p>Source-capture sample review expires {new Date(schedule.reviewExpiresAt).toISOString()}. After enabling, the sample may expire independently; future authority remains limited to the frozen source grants.</p>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify({ sourceGrants: schedule.sourceGrants, referenceSources: schedule.sampleSources, mapping: schedule.mapping, maxSkewMinutes: schedule.maxSkewMinutes, sampleId: schedule.sampleId, sampleHash: schedule.sampleHash, cutoffAt: schedule.cutoffAt, nextDueAt: schedule.nextDueAt }, null, 2)}</pre>
      {schedule.state === "draft" && <><label className="flex min-h-11 gap-2"><input type="checkbox" checked={review === reviewKey} disabled={busy || schedule.reviewExpiresAt <= now || schedule.expiresAt <= now} onChange={(e) => setReview(e.target.checked ? reviewKey : "")} />I authorize future private comparisons under these exact two source contracts, mapping, pairing rule, skew, daily interval, cap, expiry and source-code pin, without per-report approval. I grant no new provider reads, payments or sharing.</label><button type="button" className={BUTTON} disabled={busy || uncertain || review !== reviewKey || schedule.reviewExpiresAt <= now || schedule.expiresAt <= now} onClick={enable}>Enable future private comparisons</button></>}
      {schedule.state === "enabled" && <button type="button" className={BUTTON} disabled={busy} onClick={() => reduce(schedule, "pause")}>Stop future comparisons</button>}
      {schedule.state !== "revoked" && <button type="button" className={`${BUTTON} ml-2`} disabled={busy} onClick={() => reduce(schedule, "revoke")}>Revoke standing comparison</button>}
      <ul>{results.map((entry) => <li className="mt-2 border border-[var(--line)] p-2" key={entry.id}>{entry.id} · {entry.state} · expires {new Date(entry.expiresAt).toISOString()}{entry.state === "completed" && entry.expiresAt > now && <button type="button" className={`${BUTTON} ml-2`} disabled={busy || uncertain} onClick={() => openReport(entry)}>Read private scheduled result</button>}</li>)}</ul>
    </article>}
    {schedule && report && <section className="mt-3"><button type="button" className={BUTTON} onClick={() => setShowSharing((shown) => !shown)}>{showSharing ? "Close combined Slack review" : "Review future combined reports for Slack"}</button>{showSharing && <FounderReconciliationAutomaticSlack workspaceId={workspaceId} actorId={actorId} sample={{ scheduleId: schedule.id, sampleResultId: report.resultId, sampleHash: report.digest, expiresAt: report.expiresAt, scheduleExpiresAt: schedule.expiresAt }} onClose={() => setShowSharing(false)} />}</section>}
    {report && <div className="mt-3 border-t border-[var(--line)] pt-3"><p>Produced under the standing consent; not individually human-reviewed. Private result expires {new Date(report.expiresAt).toISOString()}.</p><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words">{report.text}</pre></div>}
  </section>;
}
