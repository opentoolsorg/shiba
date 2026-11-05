import { useEffect, useRef, useState, type JSX } from "react";
import type { FounderEvidenceOptions, FounderEvidenceInput, FounderEvidenceReceipt, FounderEvidencePreview, FounderEvidenceRecord, FounderEvidenceSummary } from "@shiba/shared";
import { FounderEvidenceClient } from "../founder-evidence-client";
import { ReportSlackDisclosure } from "./ReportSlackDisclosure";

const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const FIELD = "mt-1 min-h-11 min-w-0 w-full border border-[var(--input-line)] bg-[var(--paper)] px-3 py-2 text-xs";
type Props = { workspaceId: string; libraryId: string; name: string; onClose: () => void };

export function FounderEvidenceReports(props: Props): JSX.Element {
  return <FounderEvidenceReportsContent key={`${props.workspaceId}:${props.libraryId}`} {...props} />;
}
function FounderEvidenceReportsContent({ workspaceId, libraryId, name, onClose }: Props): JSX.Element {
  const [client] = useState(() => new FounderEvidenceClient(workspaceId, libraryId));
  const [options, setOptions] = useState<FounderEvidenceOptions | null>(null), [reports, setReports] = useState<FounderEvidenceSummary[]>([]);
  const [employeeId, setEmployeeId] = useState(""), [selected, setSelected] = useState<FounderEvidenceReceipt[]>([]), [expiry, setExpiry] = useState("");
  const [preview, setPreview] = useState<FounderEvidencePreview | null>(null), [previewInput, setPreviewInput] = useState<FounderEvidenceInput | null>(null);
  const [record, setRecord] = useState<FounderEvidenceRecord | null>(null), [format, setFormat] = useState<"markdown" | "json">("markdown");
  const [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null), pending = useRef(false), selectionEpoch = useRef(0), contentEpoch = useRef(0);
  const selection = useRef({ employeeId, selected }); selection.current = { employeeId, selected };
  const currentOptions = useRef(options); currentOptions.current = options;
  const visible = useRef(record); visible.current = record;
  const requestIdentity = useRef<{ hash: string; requestId: string } | null>(null);
  const active = (signal: AbortSignal) => controller.current?.signal === signal && !signal.aborted;
  const clearContent = () => { contentEpoch.current++; visible.current = null; setPreview(null); setPreviewInput(null); setReviewed(false); setRecord(null); setSharing(false); };
  const clearAccess = () => { clearContent(); setSelected([]); setOptions(null); setReports([]); setEmployeeId(""); };
  const load = async (signal: AbortSignal) => {
    const current = selection.current, employee = currentOptions.current?.employees.find((item) => item.id === current.employeeId);
    const epoch = selectionEpoch.current;
    const [setup, list] = await Promise.all([client.options(signal, employee ? { id: employee.id, version: employee.version } : undefined), client.list(signal)]);
    if (!active(signal) || epoch !== selectionEpoch.current) return;
    const previous = currentOptions.current;
    if ((previous && (previous.skill?.id !== setup.skill?.id || previous.skill?.version !== setup.skill?.version)) || current.selected.some((item) => !setup.receipts.some((next) => next.approvalId === item.approvalId && next.inputHash === item.inputHash && next.resultDigest === item.resultDigest &&
      (next.contextExpiresAt === null || next.contextExpiresAt > Date.now())))) { setSelected([]); clearContent(); setNotice("Selected receipt permission or content changed. Select current evidence and preview again."); }
    setOptions(setup); setReports(list.reports); setNeedsRefresh(false);
    const saved = visible.current;
    if (saved) {
      const fresh = await client.read(saved.id, signal, saved.reportHash);
      if (active(signal) && visible.current?.id === saved.id) setRecord(fresh);
    }
  };
  useEffect(() => {
    const current = new AbortController(); controller.current = current; pending.current = true; setBusy(true);
    const refresh = () => {
      if (!active(current.signal) || pending.current || document.visibilityState === "hidden") return;
      pending.current = true; setBusy(true);
      void load(current.signal).catch((cause) => { if (active(current.signal)) { clearAccess(); setNeedsRefresh(true); setError(cause instanceof Error ? cause.message : "Current evidence is unavailable."); } })
        .finally(() => { if (active(current.signal)) { pending.current = false; setBusy(false); } });
    };
    void load(current.signal).catch((cause) => { if (active(current.signal)) { clearAccess(); setError(cause instanceof Error ? cause.message : "Private evidence reports are unavailable."); } })
      .finally(() => { if (active(current.signal)) { pending.current = false; setBusy(false); } });
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    const timer = window.setInterval(refresh, 20_000); window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", onVisible);
    return () => { current.abort(); selectionEpoch.current++; contentEpoch.current++; window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", onVisible); };
    // biome-ignore lint/correctness/useExhaustiveDependencies: The wrapper fixes actor/workspace scope; continuations use the exact controller and current selection refs.
  }, []);
  useEffect(() => {
    const signal = controller.current?.signal, now = Date.now();
    if (!signal) return;
    const next = Math.min(preview?.expiresAt ?? Infinity, record?.expiresAt ?? Infinity, ...selected.map((item) => item.contextExpiresAt ?? Infinity));
    if (!Number.isFinite(next)) return;
    const expire = () => {
      if (!active(signal)) return;
      const at = Date.now();
      if (preview && preview.expiresAt <= at) { setPreview(null); setPreviewInput(null); setReviewed(false); }
      if (record && record.expiresAt <= at) { contentEpoch.current++; setRecord(null); setSharing(false); }
      if (selected.some((item) => item.contextExpiresAt !== null && item.contextExpiresAt <= at)) { setSelected([]); setPreview(null); setPreviewInput(null); setReviewed(false); }
    };
    const timer = window.setTimeout(expire, Math.min(2_147_483_647, Math.max(1, next - now + 1)));
    return () => window.clearTimeout(timer);
  }, [preview, record, selected]);
  const perform = async (operation: (signal: AbortSignal) => Promise<void>) => {
    const signal = controller.current?.signal;
    if (!signal || !active(signal) || pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await operation(signal); }
    catch (cause) { if (active(signal)) { clearAccess(); setNeedsRefresh(true); setError(cause instanceof Error ? cause.message : "Evidence state is unconfirmed. Refresh before another change."); } }
    finally { if (active(signal)) { pending.current = false; setBusy(false); } }
  };
  const chooseEmployee = (id: string) => {
    const employee = options?.employees.find((item) => item.id === id), epoch = ++selectionEpoch.current;
    setEmployeeId(id); setSelected([]); clearContent(); if (options) setOptions({ ...options, receipts: [] });
    if (!employee) return;
    void perform(async (signal) => { const value = await client.options(signal, employee); if (active(signal) && epoch === selectionEpoch.current) setOptions(value); });
  };
  const makePreview = () => {
    const employee = options?.employees.find((item) => item.id === employeeId), expiresAt = new Date(expiry).getTime();
    if (!employee || !options?.skill || !selected.length || selected.length > 8 || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 86_400_000) { setError("Choose current evidence and an explicit expiry within the next 24 hours."); return; }
    const input: FounderEvidenceInput = { employeeId, employeeVersion: employee.version, skillId: options.skill.id, skillVersion: options.skill.version,
      receipts: selected.map(({ approvalId, inputHash, resultDigest }) => ({ approvalId, inputHash, resultDigest })), expiresAt };
    clearContent();
    void perform(async (signal) => { const value = await client.preview(input, signal); if (!active(signal)) return;
      setPreview(value); setPreviewInput(input); setReviewed(false);
      if (requestIdentity.current?.hash !== value.reportHash) requestIdentity.current = { hash: value.reportHash, requestId: crypto.randomUUID() };
    });
  };
  const create = () => {
    if (!preview || !previewInput || !reviewed || !preview.canCreate || needsRefresh || preview.expiresAt <= Date.now()) return;
    const identity = requestIdentity.current;
    if (!identity || identity.hash !== preview.reportHash) return;
    void perform(async (signal) => { const value = await client.create(previewInput, preview, identity.requestId, signal); if (!active(signal)) return;
      setRecord(value); setPreview(null); setPreviewInput(null); setReviewed(false);
      const list = await client.list(signal); if (active(signal)) { setReports(list.reports); setNotice("Private immutable evidence report created. No app action or model was invoked."); }
    });
  };
  const open = (summary: FounderEvidenceSummary) => {
    if (!summary.canRead || summary.expiresAt <= Date.now()) return;
    const epoch = ++contentEpoch.current; setRecord(null); setPreview(null); setPreviewInput(null); setReviewed(false); setSharing(false);
    void perform(async (signal) => { const value = await client.read(summary.id, signal, summary.reportHash); if (active(signal) && epoch === contentEpoch.current) setRecord(value); });
  };
  const transfer = (kind: "copy" | "download") => {
    if (!record || !record.canRead || record.expiresAt <= Date.now()) return;
    const saved = record, epoch = contentEpoch.current;
    void perform(async (signal) => {
      const value = await client.download(saved, format, signal);
      if (!active(signal) || epoch !== contentEpoch.current || visible.current?.id !== saved.id || visible.current.reportHash !== saved.reportHash || saved.expiresAt <= Date.now()) return;
      if (kind === "copy") await navigator.clipboard.writeText(value);
      else {
        const blob = new Blob([value], { type: format === "json" ? "application/json" : "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob), anchor = document.createElement("a");
        try { anchor.href = url; anchor.download = `founder-evidence-${saved.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.${format === "json" ? "json" : "md"}`; anchor.click(); }
        finally { URL.revokeObjectURL(url); }
      }
      if (active(signal)) setNotice(kind === "copy" ? "Verified private report copied. Copies on your device cannot be revoked." : "Verified private report downloaded. Local copies cannot be revoked.");
    });
  };
  const revoke = (summary: Pick<FounderEvidenceSummary, "id" | "reportHash">) => {
    void perform(async (signal) => { await client.revoke(summary, signal); if (!active(signal)) return;
      clearContent(); const list = await client.list(signal); if (active(signal)) { setReports(list.reports); setNotice("Report revoked. Future server reads and downloads are blocked; local copies cannot be retracted."); }
    });
  };
  const content = record ?? preview;
  return <section aria-label={`Private evidence reports: ${name}`} className="mt-3 min-w-0 border border-[var(--line)] bg-[var(--card)] p-4 text-xs">
    <header className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">Private stored-evidence reports: {name}</h4><button type="button" className={BUTTON} disabled={busy} onClick={onClose}>Close evidence reports</button></header>
    <p className="mt-3">Select 1–8 of your recorded completed app receipts. Each source is a bounded stored excerpt: capture and dataset completeness are unknown, and business success is unverified. No MRR, churn, reconciliation or financial conclusions are computed.</p>
    <p className="mt-2">Only current source permissions and connection authorization metadata are checked. No new business data, app action, model, sandbox or Slack send is requested.</p>
    <button type="button" className={`${BUTTON} mt-3`} disabled={busy} onClick={() => { void perform(load); }}>Refresh private evidence</button>
    {error && <p role="alert" className="mt-3 text-[var(--danger)]">{error}</p>}{notice && <p role="status" className="mt-3">{notice}</p>}
    {needsRefresh && <p className="mt-2">Nothing is retried automatically. Refresh current source access before continuing.</p>}
    {!options ? <p className="mt-3">{error ? "Current native workspace evidence access is unavailable." : "Loading current evidence permissions…"}</p> : <>
      {!options.skill && <p className="mt-3">Install, review and activate this founder skill in the selected workspace first.</p>}
      <label className="mt-3 block">Employee version<select className={FIELD} value={employeeId} disabled={busy || needsRefresh} onChange={(event) => chooseEmployee(event.target.value)}><option value="">Choose the receipt's current employee</option>{options.employees.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}</select></label>
      {employeeId && options.receipts.length === 0 && <p className="mt-3">No eligible own completed receipts are available for this employee and recipe. No source data will be fetched to fill the gap.</p>}
      <ul className="mt-3 grid max-h-96 gap-2 overflow-auto">{options.receipts.map((item) => <li key={item.approvalId} className="min-w-0 border border-[var(--line)] p-3"><label className="flex min-h-11 gap-2"><input type="checkbox" checked={selected.some((value) => value.approvalId === item.approvalId)} disabled={busy || needsRefresh || (selected.length >= 8 && !selected.some((value) => value.approvalId === item.approvalId)) || (item.contextExpiresAt !== null && item.contextExpiresAt <= Date.now())} onChange={(event) => { const checked = event.target.checked; clearContent(); setSelected((values) => checked ? [...values, item] : values.filter((value) => value.approvalId !== item.approvalId)); }} /><span className="min-w-0 break-words">{item.providerKey} · {item.actionId}<br />Recorded {new Date(item.completedAt).toISOString()}</span></label><p className="mt-1 break-all font-mono">Receipt {item.approvalId}</p><p className="mt-1">Bounded stored excerpt. Capture completeness: unknown. Dataset completeness: unknown. Business success: unverified.</p><details className="mt-2"><summary className="min-h-11 cursor-pointer py-3">Exact receipt hashes</summary><p className="break-all">Input {item.inputHash}</p><p className="break-all">Stored result {item.resultDigest}</p></details></li>)}</ul>
      <p className="mt-2">Selected {selected.length} of 8 maximum. Missing, empty or partial data cannot establish complete business coverage.</p>
      <label className="mt-3 block">Absolute expiry in your browser's local time<input className={FIELD} type="datetime-local" value={expiry} disabled={busy || needsRefresh} onChange={(event) => { setExpiry(event.target.value); clearContent(); }} /></label>
      <p className="mt-1">Choose within 24 hours. An earlier source lease shortens the report expiry; the exact UTC expiry appears in the preview.</p>
      <button type="button" className={`${BUTTON} mt-3`} disabled={busy || needsRefresh || !options.skill || !employeeId || !selected.length || !expiry} onClick={makePreview}>Preview private evidence report</button>
    </>}
    {content && <div className="mt-4 min-w-0 border-t border-[var(--line)] pt-3"><h5 className="font-semibold">{record ? "Private saved evidence" : "Review exact evidence preview"}</h5><p className="mt-2">Expires {new Date(content.expiresAt).toISOString()}</p><p className="mt-2 break-all font-mono">Report hash {content.reportHash}</p>
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={BUTTON} aria-pressed={format === "markdown"} onClick={() => setFormat("markdown")}>Markdown</button><button type="button" className={BUTTON} aria-pressed={format === "json"} onClick={() => setFormat("json")}>JSON</button></div>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words" data-testid="evidence-content">{format === "markdown" ? content.markdown : content.json}</pre>
      {preview && <><label className="mt-3 flex min-h-11 gap-2"><input type="checkbox" checked={reviewed} disabled={busy || needsRefresh || preview.expiresAt <= Date.now()} onChange={(event) => setReviewed(event.target.checked)} />I reviewed these exact stored excerpts, source hashes, limitations and expiry. Save this report privately.</label><button type="button" className={BUTTON} disabled={busy || needsRefresh || !reviewed || !preview.canCreate || preview.expiresAt <= Date.now()} onClick={create}>Create reviewed private report</button></>}
      {record && <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={BUTTON} disabled={busy || needsRefresh || !record.canRead || record.expiresAt <= Date.now()} onClick={() => transfer("copy")}>Copy verified report</button><button type="button" className={BUTTON} disabled={busy || needsRefresh || !record.canRead || record.expiresAt <= Date.now()} onClick={() => transfer("download")}>Download verified report</button>{record.canRevoke && <button type="button" className={BUTTON} disabled={busy} onClick={() => revoke(record)}>Revoke private report</button>}</div>}
      {record && <button type="button" className={`${BUTTON} mt-3`} disabled={busy || needsRefresh || !record.canRead || record.expiresAt <= Date.now()} onClick={() => setSharing(true)}>Review separate Slack disclosure</button>}
      {record && sharing && <ReportSlackDisclosure workspaceId={workspaceId} libraryId={libraryId} report={record} onClose={() => setSharing(false)} />}
    </div>}
    <div className="mt-4 border-t border-[var(--line)] pt-3"><h5 className="font-semibold">Your private report records</h5><ul className="mt-2 grid gap-2">{reports.map((item) => <li key={item.id} className="min-w-0 border border-[var(--line)] p-3"><p>{new Date(item.createdAt).toISOString()} · {item.sourceCount} stored source{item.sourceCount === 1 ? "" : "s"} · {item.state}</p><p className="mt-1 break-all font-mono">{item.reportHash}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" className={BUTTON} disabled={busy || !item.canRead || item.expiresAt <= Date.now()} onClick={() => open(item)}>Open private report {item.id}</button>{item.canRevoke && <button type="button" className={BUTTON} disabled={busy} onClick={() => revoke(item)}>Revoke report {item.id}</button>}</div></li>)}</ul></div>
  </section>;
}
