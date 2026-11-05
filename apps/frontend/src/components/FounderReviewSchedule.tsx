import { useEffect, useRef, useState, type JSX } from "react";
import type { FounderReviewOccurrence, FounderReviewScheduleRecord } from "@shiba/shared";
import { teamWorkspaceHeaders } from "../team-workspaces-client";

type Options = { employees: Array<{ id: string; version: number; name: string }>; skill: { id: string; version: number; name: string } | null };
type View = { schedule: FounderReviewScheduleRecord | null; occurrences: FounderReviewOccurrence[]; unavailableReason?: string;
  staleSchedule?: Pick<FounderReviewScheduleRecord, "id" | "version" | "digest" | "state"> };
const control = "min-h-11 rounded border border-[var(--border-1)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]";
const field = `${control} w-full bg-[var(--card)]`;
const errorText = (error: unknown, fallback: string) => error === "native_founder_schedule_required"
  ? "Sign in with a verified native account to configure private review drafts. Access-only identities cannot use this scope."
  : typeof error === "string" ? error : fallback;

type Props = {
  libraryId: string; name: string; suggested: { timezone: string }; workspaceId?: string; onClose: () => void;
};
export function FounderReviewSchedule(props: Props): JSX.Element {
  return <FounderReviewScheduleContent key={`${props.workspaceId ?? "personal"}:${props.libraryId}`} {...props} />;
}

