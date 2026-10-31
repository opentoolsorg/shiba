import { useEffect, useMemo, type JSX } from "react";
import { redactSecrets } from "@shiba/shared";
import { LoadErrorState } from "./LoadErrorState";
import { useSpine, type OutboxEntryWire, type SpineEventWire } from "../live-status";
import { documentVisibilityPause } from "../polling";
import { ViewEmpty, ViewGroup, ViewHeader, viewButtonClass } from "./ui/ViewChrome";

/**
 * Orchestrator activity — the P9 event spine, surfaced. Two panels:
 *   - Event log: what the orchestrator decided, newest first.
 *   - Outbox: side effects it still owes (Slack/email posts, pushes).
 * Polls lightly while mounted so the feed tracks live decisions.
 */
export function ActivityView({
  sessionId,
  sessionApiAvailable,
}: {
  sessionId: string;
  sessionApiAvailable: boolean;
}): JSX.Element {
  const { state, reload, inFlight } = useSpine(sessionId, sessionApiAvailable);

  // Poll 5s after each fetch settles — never abort a request that's still in
  // flight, or a slow DO keeps the feed stuck on "Loading events…" forever.
  // A hidden tab holds the next tick and refreshes once on resume.
  useEffect(() => {
    if (inFlight) return;
    const pause = documentVisibilityPause();
    let timer: number | undefined;
    if (!pause.isPaused()) {
      timer = window.setTimeout(reload, 5_000);
    }
    const unsubscribe = pause.subscribe(() => {
      if (pause.isPaused()) {
        if (timer !== undefined) {
          window.clearTimeout(timer);
          timer = undefined;
        }
      } else if (timer === undefined) {
        // Resume: the interval was skipped while hidden — refresh now.
        reload();
      }
    });
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [inFlight, reload]);

  const events = state.kind === "data" ? state.data.events : [];
  const outbox = state.kind === "data" ? state.data.outbox : [];
  const executionBudget = state.kind === "data" ? state.data.executionBudget : undefined;
  // Bounded (≤ MAX_SPINE_EVENTS) but still worth memoizing: every render used
  // to re-allocate a sorted copy and re-filter the outbox.
  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => b.seq - a.seq),
    [events],
  );
  const pending = useMemo(
    () => outbox.filter((entry) => entry.status === "pending"),
    [outbox],
  );

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      <ViewHeader section="Activity" view="Orchestrator activity" count={`${events.length} events`}>
        {pending.length > 0 ? <span className="text-xs text-[var(--muted-foreground-2)]">{pending.length} pending</span> : null}
        <button type="button" onClick={reload} className={viewButtonClass}>Refresh</button>
      </ViewHeader>

      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-5xl mx-auto flex flex-col gap-6">
          <section aria-label="Execution limits and usage" className="lg:col-span-2 border border-[var(--border-1)] bg-[var(--card)] px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <div className="text-xs font-semibold text-[var(--fg)]">Execution limits</div>
              {executionBudget?.dailyLimitUsd !== undefined ? (
                <div className="text-xs text-[var(--fg)] tabular-nums">
                  ${executionBudget.spentUsd.toFixed(4)} / ${executionBudget.dailyLimitUsd.toFixed(2)} daily reported cost
                  <span className={`ml-2 text-[10px] font-semibold uppercase ${executionBudget.dispatchAvailable ? "text-[var(--success)]" : "text-[var(--destructive)]"}`}>
                    {executionBudget.limitReached ? "daily cap reached" : executionBudget.dispatchAvailable ? "new runs allowed" : "concurrency full"}
                  </span>
                </div>
              ) : (
                <div className="text-xs text-[var(--muted-foreground-2)]">No daily cost limit is configured.</div>
              )}
              <div className="text-[10px] text-[var(--muted-foreground-2)]">
                {executionBudget ? `${executionBudget.reportedRuns} ${executionBudget.reportedRuns === 1 ? "run" : "runs"} reported cost · ${executionBudget.unreportedRuns} ${executionBudget.unreportedRuns === 1 ? "run has" : "runs have"} no cost report` : "Usage unavailable"}
              </div>
              {executionBudget ? (
                <div className="text-[10px] tabular-nums text-[var(--muted-foreground-2)]">{executionBudget.activeRuns} / {executionBudget.maxConcurrentRuns} active tasks</div>
              ) : null}
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-[var(--muted-foreground-2)]">
              Costs are harness-reported and may be incomplete. A configured daily limit blocks new dispatches at the limit; it does not stop active tasks. Cancel fences the run and signals its executor; if the executor cannot confirm its final state, the outcome remains unknown.
            </p>
          </section>
          <section aria-label="Event log">
            <ViewGroup title="Event log" count={events.length}>
            {state.kind === "loading" ? (
              <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">Loading events…</div>
            ) : state.kind === "error" ? (
              <LoadErrorState message={state.message} onRetry={reload} />
            ) : events.length === 0 ? (
              <ViewEmpty>No events yet</ViewEmpty>
            ) : (
              <ol className="divide-y divide-[var(--border-1)]/60">
                {sortedEvents.map((event) => (
                  <EventRow key={event.seq} event={event} />
                ))}
              </ol>
            )}
            </ViewGroup>
          </section>

          <section aria-label="Outbox">
            <ViewGroup title="Outbox" count={outbox.length}>
            {state.kind === "loading" ? <p className="p-4 text-xs text-[var(--muted-foreground-2)]">Loading deliveries…</p> : state.kind === "error" ? <p className="p-4 text-xs text-[var(--muted-foreground-2)]">Deliveries unavailable</p> : outbox.length === 0 ? (
              <ViewEmpty>No pending deliveries</ViewEmpty>
            ) : (
              <ol className="divide-y divide-[var(--border-1)]/60">
                {outbox.map((entry) => (
                  <OutboxRow key={entry.id} entry={entry} />
                ))}
              </ol>
            )}
            </ViewGroup>
          </section>
        </div>
      </div>
    </div>
  );
}

