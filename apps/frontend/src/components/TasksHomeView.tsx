import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { ArrowUp, Check, CircleDot, LoaderCircle, Mic, PanelLeft, SquareArrowOutUpRight } from "lucide-react";
import type { RetainedRun, StoredApproval } from "../types";
import { formatTimeAgo } from "../ui-helpers";

export interface TasksHomeAgent {
  id: string;
  name: string;
  slug: string;
  emoji?: string;
  defaultRepoUrl?: string;
}

export interface TasksHomeItem {
  id: string;
  title: string;
  repoUrl: string;
  updatedAt: number;
  bucket: "needs-you" | "working" | "waiting";
  status: string;
  progressText?: string;
  source: { kind: "run"; runId: string } | { kind: "approval"; approvalId: string };
}

export interface TasksHomeBuckets {
  needsYou: TasksHomeItem[];
  working: TasksHomeItem[];
  waiting: TasksHomeItem[];
}

/** Adapt the existing run and approval APIs to the Tasks home queues. */
export function buildTasksHomeBuckets(
  runs: RetainedRun[],
  approvals: StoredApproval[],
): TasksHomeBuckets {
  const buckets: TasksHomeBuckets = { needsYou: [], working: [], waiting: [] };
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");

  for (const approval of pendingApprovals) {
    buckets.needsYou.push({
      id: `approval:${approval.approvalId}`,
      title: approval.task,
      repoUrl: approval.repoUrl,
      updatedAt: approval.createdAt,
      bucket: "needs-you",
      status: "Approval",
      source: { kind: "approval", approvalId: approval.approvalId },
    });
  }

  for (const run of runs) {
    if (run.archivedAt) continue;
    const base = {
      id: `run:${run.runId}`,
      title: run.task,
      repoUrl: run.repoUrl,
      updatedAt: run.updatedAt || run.createdAt,
      source: { kind: "run", runId: run.runId } as const,
    };
    if (run.status === "running") {
      buckets.working.push({
        ...base,
        bucket: "working",
        status: "Working",
        // The current run summary is the only live text the summary API exposes.
        // TODO: bind this to streamed phase/tool progress when the run API exposes it.
        progressText: run.summary?.trim() || "Working…",
      });
    } else if (run.status === "pending") {
      buckets.waiting.push({ ...base, bucket: "waiting", status: "Queued" });
    } else if (run.status === "completed") {
      buckets.needsYou.push({ ...base, bucket: "needs-you", status: "Answered" });
    } else {
      buckets.needsYou.push({
        ...base,
        bucket: "needs-you",
        status: run.status === "unknown" ? "Check status" : run.status === "error" ? "Failed" : "Stopped",
      });
    }
  }

  for (const items of Object.values(buckets)) {
    items.sort((left: TasksHomeItem, right: TasksHomeItem) => right.updatedAt - left.updatedAt);
  }
  return buckets;
}

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

