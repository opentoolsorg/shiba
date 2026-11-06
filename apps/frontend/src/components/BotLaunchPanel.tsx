import type { JSX } from "react";
import type { BotReadinessFixView, BotReadinessState } from "../bot-readiness";

/** Shown above the composer of a bot thread so setup gaps surface before Send task. */
export function BotLaunchPanel({
  botName,
  state,
  onFix,
  onRecheck,
}: {
  botName: string;
  state: BotReadinessState;
  onFix: (view: BotReadinessFixView) => void;
  onRecheck: () => void;
}): JSX.Element | null {
  if (state.status === "idle") return null;
  const readiness = state.status === "ready" ? state.readiness : null;
  const target = readiness?.target;
  return (
    <section
      aria-label={`${botName} launch checklist`}
      data-testid="bot-launch-panel"
      data-ready={readiness ? String(readiness.ready) : undefined}
      className="mx-3 mt-3 rounded-[var(--radius-panel)] border border-[var(--border-1)] bg-[var(--card)] p-3 text-xs text-[var(--fg)] flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>Launch {botName}</strong>
        {readiness?.synthetic ? (
          <span data-testid="bot-synthetic-badge" className="border border-[var(--border-1)] px-2 py-0.5 rounded-[var(--radius-button)] text-[var(--muted-foreground-2)]">
            Synthetic execution (verify stand-in)
          </span>
        ) : null}
      </div>
      {state.status === "loading" ? <p className="text-[var(--muted-foreground-2)]">Checking model, credentials, and sandbox…</p> : null}
      {state.status === "error" ? (
        <p role="alert" className="text-[var(--destructive)]">
          {state.error} <button type="button" onClick={onRecheck} className="text-[var(--primary)] underline">Check again</button>
        </p>
      ) : null}
      {target ? (
        <p data-testid="bot-launch-target">
          {target.kind === "repository"
            ? <>Works in <span className="font-mono">{target.repoUrl}</span></>
            : <>Works in an artifact workspace (no repository) and delivers <span className="font-mono">{target.expectedDeliverables.join(", ")}</span></>}
          {readiness?.model ? <> · {readiness.harness} / <span className="font-mono">{readiness.model}</span></> : null}
        </p>
      ) : null}
      {readiness && readiness.problems.length > 0 ? (
        <ul aria-label="Launch problems" className="flex flex-col gap-1.5">
          {readiness.problems.map((problem) => (
            <li key={`${problem.id}:${problem.message}`} className="flex flex-wrap items-start gap-2">
              <span className={problem.severity === "error" ? "text-[var(--destructive)]" : "text-[var(--warning-fg)]"}>
                {problem.severity === "error" ? "Blocked:" : "Note:"}
              </span>
              <span className="flex-1 min-w-0 break-words">{problem.message}</span>
              <button type="button" onClick={() => onFix(problem.fix.view)} className="text-[var(--primary)] underline underline-offset-2">
                {problem.fix.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {readiness ? (
        <p className="text-[var(--muted-foreground-2)]">
          {readiness.ready
            ? "Describe the task below. Nothing runs until you approve the run card."
            : "Fix the blocked items, then check again. Sending now would be refused before approval."}
          {readiness.problems.length > 0 ? <> <button type="button" onClick={onRecheck} className="text-[var(--primary)] underline">Check again</button></> : null}
        </p>
      ) : null}
    </section>
  );
}
