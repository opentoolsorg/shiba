import type { OnboardingStatus, OnboardingStepStatus } from "@shiba/shared";
import { useEffect, useId, useRef } from "react";

interface OnboardingNudgePopupProps {
  open: boolean;
  status: OnboardingStatus;
  onResume: (step: OnboardingStepStatus) => void;
  onDismiss: () => void;
}

export function OnboardingNudgePopup({ open, status, onResume, onDismiss }: OnboardingNudgePopupProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const visible = open && !status.complete;

  useEffect(() => {
    if (!visible) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const buttons = () => Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    buttons()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissRef.current();
      }
      if (event.key === "Tab") {
        const controls = buttons();
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--paper)]/90 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto border border-[var(--line)] bg-[var(--card)] text-[var(--ink)] shadow-[3px_3px_0_var(--paper-shadow)]">
        <div className="border-b border-[var(--line)] px-5 py-4">
          <h2 id={titleId} className="text-lg font-semibold">Your first task is waiting</h2>
          <p id={descriptionId} className="mt-2 text-sm text-[var(--ink-2)]">Pick up where you left off. {status.remaining.length} setup steps remain.</p>
        </div>
        <ul aria-label="Remaining setup steps" className="list-inside list-disc space-y-2 px-5 py-4 text-sm">
          {status.remaining.map((step) => <li key={step.id}>{step.label}</li>)}
        </ul>
        {status.nextStep ? <p className="px-5 pb-4 text-xs text-[var(--ink-2)]">Next: {status.nextStep.label}</p> : null}
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-[var(--line)] px-5 py-4">
          <button type="button" onClick={onDismiss} className="min-h-9 border border-[var(--line)] px-3 text-xs hover:bg-[var(--panel-2)]">Not now</button>
          {status.nextStep ? (
            <button type="button" onClick={() => { if (status.nextStep) onResume(status.nextStep); }} className="min-h-9 border border-[var(--navy)] bg-[var(--navy)] px-3 font-mono text-xs font-semibold text-[var(--paper)] shadow-[2px_2px_0_var(--paper-shadow)] hover:bg-[var(--navy-2)] active:translate-y-px">
              Continue setup
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
