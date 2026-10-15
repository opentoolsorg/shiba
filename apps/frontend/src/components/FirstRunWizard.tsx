/**
 * FirstRunWizard — the post-signup onboarding flow. Three steps:
 *   1. Channels  — review deployment-reported configuration for the surfaces
 *      that carry tasks & approvals (Slack/Telegram/Discord/Email/GitHub).
 *   2. Your agent — optionally connect a subscription provider via the shared
 *      SubscriptionConnect control.
 *   3. Model routing — the deployment's role→harness map, read-only, with a
 *      link into Settings → Models.
 * Opens automatically on the first authenticated session
 * (`shiba-onboarding-v1` in localStorage) and can be reopened from Setup
 * Guide. Steps never block: "Skip" always works, "Finish" marks it done.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import type { AppNavView } from "./AppNavRail";
import { ToneChip } from "./ToneChip";
import {
  SUBSCRIPTION_AUTH,
  SubscriptionConnect,
  subscriptionChip,
  type AgentCliCredential,
  type SubscriptionId,
  type SubscriptionStatus,
} from "./SubscriptionConnect";
import {
  useAgentsDirectory,
  useMailboxes,
  useSetupStatus,
} from "../live-status";

export const ONBOARDING_STORAGE_KEY = "shiba-onboarding-v1";
const SUBSCRIPTION_IDS = Object.keys(SUBSCRIPTION_AUTH) as SubscriptionId[];

const STEPS = [
  { id: "channels", title: "Your channels", blurb: "Where tasks and approvals reach you" },
  { id: "agent", title: "Your agent", blurb: "Optional subscription provider connections" },
  { id: "models", title: "Model routing", blurb: "Which agent handles each kind of task" },
] as const;

function WizardShell({
  step,
  onClose,
  children,
  footer,
}: {
  step: number;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}): JSX.Element {
  const current = STEPS[step] ?? STEPS[0];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
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
              <h2 className="mt-0.5 text-base font-semibold text-[var(--text)]">
                {current.title}
              </h2>
              <p className="mt-0.5 text-xs text-[var(--muted-foreground-2)]">{current.blurb}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
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
}: {
  step: number;
  setStep: (n: number) => void;
  onFinish: () => void;
}): JSX.Element {
  const last = step === STEPS.length - 1;
  return (
    <div className="flex items-center justify-between gap-3">
      <button
        type="button"
        onClick={onFinish}
        className="font-mono text-[11px] text-[var(--muted-foreground-2)] hover:text-[var(--text)]"
      >
        Skip setup
      </button>
      <div className="flex items-center gap-2">
        {step > 0 ? (
          <button
            type="button"
            onClick={() => setStep(step - 1)}
            className="rounded-[var(--radius-overlay)] border border-[var(--border-1)] bg-[var(--card)] px-3 py-1.5 font-mono text-[11px] font-medium text-[var(--muted-foreground-2)] hover:border-[var(--border-2)] hover:text-[var(--text)]"
          >
            Back
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => (last ? onFinish() : setStep(step + 1))}
          className="rounded-[var(--radius-button)] bg-[var(--primary)] px-4 py-1.5 font-mono text-[11px] font-semibold text-[var(--primary-text)] shadow-[2px_2px_0_var(--sh-card)] transition-colors hover:bg-[var(--primary)] active:translate-y-px"
        >
          {last ? "Finish" : "Next"}
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
        <div className="mt-0.5 text-[11px] leading-snug text-[var(--muted-foreground-2)]">{children}</div>
      </div>
      <div className="shrink-0 pt-0.5">{status}</div>
    </div>
  );
}

function AgentRow({
  id,
  agentCredential,
  status,
  onStatus,
}: {
  id: SubscriptionId;
  agentCredential?: AgentCliCredential;
  status: SubscriptionStatus | undefined;
  onStatus: (status: SubscriptionStatus) => void;
}): JSX.Element {
  const spec = SUBSCRIPTION_AUTH[id];
  const credential = agentCredential ?? spec.credential;
  return (
    <div className="border-b border-[var(--border-1)]/60 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--text)]">{spec.label}</div>
          <div className="mt-0.5 text-[11px] text-[var(--muted-foreground-2)]">{spec.blurb}</div>
        </div>
        <div className="shrink-0">{subscriptionChip(status)}</div>
      </div>
      <SubscriptionConnect spec={spec} credential={credential} onStatus={onStatus} />
    </div>
  );
}

export function FirstRunWizard({
  open,
  onClose,
  onNavigate,
  onOpenModels,
  onOpenChecklist,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate?: (view: AppNavView) => void;
  onOpenModels?: () => void;
  onOpenChecklist?: () => void;
}): JSX.Element | null {
  const [step, setStep] = useState(0);
  const [subscriptions, setSubscriptions] = useState<Partial<Record<SubscriptionId, SubscriptionStatus>>>({});
  const [routingRetried, setRoutingRetried] = useState(false);
  const routingRef = useRef<HTMLDivElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const directory = useAgentsDirectory();
  const setup = useSetupStatus();
  const mailboxes = useMailboxes();

  const agents = directory.state.kind === "data" ? directory.state.data.agents : [];
  const status = setup.state.kind === "data" ? setup.state.data : undefined;
  const mailboxList = mailboxes.state.kind === "data" ? mailboxes.state.data.mailboxes : undefined;
  const roles = status?.models.roles ?? [];
  const connectedProviders = SUBSCRIPTION_IDS.filter((id) => {
    const subscription = subscriptions[id];
    return subscription?.kind === "snapshot" && subscription.snapshot.phase === "succeeded";
  }).length;
  const checkingProviders = SUBSCRIPTION_IDS.some((id) =>
    subscriptions[id] === undefined || subscriptions[id]?.kind === "loading",
  );
  const providerCheckFailed = SUBSCRIPTION_IDS.some((id) => subscriptions[id]?.kind === "error");

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

  if (!open) return null;

  const finish = () => {
    try {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "done");
    } catch {
      // private mode — just close
    }
    onClose();
  };

  return (
    <WizardShell
      step={step}
      onClose={finish}
      footer={
        <>
          <Footer step={step} setStep={setStep} onFinish={finish} />
          {onOpenChecklist ? (
            <p className="mt-3 border-t border-[var(--border-1)]/60 pt-3">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenChecklist();
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
      {step > 0 ? (
        <div role="status" className="mb-3 space-y-1.5">
          <ToneChip
            tone={connectedProviders > 0 ? "ok" : "neutral"}
            label={`${connectedProviders} subscription provider${connectedProviders === 1 ? "" : "s"} connected`}
          />
          <p className="text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
            {checkingProviders
              ? "Checking subscription connections…"
              : providerCheckFailed
                ? "Some connections could not be checked. Only confirmed connections are counted."
                : connectedProviders === 0
                  ? "No subscription provider connected yet. Task credentials depend on your deployment's model routing."
                  : "Connection status is reported by the deployment; model routing is configured separately."}
          </p>
        </div>
      ) : null}
      {step === 0 ? (
        <div>
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
              ) : status.slack.signingSecret && status.slack.botToken && status.slack.approvers > 0 ? (
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
            {status !== undefined && !status.mailbox.sendEnabled ? " Outbound sending is not enabled." : ""}
          </ChannelRow>
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
            Configuration does not confirm live delivery. Channel setup is managed by your
            deployment administrator; review details on the Integrations page.
          </p>
          {onNavigate ? (
            <button
              type="button"
              onClick={() => {
                finish();
                onNavigate("integrations");
              }}
              className="mt-2 font-mono text-[11px] font-medium text-[var(--primary)] hover:text-[var(--primary)]"
            >
              Open Integrations →
            </button>
          ) : null}
        </div>
      ) : null}

      <div hidden={step !== 1}>
        {SUBSCRIPTION_IDS.map((id) => (
          <AgentRow
            key={id}
            id={id}
            agentCredential={agents.find((a) => a.id === id)?.credential}
            status={subscriptions[id]}
            onStatus={(next) => setSubscriptions((current) => ({ ...current, [id]: next }))}
          />
        ))}
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
          Connect a subscription provider if your model routing requires one. You can add or
          switch providers later in Settings → Providers.
        </p>
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
              This deployment has not reported per-role routing. Ask your administrator to
              check the model configuration.
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
                    <p className="mt-1 break-words text-[11px] text-[#b91c1c]">
                      Routing needs attention: {row.error}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted-foreground-2)]">
            Routing decides which agent handles each task role. Tune it any time in
            Settings → Models.
          </p>
          {onOpenModels ? (
            <button
              type="button"
              onClick={() => {
                finish();
                onOpenModels();
              }}
              className="mt-2 font-mono text-[11px] font-medium text-[var(--primary)] hover:text-[var(--primary)]"
            >
              Open Settings → Models
            </button>
          ) : null}
        </div>
      ) : null}

    </WizardShell>
  );
}
