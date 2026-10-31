import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { EMPLOYEE_TEMPLATES, type EmployeeTemplate } from "../employee-templates";
import { EMPTY_ONBOARDING_DRAFT, OUTCOME_STEPS, type OnboardingDraft, type OnboardingDraftPatch, type OutcomeStepId, type SelectedOnboardingDraft } from "../onboarding-draft";
import { OnboardingConflictError, type FirstRunProgressUpdate } from "../onboarding-progress-client";
import { readDraft, writeDraft } from "../saved";
import type { AppNavView } from "./AppNavRail";
import type { CustomAgentWire } from "./CustomAgentsView";
import type { MemorySource } from "./MemorySourcesView";
import type { FirstRunProgressSnapshot } from "./FirstRunWizard";

const QUESTIONS: Record<OutcomeStepId, { label: string; question: string; field?: keyof OnboardingDraft; choices: string[] }> = {
  goal: { label: "Goal", question: "What should be ready when this is done?", field: "goal", choices: ["A reply draft grounded in a selected email", "A research brief with sources", "A campaign brief for review"] },
  audience: { label: "Audience", question: "Who is this for?", field: "audience", choices: ["My team", "A customer", "Leadership"] },
  acceptance: { label: "Acceptance", question: "What would make this useful enough to accept?", field: "acceptance", choices: ["A clear draft with sources and open questions", "A concise recommendation with next steps", "An editable draft ready for my review"] },
  role: { label: "Your role", question: "What kind of work do you do? You can skip this.", field: "roleAnswer", choices: ["Founder or operator", "Marketing", "Engineering", "Research"] },
  help: { label: "Help", question: "Where would a coworker help most?", field: "helpAnswer", choices: ["Research and synthesis", "Writing and editing", "Planning and follow-through"] },
  employee: { label: "Employee", question: "Choose a starting role, an existing employee, or describe another need.", field: "employeeAnswer", choices: [] },
  context: { label: "Context", question: "What facts or background should the first task use?", field: "contextAnswer", choices: ["I will supply context in the task", "Use only the context I provide; flag gaps"] },
  connections: { label: "Connections", question: "Do you need a connected app for this task? Setup is optional here.", field: "connectionAnswer", choices: ["I will use supplied context first", "Review my existing connections later"] },
  review: { label: "Review", question: "Review your first task draft. Creating it will not start work.", choices: [] },
};
const REQUIRED = new Set<OutcomeStepId>(["goal", "audience", "acceptance"]);
const BUTTON = "rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--fg)] hover:bg-[var(--secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] disabled:opacity-40";

function answerFor(draft: OnboardingDraft, step: OutcomeStepId): string {
  const field = QUESTIONS[step].field;
  const value = field ? draft[field] : "";
  return typeof value === "string" ? value : "";
}

