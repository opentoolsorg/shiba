/**
 * OnboardingJourney — the guided frame around the first-run stages.
 *
 * It joins surfaces that already exist (workspace selection, provider
 * readiness, saved employees, the conversational task draft, the approval
 * queue, the run result) into one ordered flow with a visible position. Every
 * stage reports what the account already satisfies, so a returning user skips
 * ahead and a relaunch resumes in place. The frame never approves anything
 * itself: the approval stage sends the saved draft and forwards the person's
 * own decision to the same handler the approval queue uses.
 */
import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from "react";
import { EMPLOYEE_TEMPLATES, type EmployeeTemplate } from "../employee-templates";
import type { JourneyStepId, JourneyStatus } from "../onboarding-journey";
import { resolveAgentLook } from "../agent-mascots";
import { AgentMascot } from "./AgentMascot";

export interface JourneyWorkspace {
  id: string;
  name: string;
  role?: string;
}

export interface JourneyWorkspaceState {
  personalReady: boolean;
  workspaces: JourneyWorkspace[];
  selectedId: string | null;
  canCreate: boolean;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => Promise<void>;
}

export interface JourneyProviderState {
  ready: boolean;
  /** Readiness has not been answered yet; the stage says so instead of guessing. */
  pending?: boolean;
  label: string | null;
  findings: { severity: string; message: string; fix?: string }[];
  onOpenProviders: () => void;
}

export interface JourneyEmployee {
  id: string;
  version: number;
  name: string;
  slug: string;
  look?: unknown;
  roleTemplateId?: string;
}

export interface JourneyApproval {
  approvalId: string;
  tool?: string;
  input?: unknown;
  threadKey?: string;
  task?: string;
  repoUrl?: string;
}

export interface JourneyRun {
  runId: string;
  status: string;
  summary?: string;
  error?: string;
  deliverables?: { path: string; bytes?: number }[];
}

export interface OnboardingJourneyProps {
  status: JourneyStatus;
  stage: JourneyStepId;
  onSelectStage: (id: JourneyStepId) => void;
  onSkip: () => void;
  workspace: JourneyWorkspaceState;
  provider: JourneyProviderState;
  employees: JourneyEmployee[];
  selectedEmployeeId: string | null;
  onSelectEmployee: (employee: JourneyEmployee) => Promise<void>;
  onCreateEmployee: (templateId: EmployeeTemplate["id"]) => void;
  approvals: JourneyApproval[];
  decisions: Record<string, boolean>;
  onDecideApproval: (approval: JourneyApproval, approved: boolean) => void;
  onOpenApprovals: () => void;
  draftPrepared: boolean;
  onSendForApproval: () => void;
  onOpenDraft: () => void;
  run: JourneyRun | null;
  onOpenRun: () => void;
  onOpenReview: () => void;
  taskStage: ReactNode;
}

const BUTTON =
  "min-h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--fg)] hover:bg-[var(--secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] disabled:opacity-40";
const PRIMARY =
  "min-h-11 rounded-[var(--radius-button)] bg-[var(--primary)] px-4 py-2 font-mono text-xs font-semibold text-[var(--primary-text)] shadow-[2px_2px_0_var(--sh-card)] hover:bg-[var(--primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] disabled:opacity-40 active:translate-y-px";
const CARD = "rounded-[var(--radius-panel)] border border-[var(--border-1)] bg-[var(--card)] p-4";

function StatusChip({ tone, children }: { tone: "ready" | "waiting" | "failed"; children: ReactNode }): JSX.Element {
  const toneClass =
    tone === "ready"
      ? "border-[color-mix(in_oklch,var(--success)_35%,transparent)] text-[var(--success)]"
      : tone === "failed"
        ? "border-[var(--destructive)] text-[var(--destructive)]"
        : "border-[color-mix(in_oklch,var(--warning-fg)_35%,transparent)] text-[var(--warning-fg)]";
  return <span className={`shrink-0 rounded-[var(--radius-button)] border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] ${toneClass}`}>{children}</span>;
}

