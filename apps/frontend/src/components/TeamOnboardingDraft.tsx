import { useEffect, useRef, useState, type JSX } from "react";
import { onboardingTaskText, teamOnboardingTaskSchema, type TeamOnboardingTask } from "@shiba/shared";
import type { FirstRunProgressSnapshot } from "./FirstRunWizard";
import { EMPLOYEE_TEMPLATES, type EmployeeTemplate } from "../employee-templates";
import { EMPTY_ONBOARDING_DRAFT, type OnboardingDraft } from "../onboarding-draft";
import { OnboardingProgressClient } from "../onboarding-progress-client";
import { teamWorkspaceHeaders } from "../team-workspaces-client";

const FIELD = "mt-1 min-h-11 w-full border border-[var(--input-line)] bg-[var(--paper)] p-3 text-sm";
const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-4 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";
interface Employee { id: string; version: number; config: { name: string } }
interface TeamOnboardingDraftProps {
  workspaceId: string; workspaceName?: string; onClose: () => void; onOpenRooms: () => void;
  onConfigureEmployee?: (templateId: EmployeeTemplate["id"] | null) => void;
  actorId?: string; onStageTask?: (value: TeamOnboardingTask) => void;
}

/** A per-person team draft. Only a room's normal approval flow can start work. */
export function TeamOnboardingDraft(props: TeamOnboardingDraftProps): JSX.Element {
  return <TeamOnboardingDraftForm key={`${props.workspaceId}:${props.actorId ?? ""}`} {...props} />;
}