function TaskRow({
  item,
  onOpenRun,
  onOpenApproval,
}: {
  item: TasksHomeItem;
  onOpenRun?: (runId: string) => void;
  onOpenApproval?: (approvalId: string) => void;
}): JSX.Element {
  const open = () => {
    if (item.source.kind === "run") onOpenRun?.(item.source.runId);
    else onOpenApproval?.(item.source.approvalId);
  };
  const isWorking = item.bucket === "working";
  const tone = item.status === "Answered"
    ? "border-[color-mix(in_oklch,var(--success)_42%,transparent)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]"
    : item.status === "Approval"
      ? "border-[color-mix(in_oklch,var(--warning)_42%,transparent)] bg-[var(--warning-subtle)] text-[var(--warning-fg)]"
      : item.status === "Failed" || item.status === "Stopped" || item.status === "Check status"
        ? "border-[color-mix(in_oklch,var(--destructive)_42%,transparent)] bg-[var(--destructive-soft)] text-[var(--destructive)]"
        : "border-[var(--border-1)] bg-[var(--section)] text-[var(--muted-foreground-1)]";

  return (
    <article className="border-b border-[var(--border-1)] px-4 py-4 sm:px-5" data-testid={`task-row-${item.id}`}>
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 size-2 shrink-0 ${isWorking ? "animate-pulse bg-[var(--primary)]" : "bg-[var(--muted-foreground-3)]"}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <button type="button" onClick={open} className="block max-w-full truncate text-left text-sm font-medium text-[var(--fg)] hover:text-[var(--primary)] focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2">
            {item.title || "Untitled task"}
          </button>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-[var(--muted-foreground-2)]">
            {item.repoUrl ? <span className="max-w-full truncate">{item.repoUrl.replace(/^https:\/\/github\.com\//, "")}</span> : null}
            {item.repoUrl ? <span aria-hidden="true">·</span> : null}
            <span>{formatTimeAgo(item.updatedAt)}</span>
          </div>
          {item.progressText ? (
            <div className="mt-3 flex items-center gap-2 text-xs text-[var(--muted-foreground-1)]" data-testid="task-progress">
              <LoaderCircle className="size-3.5 shrink-0 animate-spin text-[var(--primary)]" aria-hidden="true" />
              <span className="min-w-0 truncate">{item.progressText}</span>
              <span className="relative ml-1 h-px min-w-8 flex-1 overflow-hidden bg-[var(--border-1)]" aria-hidden="true">
                <span className="absolute inset-y-0 left-0 w-1/3 animate-pulse bg-[var(--primary)]" />
              </span>
            </div>
          ) : null}
        </div>
        <span className={`shrink-0 border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.1em] ${tone}`}>
          {item.status}
        </span>
        <button type="button" onClick={open} aria-label={`Open ${item.title || "task"}`} className="-mr-2 inline-flex size-9 shrink-0 items-center justify-center text-[var(--muted-foreground-2)] hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-[var(--ring)]">
          <SquareArrowOutUpRight className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

function TaskQueue({
  title,
  items,
  emptyText = "Nothing here yet.",
  onOpenRun,
  onOpenApproval,
}: {
  title: string;
  items: TasksHomeItem[];
  emptyText?: string;
  onOpenRun?: (runId: string) => void;
  onOpenApproval?: (approvalId: string) => void;
}): JSX.Element {
  return (
    <section aria-label={title} className="overflow-hidden border border-[var(--border-1)] bg-[var(--card)]">
      <header className="flex min-h-12 items-center justify-between border-b border-[var(--border-1)] px-4 sm:px-5">
        <h2 className="font-display text-xl text-[var(--fg)]">{title}</h2>
        <span className="font-mono text-[10px] tabular-nums text-[var(--muted-foreground-2)]">{String(items.length).padStart(2, "0")}</span>
      </header>
      {items.length > 0 ? items.map((item) => (
        <TaskRow key={item.id} item={item} onOpenRun={onOpenRun} onOpenApproval={onOpenApproval} />
      )) : (
        <p className="px-4 py-4 text-xs text-[var(--muted-foreground-2)] sm:px-5">{emptyText}</p>
      )}
    </section>
  );
}

export function TasksHomeView({
  task,
  onTaskChange,
  agents,
  agentsLoading = false,
  selectedAgentId,
  onAgentChange,
  repoUrl,
  repoSuggestions = [],
  onRepoUrlChange,
  runs,
  approvals,
  busy = false,
  onSubmit,
  onOpenRun,
  onOpenApproval,
  onToggleAgents,
  agentsOpen = true,
}: {
  task: string;
  onTaskChange: (value: string) => void;
  agents: TasksHomeAgent[];
  agentsLoading?: boolean;
  selectedAgentId: string;
  onAgentChange: (id: string) => void;
  repoUrl: string;
  repoSuggestions?: string[];
  onRepoUrlChange: (value: string) => void;
  runs: RetainedRun[];
  approvals: StoredApproval[];
  busy?: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>, agentId: string) => void;
  onOpenRun?: (runId: string) => void;
  onOpenApproval?: (approvalId: string) => void;
  onToggleAgents?: () => void;
  agentsOpen?: boolean;
}): JSX.Element {
  const buckets = buildTasksHomeBuckets(runs, approvals);
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const repositoryNeeded = !selectedAgent?.defaultRepoUrl || !repoUrl.trim();
  const [listening, setListening] = useState(false);
  const recognizer = useRef<SpeechRecognitionLike | null>(null);
  const speechConstructor = typeof window === "undefined"
    ? undefined
    : (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition;

  useEffect(() => () => recognizer.current?.stop(), []);

  const toggleVoiceInput = () => {
    if (!speechConstructor) return;
    if (listening) {
      recognizer.current?.stop();
      return;
    }
    const instance = new speechConstructor();
    instance.lang = navigator.language || "en-US";
    instance.interimResults = false;
    instance.onresult = (event) => {
      const transcript = event.results[event.results.length - 1]?.[0]?.transcript?.trim();
      if (transcript) onTaskChange([task.trim(), transcript].filter(Boolean).join(" "));
    };
    instance.onerror = () => setListening(false);
    instance.onend = () => setListening(false);
    recognizer.current = instance;
    setListening(true);
    instance.start();
  };

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-[var(--paper)]">
      {/* Top Header Bar matching OpenBot TasksPage header */}
      <header className="sticky top-0 z-20 flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-1)] bg-[var(--chrome)]/90 px-4 backdrop-blur sm:px-6">
        <div className="flex items-center gap-2.5">
          {onToggleAgents ? (
            <button
              type="button"
              onClick={onToggleAgents}
              aria-label={agentsOpen ? "Hide agents sidebar" : "Show agents sidebar"}
              title={agentsOpen ? "Hide agents sidebar" : "Show agents sidebar"}
              className="inline-flex size-7 items-center justify-center rounded text-[var(--muted-foreground-2)] hover:bg-[var(--secondary)] hover:text-[var(--fg)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
            >
              <PanelLeft className="size-4" aria-hidden="true" />
            </button>
          ) : null}
          <span className="font-display text-[15px] text-[var(--fg)] font-medium">Shiba Workspace</span>
          <span className="text-[var(--muted-foreground-3)] font-mono text-xs">/</span>
          <span className="text-xs text-[var(--muted-foreground-2)] font-medium">Tasks</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono text-[var(--muted-foreground-2)]">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-1)] bg-[var(--panel)] px-2.5 py-0.5">
            <span className="size-1.5 rounded-full bg-[var(--primary)] animate-pulse" aria-hidden="true" />
            <span>{buckets.working.length} active</span>
          </span>
          {buckets.needsYou.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_oklch,var(--warning)_40%,transparent)] bg-[var(--warning-subtle)] px-2.5 py-0.5 text-[var(--warning-fg)] font-medium">
              <span>{buckets.needsYou.length} need review</span>
            </span>
          ) : null}
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-[860px] flex-col px-4 pb-12 pt-10 sm:px-8 sm:pt-14 lg:pt-[8vh]">
        <section className="mx-auto w-full max-w-[720px] text-center">
          <div className="mb-5 inline-flex items-center gap-2 border border-[var(--border-1)] bg-[var(--card)] px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted-foreground-2)]">
            <CircleDot className="size-3 text-[var(--primary)]" aria-hidden="true" />
            Shiba team workspace
          </div>
          <h1 className="font-display text-[clamp(2.4rem,5vw,4rem)] leading-[0.98] tracking-[-0.02em] text-[var(--fg)]">
            Hand off the work.<br />Come back to an answer.
          </h1>
          <p className="mx-auto mt-4 max-w-[34rem] text-sm leading-6 text-[var(--muted-foreground-2)]">
            Put your agents side by side. They can work while you focus on what comes next.
          </p>
        </section>

    <form onSubmit={(event) => onSubmit(event, selectedAgentId)} className="mt-8 border border-[var(--border-2)] bg-[var(--card)] shadow-[2px_2px_0_var(--paper-shadow)] focus-within:border-[var(--primary)]">
          <label htmlFor="tasks-home-prompt" className="sr-only">What do you want done?</label>
          <textarea
            id="tasks-home-prompt"
            value={task}
            onChange={(event) => onTaskChange(event.target.value)}
            placeholder="What do you want done?"
            rows={3}
            className="block min-h-24 w-full resize-y border-0 bg-transparent px-4 py-4 text-sm leading-6 text-[var(--fg)] outline-none placeholder:text-[var(--muted-foreground-3)] focus:ring-0 sm:px-5"
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-1)] px-3 py-2.5 sm:px-4">
            <label htmlFor="tasks-home-agent" className="sr-only">Choose an agent</label>
            <select
              id="tasks-home-agent"
              aria-label="Choose an agent"
              value={selectedAgentId}
              onChange={(event) => onAgentChange(event.target.value)}
              disabled={agentsLoading || agents.length === 0}
              className="h-9 max-w-full border border-[var(--border-1)] bg-[var(--panel)] px-2.5 text-xs text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
            >
              {agents.length === 0 ? <option value="">{agentsLoading ? "Loading agents…" : "No saved agents"}</option> : null}
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.emoji ? `${agent.emoji} ` : ""}{agent.name}</option>)}
            </select>
            {repositoryNeeded ? (
              <input
                type="url"
                aria-label="GitHub repository URL"
                list="tasks-home-repositories"
                value={repoUrl}
                onChange={(event) => onRepoUrlChange(event.target.value)}
                placeholder="https://github.com/owner/repo"
                className="h-9 min-w-[200px] flex-1 border border-[var(--border-1)] bg-[var(--panel)] px-2.5 text-xs text-[var(--fg)] outline-none placeholder:text-[var(--muted-foreground-3)] focus:border-[var(--primary)]"
              />
            ) : (
              <span className="max-w-[260px] truncate border border-[var(--border-1)] px-2.5 py-2 font-mono text-[10px] text-[var(--muted-foreground-2)]" title={repoUrl}>
                {repoUrl.replace(/^https:\/\/github\.com\//, "") || selectedAgent?.slug}
              </span>
            )}
            <datalist id="tasks-home-repositories">{repoSuggestions.map((repo) => <option key={repo} value={repo} />)}</datalist>
            <span className="flex-1" />
            <button
              type="button"
              onClick={toggleVoiceInput}
              disabled={!speechConstructor}
              aria-label={listening ? "Stop voice input" : "Start voice input"}
              title={speechConstructor ? (listening ? "Stop voice input" : "Voice input") : "Voice input is unavailable in this browser"}
              className={`inline-flex size-9 items-center justify-center border border-[var(--border-1)] text-[var(--muted-foreground-1)] hover:bg-[var(--section)] disabled:cursor-not-allowed disabled:opacity-40 ${listening ? "border-[var(--primary)] text-[var(--primary)]" : ""}`}
            >
              {listening ? <Check className="size-4" aria-hidden="true" /> : <Mic className="size-4" aria-hidden="true" />}
            </button>
            <button
              type="submit"
              disabled={busy || !task.trim() || agentsLoading || (repositoryNeeded && !repoUrl.trim())}
              aria-label="Send task"
              className="inline-flex size-9 items-center justify-center border border-[var(--navy)] bg-[var(--navy)] text-[var(--primary-text)] shadow-[2px_2px_0_var(--paper-shadow)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
            >
              {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <ArrowUp className="size-4" aria-hidden="true" />}
            </button>
          </div>
        </form>

        <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-4" aria-label="Task queues">
          <TaskQueue title="Needs you" items={buckets.needsYou} emptyText="Nothing waiting for review." onOpenRun={onOpenRun} onOpenApproval={onOpenApproval} />
          <TaskQueue title="Working" items={buckets.working} emptyText="No agents currently running." onOpenRun={onOpenRun} onOpenApproval={onOpenApproval} />
          <TaskQueue title="Waiting" items={buckets.waiting} emptyText="No tasks in queue." onOpenRun={onOpenRun} onOpenApproval={onOpenApproval} />
        </div>
      </div>
    </main>
  );
}
