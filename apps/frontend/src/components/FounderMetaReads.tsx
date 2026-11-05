import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { FounderMetaGrant, FounderMetaReceipt } from "@shiba/shared";
import { FounderMetaClient } from "../founder-meta-client";

const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const FIELD = "mt-1 min-h-11 min-w-0 w-full border border-[var(--input-line)] bg-[var(--paper)] px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
type Props = { workspaceId: string; actorId: string; onClose: () => void };
type Detail = { grant: FounderMetaGrant; receipts: FounderMetaReceipt[] };
export function FounderMetaReads(props: Props): JSX.Element { return <MetaContent key={`${props.workspaceId}:${props.actorId}`} {...props} />; }
function MetaContent({ workspaceId, actorId, onClose }: Props): JSX.Element {
  const [client] = useState(() => new FounderMetaClient(workspaceId, actorId));
  const [grants, setGrants] = useState<FounderMetaGrant[] | null>(null), [available, setAvailable] = useState(false), [detail, setDetail] = useState<Detail | null>(null);
  const [report, setReport] = useState<{ text: string; digest: string; expiresAt: number } | null>(null);
  const [accountId, setAccountId] = useState("");
  const [start, setStart] = useState(""), [end, setEnd] = useState(""), [expiry, setExpiry] = useState(""), [limit, setLimit] = useState(""), [calls, setCalls] = useState("");
  const [attested, setAttested] = useState(false), [review, setReview] = useState(""), [quota, setQuota] = useState(""), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const keyField = useRef<HTMLInputElement>(null), controller = useRef<AbortController | null>(null), pending = useRef<AbortSignal | null>(null), contentEpoch = useRef(0);
  const tokenRef = useCallback((node: HTMLInputElement | null) => { if (!node && keyField.current) keyField.current.value = ""; keyField.current = node; }, []);
  const active = (signal: AbortSignal) => controller.current?.signal === signal && !signal.aborted;
  const clearPrivate = () => { contentEpoch.current++; setReport(null); setReview(""); setQuota(""); };
  const perform = async (work: (signal: AbortSignal) => Promise<void>) => { const signal = controller.current?.signal; if (!signal || !active(signal) || pending.current) return;
    pending.current = signal; setBusy(true); setError(null); setNotice(null);
    try { await work(signal); } catch (cause) { if (active(signal)) { clearPrivate(); setDetail(null); setUncertain(true); setError(cause instanceof Error ? cause.message : "Meta state could not be confirmed."); } }
    finally { if (pending.current === signal) { pending.current = null; if (active(signal)) setBusy(false); } }
  };
  const refresh = async (signal: AbortSignal) => { const next = await client.list(signal); if (active(signal)) { setGrants(next.grants); setAvailable(next.available); setDetail(null); clearPrivate(); setUncertain(false); } };
  useEffect(() => { const c = new AbortController(); controller.current = c; void perform(refresh); return () => { c.abort(); if (pending.current === c.signal) pending.current = null; if (keyField.current) keyField.current.value = ""; };
  }, []);
  useEffect(() => { if (!report) return; const timer = window.setTimeout(() => setReport(null), Math.max(0, report.expiresAt - Date.now())); return () => window.clearTimeout(timer); }, [report]);
  useEffect(() => { const hide = () => { if (document.visibilityState !== "visible") { contentEpoch.current++; setReport(null); if (pending.current) { setUncertain(true); setDetail(null); } } }; document.addEventListener("visibilitychange", hide); return () => document.removeEventListener("visibilitychange", hide); }, []);
  const show = (id: string) => { clearPrivate(); void perform(async (signal) => { const value = await client.detail(id, signal); if (active(signal)) setDetail(value); }); };
  const makeDraft = () => {
    const accessToken = keyField.current?.value ?? ""; if (keyField.current) keyField.current.value = "";
    if (!attested) { setError("Attest that the token is appropriate for ads read access."); return; }
    const selection = { since: start, until: end, limit: Number(limit) };
    const expiresAt = new Date(expiry).getTime(), maxCalls = Number(calls);
    if (!accessToken || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || Date.parse(end) - Date.parse(start) !== 6 * 86400000 || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 28 * 86400000 || !Number.isInteger(selection.limit) || selection.limit < 1 || selection.limit > 25 || !Number.isInteger(maxCalls) || maxCalls < 2 || maxCalls > 8) { setError("Choose a valid fixed interval, expiry within 28 days, page limit and call cap. Re-enter the token to submit."); return; }
    clearPrivate(); setAttested(false);
    void perform(async (signal) => { const value = await client.draft({ accountId, accessToken, expiresAt, maxCalls, selection, credentialAttestation: "creator-attests-token-appropriate-for-ads-read" }, signal); if (active(signal)) { setDetail(value); setNotice("Private draft saved. Verify the account before enabling the schedule."); } });
  };
  const grant = detail?.grant, reviewKey = grant ? JSON.stringify([grant.id, grant.revision, grant.digest, grant.fingerprint]) : "";
  const act = (action: "verify" | "enable" | "revoke") => { if (!grant || uncertain || (action === "enable" && (review !== reviewKey || quota !== reviewKey))) return;
    clearPrivate(); const epoch = contentEpoch.current; void perform(async (signal) => { const value = await client.decide(grant, action, signal); if (active(signal) && epoch === contentEpoch.current) { setDetail({ grant: value, receipts: [] }); setNotice(action === "verify" ? "The account verification returned. Review the exact grant before enabling." : action === "enable" ? "The exact scheduled read grant is enabled." : "The grant is revoked."); } });
  };
  const openReport = (receipt: FounderMetaReceipt) => { if (!grant || uncertain) return; clearPrivate(); const epoch = contentEpoch.current; void perform(async (signal) => { const value = await client.report(grant, receipt, signal); if (active(signal) && epoch === contentEpoch.current) setReport({ text: JSON.stringify(value.report, null, 2), digest: value.digest, expiresAt: Math.min(receipt.expiresAt, grant.expiresAt) }); }); };
  return <section aria-label="Private Meta scheduled reads" className="mt-3 min-w-0 border border-[var(--line)] bg-[var(--card)] p-4 text-xs">
    <header className="flex flex-wrap justify-between gap-2"><h4 className="font-semibold">Private Meta scheduled reads</h4><button className={BUTTON} type="button" disabled={busy} onClick={onClose}>Close Meta reads</button></header>
    <p className="mt-3">An explicitly supplied access token authorizes a selected Meta ad account and fixed seven-day interval. Verification consumes a call. The fixed interval repeats daily until expiry or the call cap. Token verification does not prove the absence of write permissions. Provider requests can consume quota or incur charges.</p>
    <p className="mt-2">Reports are private bounded captures; completeness, revenue and reconciliation are not established. No payment, write, sharing, model or Slack authority is granted.</p>
    <button type="button" className={`${BUTTON} mt-3`} disabled={busy} onClick={() => { void perform(refresh); }}>Refresh Meta access</button>
    {error && <p role="alert" className="mt-3 text-[var(--danger)]">{error}</p>}{notice && <p role="status" className="mt-3">{notice}</p>}{uncertain && <p className="mt-2">Refresh current state before another action. An uncertain request is never automatically retried.</p>}
    {grants && !available && <p className="mt-3">Meta reads are disabled or unavailable. Existing grants can still be reviewed and revoked.</p>}
    {grants && available && !uncertain && <details className="mt-3 border border-[var(--line)] p-3"><summary className="min-h-11 cursor-pointer py-3">Prepare a private Meta draft</summary>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2"><label>Numeric Meta ad account ID<input className={FIELD} value={accountId} disabled={busy} onChange={(e) => { setAccountId(e.target.value); setAttested(false); }} /></label>
      <label>Meta access token<input ref={tokenRef} type="password" autoComplete="off" className={FIELD} disabled={busy} onChange={() => setAttested(false)} /></label>
      <label>Since date (inclusive)<input className={FIELD} type="date" value={start} disabled={busy} onChange={(e) => { setStart(e.target.value); setAttested(false); }} /></label><label>Until date (inclusive)<input className={FIELD} type="date" value={end} disabled={busy} onChange={(e) => { setEnd(e.target.value); setAttested(false); }} /></label>
      <label>Grant expiry (local time)<input className={FIELD} type="datetime-local" value={expiry} disabled={busy} onChange={(e) => { setExpiry(e.target.value); setAttested(false); }} /></label><label>Maximum records per capture<input className={FIELD} type="number" min="1" max="25" value={limit} disabled={busy} onChange={(e) => { setLimit(e.target.value); setAttested(false); }} /></label><label>Maximum provider calls, including verification<input className={FIELD} type="number" min="2" max="8" value={calls} disabled={busy} onChange={(e) => { setCalls(e.target.value); setAttested(false); }} /></label></div>
      <label className="mt-3 flex min-h-11 gap-2"><input type="checkbox" checked={attested} disabled={busy} onChange={(e) => setAttested(e.target.checked)} />I attest that I created or control this token and it is appropriate for ads read access. Verification cannot establish that its other permissions are restricted.</label><button className={BUTTON} type="button" disabled={busy || !attested} onClick={makeDraft}>Prepare private draft</button>
    </details>}
    {grants && <ul className="mt-3 grid gap-2">{grants.map((g) => <li className="border border-[var(--line)] p-3" key={g.id}><span>{g.accountId} · {g.state}</span><button type="button" className={`${BUTTON} ml-2`} disabled={busy || uncertain} onClick={() => show(g.id)}>Review grant</button></li>)}</ul>}
    {grant && <article className="mt-3 border-t border-[var(--line)] pt-3"><h5 className="font-semibold">Grant: {grant.state}</h5><p className="mt-2 break-all">Account {grant.accountId} · token fingerprint {grant.fingerprint} · digest {grant.digest}</p><p className="mt-2">Fixed seven-day interval {grant.selection.since} to {grant.selection.until} inclusive · up to {grant.selection.limit} records · {grant.usedCalls}/{grant.maxCalls} calls used · expires {new Date(grant.expiresAt).toISOString()}</p><p className="mt-2">Verified currency {grant.currency ?? "not yet verified"} · timezone {grant.timezoneName ?? "not yet verified"} · API {grant.apiVersion} · executor {grant.executorDigest} · {grant.schedule} · {grant.maxPages} page · {grant.maxBytes.toLocaleString()} bytes and {grant.maxDurationMs.toLocaleString()} ms per read.</p>
      {available && grant.state === "draft" && <button type="button" className={`${BUTTON} mt-3`} disabled={busy || uncertain || grant.expiresAt <= Date.now()} onClick={() => act("verify")}>Verify exact Meta account</button>}
      {available && grant.state === "verified" && <><label className="mt-3 flex min-h-11 gap-2"><input type="checkbox" checked={review === reviewKey} disabled={busy} onChange={(e) => setReview(e.target.checked ? reviewKey : "")} />I reviewed this exact ad account, token fingerprint, verified currency and timezone, fixed interval, expiry and limits. The verification does not attest the token's other permissions.</label><label className="flex min-h-11 gap-2"><input type="checkbox" checked={quota === reviewKey} disabled={busy} onChange={(e) => setQuota(e.target.checked ? reviewKey : "")} />I authorize the exact daily reads and provider quota or charges within this call cap.</label><button type="button" className={BUTTON} disabled={busy || uncertain || review !== reviewKey || quota !== reviewKey || grant.expiresAt <= Date.now()} onClick={() => act("enable")}>Enable exact Meta reads</button></>}
      {grant.state !== "revoked" && <button type="button" className={`${BUTTON} mt-3`} disabled={busy || uncertain} onClick={() => act("revoke")}>Revoke Meta grant</button>}
      <ul className="mt-3 grid gap-2">{detail.receipts.map((r) => <li className="border border-[var(--line)] p-3" key={r.id}>{r.state} · {new Date(r.createdAt).toISOString()} {available && r.state === "completed" && r.expiresAt > Date.now() && <button type="button" className={BUTTON} disabled={busy || uncertain} onClick={() => openReport(r)}>Read private report</button>}</li>)}</ul>
    </article>}
    {report && <div className="mt-3 border-t border-[var(--line)] pt-3"><p className="break-all">Private report digest {report.digest} · expires {new Date(report.expiresAt).toISOString()}</p><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words">{report.text}</pre></div>}
  </section>;
}