export function ConversationalOnboarding({ progress, onUpdate, onResume, onRefresh, onDismiss, onClose, onNavigate, onLegacyGuide, onUseDraft, onConfigureEmployee, employees = [], draftScope }: {
  progress: FirstRunProgressSnapshot | null;
  onUpdate: (update: FirstRunProgressUpdate) => Promise<void>;
  onResume: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onDismiss: () => Promise<void>;
  onClose: () => void;
  onNavigate: (view: AppNavView) => void;
  onLegacyGuide: () => void;
  onUseDraft: (draft: SelectedOnboardingDraft) => void;
  onConfigureEmployee?: (templateId: EmployeeTemplate["id"] | null) => void;
  employees?: CustomAgentWire[];
  draftScope?: string;
}): JSX.Element {
  const draft = progress?.draftTask ?? EMPTY_ONBOARDING_DRAFT;
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const step = draft.currentStep;
  const current = QUESTIONS[step];
  const scope = draftScope ? `onboarding:${draftScope}:${step}` : null;
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ update: FirstRunProgressUpdate; summary: string; scope: string | null } | null>(null);
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const resumeGeneration = useRef(0);
  const [sources, setSources] = useState<MemorySource[]>([]);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  useEffect(() => {
    if (step !== "context") return;
    let cancelled = false;
    setSources([]); setSourcesLoading(true); setSourcesError(null);
    void fetch("/api/memory/sources", { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Private sources could not be loaded. Retry or continue with supplied facts.");
      const body = await response.json() as { sources?: MemorySource[] };
      if (!cancelled) setSources(Array.isArray(body.sources) ? body.sources : []);
    }).catch((cause) => { if (!cancelled) setSourcesError(cause instanceof Error ? cause.message : "Private sources could not be loaded."); })
      .finally(() => { if (!cancelled) setSourcesLoading(false); });
    return () => { cancelled = true; };
  }, [step, draftScope, sourceAttempt]);
  const sourceReady = (source: MemorySource) => /^memsrc_[0-9a-f]{24}$/.test(source.id) &&
    Number.isSafeInteger(source.version) && Number(source.version) > 0 && /^[0-9a-f]{64}$/.test(source.sha256 ?? "") &&
    source.ingestion?.state === "ready" && source.disabledAt === null && (source.expiresAt === null || source.expiresAt > Date.now());


  useEffect(() => {
    setInput((scope ? readDraft(scope) : "") || answerFor(latestDraft.current, step));
    inputRef.current?.focus();
    endRef.current?.scrollIntoView?.({ block: "end", behavior: "auto" });
  // Saved answer changes must not replace unsent input on a background refresh.
  }, [scope, step]);

  useEffect(() => {
    const generation = ++resumeGeneration.current;
    void onResume().then(onRefresh).catch(() => {
      if (generation === resumeGeneration.current) setError("Saved setup could not be loaded. Retry before continuing.");
    });
    return () => { resumeGeneration.current += 1; };
  }, [onResume, onRefresh]);

  const perform = async (update: FirstRunProgressUpdate, summary: string, answerScope = scope) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null); setConflict(false);
    setPending({ update, summary, scope: answerScope });
    try {
      await onUpdate(update);
      const savedAnswer = update.action === "save-draft" && OUTCOME_STEPS.some((item) => {
        const field = QUESTIONS[item].field;
        return field && Object.hasOwn(update.draftTask ?? {}, field);
      });
      if (savedAnswer) { if (answerScope) writeDraft(answerScope, ""); setInput(""); }
      setPending(null);
    } catch (failure) {
      setConflict(failure instanceof OnboardingConflictError);
      setError(failure instanceof Error ? failure.message : "Your answer could not be saved. Retry when the connection returns.");
    } finally { inFlight.current = false; setBusy(false); }
  };

  const moveTo = (next: OutcomeStepId) => { void perform({ action: "save-draft", draftTask: { currentStep: next } }, `Return to ${QUESTIONS[next].label.toLowerCase()}`); };
  const saveAnswer = (text: string, fields: OnboardingDraftPatch = {}) => {
    if (!text.trim() || text.trim().length > 4000) return;
    if (scope) writeDraft(scope, text.trim());
    const index = OUTCOME_STEPS.indexOf(step);
    const field = current.field;
    if (!field) return;
    const deferred = step === "connections" || (step === "employee" && !fields.employeeId && !fields.employeeTemplateId);
    const patch: OnboardingDraftPatch = {
      [field]: text.trim(), ...fields,
      currentStep: OUTCOME_STEPS.slice(index + 1).find((item) => item === "review" || (!draft.completedSteps.includes(item) && !draft.skippedSteps.includes(item))) ?? "review",
      completedSteps: deferred ? draft.completedSteps.filter((item) => item !== step) : [...new Set([...draft.completedSteps, step])],
      skippedSteps: deferred ? [...new Set([...draft.skippedSteps, step])] : draft.skippedSteps.filter((item) => item !== step),
    };
    if (step === "employee" && !fields.employeeId && !fields.employeeTemplateId) {
      Object.assign(patch, { employeeId: null, employeeVersion: null, employeeTemplateId: null, employeeTemplateVersion: null });
    }
    void perform({ action: "save-draft", draftTask: patch }, text.trim());
  };

  const skipQuestion = () => {
    if (REQUIRED.has(step) || step === "review") return;
    const field = current.field;
    void perform({ action: "save-draft", draftTask: {
      ...(field ? { [field]: "" } : {}), currentStep: OUTCOME_STEPS[OUTCOME_STEPS.indexOf(step) + 1] ?? "review",
      completedSteps: draft.completedSteps.filter((item) => item !== step), skippedSteps: [...new Set([...draft.skippedSteps, step])],
      ...(step === "employee" ? { employeeId: null, employeeVersion: null, employeeTemplateId: null, employeeTemplateVersion: null } : {}),
    } }, `${current.label}: skipped for now`);
  };

  const leave = async (navigate?: AppNavView, configure = false) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      await onDismiss();
      onClose();
      if (configure) onConfigureEmployee?.(draft.employeeTemplateId);
      else if (navigate) onNavigate(navigate);
    } catch { setError("Your place could not be saved. Try Skip setup again, or leave without saving."); }
    finally { inFlight.current = false; setBusy(false); }
  };

  const submit = (event: FormEvent) => { event.preventDefault(); if (!pending && !busy) saveAnswer(input); };
  const selectedTemplate = EMPLOYEE_TEMPLATES.find((template) => template.id === draft.employeeTemplateId);
  const selectedEmployee = employees.find((employee) => employee.id === draft.employeeId);
  const recommendationText = `${draft.goal} ${draft.roleAnswer} ${draft.helpAnswer}`.toLowerCase();
  const suggestedId = EMPLOYEE_TEMPLATES.find((template) => recommendationText.includes(template.label.toLowerCase()))?.id ?? "research";
  const suggestedTemplates = [...EMPLOYEE_TEMPLATES.filter((item) => item.id === suggestedId), ...EMPLOYEE_TEMPLATES.filter((item) => item.id !== suggestedId)];
  const templateCard = (template: EmployeeTemplate) => <button key={template.id} type="button" disabled={busy || Boolean(pending)} onClick={() => saveAnswer(template.label, { employeeTemplateId: template.id, employeeTemplateVersion: 1, employeeId: null, employeeVersion: null })} className={`${BUTTON} text-left`}><strong className="block">{template.label}</strong><span className="mt-1 block">{template.description}</span></button>;
  const suggestionLabel = EMPLOYEE_TEMPLATES.find((item) => item.id === suggestedId)?.label ?? "Research";
  const readyToPrepare = Boolean(draft.goal.trim() && draft.audience.trim() && draft.acceptance.trim());
  const prepared = Boolean(draft.preparedAt && progress?.draftTaskId);
  const preparedId = progress?.draftTaskId;
  const previousStep = OUTCOME_STEPS[OUTCOME_STEPS.indexOf(step) - 1];

  return (
    <section aria-label="First task setup" className="flex min-h-0 flex-1 flex-col bg-[var(--bg)]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-1)] px-4 py-3">
        <div><h1 className="text-base font-semibold text-[var(--fg)]">Let’s shape your first task</h1><p className="mt-1 text-xs text-[var(--muted-foreground-2)]">A saved brief first. You decide when work starts.</p></div>
        <div className="flex gap-2"><button type="button" disabled={busy} onClick={onLegacyGuide} className={BUTTON}>Advanced setup guide</button><button type="button" disabled={busy} onClick={() => { void leave(); }} className={BUTTON}>Skip setup</button></div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
          <p className="text-xs text-[var(--muted-foreground-2)]">Shiba setup uses guided questions, not a live model conversation. Submitted answers are saved to your account; connections and permissions are never granted here.</p>
          <div role="log" aria-label="Setup conversation" className="flex flex-col gap-5">
            {OUTCOME_STEPS.filter((item) => item !== "review" && (draft.completedSteps.includes(item) || draft.skippedSteps.includes(item))).map((item) => (
              <article key={item} aria-label={`${QUESTIONS[item].label} answer`} className="flex flex-col gap-2">
                <p className="text-sm text-[var(--fg)]"><span className="mr-2 font-semibold">Shiba</span>{QUESTIONS[item].question}</p>
                <div className="ml-4 rounded-[var(--radius-panel)] border border-[var(--border-1)] bg-[var(--card)] p-3 text-sm text-[var(--fg)] sm:ml-10">
                  <div className="flex justify-between gap-2"><span className="text-xs font-semibold text-[var(--muted-foreground-2)]">You</span><button type="button" disabled={busy || Boolean(pending)} onClick={() => moveTo(item)} className="text-xs text-[var(--primary)]">Edit {QUESTIONS[item].label.toLowerCase()}</button></div>
                  <p className="mt-1 whitespace-pre-wrap break-words">{answerFor(draft, item) || "Skipped for now"}{draft.skippedSteps.includes(item) && answerFor(draft, item) ? " · setup deferred" : ""}</p>
                </div>
              </article>
            ))}
          </div>
          <article aria-label={`Current question: ${current.label}`} className="flex flex-col gap-3">
            <h2 id="setup-current-question" className="text-base font-medium text-[var(--fg)]"><span className="mr-2 font-semibold">Shiba</span>{current.question}</h2>
            {step !== "review" && current.choices.length ? <div role="group" className="flex flex-wrap gap-2" aria-label="Suggested answers">
              {current.choices.map((choice) => <button key={choice} type="button" disabled={busy || Boolean(pending)} onClick={() => saveAnswer(choice)} className={BUTTON}>{choice}</button>)}
            </div> : null}
            {step === "employee" ? <>
              <p className="text-xs text-[var(--muted-foreground-2)]">Suggested starting point: {suggestionLabel}. A template is not a configured employee or an access grant.</p>
              <div role="group" aria-label="Suggested roles" className="grid gap-2 sm:grid-cols-2">{suggestedTemplates.slice(0, 2).map(templateCard)}</div>
              <details><summary className="cursor-pointer text-sm text-[var(--primary)]">Other roles</summary><div className="mt-2 grid gap-2 sm:grid-cols-2">{suggestedTemplates.slice(2).map(templateCard)}</div></details>
              {employees.filter((employee) => employee.archivedAt === undefined).length ? <details><summary className="cursor-pointer text-sm text-[var(--primary)]">Use an existing employee</summary><div className="mt-2 flex flex-wrap gap-2">{employees.filter((employee) => employee.archivedAt === undefined).map((employee) => <button key={employee.id} type="button" disabled={busy || Boolean(pending)} className={BUTTON} onClick={() => saveAnswer(employee.config.name, { employeeId: employee.id, employeeVersion: employee.version, employeeTemplateId: null, employeeTemplateVersion: null })}>{employee.config.name} · v{employee.version}</button>)}</div></details> : null}
            </> : null}
            {step === "context" ? <section aria-label="Private task sources" className="flex flex-col gap-2 text-xs text-[var(--muted-foreground-2)]">
              <p>Add facts below or select private uploaded sources. Source versions are saved with the draft; access is checked again before work starts.</p>
              {sourcesLoading ? <p role="status">Loading private sources…</p> : null}
              {sourcesError ? <p role="alert">{sourcesError}</p> : null}
              {!sourcesLoading && !sourcesError && sources.length === 0 ? <p>No uploaded sources yet.</p> : null}
              {sources.map((source) => <label key={source.id} className="flex items-start gap-2 break-words"><input type="checkbox" checked={draft.sourceIds.includes(source.id)} disabled={busy || Boolean(pending) || !sourceReady(source)} onChange={(event) => { void perform({ action: "save-draft", draftTask: { sourceIds: event.target.checked ? [...draft.sourceIds, source.id] : draft.sourceIds.filter((id) => id !== source.id) } }, "Update selected sources"); }} /><span>{source.title} · {sourceReady(source) ? `v${source.version} · ready` : source.disabledAt !== null ? "disabled" : source.expiresAt !== null && source.expiresAt <= Date.now() ? "expired" : "not available as a versioned source"}</span></label>)}
              {draft.sourceIds.filter((id) => !sources.some((source) => source.id === id && sourceReady(source))).map((id, index) => <div key={id} className="flex items-center gap-2"><span>Selected source {index + 1} unavailable</span><button type="button" disabled={busy || Boolean(pending)} onClick={() => { void perform({ action: "save-draft", draftTask: { sourceIds: draft.sourceIds.filter((item) => item !== id) } }, "Remove unavailable source"); }} className={BUTTON}>Remove unavailable source {index + 1}</button></div>)}
              <div className="flex flex-wrap gap-2"><button type="button" disabled={sourcesLoading || busy} onClick={() => setSourceAttempt((attempt) => attempt + 1)} className={BUTTON}>Refresh private sources</button><button type="button" disabled={busy || Boolean(pending)} onClick={() => { void leave("memory"); }} className={BUTTON}>Upload or manage sources, then return</button></div>
            </section> : null}
            {step === "connections" ? <>
              <p className="text-xs text-[var(--muted-foreground-2)]">Your saved brief waits here while you review available connections. No connection or resource permission is created by an answer.</p>
              <button type="button" disabled={busy || Boolean(pending)} onClick={() => { void leave("integrations"); }} className={BUTTON}>Review connections, then return</button>
            </> : null}
            {step === "review" ? <section aria-label="First task draft review" className="rounded-[var(--radius-panel)] border border-[var(--border-1)] bg-[var(--card)] p-4 text-sm text-[var(--fg)]">
              <h3 className="font-semibold">{prepared ? "First task draft saved" : "Your first task draft"}</h3>
              <dl className="mt-3 grid gap-3 break-words"><div><dt className="font-semibold">Goal</dt><dd className="whitespace-pre-wrap">{draft.goal || "Required"}</dd></div><div><dt className="font-semibold">Audience</dt><dd>{draft.audience || "Required"}</dd></div><div><dt className="font-semibold">Acceptance</dt><dd>{draft.acceptance || "Required"}</dd></div><div><dt className="font-semibold">Employee</dt><dd>{selectedEmployee ? `${selectedEmployee.config.name} · saved version ${draft.employeeVersion}` : selectedTemplate ? `${selectedTemplate.label} template · employee configuration pending` : "Employee configuration pending"}</dd></div><div><dt className="font-semibold">Context</dt><dd className="whitespace-pre-wrap">{draft.contextAnswer || "No background supplied yet"}{draft.sourceIds.length ? ` · ${draft.sourceIds.length} private source${draft.sourceIds.length === 1 ? "" : "s"} selected` : ""}</dd></div><div><dt className="font-semibold">Connections</dt><dd>{draft.connectionAnswer || "Deferred; current access checked when work starts"}</dd></div></dl>
              <p className="mt-3 text-xs text-[var(--muted-foreground-2)]">This saves a task brief only. It creates no employee, grant, invitation, run, or external action. Source access and readiness are checked when you explicitly start work.</p>
              {!selectedEmployee ? <div className="mt-3 flex flex-wrap gap-2">{onConfigureEmployee ? <button type="button" disabled={busy || Boolean(pending)} onClick={() => { void leave(undefined, true); }} className={BUTTON}>Configure {selectedTemplate ? `${selectedTemplate.label} employee` : "an employee"}</button> : null}<button type="button" disabled={busy || Boolean(pending)} onClick={() => moveTo("employee")} className={BUTTON}>Choose a saved employee</button></div> : null}
              {!readyToPrepare ? <p role="status" className="mt-2 text-xs text-[var(--warning-fg)]">Add goal, audience, and acceptance before creating a first task draft.</p> : null}
              <div className="mt-4 flex flex-wrap gap-2">{prepared && preparedId ? <button type="button" disabled={busy} onClick={() => onUseDraft({ draftTaskId: preparedId, version: draft.version, draftTask: draft })} className={BUTTON}>Use first task draft in Work</button> : <button type="button" disabled={busy || Boolean(pending) || !readyToPrepare} onClick={() => { void perform({ action: "prepare-task" }, "Create first task draft"); }} className={BUTTON}>Create first task draft</button>}<button type="button" disabled={busy || Boolean(pending)} onClick={() => moveTo("goal")} className={BUTTON}>Edit brief</button></div>
            </section> : null}
          </article>
          {error ? <section aria-label="Setup recovery" className="rounded-[var(--radius-panel)] border border-[var(--border-1)] bg-[var(--card)] p-3 text-sm text-[var(--fg)]">
            <p role="alert">{error}</p>{pending ? <><p className="mt-2 whitespace-pre-wrap break-words">Your pending answer: {pending.summary}</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => { void perform(pending.update, pending.summary, pending.scope); }} className={BUTTON}>{conflict ? "Retry my answer after review" : "Retry save"}</button><button type="button" disabled={busy} onClick={() => { if (pending.scope) writeDraft(pending.scope, ""); setPending(null); setError(null); setConflict(false); setInput(answerFor(draft, step)); }} className={BUTTON}>Use saved setup</button></div></> : <button type="button" disabled={busy} onClick={() => { void onRefresh().then(() => setError(null)).catch(() => setError("Saved setup still could not be loaded.")); }} className={`${BUTTON} mt-3`}>Retry loading setup</button>}
            <button type="button" disabled={busy} onClick={onClose} className="mt-3 block text-xs underline">Leave without saving</button>
          </section> : null}
          <div ref={endRef} />
        </div>
      </div>
      <footer className="shrink-0 border-t border-[var(--border-1)] bg-[var(--bg)] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-2xl">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs"><span role="status" aria-live="polite" className="text-[var(--muted-foreground-2)]">{busy ? "Saving your setup…" : draft.preparedAt ? "Task draft retained. Work has not started." : progress ? "Submitted answers saved to your account" : "Loading saved setup…"}</span><div className="flex gap-3">{previousStep ? <button type="button" disabled={busy || Boolean(pending)} onClick={() => moveTo(previousStep)} className="text-[var(--primary)]">Back</button> : null}{!REQUIRED.has(step) && step !== "review" ? <button type="button" disabled={busy || Boolean(pending)} onClick={skipQuestion} className="text-[var(--primary)]">Skip question</button> : null}</div></div>
          {step !== "review" ? <form onSubmit={submit} aria-label="Setup answer composer" className="flex items-end gap-2 rounded-[var(--radius-panel)] border border-[var(--border-1)] bg-[var(--card)] p-2">
            <textarea ref={inputRef} aria-label={`Your answer: ${current.label}`} aria-describedby="setup-current-question" maxLength={4000} rows={2} value={input} disabled={busy || Boolean(pending)} onChange={(event) => { setInput(event.target.value); if (scope) writeDraft(scope, event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!pending && !busy) saveAnswer(input); } }} placeholder="Choose a suggestion or write your own answer" className="min-w-0 flex-1 resize-y bg-transparent p-2 text-sm text-[var(--fg)] focus:outline-none" />
            <button type="submit" disabled={busy || Boolean(pending) || !input.trim()} className={BUTTON}>Send answer</button>
          </form> : null}
        </div>
      </footer>
    </section>
  );
}
