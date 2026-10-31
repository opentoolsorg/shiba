import type { AcpProviderCard, AcpProvidersSnapshot } from "@shiba/shared";
import { type JSX, useEffect, useRef, useState } from "react";
import { useMailboxes, useSetupStatus } from "../live-status";
import type { AppNavView } from "./AppNavRail";
import { providerPhaseLabel } from "./provider-phase";
import { ToneChip } from "./ToneChip";
import { EMPLOYEE_TEMPLATES, type EmployeeTemplate } from "../employee-templates";

export type FirstRunStepId = "channels" | "agent" | "models" | "employee";
export interface FirstRunProgressSnapshot {
  currentStep: FirstRunStepId;
  dismissedAt: number | null;
  connectionVerifiedAt: number | null;
  firstSuccessfulRunAt: number | null;
  acceptedArtifactAt: number | null;
  activatedAt: number | null;
  revision: number;
  evidence: { connectedProvider: boolean | null; successfulRun: boolean | null; acceptedDeliverable: boolean | null };
}

const STEPS = [
  { id: "channels", title: "Your channels", blurb: "Where tasks and approvals reach you" },
  { id: "agent", title: "Your agent", blurb: "ACP adapters that run in the sandbox" },
  { id: "models", title: "Model routing", blurb: "Which agent handles each kind of task" },
  { id: "employee", title: "Your first employee", blurb: "Choose a role, review it, then launch a task" },
] as const;

function WizardShell({
  step,
  onClose,
  busy,
  children,
  footer,
}: {
  step: number;
  onClose: () => void | Promise<void>;
  busy?: boolean;
  children: React.ReactNode;
  footer: React.ReactNode;
}): JSX.Element {
  const current = STEPS[step] ?? STEPS[0];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Welcome setup"
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-[var(--radius-overlay)] border border-[var(--border-1)] bg-[var(--card)] shadow-[4px_4px_0_var(--sh-card)]"
      >
        <div className="shrink-0 border-b border-[var(--border-1)] px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-[var(--primary)]">
                Welcome — {step + 1} of {STEPS.length}
              </div>
              <h2 className="mt-0.5 text-base font-semibold text-[var(--text)]">{current.title}</h2>
              <p className="mt-0.5 text-xs text-[var(--muted-foreground-2)]">{current.blurb}</p>
            </div>
            <button
              type="button"
              onClick={() => { void onClose(); }}
              disabled={busy}
              aria-label="Close setup"
              className="size-8 shrink-0 rounded-[var(--radius-button)] text-[var(--muted-foreground-2)] hover:bg-[var(--border-1)] hover:text-[var(--text)]"
            >
              ✕
            </button>
          </div>
          <div className="mt-3 flex gap-1.5">
            {STEPS.map((s, i) => (
              <span
                key={s.id}
                className={`h-1 flex-1 rounded-full ${i <= step ? "bg-[var(--primary)]" : "bg-[var(--border-1)]"}`}
              />
            ))}
          </div>
        </div>
        <div className="min-h-0 max-h-[60vh] overflow-y-auto px-5 py-4">{children}</div>
        <div className="shrink-0 border-t border-[var(--border-1)] px-5 py-4">{footer}</div>
      </div>
    </div>
  );
}

