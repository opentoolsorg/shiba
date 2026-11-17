import { useCallback, useEffect, useState } from "react";
import { routineCadence, routineCron, routineInfo, WEEKDAYS, type RoutinePreset, type RoutineRecord, type RoutineSource } from "../routines";
import { WorkDetailModal } from "./WorkDetailModal";

const control = "min-h-11 rounded border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--fg)] disabled:opacity-50";

export function useRoutines(enabled: boolean, refreshToken = 0) {
  const [routines, setRoutines] = useState<RoutineRecord[]>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) { setRoutines([]); return; }
    let current = true;
    let generation = 0;
    const load = async () => {
      const requestGeneration = ++generation;
      try {
        const response = await fetch("/api/automations");
        if (!response.ok) throw new Error(`Routines request failed (${response.status}).`);
        const body = await response.json() as { automations?: RoutineRecord[] };
        if (current && generation === requestGeneration) { setRoutines((body.automations ?? []).filter((item) => item.triggers.some((trigger) => trigger.kind === "schedule" || trigger.kind === "webhook"))); setError(""); }
      } catch (cause) { if (current && generation === requestGeneration) setError(cause instanceof Error ? cause.message : "Could not load routines."); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [enabled, revision, refreshToken]);
  return { routines, error, refresh };
}

function routineOutcome(outcome: string | undefined, triggered: boolean): string {
  if (!outcome) return triggered ? "Triggered" : "Not run yet";
  const labels: Record<string, string> = { "approval-pending": "Waiting for approval", "queue-outcome-unknown": "Queue status unknown", "not-queued": "Not queued", approved: "Approved", expired: "Approval expired", rejected: "Rejected", running: "Running", completed: "Completed", error: "Failed", aborted: "Stopped", cancelled: "Cancelled", unknown: "Unknown" };
  return labels[outcome] ?? "Unknown";
}

