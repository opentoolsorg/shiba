import { useEffect, useMemo, type JSX } from "react";
import { ChevronRight, PanelLeft } from "lucide-react";
import { redactSecrets } from "@shiba/shared";
import { LoadErrorState } from "./LoadErrorState";
import { useSpine, type OutboxEntryWire, type SpineEventWire } from "../live-status";
import { documentVisibilityPause } from "../polling";
import { ViewEmpty, ViewGroup } from "./ui/ViewChrome";
import { MainCard, type Scope } from "./ui/ContextPanel";

/**
 * Orchestrator activity — the P9 event spine, surfaced.
 * Main card: 48px header with breadcrumb "Scope > Insights > Activity",
 * execution limits card, event log, and outbox deliveries.
 */
export function ActivityView({
  sessionId,
  sessionApiAvailable,
  scope = "personal",
  sidebarCollapsed = false,
  onToggleSidebar,
  className = "",
}: {
  sessionId: string;
  sessionApiAvailable: boolean;
  scope?: Scope;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  className?: string;
}): JSX.Element {
  const { state, reload, inFlight } = useSpine(sessionId, sessionApiAvailable);
  const scopeLabel = scope === "workspace" ? "Workspace" : "Personal";

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

  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => b.seq - a.seq),
    [events],
  );
  const pending = useMemo(
    () => outbox.filter((entry) => entry.status === "pending"),
    [outbox],
  );

  return (
    <MainCard className={className}>
      {/* 48px Header */}
      <header className="flex h-12 min-h-[48px] shrink-0 items-center justify-between border-b border-[#e4e4e7] px-4 select-none dark:border-zinc-800">
        <div className="flex items-center gap-2.5 min-w-0">
          {onToggleSidebar ? (
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!sidebarCollapsed}
              className="flex size-7 items-center justify-center rounded-md text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <PanelLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          ) : null}

          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0">
            <ol className="flex items-center gap-1.5 min-w-0">
              <li className="flex items-center gap-1.5 min-w-0">
                <span className="text-[14px] text-[#71717a] dark:text-zinc-400 truncate">{scopeLabel}</span>
              </li>
              <li className="flex items-center gap-1.5 min-w-0">
                <ChevronRight className="size-3.5 text-[#71717a] dark:text-zinc-500 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                <span className="text-[14px] text-[#71717a] dark:text-zinc-400 truncate">Insights</span>
              </li>
              <li className="flex items-center gap-1.5 min-w-0">
                <ChevronRight className="size-3.5 text-[#71717a] dark:text-zinc-500 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                <h1 className="text-[14px] font-medium text-[#0a0a0a] dark:text-zinc-100 truncate" aria-current="page">
                  Activity
                </h1>
              </li>
            </ol>
            <span className="ml-2 rounded-full bg-[#f4f4f5] dark:bg-zinc-800 px-2 py-0.5 text-xs text-[#71717a] dark:text-zinc-400 tabular-nums">
              {events.length} events
            </span>
          </nav>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {pending.length > 0 ? (
            <span className="text-xs text-[#71717a] dark:text-zinc-400">{pending.length} pending</span>
          ) : null}
          <button
            type="button"
            onClick={reload}
            aria-label="Refresh"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-[#e4e4e7] bg-white px-2.5 text-[13px] font-medium text-[#0a0a0a] transition-colors hover:bg-[#f4f4f5] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            Refresh
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 min-h-0 text-[#0a0a0a] dark:text-zinc-100">
        <div className="max-w-5xl mx-auto flex flex-col gap-6">
          <section aria-label="Execution limits and usage" className="rounded-xl border border-[#e4e4e7] bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/50">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <div className="text-xs font-semibold text-[#0a0a0a] dark:text-zinc-100">Execution limits</div>
              {executionBudget?.dailyLimitUsd !== undefined ? (
                <div className="text-xs text-[#0a0a0a] dark:text-zinc-100 tabular-nums">
                  ${executionBudget.spentUsd.toFixed(4)} / ${executionBudget.dailyLimitUsd.toFixed(2)} daily reported cost
                  <span className={`ml-2 text-[10px] font-semibold uppercase ${executionBudget.dispatchAvailable ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                    {executionBudget.limitReached ? "daily cap reached" : executionBudget.dispatchAvailable ? "new runs allowed" : "concurrency full"}
                  </span>
                </div>
              ) : (
                <div className="text-xs text-[#71717a] dark:text-zinc-400">No daily cost limit is configured.</div>
              )}
              <div className="text-[10px] text-[#71717a] dark:text-zinc-400">
                {executionBudget ? `${executionBudget.reportedRuns} ${executionBudget.reportedRuns === 1 ? "run" : "runs"} reported cost · ${executionBudget.unreportedRuns} ${executionBudget.unreportedRuns === 1 ? "run has" : "runs have"} no cost report` : "Usage unavailable"}
              </div>
              {executionBudget ? (
                <div className="text-[10px] tabular-nums text-[#71717a] dark:text-zinc-400">{executionBudget.activeRuns} / {executionBudget.maxConcurrentRuns} active tasks</div>
              ) : null}
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-[#71717a] dark:text-zinc-400">
              Costs are harness-reported and may be incomplete. A configured daily limit blocks new dispatches at the limit; it does not stop active tasks. Cancel fences the run and signals its executor; if the executor cannot confirm its final state, the outcome remains unknown.
            </p>
          </section>

          <section aria-label="Event log" className="rounded-xl border border-[#e4e4e7] bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
            <ViewGroup title="Event log" count={events.length}>
              {state.kind === "loading" ? (
                <div className="px-4 py-6 text-center text-xs text-[#71717a] dark:text-zinc-400">Loading events…</div>
              ) : state.kind === "error" ? (
                <LoadErrorState message={state.message} onRetry={reload} />
              ) : events.length === 0 ? (
                <ViewEmpty>No events yet</ViewEmpty>
              ) : (
                <ol className="divide-y divide-[#e4e4e7] dark:divide-zinc-800 pt-2">
                  {sortedEvents.map((event) => (
                    <EventRow key={event.seq} event={event} />
                  ))}
                </ol>
              )}
            </ViewGroup>
          </section>

          <section aria-label="Outbox" className="rounded-xl border border-[#e4e4e7] bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
            <ViewGroup title="Outbox" count={outbox.length}>
              {state.kind === "loading" ? (
                <p className="p-4 text-xs text-[#71717a] dark:text-zinc-400">Loading deliveries…</p>
              ) : state.kind === "error" ? (
                <p className="p-4 text-xs text-rose-600 dark:text-rose-400">Deliveries unavailable</p>
              ) : outbox.length === 0 ? (
                <ViewEmpty>No pending deliveries</ViewEmpty>
              ) : (
                <ol className="divide-y divide-[#e4e4e7] dark:divide-zinc-800 pt-2">
                  {outbox.map((entry) => (
                    <OutboxRow key={entry.id} entry={entry} />
                  ))}
                </ol>
              )}
            </ViewGroup>
          </section>
        </div>
      </div>
    </MainCard>
  );
}

const KIND_TONE: Record<string, string> = {
  "run.completed": "text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-800",
  "run.failed": "text-rose-700 bg-rose-50 border-rose-200 dark:text-rose-300 dark:bg-rose-950/40 dark:border-rose-800",
  "run.cancelled": "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-950/40 dark:border-amber-800",
  "run.rejected": "text-rose-700 bg-rose-50 border-rose-200 dark:text-rose-300 dark:bg-rose-950/40 dark:border-rose-800",
  "approval.answered": "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-950/40 dark:border-blue-800",
  "approval.requested": "text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-950/40 dark:border-blue-800",
  "side_effect.failed": "text-rose-700 bg-rose-50 border-rose-200 dark:text-rose-300 dark:bg-rose-950/40 dark:border-rose-800",
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
  const tone = KIND_TONE[event.kind] ?? "text-[#71717a] bg-[#f4f4f5] border-[#e4e4e7] dark:text-zinc-400 dark:bg-zinc-800 dark:border-zinc-700";
  const summary = eventSummary(event);
  return (
    <li className="min-h-11 border-b border-[#e4e4e7] dark:border-zinc-800/80 px-3 py-2.5 flex flex-wrap items-center gap-3 last:border-b-0">
      <span className="font-mono text-[10px] text-[#71717a] dark:text-zinc-400 w-10 shrink-0 tabular-nums">
        #{event.seq}
      </span>
      <span
        className={`text-xs font-medium rounded-md px-2 py-0.5 border shrink-0 ${tone}`}
      >
        {event.kind}
      </span>
      <span className="flex-1 min-w-32">
        <span className="block text-xs text-[#0a0a0a] dark:text-zinc-100 truncate">
          {summary || <span className="text-[#71717a] dark:text-zinc-400">—</span>}
        </span>
        <span className="block font-mono text-[10px] text-[#71717a] dark:text-zinc-400 truncate">
          {event.runId ? `run ${event.runId.slice(0, 12)}… · ` : ""}
          cmd {event.commandId.slice(0, 12)}
          {event.causationId ? ` · caused by ${event.causationId.slice(0, 12)}` : ""}
        </span>
      </span>
      <time
        className="font-mono text-[10px] text-[#71717a] dark:text-zinc-400 shrink-0 tabular-nums"
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
      ? "text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-800"
      : entry.status === "failed"
        ? "text-rose-700 bg-rose-50 border-rose-200 dark:text-rose-300 dark:bg-rose-950/40 dark:border-rose-800"
        : "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-950/40 dark:border-amber-800";
  return (
    <li className="min-h-11 border-b border-[#e4e4e7] dark:border-zinc-800/80 px-3 py-3 flex flex-col gap-1 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className={`text-xs font-medium rounded-md px-2 py-0.5 border ${tone}`}>
          {entry.status}
        </span>
        <span className="text-xs font-medium text-[#0a0a0a] dark:text-zinc-100">{entry.effectKind}</span>
        <span className="font-mono text-[10px] text-[#71717a] dark:text-zinc-400 ml-auto">×{entry.attempts}</span>
      </div>
      <div className="font-mono text-[10px] text-[#71717a] dark:text-zinc-400 truncate">
        {entry.target}
        {entry.summary ? ` — ${entry.summary}` : ""}
      </div>
      {entry.lastError ? (
        <div className="text-[10px] text-rose-600 dark:text-rose-400 truncate">{redactSecrets(entry.lastError).slice(0, 500)}</div>
      ) : null}
    </li>
  );
}