function TeamOnboardingDraftForm({ workspaceId, workspaceName, actorId, onStageTask, onClose, onOpenRooms, onConfigureEmployee }: TeamOnboardingDraftProps): JSX.Element {
  const [draft, setDraft] = useState<OnboardingDraft>({ ...EMPTY_ONBOARDING_DRAFT });
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const controller = useRef(new AbortController());
  const client = useRef<OnboardingProgressClient | null>(null);
  const accepted = useRef<FirstRunProgressSnapshot | null>(null);
  const live = useRef(false);
  const currentOperation = () => {
    const owner = client.current, abort = controller.current;
    return () => live.current && client.current === owner && controller.current === abort && !abort.signal.aborted;
  };
  useEffect(() => {
    live.current = true;
    const abort = new AbortController(); controller.current = abort;
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [key, value] of Object.entries(teamWorkspaceHeaders(workspaceId))) headers.set(key, value);
      const response = await fetch(input, { ...init, signal: abort.signal, headers });
      if (live.current && !abort.signal.aborted && [401, 403, 404].includes(response.status)) {
        setDraft({ ...EMPTY_ONBOARDING_DRAFT }); setEmployees([]);
      }
      return response;
    };
    const progress = new OnboardingProgressClient(fetcher, (snapshot) => { accepted.current = snapshot; }); client.current = progress;
    void Promise.all([
      progress.read(),
      fetcher("/api/custom-agents", { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error("Workspace employees are unavailable.");
        return await response.json() as { agents: Employee[] };
      }),
    ]).then(([saved, profiles]) => {
      if (!live.current || abort.signal.aborted) return;
      setDraft(saved?.draftTask ?? { ...EMPTY_ONBOARDING_DRAFT });
      setEmployees(Array.isArray(profiles.agents) ? profiles.agents : []);
    }).catch((cause) => { if (live.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Team setup unavailable."); })
      .finally(() => { if (live.current && !abort.signal.aborted) setBusy(false); });
    return () => { live.current = false; abort.abort(); progress.reset(); };
  }, [workspaceId]);

  const save = async () => {
    if (busy || !client.current) return false;
    const progress = client.current, active = currentOperation();
    setBusy(true); setError(null); setNotice(null);
    try {
      const { schemaVersion: _schema, sourceRefs: _refs, version: _version, preparedAt: _prepared, ...answers } = draft;
      await progress.update({ action: "save-draft", draftTask: { ...answers, sourceIds: [], completedSteps: [], skippedSteps: [] } });
      if (active()) setNotice("Draft saved for your account in this workspace. Nothing was activated or started.");
      return active();
    } catch (cause) {
      if (active()) setError(cause instanceof Error ? cause.message : "Draft could not be saved.");
      return false;
    } finally { if (active()) setBusy(false); }
  };
  const reload = async () => {
    const progress = client.current, active = currentOperation();
    if (!progress || !active()) return;
    setBusy(true); setError(null);
    try { const saved = await progress.read(); if (active()) setDraft(saved?.draftTask ?? { ...EMPTY_ONBOARDING_DRAFT }); }
    catch (cause) { if (active()) { setDraft({ ...EMPTY_ONBOARDING_DRAFT }); setError(cause instanceof Error ? cause.message : "Draft unavailable."); } }
    finally { if (active()) setBusy(false); }
  };
  const configure = async () => {
    const active = currentOperation(), templateId = draft.employeeTemplateId;
    if (await save() && active()) onConfigureEmployee?.(templateId);
  };
  const copy = async () => {
    const active = currentOperation();
    try {
      if (!active()) return;
      await navigator.clipboard.writeText(onboardingTaskText(draft));
      if (active()) setNotice("Task draft copied. Review it in a team room before requesting approval.");
    } catch { if (active()) setError("Copy unavailable. Select and copy the task text above."); }
  };
  const task = onboardingTaskText(draft);
  const canReview = Boolean(draft.goal.trim() && draft.audience.trim() && draft.acceptance.trim() && task.length <= 4000);
  const stage = async () => {
    if (busy || !client.current || !actorId || !onStageTask || !canReview) return;
    const progress = client.current, active = currentOperation();
    setBusy(true); setError(null); setNotice(null); accepted.current = null;
    try {
      const { schemaVersion: _schema, sourceRefs: _refs, version: _version, preparedAt: _prepared, ...answers } = draft;
      await progress.update({ action: "save-draft", draftTask: { ...answers, sourceIds: [], completedSteps: [], skippedSteps: [] } });
      const saved = accepted.current as FirstRunProgressSnapshot | null;
      if (!active()) return;
      if (!saved?.draftTaskId || !saved.draftTask || !Number.isSafeInteger(saved.draftTask.version) || saved.draftTask.version < 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || onboardingTaskText(saved.draftTask) !== task || saved.draftTask.employeeId !== draft.employeeId || saved.draftTask.employeeVersion !== draft.employeeVersion) throw new Error("Saved task could not be verified. Reload the saved answers and try again.");
      const query = new URLSearchParams({ draftTaskId: saved.draftTaskId, draftTaskVersion: String(saved.draftTask.version), expectedRevision: String(saved.revision) });
      const response = await fetch(`/api/onboarding/progress/team-task?${query}`, { credentials: "same-origin", cache: "no-store", signal: controller.current.signal, headers: teamWorkspaceHeaders(workspaceId) });
      if (!response.ok) throw new Error("Saved task could not be reviewed. Reload the saved answers and try again.");
      const parsed = teamOnboardingTaskSchema.safeParse(await response.json());
      if (!active()) return;
      if (!parsed.success || parsed.data.expiresAt <= Date.now() || parsed.data.workspaceId !== workspaceId || parsed.data.actorId !== actorId || parsed.data.draftTaskId !== saved.draftTaskId || parsed.data.draftTaskVersion !== saved.draftTask.version || parsed.data.progressRevision !== saved.revision || parsed.data.text !== task || (parsed.data.employee?.id ?? null) !== draft.employeeId || (parsed.data.employee?.version ?? null) !== draft.employeeVersion) throw new Error("Saved task could not be verified. Reload the saved answers and try again.");
      onStageTask(parsed.data);
    } catch (cause) { if (active()) setError(cause instanceof Error ? cause.message : "Saved task could not be reviewed."); }
    finally { if (active()) setBusy(false); }
  };
  return <section aria-label="Team first task setup" className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--paper)] p-4 text-[var(--ink)] sm:p-7"><div className="mx-auto grid w-full max-w-3xl gap-4">
    <header><h2 className="text-xl">First task in {workspaceName ?? "your workspace"}</h2><p className="mt-2 text-sm text-[var(--ink-2)]">Save a draft for your account in this workspace. Optional answers can stay blank. Private memory, personal sources and provider connections are not inherited. In a team room, select shared context and request normal human approval before work starts.</p></header>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {([['goal', 'Goal'], ['audience', 'Audience'], ['acceptance', 'Acceptance'], ['contextAnswer', 'Supplied team context'], ['connectionAnswer', 'Apps needed, optional']] as const).map(([field, label]) => <label key={field} className="text-xs">{label}<textarea className={FIELD} value={draft[field]} maxLength={4000} disabled={busy} onChange={(event) => setDraft((previous) => ({ ...previous, [field]: event.target.value }))} /></label>)}
    <label className="text-xs">Starting role, optional<select className={FIELD} value={draft.employeeTemplateId ?? ""} disabled={busy} onChange={(event) => { const template = EMPLOYEE_TEMPLATES.find((entry) => entry.id === event.target.value); setDraft((previous) => ({ ...previous, employeeTemplateId: template?.id ?? null, employeeTemplateVersion: template ? 1 : null })); }}><option value="">Skip role selection</option>{EMPLOYEE_TEMPLATES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
    <label className="text-xs">Saved team employee, optional<select className={FIELD} value={draft.employeeId ?? ""} disabled={busy} onChange={(event) => { const employee = employees.find((entry) => entry.id === event.target.value); setDraft((previous) => ({ ...previous, employeeId: employee?.id ?? null, employeeVersion: employee?.version ?? null })); }}><option value="">Choose later in a room</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.config.name} · v{employee.version}</option>)}</select></label>
    <div className="flex flex-wrap gap-2"><button type="button" className={BUTTON} disabled={busy} onClick={() => { void save(); }}>Save team draft</button><button type="button" className={BUTTON} disabled={busy} onClick={() => { void reload(); }}>Reload saved answers</button>{onConfigureEmployee && <button type="button" className={BUTTON} disabled={busy} onClick={() => { void configure(); }}>Configure team employee</button>}<button type="button" className={BUTTON} onClick={onClose}>Close setup</button></div>
    <section className="border border-[var(--line)] bg-[var(--card)] p-4"><h3 className="text-sm font-semibold">Review and continue in a team room</h3><pre className="mt-3 whitespace-pre-wrap break-words text-xs">{task}</pre><p className="mt-3 text-xs text-[var(--ink-2)]">Review the saved task in a room, choose the current employee and shared sources, then review the frozen task approval. This saved setup draft cannot execute by itself.</p>{task.length > 4000 && <p role="alert">The task must be at most 4,000 characters to review in a room. It has not been shortened.</p>}<div className="mt-3 flex flex-wrap gap-2">{actorId && onStageTask && <button type="button" className={BUTTON} disabled={busy || !canReview} onClick={() => { void stage(); }}>Review saved task in team rooms</button>}<button type="button" className={BUTTON} disabled={busy || !draft.goal.trim() || !draft.audience.trim() || !draft.acceptance.trim()} onClick={() => { void copy(); }}>Copy task draft</button><button type="button" className={BUTTON} onClick={onOpenRooms}>Open team rooms</button></div></section>
  </div></section>;
}