export function RoutinesList({ routines, error, onChanged }: { routines: RoutineRecord[]; error?: string; onChanged(): void }) {
  const [busy, setBusy] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [revealed, setRevealed] = useState<{ id: string; secret: string } | null>(null);
  const changeSecret = async (id: string, method: "POST" | "DELETE") => {
    setBusy(id); setMutationError(""); setRevealed(null);
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(id)}/hook-secret`, { method });
      const body = await response.json() as { hookSecret?: string; error?: string };
      if (!response.ok) throw new Error(body.error || "Could not change webhook secret.");
      if (body.hookSecret) setRevealed({ id, secret: body.hookSecret });
      onChanged();
    } catch (cause) { setMutationError(cause instanceof Error ? cause.message : "Could not change webhook secret."); }
    finally { setBusy(""); }
  };
  const toggle = async (routine: RoutineRecord) => {
    setBusy(routine.id); setMutationError("");
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(routine.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !routine.enabled }) });
      if (!response.ok) throw new Error("Could not change routine.");
      onChanged();
    } catch (cause) { setMutationError(cause instanceof Error ? cause.message : "Could not change routine."); }
    finally { setBusy(""); }
  };
  return <section aria-label="Routines" className="min-h-0 overflow-y-auto p-4">
    {error || mutationError ? <p role="alert">{error || mutationError}</p> : null}
    {!error && !routines.length ? <p className="text-sm text-[var(--muted-foreground-2)]">No routines yet. Choose “Repeat this…” on a task to schedule recurring work.</p> : null}
    {routines.map((record) => {
      const routine = routineInfo(record);
      return <article key={record.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-1)] py-3 text-sm">
        <div className="min-w-0"><h3 className="break-words font-medium">{routine.name}</h3>
          <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">{routine.schedule ? `Repeats ${routineCadence(routine.schedule, routine.timezone).replace(/^Every /, "every ")}` : "Webhook routine"}</p>
          <p className="mt-1 text-xs">{record.enabled ? `Next run: ${routine.nextRunAt ? new Date(routine.nextRunAt).toLocaleString(undefined, { timeZone: routine.timezone }) : "Unavailable"}` : "Paused"}</p>
          <p className="mt-1 text-xs">Last run: {routineOutcome(record.occurrences?.at(-1)?.outcome, Boolean(record.lastTriggeredAt))}</p>
          {record.triggers.some((trigger) => trigger.kind === "webhook") ? <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all">{`${window.location.origin}/api/hooks/${encodeURIComponent(record.id)}`}</code>
            <button type="button" className={control} disabled={busy === record.id} onClick={() => void changeSecret(record.id, "POST")}>Rotate secret</button>
            <button type="button" className={control} disabled={busy === record.id} onClick={() => void changeSecret(record.id, "DELETE")}>Revoke secret</button>
            {revealed?.id === record.id ? <div><p>Save this secret now. It will not be shown again.</p><code className="break-all">{revealed.secret}</code><button type="button" className={control} onClick={() => void navigator.clipboard.writeText(revealed.secret).catch(() => setMutationError("Could not copy secret."))}>Copy secret</button><button type="button" className={control} onClick={() => setRevealed(null)}>Hide secret</button></div> : null}
          </div> : null}
        </div>
        <button type="button" role="switch" aria-checked={record.enabled} aria-label={`Enable ${routine.name}`} disabled={busy === record.id} className={control} onClick={() => void toggle(record)}>{record.enabled ? "On" : "Off"}</button>
      </article>;
    })}
  </section>;
}

export function EmployeeRoutines({ employeeId }: { employeeId: string }) {
  const state = useRoutines(true);
  return <div className="mt-4"><h3 className="font-medium">Routines</h3><RoutinesList {...state} routines={state.routines.filter((routine) => routine.customAgentId === employeeId)} onChanged={state.refresh} /></div>;
}

export function RepeatRoutineDialog({ source, employees, onClose, onCreated }: {
  source: RoutineSource;
  employees: { id: string; name: string }[];
  onClose(): void;
  onCreated(): void;
}) {
  const [name, setName] = useState((source.prompt.split("\n")[0] ?? "").slice(0, 120));
  const [preset, setPreset] = useState<RoutinePreset>("weekly");
  const [time, setTime] = useState("09:00");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [weekday, setWeekday] = useState(1);
  const [day, setDay] = useState(1);
  const [custom, setCustom] = useState("0 9 * * 1");
  const [employee, setEmployee] = useState(source.customAgentId ?? "");
  const [skip, setSkip] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true); setError("");
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      const cron = routineCron(preset, time, weekday, day, custom);
      const response = await fetch("/api/automations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...source, name: name.trim(), enabled, skipWhilePending: skip, customAgentId: employee || undefined, triggers: [{ kind: "schedule", cron, timezone }] }) });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not create routine.");
      onCreated(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create routine."); }
    finally { setBusy(false); }
  };
  return <WorkDetailModal label="Repeat this task" compact onClose={onClose}>
    <form className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="flex items-center justify-between"><h2 className="text-xl">Repeat this…</h2><button type="button" aria-label="Close task" onClick={onClose} className={control}>Close</button></div>
      <label className="flex flex-col gap-1 text-sm">Routine name<input required maxLength={120} className={control} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <p className="whitespace-pre-wrap break-words text-sm">{source.prompt}</p>
      <label className="flex flex-col gap-1 text-sm">Cadence<select className={control} value={preset} onChange={(event) => setPreset(event.target.value as RoutinePreset)}><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="custom">Custom cron</option></select></label>
      {preset === "weekly" ? <label className="flex flex-col gap-1 text-sm">Day<select className={control} value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>{WEEKDAYS.map((label, value) => <option key={label} value={value}>{label}</option>)}</select></label> : null}
      {preset === "monthly" ? <label className="flex flex-col gap-1 text-sm">Date of month<input className={control} type="number" min={1} max={31} value={day} onChange={(event) => setDay(Number(event.target.value))} /></label> : null}
      {preset === "custom" ? <label className="flex flex-col gap-1 text-sm">Cron expression<input required className={control} value={custom} onChange={(event) => setCustom(event.target.value)} /><span>Five fields; at most one run every five minutes.</span></label> : <label className="flex flex-col gap-1 text-sm">Time<input required className={control} type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>}
      <label className="flex flex-col gap-1 text-sm">Timezone<input required className={control} value={timezone} onChange={(event) => setTimezone(event.target.value)} /></label>
      <label className="flex flex-col gap-1 text-sm">Employee<select className={control} value={employee} onChange={(event) => setEmployee(event.target.value)}><option value="">Workspace default</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={skip} onChange={(event) => setSkip(event.target.checked)} />Skip while the previous run is waiting for approval</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />Enabled</label>
      <p className="text-xs text-[var(--muted-foreground-2)]">Each occurrence needs human approval before work starts. Monthly dates absent from a month are skipped.</p>
      {error ? <p role="alert" className="text-sm">{error}</p> : null}
      <button className={control} type="submit" disabled={busy || !source.prompt.trim()}>{busy ? "Creating…" : "Create routine"}</button>
    </form>
  </WorkDetailModal>;
}
