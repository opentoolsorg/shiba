import { lazy, Suspense, useEffect, useRef, useState, type JSX } from "react";
import { FOUNDER_AUTOMATIC_READ_MAX_LIFETIME_MS, founderAutomaticReadInputSchema, type FounderAutomaticReadOptions, type FounderAutomaticReadState, type FounderAutomaticReadGrant, type FounderAutomaticReadOccurrence, type FounderAutomaticReadReport } from "@shiba/shared";
import { FounderAutomaticClient } from "../founder-automatic-client";

const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const FIELD = "mt-1 min-h-11 min-w-0 w-full border border-[var(--input-line)] bg-[var(--paper)] px-3 py-2 text-xs";
const FounderAutomaticSlack = lazy(() => import("./FounderAutomaticSlack").then((module) => ({ default: module.FounderAutomaticSlack })));
type Props = { workspaceId: string; libraryId: string; name: string; onClose: () => void };
type Step = { key: string; connectionId: string; operationId: string; argumentsText: string };
const emptyStep = (): Step => ({ key: crypto.randomUUID(), connectionId: "", operationId: "", argumentsText: "" });
const currentGrant = (state: FounderAutomaticReadState | null, now: number) => state?.available && state.grant && !["revoked", "blocked"].includes(state.grant.state) && state.grant.contract.expiresAt > now &&
  (!["draft", "paused"].includes(state.grant.state) || state.grant.reviewExpiresAt > now) ? state.grant : null;