function FounderReviewScheduleContent({ libraryId, name, suggested, workspaceId, onClose }: Props): JSX.Element {
  const [options, setOptions] = useState<Options | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [cadence, setCadence] = useState<"daily" | "weekly">("daily");
  const [localTime, setLocalTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [timezone, setTimezone] = useState(suggested.timezone);
  const [days, setDays] = useState(30);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const base = `/api/founder-skills/${encodeURIComponent(libraryId)}/review-schedule`;
  const active = (signal: AbortSignal) => controller.current?.signal === signal && !signal.aborted;

  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    const read = async (path: string) => {
      const response = await fetch(path, { credentials: "same-origin", cache: "no-store", headers: teamWorkspaceHeaders(workspaceId), signal: current.signal });
      const value = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(errorText(value.error, "Review schedule unavailable."));
      return value;
    };
    void Promise.all([read(`${base}/options`), read(base)]).then(([setup, state]) => {
      if (!active(current.signal)) return;
      setOptions(setup as unknown as Options); setView(state as unknown as View);
      const schedule = (state as unknown as View).schedule;
      if (schedule) {
        setEmployeeId(schedule.contract.employeeId); setCadence(schedule.contract.cadence);
        setLocalTime(schedule.contract.localTime); setTimezone(schedule.contract.timezone);
        setWeekday(schedule.contract.weekday ?? 1);
      }
    }).catch((cause) => { if (active(current.signal)) setError(cause instanceof Error ? cause.message : "Review schedule unavailable."); });
    return () => current.abort();
  }, [base, workspaceId]);

  const mutate = async (action: string, body: unknown) => {
    const signal = controller.current?.signal;
    if (!signal || !active(signal) || pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`${base}${action ? `/${action}` : ""}`, { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { ...teamWorkspaceHeaders(workspaceId), "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
      const value = await response.json() as View & { error?: string };
      if (!active(signal)) return;
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) { setView(null); setOptions(null); }
        throw new Error(errorText(value.error, "Review schedule could not be updated. Refresh before retrying."));
      }
      setView(value); setReviewed(false);
      setNotice(action === "" ? "Review this exact configuration before enabling draft receipts." : action === "dismiss" ? "Draft dismissed. No task was executed." : `Review drafts ${action === "enable" || action === "resume" ? "enabled" : action === "revoke" ? "revoked" : "paused"}. No task was executed.`);
    } catch (cause) { if (active(signal)) setError(cause instanceof Error ? cause.message : "Review schedule could not be updated."); }
    finally { if (active(signal)) { pending.current = false; setBusy(false); } }
  };
  const prepare = () => {
    const employee = options?.employees.find((item) => item.id === employeeId);
    if (!employee || !options?.skill) return;
    void mutate("", { mode: "review-draft", employeeId, employeeVersion: employee.version,
      skillId: options.skill.id, skillVersion: options.skill.version, cadence, localTime, timezone,
      ...(cadence === "weekly" ? { weekday } : {}), expiresAt: Date.now() + days * 86_400_000,
      provider: null, allowedTools: [], destination: "private-dashboard", expectedVersion: view?.schedule?.version ?? view?.staleSchedule?.version ?? 0 });
  };
  const record = view?.schedule ?? view?.staleSchedule;
  const decide = (action: string, occurrenceId?: string) => {
    if (record) void mutate(action, { expectedVersion: record.version, digest: record.digest, reviewed: true, ...(occurrenceId ? { occurrenceId } : {}) });
  };
  const refresh = async () => {
    const signal = controller.current?.signal;
    if (!signal || !active(signal) || pending.current) return;
    pending.current = true; setBusy(true); setError(null); setReviewed(false);
    try {
      const response = await fetch(base, { credentials: "same-origin", cache: "no-store", headers: teamWorkspaceHeaders(workspaceId), signal });
      const value = await response.json() as View & { error?: string };
      if (!active(signal)) return;
      if (!response.ok) {
        setView(null);
        if ([401, 403, 404].includes(response.status)) setOptions(null);
        throw new Error(errorText(value.error, "Review drafts could not be refreshed."));
      }
      setView(value);
    } catch (cause) { if (active(signal)) setError(cause instanceof Error ? cause.message : "Review drafts could not be refreshed."); }
    finally { if (active(signal)) { pending.current = false; setBusy(false); } }
  };

  return <section aria-label={`Review draft schedule: ${name}`} className="mt-3 min-w-0 border border-[var(--border-1)] bg-[var(--card)] p-4 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">Schedule review drafts: {name}</h4><button type="button" className={control} disabled={busy} onClick={onClose}>Close schedule</button></div>
    <p className="mt-3">Creates private dashboard task drafts for you to review. It does not run an employee, call a model, read connected apps, start a computer, approve work or send a digest. Hosting and storage use this deployment. Scheduled connector execution still requires an explicit account, funding and execution contract.</p>
    <button type="button" className={`${control} mt-3`} disabled={busy} onClick={() => { void refresh(); }}>Refresh review drafts</button>
    {error && <p role="alert" className="mt-3 text-[var(--danger)]">{error}</p>}
    {notice && <p role="status" className="mt-3">{notice}</p>}
    {view?.unavailableReason && <p className="mt-3">Previous configuration unavailable: {view.unavailableReason}. Its cached instructions and task drafts are hidden. Review current versions to replace it.</p>}
    {!options ? <p className="mt-3">{error ? "Current versions are unavailable. Reopen this panel after your access is restored." : "Loading available versions…"}</p> : <>
      {!options.skill && <p className="mt-3">Install, review and activate this founder skill in the current scope before configuring review drafts.</p>}
      {!options.employees.length && <p className="mt-3">Create or restore an employee profile in this scope first. No provider will be selected for these drafts.</p>}
      <fieldset disabled={busy} className="mt-3 grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 font-semibold">Choose current versions and cadence</legend>
        <label>Employee profile<select aria-label="Employee profile" className={field} value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="">Choose an employee</option>{options.employees.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}</select></label>
        <div>Active founder instructions<p className="mt-2">{options.skill ? `${options.skill.name} · v${options.skill.version}` : "No reviewed active version"}</p></div>
        <label>Cadence<select className={field} value={cadence} onChange={(event) => setCadence(event.target.value as "daily" | "weekly")}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
        <label>Local time<input className={field} type="time" step={300} value={localTime} onChange={(event) => setLocalTime(event.target.value)} /></label>
        {cadence === "weekly" && <label>Weekday<select className={field} value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, i) => <option key={day} value={i}>{day}</option>)}</select></label>}
        <label>IANA timezone<input className={field} value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="America/Los_Angeles" /></label>
        <label>Expires in days<input className={field} type="number" min={1} max={90} value={days} onChange={(event) => setDays(Number(event.target.value))} /></label>
      </fieldset>
      <button type="button" className={`${control} mt-3`} disabled={busy || !options.skill || !employeeId || days < 1 || days > 90} onClick={prepare}>Prepare review draft configuration</button>
    </>}
    {view?.schedule && <div className="mt-4 border-t border-[var(--border-1)] pt-3">
      <p>State: {view.schedule.state} · revision {view.schedule.version}</p>
      <p className="mt-2">{view.schedule.contract.employeeName} v{view.schedule.contract.employeeVersion} · {view.schedule.contract.skillName} v{view.schedule.contract.skillVersion}</p>
      <p className="mt-2">{view.schedule.contract.cron} ({view.schedule.contract.timezone}) · expires {new Date(view.schedule.contract.expiresAt).toISOString()}</p>
      <p className="mt-2">Next due: {new Date(view.schedule.nextDueAt).toISOString()}. Delays coalesce into one draft. A pending draft blocks overlapping drafts.</p>
      <p className="mt-2">Source requirements: {view.schedule.contract.requiredSources.join(", ")}. These labels grant no account or app access. Provider: none. Allowed tools: none. Destination: your private dashboard.</p>
      <details className="mt-2"><summary className="min-h-11 cursor-pointer py-3">Read frozen profile, skill and task</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{view.schedule.contract.employeeConfig}{"\n\n"}{view.schedule.contract.skillInstructions}{"\n\n"}{view.schedule.contract.task}</pre></details>
      <p className="mt-2 break-all font-mono">Review digest: {view.schedule.digest}</p>
      {view.schedule.state === "draft" || view.schedule.state === "paused" ? <><label className="mt-2 flex min-h-11 items-center gap-2"><input type="checkbox" checked={reviewed} disabled={busy} onChange={(event) => setReviewed(event.target.checked)} />I reviewed these exact versions, cadence, expiry and private draft-only scope.</label><button type="button" className={control} disabled={busy || !reviewed} onClick={() => decide(view.schedule?.state === "paused" ? "resume" : "enable")}>{view.schedule.state === "paused" ? "Resume review drafts" : "Enable review drafts"}</button></> : null}
      {view.schedule.state === "enabled" && <button type="button" className={`${control} mt-2`} disabled={busy} onClick={() => decide("pause")}>Pause review drafts</button>}
    </div>}
    {record && record.state !== "revoked" && <button type="button" className={`${control} ml-2 mt-2`} disabled={busy} onClick={() => decide("revoke")}>Revoke review drafts</button>}
    {view?.occurrences.length ? <div className="mt-4"><h5 className="font-semibold">Private review receipts</h5><p className="mt-2">No source data was fetched. Review and copy a task into the normal task approval flow when ready; this receipt cannot execute it.</p><ul>{view.occurrences.map((item) => <li key={item.id} className="mt-3 border border-[var(--border-1)] p-3"><p>{new Date(item.scheduledAt).toISOString()} · {item.status}</p><pre className="mt-2 whitespace-pre-wrap break-words">{item.task}</pre>{item.status === "pending" && view.schedule?.state === "enabled" && <button type="button" className={`${control} mt-2`} disabled={busy} onClick={() => decide("dismiss", item.id)}>Dismiss reviewed draft</button>}</li>)}</ul><p className="mt-2">Shows up to 50 retained receipts. Pausing or revoking cancels pending drafts.</p></div> : null}
  </section>;
}
