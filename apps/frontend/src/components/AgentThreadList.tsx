import { MessageSquare } from "lucide-react";
import type { JSX } from "react";
import type { WebThread } from "../agent-threads";
import { formatTimeAgo } from "../ui-helpers";

export type ThreadRunState = "idle" | "working" | "waiting";

/** Live state from the caller wins; persisted session metadata is the fallback. */
export function threadRunState(
  thread: WebThread,
  threadStates?: Record<string, ThreadRunState>,
): ThreadRunState {
  const live = threadStates?.[thread.id];
  if (live) return live;
  const status = thread.metadata?.status;
  if (status === "running" || status === "working" || status === "live") return "working";
  if (status === "waiting-approval" || status === "waiting") return "waiting";
  return "idle";
}

export function agentRunState(
  threads: WebThread[],
  threadStates?: Record<string, ThreadRunState>,
): ThreadRunState {
  const states = threads.map((thread) => threadRunState(thread, threadStates));
  return states.includes("working") ? "working" : states.includes("waiting") ? "waiting" : "idle";
}

const stateLabel: Record<ThreadRunState, string> = {
  idle: "Idle",
  working: "Working",
  waiting: "Waiting",
};
const stateText: Record<ThreadRunState, string> = {
  idle: "",
  working: "text-emerald-600 dark:text-emerald-400",
  waiting: "text-amber-600 dark:text-amber-400",
};

export function AgentThreadList({
  id,
  agentName,
  threads,
  activeId,
  threadStates,
  onSelect,
}: {
  id?: string;
  agentName: string;
  threads: WebThread[];
  activeId?: string;
  threadStates?: Record<string, ThreadRunState>;
  onSelect: (threadId: string) => void;
}): JSX.Element {
  return (
    <div
      id={id}
      className="relative ml-5 mt-0.5 flex flex-col border-l border-[#e4e4e7] pl-2.5 dark:border-zinc-800"
      role="group"
      aria-label={`${agentName} threads`}
    >
      {threads.length === 0 ? (
        <span className="py-1 text-[12px] text-[#71717a] dark:text-zinc-500">No threads yet</span>
      ) : (
        threads.map((thread) => {
          const isActive = activeId === thread.id;
          const state = threadRunState(thread, threadStates);
          return (
            <button
              key={thread.id}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => onSelect(thread.id)}
              className={`relative flex min-h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400 ${
                isActive
                  ? "bg-[#e4e4e7] font-medium text-[#0a0a0a] dark:bg-zinc-800 dark:text-zinc-100"
                  : "text-[#71717a] hover:bg-[#f4f4f5] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-100"
              }`}
            >
              <span
                className="absolute -left-2.5 top-1/2 h-px w-2 bg-[#e4e4e7] dark:bg-zinc-800"
                aria-hidden="true"
              />
              <MessageSquare
                className="size-3.5 shrink-0 opacity-70"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{thread.name || "Untitled thread"}</span>
              <span className={`shrink-0 text-[10px] ${stateText[state]}`}>
                {state !== "idle"
                  ? stateLabel[state]
                  : thread.updatedAt
                    ? formatTimeAgo(thread.updatedAt)
                    : ""}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