function Stage({
  title,
  blurb,
  action,
  headingRef,
  children,
}: {
  title: string;
  blurb: string;
  action?: ReactNode;
  headingRef?: React.RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
}): JSX.Element {
  return (
    <section aria-label={`${title} step`} className="shiba-journey-stage flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold leading-tight text-[var(--fg)] outline-none focus-visible:underline focus-visible:decoration-[var(--primary)] focus-visible:decoration-2 focus-visible:underline-offset-4">
            {title}
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-[var(--muted-foreground-2)]">{blurb}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A primary action and its secondary siblings, always in the same place. */
function StageActions({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border-1)] pt-4">{children}</div>;
}

export function OnboardingJourney(props: OnboardingJourneyProps): JSX.Element {
  const { status, stage: stageId, workspace, provider, employees, approvals, decisions, run } = props;
  const [workspaceName, setWorkspaceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stage = status.steps.find((step) => step.id === stageId) ?? status.steps[0]!;
  // The counter follows the stage on screen, so opening a later stage from the
  // rail never claims a position the person is not looking at.
  const stageIndex = status.steps.findIndex((step) => step.id === stage.id) + 1;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openedStage = useRef<string | null>(null);
  const statusId = useId();
  // A keyboard or screen-reader user lands in the new stage instead of at the
  // top of the page; the first render keeps focus where the person put it.
  useEffect(() => {
    if (openedStage.current === stage.id) return;
    const first = openedStage.current === null;
    openedStage.current = stage.id;
    if (!first) headingRef.current?.focus();
  }, [stage.id]);

  const runStage = (next: JourneyStepId) => props.onSelectStage(next);

  const createWorkspace = async () => {
    const name = workspaceName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await workspace.onCreate(name);
      setWorkspaceName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workspace could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const selectEmployee = async (employee: JourneyEmployee) => {
    setBusy(true);
    setError(null);
    try {
      await props.onSelectEmployee(employee);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The employee could not be saved to your draft.");
    } finally {
      setBusy(false);
    }
  };

  const activeEmployees = employees.filter((employee) => employee.id);
  const selectedEmployee = activeEmployees.find((employee) => employee.id === props.selectedEmployeeId);
  const openApprovals = approvals.filter((approval) => decisions[approval.approvalId] === undefined);

  // A completed journey still shows its result when the person opens that
  // stage; the summary panel replaces the other stages only.
  const body = status.complete && stage.id !== "result" ? (
    <Stage headingRef={headingRef} title="You are set up" blurb="A workspace, a provider, a saved employee, your first approved run, and its result are all in place. Everything else lives in the sidebar.">
      <div className={`${CARD} flex flex-wrap items-center gap-3 text-sm text-[var(--fg)]`}>
        <StatusChip tone="ready">Complete</StatusChip>
        <p>Open Threads to keep working, or Approvals to review anything waiting on you.</p>
      </div>
      <div><button type="button" className={PRIMARY} onClick={props.onSkip}>Close setup</button></div>
    </Stage>
  ) : stage.id === "workspace" ? (
    <Stage
      headingRef={headingRef}
      title="Choose a workspace"
      blurb="Work lands in your personal workspace, or in a shared one you belong to. Creating a shared workspace does not invite anyone or grant access."
      action={<StatusChip tone={workspace.personalReady ? "ready" : "waiting"}>{workspace.personalReady ? "Personal ready" : "No workspace"}</StatusChip>}
    >
      <div className={CARD}>
        <p className="text-sm font-semibold text-[var(--fg)]">Personal workspace</p>
        <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">Private to your account. Your first task and its result stay here unless you choose a shared workspace.</p>
        <button type="button" disabled={!workspace.personalReady || workspace.selectedId === null} onClick={() => workspace.onSelect(null)} className={`${BUTTON} mt-3`}>
          {workspace.selectedId === null ? "Personal workspace selected" : "Use personal workspace"}
        </button>
      </div>
      {workspace.workspaces.length ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground-2)]">Shared workspaces</legend>
          {workspace.workspaces.map((item) => (
            <button key={item.id} type="button" disabled={busy} onClick={() => workspace.onSelect(item.id)} className={`${BUTTON} flex items-center justify-between gap-3 text-left`}>
              <span className="min-w-0 truncate">{item.name}</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--muted-foreground-2)]">
                {workspace.selectedId === item.id ? "selected" : item.role ?? "member"}
              </span>
            </button>
          ))}
        </fieldset>
      ) : null}
      {workspace.canCreate ? (
        <form
          className="flex flex-wrap items-end gap-3 border-t border-[var(--border-1)] pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void createWorkspace();
          }}
        >
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-[var(--muted-foreground-2)]">
            Shared workspace name
            <input
              value={workspaceName}
              maxLength={80}
              disabled={busy}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="Team or client name"
              className="min-h-11 border border-[var(--border-1)] bg-[var(--card)] px-3 text-sm text-[var(--fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
            />
          </label>
          <button type="submit" disabled={busy || !workspaceName.trim()} className={BUTTON}>Create workspace</button>
        </form>
      ) : null}
      {error ? <p role="alert" aria-live="assertive" className="text-sm text-[var(--destructive)]">{error}</p> : null}
      <StageActions>
        <button type="button" disabled={busy || !workspace.personalReady} onClick={() => runStage("provider")} className={PRIMARY}>Continue to providers</button>
      </StageActions>
    </Stage>
  ) : stage.id === "provider" ? (
    <Stage
      headingRef={headingRef}
      title="Connect a provider"
      blurb="Shiba runs work through a connected plan, an API key, or this deployment's own gateway. Readiness is reported by the deployment, not assumed here."
      action={<StatusChip tone={provider.ready ? "ready" : "waiting"}>{provider.pending ? "Checking" : provider.ready ? "Ready" : "Not connected"}</StatusChip>}
    >
      <div className={CARD}>
        <p aria-busy={provider.pending ? "true" : undefined} className="text-sm leading-relaxed text-[var(--fg)]">
          {provider.pending
            ? "Checking what this deployment can run work on…"
            : provider.ready
              ? `This account can run work${provider.label ? ` via ${provider.label}` : ""}.`
              : "No provider is ready yet. Connect a plan or enter a key on the Providers screen, then come back here."}
        </p>
        {provider.findings.length ? (
          <ul className="mt-3 flex flex-col gap-2 text-xs text-[var(--muted-foreground-2)]">
            {provider.findings.slice(0, 4).map((finding, index) => (
              <li key={`${finding.message}-${index}`} className={finding.severity === "error" ? "text-[var(--destructive)]" : undefined}>
                {finding.message}{finding.fix ? ` ${finding.fix}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
        <button type="button" onClick={provider.onOpenProviders} className={`${BUTTON} mt-3`}>Open Providers</button>
        <p className="mt-3 text-xs text-[var(--muted-foreground-2)]">Keys are entered on the Providers screen. Onboarding never asks for or stores a provider credential, and the sandbox only ever sees a placeholder.</p>
      </div>
      <StageActions>
        <button type="button" onClick={() => runStage("employee")} className={PRIMARY}>Continue to employees</button>
        <button type="button" onClick={provider.onOpenProviders} className={BUTTON}>Connect a provider now</button>
      </StageActions>
    </Stage>
  ) : stage.id === "employee" ? (
    <Stage
      headingRef={headingRef}
      title="Pick or create an AI employee"
      blurb="An employee is a saved role with its own instructions and expected deliverables. Choosing one here does not grant app access, install tools, or approve spending."
      action={selectedEmployee ? <StatusChip tone="ready">Saved</StatusChip> : undefined}
    >
      {selectedEmployee ? (
        <div className={`${CARD} flex flex-wrap items-center gap-3 text-sm text-[var(--fg)]`}>
          <div className="size-8 shrink-0"><AgentMascot look={resolveAgentLook({ id: selectedEmployee.id, look: selectedEmployee.look })} /></div>
          <p className="min-w-0 flex-1">Using <strong>{selectedEmployee.name}</strong> · saved version {selectedEmployee.version}</p>
        </div>
      ) : null}
      {activeEmployees.length ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground-2)]">Your employees</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {activeEmployees.map((employee) => (
              <button key={employee.id} type="button" disabled={busy} onClick={() => void selectEmployee(employee)} className={`${BUTTON} flex items-center gap-3 text-left`}>
                <span className="size-7 shrink-0"><AgentMascot look={resolveAgentLook({ id: employee.id, look: employee.look })} /></span>
                <span className="min-w-0 flex-1 truncate">{employee.name}</span>
                <span className="font-mono text-[10px] text-[var(--muted-foreground-2)]">v{employee.version}</span>
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground-2)]">{activeEmployees.length ? "Or start from a role" : "Start from a role"}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {EMPLOYEE_TEMPLATES.map((template) => (
            <button key={template.id} type="button" disabled={busy} onClick={() => props.onCreateEmployee(template.id)} className={`${BUTTON} text-left`}>
              <strong className="block text-[var(--fg)]">{template.label}</strong>
              <span className="mt-1 block text-[var(--muted-foreground-2)]">{template.description}</span>
            </button>
          ))}
        </div>
      </fieldset>
      {error ? <p role="alert" aria-live="assertive" className="text-sm text-[var(--destructive)]">{error}</p> : null}
      <StageActions>
        <button type="button" disabled={busy} onClick={() => runStage("task")} className={PRIMARY}>{selectedEmployee ? "Continue to your first task" : "Continue without an employee"}</button>
      </StageActions>
    </Stage>
  ) : stage.id === "approval" ? (
    <Stage
      headingRef={headingRef}
      title="Approve the run"
      blurb="Sending the saved draft creates an approval. Nothing starts — no sandbox, no repository access — until you approve it here or in the queue."
      action={<StatusChip tone={run && run.status !== "pending" ? "ready" : openApprovals.length ? "waiting" : "waiting"}>{run ? "Approved" : openApprovals.length ? "Needs you" : "Not sent"}</StatusChip>}
    >
      {run ? (
        <div className={`${CARD} text-sm text-[var(--fg)]`}>
          <p>Your approval is recorded and the run is with the executor.</p>
          <p className="mt-1 text-xs text-[var(--muted-foreground-2)]">{run.status === "completed" ? "The run finished. Open the result." : run.status === "failed" || run.status === "error" ? "The run reported an error. Read its output in the run inspector." : "Progress is reported in the run inspector and in Threads."}</p>
          <button type="button" className={`${BUTTON} mt-3`} onClick={props.onOpenRun}>Open the run</button>
        </div>
      ) : openApprovals.length ? (
        <div className="flex flex-col gap-2">
          {openApprovals.map((approval) => (
            <div key={approval.approvalId} className={CARD}>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--warning-fg)]">Needs approval</p>
              <p className="mt-1 break-words text-sm text-[var(--fg)]">{approval.task ?? approval.tool ?? "Queued work"}</p>
              {approval.repoUrl ? <p className="mt-1 break-all font-mono text-[11px] text-[var(--muted-foreground-2)]">{approval.repoUrl}</p> : null}
              {decisions[approval.approvalId] !== undefined ? (
                <p role="status" className="mt-2 text-xs text-[var(--muted-foreground-2)]">{decisions[approval.approvalId] ? "Approved" : "Rejected"}</p>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => props.onDecideApproval(approval, true)} className={PRIMARY}>Approve and start</button>
                  <button type="button" onClick={() => props.onDecideApproval(approval, false)} className={BUTTON}>Reject</button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : props.draftPrepared ? (
        <div className={CARD}>
          <p className="text-sm text-[var(--fg)]">Your draft is saved. Send it to create the approval — you still decide whether it runs.</p>
          <button type="button" onClick={props.onSendForApproval} className={`${PRIMARY} mt-3`}>Send the saved draft</button>
        </div>
      ) : (
        <div className={CARD}>
          <p className="text-sm text-[var(--fg)]">There is no saved draft to send yet.</p>
          <button type="button" onClick={props.onOpenDraft} className={`${BUTTON} mt-3`}>Draft the first task</button>
        </div>
      )}
      <div className="flex flex-wrap gap-2 text-xs">
        <button type="button" onClick={props.onOpenApprovals} className="min-h-9 text-[var(--primary)] underline">Open the approval queue</button>
        {run ? <button type="button" onClick={() => runStage("result")} className="min-h-9 text-[var(--primary)] underline">See the result</button> : null}
      </div>
    </Stage>
  ) : stage.id === "result" ? (
    <Stage
      headingRef={headingRef}
      title="See the result"
      blurb="The run's status and the files it produced. Recording your own review is what completes setup — dismissal never counts."
      action={run ? <StatusChip tone={run.status === "completed" ? "ready" : run.status === "failed" || run.status === "error" ? "failed" : "waiting"}>{run.status}</StatusChip> : undefined}
    >
      {run ? (
        <div className={CARD}>
          <dl className="grid gap-3 text-sm text-[var(--fg)]">
            <div><dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-foreground-2)]">Status</dt><dd className="mt-1">{run.status}</dd></div>
            {run.summary ? <div><dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-foreground-2)]">Summary</dt><dd className="mt-1 whitespace-pre-wrap break-words">{run.summary}</dd></div> : null}
            {run.error ? <div><dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-foreground-2)]">Error</dt><dd className="mt-1 whitespace-pre-wrap break-words text-[var(--destructive)]">{run.error}</dd></div> : null}
            <div>
              <dt className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-foreground-2)]">Deliverables</dt>
              <dd className="mt-1">
                {run.deliverables?.length ? (
                  <ul className="flex flex-col gap-1">
                    {run.deliverables.map((file) => (
                      <li key={file.path} className="break-all font-mono text-xs">{file.path}{file.bytes ? ` · ${file.bytes} B` : ""}</li>
                    ))}
                  </ul>
                ) : <span className="text-xs text-[var(--muted-foreground-2)]">No files were reported for this run.</span>}
              </dd>
            </div>
          </dl>
          <StageActions>
            <button type="button" onClick={props.onOpenReview} className={PRIMARY}>Record your review</button>
            <button type="button" onClick={props.onOpenRun} className={BUTTON}>Open the run</button>
          </StageActions>
        </div>
      ) : (
        <div className={CARD}>
          <p className="text-sm text-[var(--fg)]">No run yet. Approve the first task and its result appears here.</p>
          <button type="button" onClick={() => runStage("approval")} className={`${BUTTON} mt-3`}>Go to approval</button>
        </div>
      )}
    </Stage>
  ) : (
    props.taskStage
  );

  return (
    <section aria-label="Guided onboarding" className="flex min-h-0 flex-1 flex-col bg-[var(--bg)]">
      <header className="shrink-0 border-b border-[var(--border-1)] bg-[var(--card)] px-4 pb-3 pt-4">
        <div className="mx-auto flex w-full max-w-3xl items-start gap-3">
          <div className="size-10 shrink-0"><AgentMascot look={resolveAgentLook({ id: "shiba-guide" })} label="Shiba guide" /></div>
          <div className="min-w-0 flex-1">
            <h1 id="journey-title" className="text-base font-semibold leading-tight text-[var(--fg)]">From first launch to your first result</h1>
            <p role="status" id={statusId} className="mt-1 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--primary)]">
              {status.complete ? "Setup complete" : `Step ${stageIndex} of ${status.steps.length} · ${stage.label}`}
            </p>
          </div>
          <button type="button" onClick={props.onSkip} className={`${BUTTON} shrink-0`}>Skip for now</button>
        </div>
        <div aria-hidden="true" className="mx-auto mt-3 flex w-full max-w-3xl gap-1.5">
          {status.steps.map((step, index) => (
            <span
              key={step.id}
              className={`h-1 flex-1 rounded-full ${
                step.state === "done" ? "bg-[var(--success)]" : index + 1 === stageIndex ? "bg-[var(--primary)]" : "bg-[var(--border-1)]"
              }`}
            />
          ))}
        </div>
        <nav aria-label="Onboarding steps" aria-describedby={statusId} className="mx-auto mt-3 flex w-full max-w-3xl flex-wrap gap-1.5">
          {status.steps.map((step, index) => {
            const current = step.id === stage.id;
            return (
              <button
                key={step.id}
                type="button"
                aria-current={current ? "step" : undefined}
                onClick={() => props.onSelectStage(step.id)}
                className={`flex min-h-11 shrink-0 items-center gap-2 rounded-[var(--radius-button)] border px-3 text-xs transition-colors duration-150 motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] ${
                  current
                    ? "border-[var(--primary)] bg-[var(--secondary)] font-semibold text-[var(--fg)]"
                    : step.state === "done"
                      ? "border-[var(--border-1)] text-[var(--fg)] hover:border-[var(--border-2)]"
                      : "border-[var(--border-1)] text-[var(--muted-foreground-2)] hover:border-[var(--border-2)] hover:text-[var(--fg)]"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold ${
                    step.state === "done"
                      ? "border-[var(--success)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]"
                      : current
                        ? "border-[var(--primary)] text-[var(--fg)]"
                        : "border-[var(--border-1)]"
                  }`}
                >
                  {step.state === "done" ? "✓" : index + 1}
                </span>
                <span>{step.label}</span>
                <span className="sr-only"> — {step.summary}</span>
              </button>
            );
          })}
        </nav>
      </header>
      {stage.id === "task" && !status.complete ? (
        props.taskStage
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-5">{body}</div>
        </div>
      )}
    </section>
  );
}
