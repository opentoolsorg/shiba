import type { OnboardingStatus, OnboardingStepStatus } from "@shiba/shared";
import { useState } from "react";

interface OnboardingNudgeBannerProps {
  status: OnboardingStatus;
  onResume: (step: OnboardingStepStatus) => void;
  onDismiss: () => void;
}

export function OnboardingNudgeBanner({ status, onResume, onDismiss }: OnboardingNudgeBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  if (status.complete || dismissed) return null;

  return (
    <section aria-label="Setup reminder" className="shrink-0 border-b border-[var(--line)] bg-[var(--card)] px-4 py-3 text-[var(--ink)] sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Finish setup — {status.remaining.length} steps left</h2>
          {status.nextStep ? <p className="mt-1 text-xs text-[var(--ink-2)]">Next: {status.nextStep.label}</p> : null}
          <ul aria-label="Remaining setup steps" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--ink-2)]">
            {status.remaining.map((step) => <li key={step.id}>{step.label}</li>)}
          </ul>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button type="button" onClick={() => { setDismissed(true); onDismiss(); }} className="min-h-9 px-2 text-xs text-[var(--ink-2)] hover:text-[var(--ink)]">
            Dismiss for now
          </button>
          {status.nextStep ? (
            <button type="button" onClick={() => { if (status.nextStep) onResume(status.nextStep); }} className="min-h-9 border border-[var(--navy)] bg-[var(--navy)] px-3 font-mono text-xs font-semibold text-[var(--paper)] shadow-[2px_2px_0_var(--paper-shadow)] hover:bg-[var(--navy-2)] active:translate-y-px">
              Continue
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