const KIND_TONE: Record<string, string> = {
  "run.completed": "text-[var(--success)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)] border-[color-mix(in_oklch,var(--success)_35%,transparent)]",
  "run.failed": "text-[var(--destructive)] bg-[var(--destructive-soft)] border-[color-mix(in_oklch,var(--destructive)_30%,transparent)]",
  "run.cancelled": "text-[var(--warning-fg)] bg-[var(--warning-subtle)] border-[var(--warning)]",
  "run.rejected": "text-[var(--destructive)] bg-[var(--destructive-soft)] border-[color-mix(in_oklch,var(--destructive)_30%,transparent)]",
  "approval.answered": "text-[var(--primary)] bg-[var(--primary-soft)] border-[var(--primary)]/30",
  "approval.requested": "text-[var(--primary)] bg-[var(--primary-soft)] border-[var(--primary)]/30",
  "side_effect.failed": "text-[var(--destructive)] bg-[var(--destructive-soft)] border-[color-mix(in_oklch,var(--destructive)_30%,transparent)]",
};

function eventSummary(event: SpineEventWire): string {
  const p = event.payload;
  if (!p) return "";
  if (typeof p.summary === "string") return p.summary;
  if (typeof p.status === "string") return p.status;
  if (typeof p.target === "string") return `${p.effectKind ?? "effect"} → ${p.target}`;
  if (typeof p.error === "string") return redactSecrets(p.error).slice(0, 500);
  if (typeof p.result === "string") return p.result;
  if (p.forkedFrom && typeof p.forkedFrom === "object") {
    const f = p.forkedFrom as Record<string, unknown>;
    const ref = typeof f.checkpointRef === "string" ? f.checkpointRef.split("/").pop() : "";
    return `fork of ${typeof f.runId === "string" ? f.runId.slice(0, 12) : "?"}… · cp ${ref}`;
  }
  if (p.run && typeof p.run === "object") {
    const run = p.run as Record<string, unknown>;
    return [run.harness, run.codingModel].filter((v) => typeof v === "string").join(" · ");
  }
  return "";
}

function EventRow({ event }: { event: SpineEventWire }): JSX.Element {
  const tone = KIND_TONE[event.kind] ?? "text-[var(--muted-foreground-2)] bg-[var(--section)] border-[var(--border-1)]";
  const summary = eventSummary(event);
  return (
    <li className="min-h-11 border-b border-[var(--border-1)] px-3 py-2.5 flex flex-wrap items-center gap-3">
      <span className="font-mono text-[10px] text-[var(--muted-foreground-2)] w-10 shrink-0 tabular-nums">
        #{event.seq}
      </span>
      <span
        className={`text-xs font-medium rounded-md px-2 py-1 shrink-0 ${tone}`}
      >
        {event.kind}
      </span>
      <span className="flex-1 min-w-32">
        <span className="block text-xs text-[var(--fg)] truncate">
          {summary || <span className="text-[var(--muted-foreground-2)]">—</span>}
        </span>
        <span className="block font-mono text-[10px] text-[var(--muted-foreground-2)] truncate">
          {event.runId ? `run ${event.runId.slice(0, 12)}… · ` : ""}
          cmd {event.commandId.slice(0, 12)}
          {event.causationId ? ` · caused by ${event.causationId.slice(0, 12)}` : ""}
        </span>
      </span>
      <time
        className="font-mono text-[10px] text-[var(--muted-foreground-2)] shrink-0 tabular-nums"
        dateTime={new Date(event.at).toISOString()}
      >
        {new Date(event.at).toLocaleTimeString()}
      </time>
    </li>
  );
}

function OutboxRow({ entry }: { entry: OutboxEntryWire }): JSX.Element {
  const tone =
    entry.status === "dispatched"
      ? "text-[var(--success)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)] border-[color-mix(in_oklch,var(--success)_35%,transparent)]"
      : entry.status === "failed"
        ? "text-[var(--destructive)] bg-[var(--destructive-soft)] border-[color-mix(in_oklch,var(--destructive)_30%,transparent)]"
        : "text-[var(--warning-fg)] bg-[var(--warning-subtle)] border-[var(--warning)]";
  return (
    <li className="min-h-11 border-b border-[var(--border-1)] px-3 py-3 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className={`text-xs font-medium rounded-md px-2 py-1 ${tone}`}>
          {entry.status}
        </span>
        <span className="text-xs font-medium text-[var(--fg)]">{entry.effectKind}</span>
        <span className="font-mono text-[10px] text-[var(--muted-foreground-2)] ml-auto">×{entry.attempts}</span>
      </div>
      <div className="font-mono text-[10px] text-[var(--muted-foreground-2)] truncate">
        {entry.target}
        {entry.summary ? ` — ${entry.summary}` : ""}
      </div>
      {entry.lastError ? (
        <div className="text-[10px] text-[var(--destructive)] truncate">{redactSecrets(entry.lastError).slice(0, 500)}</div>
      ) : null}
    </li>
  );
}