function Footer({
  step,
  setStep,
  onFinish,
  activated,
  saving,
}: {
  step: number;
  setStep: (n: number) => void;
  onFinish: () => void | Promise<void>;
  activated: boolean;
  saving: boolean;
}): JSX.Element {
  const last = step === STEPS.length - 1;
  return (
    <div className="flex items-center justify-between gap-3">
      <button
        type="button"
        onClick={() => { void onFinish(); }}
        disabled={saving}
        className="font-mono text-[11px] text-[var(--muted-foreground-2)] hover:text-[var(--text)]"
      >
        Skip for now
      </button>
      <div className="flex items-center gap-2">
        {step > 0 ? (
          <button
            type="button"
            onClick={() => setStep(step - 1)}
            disabled={saving}
            className="rounded-[var(--radius-overlay)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-1.5 font-mono text-[11px] font-medium text-[var(--muted-foreground-2)] hover:border-[var(--border-2)] hover:text-[var(--text)]"
          >
            Back
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => (last ? void onFinish() : setStep(step + 1))}
          disabled={saving}
          className="rounded-[var(--radius-button)] bg-[var(--primary)] px-4 py-1.5 font-mono text-[11px] font-semibold text-[var(--primary-text)] shadow-[2px_2px_0_var(--sh-card)] transition-colors hover:bg-[var(--primary)] active:translate-y-px"
        >
          {last ? (activated ? "Finish" : "Close for now") : "Next"}
        </button>
      </div>
    </div>
  );
}

function ChannelRow({
  name,
  status,
  children,
}: {
  name: string;
  status: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[var(--border-1)]/60 py-2.5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-[var(--text)]">{name}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-[var(--muted-foreground-2)]">
          {children}
        </div>
      </div>
      <div className="shrink-0 pt-0.5">{status}</div>
    </div>
  );
}

export function FirstRunWizard({
  open,
  onClose,
  onNavigate,
  onStartEmployeeSetup,
  onOpenModels,
  onOpenChecklist,
  progress,
  onStepChange,
  onDismiss,
  onResume,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate?: (view: AppNavView) => void;
  onStartEmployeeSetup?: (template: EmployeeTemplate) => void;
  onOpenModels?: () => void;
  onOpenChecklist?: () => void;
  progress?: FirstRunProgressSnapshot | null;
  onStepChange?: (step: FirstRunStepId) => Promise<void>;
  onDismiss?: (step: FirstRunStepId) => Promise<void>;
  onResume?: () => Promise<void>;
  onRefresh?: () => Promise<void>;
}): JSX.Element | null {
  const [step, setStep] = useState(0);
  const [savingProgress, setSavingProgress] = useState(false);
  const [progressError, setProgressError] = useState<string | null>(null);
  const progressRequestGeneration = useRef(0);
  const progressAction = useRef(false);
  const [providers, setProviders] = useState<AcpProviderCard[] | null>(null);
  const [providersError, setProvidersError] = useState(false);
  const [routingRetried, setRoutingRetried] = useState(false);
  const routingRef = useRef<HTMLDivElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const setup = useSetupStatus();
  const mailboxes = useMailboxes();

  const status = setup.state.kind === "data" ? setup.state.data : undefined;
  const mailboxList = mailboxes.state.kind === "data" ? mailboxes.state.data.mailboxes : undefined;
  const roles = status?.models.roles ?? [];
  const connectedProviders = (providers ?? []).filter(
    (card) => card.connection.phase === "connected",
  ).length;
  const checkingProviders = providers === null && !providersError;

  useEffect(() => {
    if (routingRetried && !setup.inFlight && setup.state.kind === "data") {
      const active = document.activeElement;
      if (!active || active === document.body || active === retryButtonRef.current) {
        routingRef.current?.focus();
      }
    }
  }, [routingRetried, setup.inFlight, setup.state.kind]);

  useEffect(() => {
    if (!open || step !== 2) setRoutingRetried(false);
  }, [open, step]);

  useEffect(() => {
    if (!open || !progress) return;
    const savedIndex = STEPS.findIndex((item) => item.id === progress.currentStep);
    if (savedIndex >= 0) setStep(savedIndex);
  }, [open, progress?.currentStep]);

  useEffect(() => {
    if (!open) return;
    const generation = ++progressRequestGeneration.current;
    setProgressError(null);
    void (async () => {
      try {
        await onResume?.();
        if (generation !== progressRequestGeneration.current) return;
        await onRefresh?.();
        if (generation !== progressRequestGeneration.current) return;
      } catch {
        if (generation === progressRequestGeneration.current) {
          setProgressError("Could not resume saved setup progress. Try again when the connection is restored.");
        }
      }
    })();
    const timer = window.setInterval(() => { void onRefresh?.().catch(() => {}); }, 15_000);
    return () => {
      window.clearInterval(timer);
      if (progressRequestGeneration.current === generation) progressRequestGeneration.current += 1;
    };
  }, [open, onRefresh, onResume]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetch("/api/providers")
      .then(async (response) => {
        if (!response.ok) throw new Error(`Providers request failed: ${response.status}`);
        return (await response.json()) as AcpProvidersSnapshot;
      })
      .then((body) => {
        if (!cancelled) {
          setProviders(Array.isArray(body.providers) ? body.providers : []);
          setProvidersError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setProvidersError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const currentStep = STEPS[step]?.id ?? "channels";
  const dismiss = async (afterDismiss?: () => void) => {
    if (progressAction.current) return;
    progressAction.current = true;
    const generation = ++progressRequestGeneration.current;
    setSavingProgress(true);
    setProgressError(null);
    try {
      await onDismiss?.(currentStep);
      if (generation !== progressRequestGeneration.current) return;
      onClose();
      afterDismiss?.();
    }
    catch {
      if (generation === progressRequestGeneration.current) setProgressError("Setup progress could not be saved. Try again, or close without saving your place.");
    }
    finally {
      progressAction.current = false;
      setSavingProgress(false);
    }
  };
  const changeStep = (nextStep: number) => {
    const next = STEPS[nextStep];
    if (!next || progressAction.current) return;
    progressAction.current = true;
    const generation = ++progressRequestGeneration.current;
    setSavingProgress(true);
    setProgressError(null);
    void (async () => {
      try {
        await onStepChange?.(next.id);
        if (generation === progressRequestGeneration.current) setStep(nextStep);
      } catch {
        if (generation === progressRequestGeneration.current) setProgressError("Setup progress could not be saved. Your last saved step is still available.");
      } finally { progressAction.current = false; setSavingProgress(false); }
    })();
  };

  return (
    <WizardShell
      step={step}
      onClose={dismiss}
      busy={savingProgress}
      footer={
        <>
          <Footer step={step} setStep={changeStep} onFinish={dismiss} activated={progress?.activatedAt !== null && progress?.activatedAt !== undefined} saving={savingProgress} />
          {onOpenChecklist ? (
            <p className="mt-3 border-t border-[var(--border-1)]/60 pt-3">
              <button
                type="button"
                disabled={savingProgress}
                onClick={() => {
                  void dismiss(onOpenChecklist);
                }}
                className="font-mono text-[10px] text-[var(--muted-foreground-2)] hover:text-[var(--text)]"
              >
                Operator? Open the deployment checklist →
              </button>
            </p>
          ) : null}
        </>
      }
    >
      <p role="status" className="sr-only">
        {step !== 2
          ? ""
          : setup.inFlight
            ? "Checking model routing…"
            : routingRetried && setup.state.kind === "data"
              ? "Model routing loaded."
              : routingRetried
                ? "Model routing still could not be loaded."
                : ""}
      </p>
      <section aria-label="Activation status" className="mb-4 border border-[var(--border-1)] bg-[var(--section)] p-3 text-[11px]">
        <p className="font-semibold text-[var(--text)]">Activation is verified by Shiba</p>
        <p className="mt-1 text-[var(--muted-foreground-2)]">
          {onStepChange && onDismiss
            ? "Closing or skipping saves your place; it does not activate your account. Shiba records activation after the server confirms a connected provider and an artifact you explicitly approve from a completed run."
            : "This setup guide is not linked to a signed-in account. Its place lasts only while this page stays open; activation status is not saved."}
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <span>Provider: {!progress ? "checking" : progress.evidence.connectedProvider === null ? "not verified" : progress.evidence.connectedProvider ? "confirmed" : "not confirmed"}</span>
          <span>Successful run: {!progress ? "checking" : progress.evidence.successfulRun === null ? "not verified" : progress.evidence.successfulRun ? "confirmed" : "not confirmed"}</span>
          <span>Accepted deliverable: {!progress ? "checking" : progress.evidence.acceptedDeliverable === null ? "not verified" : progress.evidence.acceptedDeliverable ? "confirmed" : "not confirmed"}</span>
          {progress?.activatedAt ? <strong>Activated</strong> : null}
        </div>
        {progressError ? <div className="mt-2">
          <p className="text-[var(--destructive)]" role="alert">{progressError}</p>
          <button type="button" disabled={savingProgress} onClick={onClose} className="mt-2 underline">Close without saving</button>
        </div> : null}
      </section>
      {step > 0 ? (
        <div role="status" className="mb-3 space-y-1.5">
          <ToneChip
            tone={connectedProviders > 0 ? "ok" : "neutral"}
            label={`${connectedProviders} provider${connectedProviders === 1 ? "" : "s"} connected`}
          />
          <p className="text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
            {checkingProviders
              ? "Checking provider connections…"
              : providersError
                ? "Provider status could not be checked. Only confirmed connections are counted."
                : connectedProviders === 0
                  ? "No provider connected yet. Sign in on the Providers page."
                  : "Connection status comes from the provider registry. Model routing is configured separately."}
          </p>
        </div>
      ) : null}
      {step === 0 ? (
        <div>
          <p className="mb-2 text-[11px] text-[var(--muted-foreground-2)]">Start with a role and one task. Channels and model routing can wait.</p>
          <button type="button" disabled={savingProgress} onClick={() => changeStep(3)} className="mb-3 rounded-[var(--radius-button)] bg-[var(--primary)] px-3 py-2 text-xs font-semibold text-[var(--primary-text)]">Choose a role →</button>
          <ChannelRow
            name="GitHub"
            status={
              setup.state.kind === "error" && !setup.inFlight ? (
                <ToneChip tone="pending" label="Could not check" />
              ) : setup.inFlight || status === undefined ? (
                <ToneChip tone="neutral" label="Checking…" />
              ) : status.github.token && status.github.webhookSecret ? (
                <ToneChip tone="ok" label="Configured" />
              ) : status.github.token || status.github.webhookSecret ? (
                <ToneChip tone="pending" label="Partly configured" />
              ) : (
                <ToneChip tone="neutral" label="Not set up" />
              )
            }
          >
            Pull requests and repo events.
          </ChannelRow>
          <ChannelRow
            name="Slack"
            status={
              setup.state.kind === "error" && !setup.inFlight ? (
                <ToneChip tone="pending" label="Could not check" />
              ) : setup.inFlight || status === undefined ? (
                <ToneChip tone="neutral" label="Checking…" />
              ) : status.slack.signingSecret &&
                status.slack.botToken &&
                status.slack.approvers > 0 ? (
                <ToneChip tone="ok" label="Configured" />
              ) : status.slack.signingSecret || status.slack.botToken ? (
                <ToneChip tone="pending" label="Partly configured" />
              ) : (
                <ToneChip tone="neutral" label="Not set up" />
              )
            }
          >
            Approve runs in chat.
          </ChannelRow>
          <ChannelRow name="Telegram" status={<ToneChip tone="neutral" label="Not reported" />}>
            Task intake through a bot. This deployment does not report connection status here.
          </ChannelRow>
          <ChannelRow name="Discord" status={<ToneChip tone="neutral" label="Not reported" />}>
            Commands and progress posts. This deployment does not report connection status here.
          </ChannelRow>
          <ChannelRow
            name="Email"
            status={
              mailboxes.state.kind === "error" ? (
                <ToneChip tone="pending" label="Could not check" />
              ) : mailboxList === undefined ? (
                <ToneChip tone="neutral" label="Checking…" />
              ) : mailboxList.length > 0 ? (
                <ToneChip tone="ok" label="Mailbox available" />
              ) : (
                <ToneChip tone="neutral" label="Not set up" />
              )
            }
          >
            Inbound triage and approved sends.
            {status !== undefined && !status.mailbox.sendEnabled
              ? " Outbound sending is not enabled."
              : ""}
          </ChannelRow>
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
            Configuration does not confirm live delivery. Channel setup is managed by your
            deployment administrator; review details on the Integrations page.
          </p>
          {onNavigate ? (
            <button
              type="button"
              disabled={savingProgress}
              onClick={() => {
                void dismiss(() => onNavigate("integrations"));
              }}
              className="mt-2 font-mono text-[11px] font-medium text-[var(--primary)] hover:text-[var(--primary)]"
            >
              Open Integrations →
            </button>
          ) : null}
        </div>
      ) : null}

      <div hidden={step !== 1}>
        {providers === null && !providersError ? (
          <p className="font-mono text-[11px] text-[var(--muted-foreground-2)]">
            Loading providers…
          </p>
        ) : providersError ? (
          <p className="text-[11px] text-[var(--warning-fg)]">
            Provider status could not be loaded. Open Providers to try again.
          </p>
        ) : (
          (providers ?? []).map((card) => {
            const phase = providerPhaseLabel(card.connection);
            return (
              <div
                key={card.id}
                className="border-b border-[var(--border-1)]/60 py-3 last:border-b-0"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-[var(--text)]">{card.label}</div>
                    <div className="mt-0.5 text-[11px] text-[var(--muted-foreground-2)]">
                      {card.blurb}
                    </div>
                  </div>
                  <div className="shrink-0">
                    <ToneChip tone={phase.tone} label={phase.label} />
                  </div>
                </div>
              </div>
            );
          })
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
          Sign-in, the API credential, test, and the org default are on Providers. Cursor, Devin,
          and Antigravity subscription lanes stay on their operator routes.
        </p>
        {onNavigate ? (
          <button
            type="button"
            disabled={savingProgress}
            onClick={() => {
              void dismiss(() => onNavigate("providers"));
            }}
            className="mt-2 font-mono text-[11px] font-medium text-[var(--primary)] hover:text-[var(--primary)]"
          >
            Open Providers →
          </button>
        ) : null}
      </div>

      {step === 2 ? (
        <div ref={routingRef} tabIndex={-1}>
          {setup.state.kind === "error" ? (
            <div className="space-y-2 text-[11px] text-[var(--warning-fg)]">
              <p>Model routing could not be loaded. You can continue setup and check it later.</p>
              <button
                ref={retryButtonRef}
                type="button"
                onClick={() => {
                  if (!setup.inFlight) {
                    setRoutingRetried(true);
                    setup.reload();
                  }
                }}
                aria-disabled={setup.inFlight}
                className="font-mono text-[var(--primary)] hover:text-[var(--primary)] aria-disabled:cursor-wait aria-disabled:opacity-60 aria-disabled:hover:text-[var(--primary)]"
              >
                Retry routing check
              </button>
            </div>
          ) : setup.inFlight ? (
            <p className="text-[11px] text-[var(--muted-foreground-2)]">Checking model routing…</p>
          ) : roles.length === 0 ? (
            <p className="text-[11px] text-[var(--muted-foreground-2)]">
              This deployment has not reported per-role routing. Ask your administrator to check the
              model configuration.
            </p>
          ) : (
            <div className="space-y-1.5">
              {roles.map((row) => (
                <div
                  key={row.role}
                  className="border-b border-[var(--border-1)]/60 py-2 last:border-b-0"
                >
                  <div className="text-[13px] font-medium text-[var(--text)]">{row.role}</div>
                  <div className="mt-0.5 break-words font-mono text-[10px] text-[var(--muted-foreground-2)]">
                    harness: {row.harness || "Not resolved"}
                  </div>
                  <div className="break-words font-mono text-[10px] text-[var(--muted-foreground-2)]">
                    model: {row.model || "Not resolved"}
                  </div>
                  {row.error ? (
                    <p className="mt-1 break-words text-[11px] text-[var(--destructive)]">
                      Routing needs attention: {row.error}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
            Routing decides which agent handles each task role. Tune it any time in Settings →
            Models.
          </p>
          {onOpenModels ? (
            <button
              type="button"
              disabled={savingProgress}
              onClick={() => {
                void dismiss(onOpenModels);
              }}
              className="mt-2 font-mono text-[11px] font-medium text-[var(--primary)] hover:text-[var(--primary)]"
            >
              Open Settings → Models
            </button>
          ) : null}
        </div>
      ) : null}

      {step === 3 ? (
        <div className="space-y-3">
          <p className="text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
            Employees are reusable role instructions for Shiba’s existing approval-gated task runner.
            Choose a starting point; you can review and edit the profile before saving it.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {EMPLOYEE_TEMPLATES.map((template) => (
              <article key={template.id} className="border border-[var(--border-1)] bg-[var(--bg)] p-3">
                <h3 className="text-[13px] font-medium text-[var(--text)]">
                  {template.config.emoji} {template.label}
                </h3>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
                  {template.description}
                </p>
                <p className="mt-2 font-mono text-[10px] text-[var(--muted-foreground-2)]">
                  {template.config.expectedDeliverables?.length
                    ? `${template.config.expectedDeliverables.length} suggested deliverables`
                    : "Flexible code deliverables"}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    void dismiss(() => onStartEmployeeSetup?.(template));
                  }}
                  disabled={!onStartEmployeeSetup || savingProgress}
                  className="mt-3 border border-[var(--primary)] px-2.5 py-1.5 font-mono text-[10px] font-semibold text-[var(--primary)] disabled:opacity-50"
                >
                  Set up {template.label.toLowerCase()} →
                </button>
              </article>
            ))}
          </div>
          <p className="border-t border-[var(--border-1)] pt-3 text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
            After saving, launch the employee to open its task conversation. Shiba shows the exact task for approval before any sandbox starts, then reports run status and returned files.
          </p>
          {onNavigate ? (
            <button
              type="button"
              disabled={savingProgress}
              onClick={() => {
                void dismiss(() => onNavigate("custom-agents"));
              }}
              className="font-mono text-[11px] font-medium text-[var(--primary)] hover:text-[var(--primary)]"
            >
              Open employee directory →
            </button>
          ) : null}
        </div>
      ) : null}
    </WizardShell>
  );
}
