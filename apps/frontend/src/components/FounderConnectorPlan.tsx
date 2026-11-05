import { useEffect, useRef, useState, type JSX } from "react";
import type { FounderConnectorOptions, FounderConnectorState, FounderConnectorActions, FounderConnectorPlan as Plan, FounderConnectorOccurrence } from "@shiba/shared";
import { founderConnectorPrepareInputSchema } from "@shiba/shared";
import { FounderConnectorClient, canonicalFounderArguments } from "../founder-connector-client";

const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
const FIELD = "mt-1 min-h-11 min-w-0 w-full border border-[var(--input-line)] bg-[var(--paper)] px-3 py-2 text-xs";
type Props = { workspaceId: string; libraryId: string; name: string; timezone: string; onClose: () => void };
function hideExpired(value: FounderConnectorState, now = Date.now()): FounderConnectorState {
  const plan = value.plan;
  if (!plan) return value;
  if (plan.contract.expiresAt <= now || ((plan.state === "draft" || plan.state === "paused") && plan.reviewExpiresAt <= now)) return {
    ...value, plan: null, occurrences: [], stalePlan: { id: plan.id, version: plan.version, digest: plan.digest, state: plan.state, canRevoke: plan.canRevoke }, unavailableReason: "plan_lease_expired" };
  let changed = false;
  const occurrences = value.occurrences.map((item) => {
    if (Math.min(item.expiresAt, item.approval?.expiresAt ?? Infinity) > now || (!item.approval && !item.canPrepare && !item.canDecide && !item.canExecute)) return item;
    changed = true;
    return { ...item, status: "expired" as const, approval: null, canPrepare: false, canDecide: false, canExecute: false };
  });
  return changed ? { ...value, occurrences } : value;
}

export function FounderConnectorPlan(props: Props): JSX.Element {
  return <FounderConnectorPlanContent key={`${props.workspaceId}:${props.libraryId}`} {...props} />;
}