const reviewKey = (grant: FounderAutomaticReadGrant) => JSON.stringify([grant.id, grant.version, grant.digest, grant.contract]);
const localDateInput = (at: number) => new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function FounderAutomaticReads(props: Props): JSX.Element {
  return <FounderAutomaticReadsContent key={`${props.workspaceId}:${props.libraryId}`} {...props} />;
}
function FounderAutomaticReadsContent({ workspaceId, libraryId, name, onClose }: Props): JSX.Element {
  const [client] = useState(() => new FounderAutomaticClient(workspaceId, libraryId));
  const [options, setOptions] = useState<FounderAutomaticReadOptions | null>(null), [view, setView] = useState<FounderAutomaticReadState | null>(null);
  const [employeeId, setEmployeeId] = useState(""), [steps, setSteps] = useState<Step[]>([]);
  const [cadence, setCadence] = useState(""), [localTime, setLocalTime] = useState(""), [weekday, setWeekday] = useState(""), [timezone, setTimezone] = useState(""), [expiry, setExpiry] = useState("");
  const [occurrenceLimit, setOccurrenceLimit] = useState(""), [callLimit, setCallLimit] = useState(""), [byteLimit, setByteLimit] = useState(""), [occurrenceBytes, setOccurrenceBytes] = useState("");
  const [readReview, setReadReview] = useState(""), [quotaReview, setQuotaReview] = useState("");
  const [report, setReport] = useState<{ value: FounderAutomaticReadReport; occurrence: FounderAutomaticReadOccurrence } | null>(null), [format, setFormat] = useState<"markdown" | "json">("markdown");
  const [slackOpen, setSlackOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false), [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null), pending = useRef(false), contentEpoch = useRef(0), visible = useRef(report), directory = useRef(options);
  visible.current = report; directory.current = options;
  const active = (signal: AbortSignal) => controller.current?.signal === signal && !signal.aborted;
  const clearContent = () => { contentEpoch.current++; visible.current = null; setReport(null); setSlackOpen(null); setReadReview(""); setQuotaReview(""); };
  const clear = () => { clearContent(); setView(null); setOptions(null); setSteps([]); setEmployeeId(""); };
  const adopt = (state: FounderAutomaticReadState) => {
    setView(state); setNow(Date.now()); const current = currentGrant(state, Date.now()), key = current ? reviewKey(current) : "";
    setReadReview((previous) => previous === key ? previous : ""); setQuotaReview((previous) => previous === key ? previous : "");
    if (!currentGrant(state, Date.now())) clearContent();
  };
  const load = async (signal: AbortSignal) => {
    const [setup, state] = await Promise.all([client.options(signal), client.state(signal)]);
    if (!active(signal)) return;
    const previous = directory.current;
    if (previous && (JSON.stringify(previous.runtime) !== JSON.stringify(setup.runtime) || previous.skill?.id !== setup.skill?.id || previous.skill?.version !== setup.skill?.version ||
      previous.connections.some((item) => !setup.connections.some((next) => next.id === item.id && next.version === item.version && next.generation === item.generation)))) {
      clearContent(); setSteps([]); setEmployeeId(""); setNotice("The audited runtime or source versions changed. Select current accounts and review a fresh grant.");
    }
    setOptions(setup); adopt(state); setNeedsRefresh(false);
    const shown = visible.current, occurrence = shown && state.occurrences.find((item) => item.id === shown.occurrence.id && item.canReadReport);
    if (shown && !occurrence) clearContent();
    else if (shown && occurrence) {
      const epoch = contentEpoch.current, fresh = await client.report(occurrence, signal);
      if (active(signal) && epoch === contentEpoch.current && visible.current?.occurrence.id === occurrence.id) setReport({ value: fresh, occurrence });
    }
  };
  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    const refresh = () => {
      if (!active(current.signal) || pending.current || document.visibilityState === "hidden") return;
      pending.current = true; setBusy(true);
      void load(current.signal).catch((cause) => { if (active(current.signal)) { clear(); setNeedsRefresh(true); setError(cause instanceof Error ? cause.message : "Current scheduled-read access is unavailable."); } })
        .finally(() => { if (active(current.signal)) { pending.current = false; setBusy(false); } });
    };
    refresh(); const timer = window.setInterval(refresh, 20_000); window.addEventListener("focus", refresh);
    const visibleAgain = () => { if (document.visibilityState === "visible") refresh(); }; document.addEventListener("visibilitychange", visibleAgain);
    return () => { current.abort(); contentEpoch.current++; window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visibleAgain); };
    // biome-ignore lint/correctness/useExhaustiveDependencies: The wrapper fixes native scope; every continuation uses its exact controller and current directory/report refs.
  }, []);
  useEffect(() => {
    const grant = view?.grant, deadlines = [grant?.contract.expiresAt, ...(grant && ["draft", "paused"].includes(grant.state) ? [grant.reviewExpiresAt] : []), report?.value.expiresAt].filter((value): value is number => value !== undefined && value > Date.now());
    if (!deadlines.length) return;
    const timer = window.setTimeout(() => { setNow(Date.now()); clearContent(); }, Math.max(1, Math.min(...deadlines) - Date.now() + 1));
    return () => window.clearTimeout(timer);
  }, [view, report, now]);
  const perform = async (action: (signal: AbortSignal) => Promise<void>) => {
    const signal = controller.current?.signal;
    if (!signal || !active(signal) || pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try { await action(signal); }
    catch (cause) { if (active(signal)) { clear(); setNeedsRefresh(true); setError(cause instanceof Error ? cause.message : "Scheduled-read state is unconfirmed. Refresh before continuing."); } }
    finally { if (active(signal)) { pending.current = false; setBusy(false); } }
  };
  const save = () => {
    if (!view?.available || !view.canConfigure || !options?.available || !options.runtime || !options.skill || needsRefresh) return;
    const employee = options.employees.find((item) => item.id === employeeId);
    try {
      if (!employee) throw new Error("Select a current employee version.");
      const value = founderAutomaticReadInputSchema.parse({ employeeId, employeeVersion: employee.version, skillId: options.skill.id, skillVersion: options.skill.version,
        operations: steps.map((step) => { const connection = options.connections.find((item) => item.id === step.connectionId && item.state === "active" && item.upstreamReady);
          if (!connection || !options.operations.some((item) => item.id === step.operationId && item.service === connection.providerKey)) throw new Error("Select an eligible current account and one audited operation for every step.");
          return { connectionId: connection.id, connectionVersion: connection.version, operationId: step.operationId, arguments: JSON.parse(step.argumentsText) as unknown }; }),
        cadence, localTime, ...(cadence === "weekly" ? { weekday: Number(weekday) } : {}), timezone, expiresAt: new Date(expiry).getTime(),
        maxOccurrences: Number(occurrenceLimit), maxCalls: Number(callLimit), maxCapturedBytes: Number(byteLimit), maxBytesPerOccurrence: Number(occurrenceBytes), expectedVersion: view.grant?.version ?? view.staleGrant?.version ?? 0 });
      if (cadence === "weekly" && weekday === "") throw new Error("Select an explicit weekday.");
      clearContent(); void perform(async (signal) => { const next = await client.configure(value, signal); if (active(signal)) { adopt(next); setNotice("Exact scheduled-read draft saved. No schedule is enabled and no business data was read."); } });
    } catch { setError("Select every source, fixed argument, cadence, timezone, expiry and budget explicitly. Arguments must match one supported operation; no raw query or endpoint is accepted."); }
  };
  const grant = currentGrant(view, now), pointer = grant ?? view?.staleGrant ?? view?.grant;
  const decide = (action: "enable" | "pause" | "resume" | "revoke") => {
    if (!pointer) return;
    const consent = action === "enable" || action === "resume";
    if (consent && (!grant || !view?.available || grant.contract.expiresAt <= Date.now() || grant.reviewExpiresAt <= Date.now() || readReview !== reviewKey(grant) || quotaReview !== reviewKey(grant))) return;
    if (!(action === "enable" ? grant?.canEnable : action === "resume" ? grant?.canResume : action === "pause" ? grant?.canPause : pointer.canRevoke)) return;
    void perform(async (signal) => { const next = await client.decide(pointer, action, signal); if (active(signal)) { clearContent(); adopt(next); setNotice(action === "enable" || action === "resume" ? "Standing read consent recorded. Only the exact bounded scheduler operations are permitted. No Slack or model permission was granted." : "Current scheduler state returned. In-flight requests may still consume provider quota; no work is retried automatically."); } });
  };
  const open = (occurrence: FounderAutomaticReadOccurrence) => {
    if (!grant || !occurrence.canReadReport) return;
    clearContent(); const epoch = contentEpoch.current;
    void perform(async (signal) => { const value = await client.report(occurrence, signal); if (active(signal) && epoch === contentEpoch.current) setReport({ value, occurrence }); });
  };
  const download = () => {
    const shown = report; if (!shown || shown.value.expiresAt <= Date.now() || !grant) return;
    const epoch = contentEpoch.current;
    void perform(async (signal) => { const value = await client.download(shown.value, shown.occurrence, format, signal);
      if (!active(signal) || epoch !== contentEpoch.current || visible.current?.value.reportHash !== shown.value.reportHash || shown.value.expiresAt <= Date.now()) return;
      const url = URL.createObjectURL(new Blob([value], { type: format === "json" ? "application/json" : "text/markdown;charset=utf-8" })), anchor = document.createElement("a");
      try { anchor.href = url; anchor.download = `scheduled-evidence-${shown.occurrence.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.${format === "json" ? "json" : "md"}`; anchor.click(); } finally { URL.revokeObjectURL(url); }
      if (active(signal)) setNotice("Exact private report downloaded. Local copies cannot be revoked. No sharing or Slack authority was granted.");
    });
  };
  const slackScope = report && grant && view ? JSON.stringify([workspaceId, libraryId, view.actorId, grant.id, grant.version, grant.digest, grant.contract.expiresAt, report.occurrence.id, report.occurrence.state, report.value.reportHash, report.value.expiresAt]) : null;
  return <section aria-label={`Scheduled reads: ${name}`} className="mt-3 min-w-0 border border-[var(--line)] bg-[var(--card)] p-4 text-xs">
    <header className="flex flex-wrap justify-between gap-2"><h4 className="font-semibold">Bounded scheduled reads: {name}</h4><button type="button" className={BUTTON} disabled={busy} onClick={onClose}>Close scheduled reads</button></header>
    <p className="mt-3">Authorize specific audited app reads under a separate scheduler identity. These reads can consume provider quota or incur account charges. No model, coding agent, app write, automatic pagination or Slack send is authorized.</p>
    <p className="mt-2">Reports cite bounded responses. Dataset completeness is unknown and business success is unverified. No MRR, churn, reconciliation or financial conclusion is computed. Existing manual approvals do not enable this schedule.</p>
    <button type="button" className={`${BUTTON} mt-3`} disabled={busy} onClick={() => { void perform(load); }}>Refresh scheduled-read access</button>
    {error && <p role="alert" className="mt-3 text-[var(--danger)]">{error}</p>}{notice && <p role="status" className="mt-3">{notice}</p>}
    {needsRefresh && <p className="mt-2">No change is retried automatically. Refresh the current grant before another decision.</p>}
    {!view || !options ? <p className="mt-3">{error ? "Current scheduled-read setup is unavailable." : "Checking current audited runtime and source authority…"}</p> : !view.available || !options.available ? <p className="mt-3">Scheduled reads are unavailable: {view.unavailableReason ?? options.unavailableReason ?? "operator setup required"}. The deployment needs an enabled feature, attested read gateway version and eligible explicitly authorized source accounts. No generic app or operator credential fallback is used.</p> : <>
      {view.canConfigure && <details className="mt-3 border border-[var(--line)] p-3"><summary className="min-h-11 cursor-pointer py-3">Configure a new exact standing-read draft</summary>
        <label className="mt-2 block">Scheduled employee version<select className={FIELD} value={employeeId} disabled={busy || needsRefresh} onChange={(event) => { setEmployeeId(event.target.value); clearContent(); }}><option value="">Choose a current employee</option>{options.employees.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}</select></label>
        <p className="mt-2">Reviewed skill: {options.skill ? `${options.skill.name} · v${options.skill.version}` : "Activate your own reviewed founder skill first."}</p>
        <button type="button" className={`${BUTTON} mt-3`} disabled={busy || needsRefresh || steps.length >= 8} onClick={() => { setSteps((current) => [...current, emptyStep()]); clearContent(); }}>Add explicit read step</button>
        {steps.map((step, index) => { const connection = options.connections.find((item) => item.id === step.connectionId), operation = options.operations.find((item) => item.id === step.operationId);
          const update = (value: Partial<Step>) => { setSteps((current) => current.map((item) => item.key === step.key ? { ...item, ...value } : item)); clearContent(); };
          return <fieldset key={step.key} className="mt-3 min-w-0 border border-[var(--line)] p-3"><legend>Read step {index + 1}</legend><label className="block">Source account {index + 1}<select className={FIELD} value={step.connectionId} disabled={busy} onChange={(event) => update({ connectionId: event.target.value, operationId: "", argumentsText: "" })}><option value="">Choose an owned eligible account</option>{options.connections.filter((item) => item.state === "active" && item.upstreamReady).map((item) => <option key={item.id} value={item.id}>{item.providerKey} · {item.identityLabel ?? item.id} · v{item.version}</option>)}</select></label>
            <label className="mt-2 block">Audited operation {index + 1}<select className={FIELD} value={step.operationId} disabled={busy || !connection} onChange={(event) => update({ operationId: event.target.value, argumentsText: "" })}><option value="">Choose a fixed read operation</option>{options.operations.filter((item) => item.service === connection?.providerKey).map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
            <label className="mt-2 block">Exact fixed arguments JSON {index + 1}<textarea className={`${FIELD} min-h-24 font-mono`} value={step.argumentsText} disabled={busy || !operation} maxLength={8192} onChange={(event) => update({ argumentsText: event.target.value })} /></label>
            {operation && <details className="mt-2"><summary className="min-h-11 cursor-pointer py-3">Review audited argument schema {index + 1}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(operation.inputSchema, null, 2)}</pre><p className="mt-2 break-all">Executor {operation.executorHash} · one page · maximum {operation.maxBytes} response bytes</p></details>}
            <button type="button" className={`${BUTTON} mt-2`} disabled={busy} onClick={() => { setSteps((current) => current.filter((item) => item.key !== step.key)); clearContent(); }}>Remove read step {index + 1}</button>
          </fieldset>; })}
        <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2"><label>Cadence<select className={FIELD} value={cadence} disabled={busy} onChange={(event) => { setCadence(event.target.value); setWeekday(""); }}><option value="">Choose cadence</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><label>Local time<input className={FIELD} type="time" step={300} value={localTime} disabled={busy} onChange={(event) => setLocalTime(event.target.value)} /></label>
          {cadence === "weekly" && <label>Weekday<select className={FIELD} value={weekday} disabled={busy} onChange={(event) => setWeekday(event.target.value)}><option value="">Choose weekday</option>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, i) => <option key={day} value={i}>{day}</option>)}</select></label>}
          <label>IANA timezone<input className={FIELD} value={timezone} placeholder="Enter timezone, for example UTC" disabled={busy} onChange={(event) => setTimezone(event.target.value)} /></label><label>Absolute standing-grant expiry<input type="datetime-local" className={FIELD} value={expiry} max={localDateInput(Date.now() + FOUNDER_AUTOMATIC_READ_MAX_LIFETIME_MS)} disabled={busy} onChange={(event) => setExpiry(event.target.value)} /></label>
          <label>Maximum scheduled occurrences<input type="number" min={1} max={7} step={1} className={FIELD} value={occurrenceLimit} disabled={busy} onChange={(event) => setOccurrenceLimit(event.target.value)} /></label><label>Maximum provider calls<input type="number" min={1} max={56} step={1} className={FIELD} value={callLimit} disabled={busy} onChange={(event) => setCallLimit(event.target.value)} /></label>
          <label>Maximum captured bytes for this grant<input type="number" min={1024} max={458752} step={1} className={FIELD} value={byteLimit} disabled={busy} onChange={(event) => setByteLimit(event.target.value)} /></label><label>Maximum bytes per occurrence<input type="number" min={8192} max={65536} step={1} className={FIELD} value={occurrenceBytes} disabled={busy} onChange={(event) => setOccurrenceBytes(event.target.value)} /></label>
        </div><p className="mt-2">Choose an expiry within 28 days. Limits remain seven occurrences, eight steps, 56 total provider calls and one page per step. Requests time out at five seconds per step and 60 seconds per occurrence. Reserved capacity is not refunded after an unknown outcome. Missing data is not invented. Existing approved expiries are not extended.</p>
        <button type="button" className={`${BUTTON} mt-3`} disabled={busy || needsRefresh || !employeeId || !options.skill || !steps.length || !cadence || !localTime || !timezone || !expiry || !occurrenceLimit || !callLimit || !byteLimit || !occurrenceBytes} onClick={save}>Prepare exact standing-read review</button>
      </details>}
    </>}
    {grant && <article className="mt-4 min-w-0 border-t border-[var(--line)] pt-3"><h5 className="font-semibold">Standing-read grant: {grant.state} · v{grant.version}</h5><p className="mt-2">{grant.usedOccurrences}/{grant.contract.maxOccurrences} occurrences · {grant.reservedCalls}/{grant.contract.maxCalls} reserved calls · {grant.reservedBytes}/{grant.contract.maxCapturedBytes} reserved bytes</p><p className="mt-2 break-all">Grant digest {grant.digest}</p><p className="mt-2">Grant expires {new Date(grant.contract.expiresAt).toISOString()}; review expires {new Date(grant.reviewExpiresAt).toISOString()}. Next due {new Date(grant.nextDueAt).toISOString()}.</p>
      <details className="mt-2" open={grant.state === "draft" || grant.state === "paused"}><summary className="min-h-11 cursor-pointer py-3">Review complete frozen accounts, arguments, runtime and limits</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words" data-testid="automatic-contract">{JSON.stringify(grant.contract, null, 2)}</pre></details>
      {(grant.canEnable || grant.canResume) && <><label className="mt-3 flex min-h-11 gap-2"><input type="checkbox" checked={readReview === reviewKey(grant)} disabled={busy || needsRefresh} onChange={(event) => setReadReview(event.target.checked ? reviewKey(grant) : "")} />I reviewed these exact source accounts, fixed read arguments, scheduler identity, audited runtime versions, cadence, expiry and limits. I authorize these scheduled provider reads without a new per-occurrence approval.</label>
        <label className="mt-2 flex min-h-11 gap-2"><input type="checkbox" checked={quotaReview === reviewKey(grant)} disabled={busy || needsRefresh} onChange={(event) => setQuotaReview(event.target.checked ? reviewKey(grant) : "")} />I authorize the selected provider requests to use account quota or incur charges within this exact grant. This is not a provider invoice cap or a Slack disclosure permission.</label>
        <button type="button" className={BUTTON} disabled={busy || needsRefresh || readReview !== reviewKey(grant) || quotaReview !== reviewKey(grant)} onClick={() => decide(grant.canEnable ? "enable" : "resume")}>{grant.canEnable ? "Enable exact bounded scheduled reads" : "Resume exact bounded scheduled reads"}</button></>}
      {grant.canPause && <button type="button" className={`${BUTTON} mt-3`} disabled={busy} onClick={() => decide("pause")}>Pause scheduled reads</button>}
      {grant.blockedReason && <p className="mt-2">{grant.blockedReason}</p>}
    </article>}
    {pointer?.canRevoke && <button type="button" className={`${BUTTON} mt-3`} disabled={busy} onClick={() => decide("revoke")}>{grant ? "Revoke scheduled-read grant" : "Revoke unavailable scheduled-read grant"}</button>}
    {grant && <div className="mt-4 border-t border-[var(--line)] pt-3"><h5 className="font-semibold">Scheduled occurrence receipts</h5><ul className="mt-2 grid gap-2">{view?.occurrences.map((item) => <li key={item.id} className="min-w-0 border border-[var(--line)] p-3"><p>{item.state} · {item.completedSteps}/{item.stepCount} completed steps · {new Date(item.scheduledAt).toISOString()}</p><p className="mt-1 break-all">Scheduler {item.principal.id} · occurrence {item.id}</p>{item.error && <p className="mt-2">{item.error}</p>}{item.canReadReport && <button type="button" className={`${BUTTON} mt-2`} disabled={busy} onClick={() => open(item)}>Read private scheduled report {item.id}</button>}</li>)}</ul><p className="mt-2">Unknown or partially completed work is not blindly retried. No human review or Execute button is fabricated for scheduler work.</p></div>}
    {report && grant && report.value.expiresAt > now && <div className="mt-4 min-w-0 border-t border-[var(--line)] pt-3"><h5 className="font-semibold">Private scheduled evidence</h5><p className="mt-2 break-all">Report hash {report.value.reportHash} · expires {new Date(report.value.expiresAt).toISOString()}</p><p className="mt-2">Bounded response. Dataset completeness: unknown. Business success: unverified. This report grants no external sharing or Slack authority.</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" className={BUTTON} aria-pressed={format === "markdown"} onClick={() => setFormat("markdown")}>Scheduled Markdown</button><button type="button" className={BUTTON} aria-pressed={format === "json"} onClick={() => setFormat("json")}>Scheduled JSON</button></div><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words" data-testid="automatic-report">{format === "markdown" ? report.value.markdown : report.value.json}</pre><button type="button" className={`${BUTTON} mt-3`} disabled={busy || needsRefresh} onClick={download}>Download exact private scheduled report</button>
      {report.occurrence.state === "completed" && slackOpen !== slackScope && <button type="button" className={`${BUTTON} ml-2 mt-3`} disabled={busy || needsRefresh} onClick={() => setSlackOpen(slackScope)}>Review separate future Slack delivery</button>}
      {slackOpen !== null && slackOpen === slackScope && report.occurrence.state === "completed" && view && <Suspense fallback={<p role="status" className="mt-3">Loading separate Slack delivery review…</p>}><FounderAutomaticSlack workspaceId={workspaceId} libraryId={libraryId} actorId={view.actorId}
        sample={{ readGrantId: grant.id, readGrantVersion: grant.version, sampleOccurrenceId: report.occurrence.id, sampleReportHash: report.value.reportHash, expiresAt: report.value.expiresAt, readGrantExpiresAt: grant.contract.expiresAt }} onClose={() => setSlackOpen(null)} /></Suspense>}
    </div>}
  </section>;
}