function FounderConnectorPlanContent({ workspaceId, libraryId, name, timezone: suggestedTimezone, onClose }: Props): JSX.Element {
  const [client] = useState(() => new FounderConnectorClient(workspaceId, libraryId));
  const [options, setOptions] = useState<FounderConnectorOptions | null>(null), [view, setView] = useState<FounderConnectorState | null>(null);
  const [connectionId, setConnectionId] = useState(""), [employeeId, setEmployeeId] = useState(""), [actionId, setActionId] = useState("");
  const [actions, setActions] = useState<FounderConnectorActions["actions"]>([]), [query, setQuery] = useState(""), [argumentsText, setArgumentsText] = useState("{}");
  const [cadence, setCadence] = useState<"daily" | "weekly">("daily"), [localTime, setLocalTime] = useState("09:00"), [weekday, setWeekday] = useState(1);
  const [timezone, setTimezone] = useState(suggestedTimezone), [days, setDays] = useState(30), [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false), [unconfirmed, setUnconfirmed] = useState<Record<string, string>>({});
  const controller = useRef<AbortController | null>(null), pending = useRef(false), searchEpoch = useRef(0);
  const active = (signal: AbortSignal) => controller.current?.signal === signal && !signal.aborted;
  const clear = () => { setOptions(null); setView(null); setActions([]); setActionId(""); setConnectionId(""); setEmployeeId(""); setArgumentsText("{}"); setReviewed(false); };
  const adopt = (value: FounderConnectorState) => {
    setView(hideExpired(value)); setReviewed(false);
    setUnconfirmed((previous) => Object.fromEntries(Object.entries(previous).filter(([occurrenceId, approvalId]) => !value.occurrences.some((item) =>
      item.id === occurrenceId && item.approval?.id === approvalId && ["completed", "failed", "denied", "expired"].includes(item.approval.status)))));
  };
  const load = async (signal: AbortSignal) => {
    const [setup, state] = await Promise.all([client.options(signal), client.read(signal)]);
    if (!active(signal)) return;
    setOptions(setup); adopt(state); setNeedsRefresh(false);
  };
  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    pending.current = true; setBusy(true);
    void load(current.signal).catch((cause) => { if (active(current.signal)) { clear(); setError(cause instanceof Error ? cause.message : "Scheduled app action reviews are unavailable."); } })
      .finally(() => { if (active(current.signal)) { pending.current = false; setBusy(false); } });
    const refreshIdle = () => {
      if (!active(current.signal) || pending.current || document.visibilityState === "hidden") return;
      setView((value) => value ? hideExpired(value) : value);
      pending.current = true; setBusy(true);
      void load(current.signal).catch((cause) => { if (active(current.signal)) { clear(); setNeedsRefresh(true); setError(cause instanceof Error ? cause.message : "Current source permission is unavailable."); } })
        .finally(() => { if (active(current.signal)) { pending.current = false; setBusy(false); } });
    };
    const onVisible = () => { if (document.visibilityState === "visible") refreshIdle(); };
    const timer = window.setInterval(refreshIdle, 20_000);
    window.addEventListener("focus", refreshIdle); document.addEventListener("visibilitychange", onVisible);
    return () => { current.abort(); searchEpoch.current++; window.clearInterval(timer); window.removeEventListener("focus", refreshIdle); document.removeEventListener("visibilitychange", onVisible); };
    // biome-ignore lint/correctness/useExhaustiveDependencies: The wrapper keys the native workspace and recipe; every continuation checks this exact controller.
  }, []);
  useEffect(() => {
    const signal = controller.current?.signal, plan = view?.plan;
    if (!signal || !view || !plan) return;
    const now = Date.now(), boundaries = [plan.contract.expiresAt,
      ...(plan.state === "draft" || plan.state === "paused" ? [plan.reviewExpiresAt] : []),
      ...view.occurrences.filter((item) => item.approval || item.canPrepare || item.canDecide || item.canExecute).flatMap((item) => [item.expiresAt, item.approval?.expiresAt ?? Infinity])];
    const due = Math.min(...boundaries.filter((at) => at > now));
    if (!Number.isFinite(due)) return;
    const timer = window.setTimeout(() => {
      if (!active(signal)) return;
      const next = hideExpired(view);
      setView((current) => current === view ? next === view ? { ...view } : next : current);
      if (next !== view) { setReviewed(false); setArgumentsText("{}"); setActions([]); setActionId(""); }
    }, Math.min(2_147_483_647, Math.max(1, due - now + 1)));
    return () => window.clearTimeout(timer);
  }, [view]);
  const perform = async (operation: (signal: AbortSignal) => Promise<FounderConnectorState>, message: string) => {
    const signal = controller.current?.signal;
    if (!signal || !active(signal) || pending.current || needsRefresh) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null); setReviewed(false);
    try {
      const result = await operation(signal);
      if (!active(signal)) return;
      adopt(result); setNotice(message);
    } catch (cause) {
      if (active(signal)) { clear(); setNeedsRefresh(true); setError(cause instanceof Error ? cause.message : "The action outcome is unconfirmed. Refresh before continuing."); }
    } finally { if (active(signal)) { pending.current = false; setBusy(false); } }
  };
  const refresh = async () => {
    const signal = controller.current?.signal;
    if (!signal || !active(signal) || pending.current) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null); setReviewed(false);
    try { await load(signal); }
    catch (cause) { if (active(signal)) { clear(); setNeedsRefresh(true); setError(cause instanceof Error ? cause.message : "Current action state is unavailable."); } }
    finally { if (active(signal)) { pending.current = false; setBusy(false); } }
  };
  const search = async () => {
    const signal = controller.current?.signal, employee = options?.employees.find((item) => item.id === employeeId), epoch = ++searchEpoch.current;
    if (!signal || !active(signal) || pending.current || !employee || !connectionId) return;
    pending.current = true; setBusy(true); setError(null); setActions([]); setActionId("");
    try {
      const result = await client.actions(connectionId, employeeId, employee.version, query, signal);
      if (active(signal) && epoch === searchEpoch.current) setActions(result.actions);
    } catch (cause) { if (active(signal)) { clear(); setError(cause instanceof Error ? cause.message : "Allowed actions are unavailable."); } }
    finally { if (active(signal)) { pending.current = false; setBusy(false); } }
  };
  const uncertain = Object.keys(unconfirmed).length > 0 || Boolean(view?.occurrences.some((item) => ["unknown", "executing"].includes(item.status) || (item.approval && ["unknown", "executing"].includes(item.approval.status))));
  const canConfigure = Boolean(options?.canConfigure && view?.canConfigure);
  const prepare = () => {
    const employee = options?.employees.find((item) => item.id === employeeId), connection = options?.connections.find((item) => item.id === connectionId);
    if (!canConfigure || !options?.skill || !employee || !connection || !actions.some((item) => item.id === actionId) || uncertain) return;
    let args: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(argumentsText);
      if (!value || typeof value !== "object" || Array.isArray(value) || new TextEncoder().encode(canonicalFounderArguments(value)).length > 16_000) throw new Error("invalid_arguments");
      args = value as Record<string, unknown>;
    } catch { setError("Enter a JSON object of at most 16,000 bytes. Do not paste credentials into action arguments."); return; }
    const input = founderConnectorPrepareInputSchema.safeParse({ employeeId, employeeVersion: employee.version, skillId: options.skill.id, skillVersion: options.skill.version,
      connectionId, connectionVersion: connection.version, actionId, arguments: args, cadence, localTime, timezone, ...(cadence === "weekly" ? { weekday } : {}),
      expiresAt: Date.now() + days * 86_400_000, expectedVersion: view?.plan?.version ?? view?.stalePlan?.version ?? 0 });
    if (!input.success) { setError("Review the selected versions, cadence, time, IANA timezone and expiry before preparing this plan."); return; }
    void perform((signal) => client.prepare(input.data, signal), "Exact action plan prepared. Review it before enabling occurrences. Nothing was executed.");
  };
  const decidePlan = (action: "enable" | "pause" | "resume" | "revoke") => {
    const plan = view?.plan ?? view?.stalePlan;
    if (!plan || ((action === "enable" || action === "resume") && (!reviewed || uncertain))) return;
    void perform((signal) => client.decidePlan(action, plan, signal), action === "revoke" || action === "pause" ? "Future occurrences stopped. This does not retract an external action already sent." : "Review occurrences enabled. Each app action still requires separate human approval and execution.");
  };
  const runOccurrence = (plan: Plan, item: FounderConnectorOccurrence, action: "prepare" | "approve" | "deny" | "execute") => {
    if (pending.current || needsRefresh) return;
    if (uncertain && (action === "prepare" || action === "execute")) return;
    if (action === "execute") {
      if (!item.approval || unconfirmed[item.id]) return;
      setUnconfirmed((previous) => ({ ...previous, [item.id]: item.approval!.id }));
    }
    void perform((signal) => action === "prepare" ? client.prepareOccurrence(plan, item, signal) : action === "execute" ? client.executeOccurrence(plan, item, signal)
      : client.decideOccurrence(plan, item, action === "approve", signal), action === "prepare" ? "Exact action submitted for manager review. Nothing was executed."
        : action === "approve" ? "Human approval recorded. The original requester must separately execute it."
          : action === "deny" ? "Action denied. Nothing was executed." : "Execution receipt received. Inspect the reported outcome before another action.");
  };
  const plan = view?.plan, stale = view?.stalePlan, selected = actions.find((item) => item.id === actionId);
  const accounts = options?.connections.filter((item) => item.state === "active" && item.upstreamReady) ?? [];
  return <section aria-label={`Scheduled app action: ${name}`} className="mt-3 min-w-0 border border-[var(--line)] bg-[var(--card)] p-4 text-xs">
    <header className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">Scheduled app action reviews: {name}</h4><button type="button" className={BUTTON} disabled={busy} onClick={onClose}>Close app action plan</button></header>
    <p className="mt-3">Schedules one fixed app action for human review. The timer creates a private occurrence only. It calls no model, reads no app data and sends no Slack message. This does not generate the template's full report. Hosting and storage use this deployment.</p>
    <button type="button" className={`${BUTTON} mt-3`} disabled={busy} onClick={() => { void refresh(); }}>Refresh app action plan</button>
    {error && <p role="alert" className="mt-3 text-[var(--danger)]">{error}</p>}{notice && <p role="status" className="mt-3">{notice}</p>}
    {needsRefresh && <p role="status" className="mt-3">No request is retried automatically. Refresh current state before another change.</p>}
    {uncertain && <p role="status" className="mt-3">An account action is in flight or unconfirmed. Execution remains blocked until a conclusive receipt or operator inspection. Refreshing does not retry the action.</p>}
    {view?.unavailableReason && <p className="mt-3">The previous configuration is unavailable. Its source content and results are hidden. Review current source versions before new work.</p>}
    {!options ? <p className="mt-3">{error ? "Current native workspace configuration is unavailable." : "Loading current source permissions…"}</p> : <>
      {!canConfigure && <p className="mt-3">A verified native workspace manager must configure this plan.</p>}
      {!options.skill && <p className="mt-3">Install, review and activate this founder skill in this workspace first.</p>}
      {accounts.length === 0 && <p className="mt-3">Configure an authorized workspace account and exact employee/member grants in Apps, then refresh. A catalog entry is not an account connection.</p>}
      <fieldset disabled={busy || !canConfigure || needsRefresh} className="mt-3 grid gap-3 sm:grid-cols-2"><legend className="mb-2 font-semibold">Choose the exact action and cadence</legend>
        <label>Employee version<select className={FIELD} value={employeeId} onChange={(event) => { searchEpoch.current++; setEmployeeId(event.target.value); setActions([]); setActionId(""); setReviewed(false); }}><option value="">Choose an employee</option>{options.employees.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}</select></label>
        <label>Workspace app account<select className={FIELD} value={connectionId} onChange={(event) => { searchEpoch.current++; setConnectionId(event.target.value); setActions([]); setActionId(""); setReviewed(false); }}><option value="">Choose an authorized account</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.providerKey} · {item.identityLabel ?? "workspace account"} · v{item.version}</option>)}</select></label>
        <label className="sm:col-span-2">Find granted actions<input className={FIELD} maxLength={200} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <button type="button" className={BUTTON} disabled={!connectionId || !employeeId} onClick={() => { void search(); }}>Find exact app actions</button>
        <label>Action<select className={FIELD} value={actionId} onChange={(event) => { setActionId(event.target.value); setReviewed(false); }}><option value="">Choose a registered action</option>{actions.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</select></label>
        {selected && <details className="sm:col-span-2"><summary className="min-h-11 cursor-pointer py-3">Review registered action schema</summary><p>{selected.description}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(selected.inputSchema ?? {}, null, 2)}</pre></details>}
        <label className="sm:col-span-2">Fixed action arguments<textarea className={`${FIELD} min-h-28 font-mono`} maxLength={16_000} value={argumentsText} onChange={(event) => { setArgumentsText(event.target.value); setReviewed(false); }} /></label>
        <p className="sm:col-span-2">These exact arguments repeat without date interpolation or model-generated changes. Never enter passwords, tokens or credentials here.</p>
        <label>Cadence<select className={FIELD} value={cadence} onChange={(event) => { setCadence(event.target.value as "daily" | "weekly"); setReviewed(false); }}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
        <label>Local time<input className={FIELD} type="time" step={300} value={localTime} onChange={(event) => { setLocalTime(event.target.value); setReviewed(false); }} /></label>
        {cadence === "weekly" && <label>Weekday<select className={FIELD} value={weekday} onChange={(event) => { setWeekday(Number(event.target.value)); setReviewed(false); }}>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
        <label>IANA timezone<input className={FIELD} value={timezone} onChange={(event) => { setTimezone(event.target.value); setReviewed(false); }} /></label>
        <label>Expires in days<input className={FIELD} type="number" min={1} max={90} value={days} onChange={(event) => { setDays(Number(event.target.value)); setReviewed(false); }} /></label>
      </fieldset>
      <button type="button" className={`${BUTTON} mt-3`} disabled={busy || needsRefresh || uncertain || !canConfigure || !options.skill || !employeeId || !connectionId || !actionId || !Number.isInteger(days) || days < 1 || days > 90} onClick={prepare}>Prepare exact action plan</button>
    </>}
    {plan && <div className="mt-4 border-t border-[var(--line)] pt-3"><p>State: {plan.state} · revision {plan.version}</p>
      <p className="mt-2">{plan.contract.employeeName} v{plan.contract.employeeVersion} · {plan.contract.skillName} v{plan.contract.skillVersion}</p>
      <p className="mt-2">{plan.contract.providerKey} · {plan.contract.identityLabel ?? "workspace account"} · account v{plan.contract.connectionVersion}</p>
      <p className="mt-2">{plan.contract.actionName} · {plan.contract.actionId}</p><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(plan.contract.arguments, null, 2)}</pre>
      <p className="mt-2">{plan.contract.cron} ({plan.contract.timezone}) · expires {new Date(plan.contract.expiresAt).toISOString()}</p><p className="mt-2">Next due: {new Date(plan.nextDueAt).toISOString()}. Late intervals coalesce; there is no automatic catch-up execution.</p>
      <p className="mt-2 break-all font-mono">Plan digest: {plan.digest}</p><p className="mt-2 break-all font-mono">Account/grant binding: {plan.contract.bindingDigest}</p>
      {(plan.canEnable || plan.canResume) && <><label className="mt-3 flex min-h-11 gap-2"><input type="checkbox" checked={reviewed} disabled={busy || needsRefresh || uncertain} onChange={(event) => setReviewed(event.target.checked)} />I reviewed this exact account, action, fixed arguments, source versions and cadence. Each occurrence still needs human approval and a separate requester execution click.</label><button type="button" className={BUTTON} disabled={busy || needsRefresh || uncertain || !reviewed || plan.reviewExpiresAt <= Date.now()} onClick={() => decidePlan(plan.canResume ? "resume" : "enable")}>{plan.canResume ? "Resume app action reviews" : "Enable app action reviews"}</button></>}
      <div className="mt-3 flex flex-wrap gap-2">{plan.canPause && <button type="button" className={BUTTON} disabled={busy || needsRefresh} onClick={() => decidePlan("pause")}>Pause app action reviews</button>}{plan.canRevoke && <button type="button" className={BUTTON} disabled={busy || needsRefresh} onClick={() => decidePlan("revoke")}>Revoke app action plan</button>}</div>
    </div>}
    {!plan && stale?.canRevoke && <button type="button" className={`${BUTTON} mt-3`} disabled={busy || needsRefresh} onClick={() => decidePlan("revoke")}>Revoke unavailable app action plan</button>}
    {plan && view && view.occurrences.length > 0 && <div className="mt-4"><h5 className="font-semibold">Private action occurrences</h5><p className="mt-2">Expired receipts hide their protected arguments and output. Expiry does not undo an external action.</p><ul className="mt-2 grid gap-3">{view.occurrences.map((item) => <li key={item.id} className="min-w-0 border border-[var(--line)] p-3">
      <p>{new Date(item.scheduledAt).toISOString()} · {item.status}</p><p className="mt-1">Expires {new Date(item.expiresAt).toISOString()}</p>
      {item.approval && <><p className="mt-2">Requested by {item.approval.requesterId} · {item.approval.status}</p><p className="mt-1 break-all font-mono">Exact input {item.approval.inputHash}</p><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(item.approval.arguments, null, 2)}</pre>{item.approval.error && <p className="mt-2">The action needs inspection before further work. Refresh its current source permissions and receipt; nothing is retried automatically.</p>}{item.approval.result !== null && <details className="mt-2"><summary className="min-h-11 cursor-pointer py-3">Private completion receipt</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(item.approval.result, null, 2)}</pre></details>}</>}
      {unconfirmed[item.id] && <p role="status" className="mt-2">Execution response unconfirmed. This panel will not retry it.</p>}
      <div className="mt-3 flex flex-wrap gap-2">{item.canPrepare && <button type="button" className={BUTTON} disabled={busy || needsRefresh || uncertain || item.expiresAt <= Date.now()} onClick={() => runOccurrence(plan, item, "prepare")}>Request review for this occurrence</button>}{item.canDecide && item.approval?.canDecide && <><button type="button" className={BUTTON} disabled={busy || needsRefresh || item.expiresAt <= Date.now()} onClick={() => runOccurrence(plan, item, "approve")}>Approve exact occurrence action</button><button type="button" className={BUTTON} disabled={busy || needsRefresh || item.expiresAt <= Date.now()} onClick={() => runOccurrence(plan, item, "deny")}>Deny occurrence action</button></>}{item.canExecute && item.approval?.canExecute && <button type="button" className={BUTTON} disabled={busy || needsRefresh || uncertain || item.expiresAt <= Date.now()} onClick={() => runOccurrence(plan, item, "execute")}>Execute approved occurrence once</button>}</div>
    </li>)}</ul><p className="mt-2">Only the original requester may execute a reviewed occurrence. Managers can review its exact action in workspace Apps; completion output remains private to the requester.</p></div>}
  </section>;
}
