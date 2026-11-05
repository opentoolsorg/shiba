import { useState } from "react";
import type { TeamWorkActivity, TeamWorkItem } from "../team-work-items";
import { formatTimeAgo } from "../ui-helpers";

type ActivityTask = Pick<TeamWorkItem, "activity" | "updatedAt"> & { createdAt?: number };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    (parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")
  ).toUpperCase();
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-100"
    >
      {initials(name)}
    </span>
  );
}

function When({ at }: { at: number }) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      className="text-xs text-slate-400 dark:text-slate-500"
    >
      {formatTimeAgo(at)}
    </time>
  );
}

export function TaskActivity({
  task,
  onComment,
  currentActorId,
  actorNames = {},
}: {
  task: ActivityTask;
  onComment: (text: string) => void;
  currentActorId?: string;
  actorNames?: Record<string, string>;
}) {
  const [draft, setDraft] = useState("");
  const actorLabel = (actorId?: string) =>
    !actorId || actorId === currentActorId ? "You" : (actorNames[actorId] ?? actorId);

  const activity = [...(task.activity ?? [])].sort((a, b) => a.at - b.at);
  const entries: TeamWorkActivity[] = activity.some((entry) => entry.kind === "created")
    ? activity
    : [
        {
          id: "created",
          kind: "created",
          at: task.createdAt ?? task.updatedAt,
          text: "created this task",
        },
        ...activity,
      ];

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onComment(text);
    setDraft("");
  };

  return (
    <section aria-labelledby="task-activity-heading" className="flex flex-col">
      <h3
        id="task-activity-heading"
        className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
      >
        Activity
      </h3>
      <ol className="relative ml-3 border-l border-slate-200 dark:border-slate-700">
        {entries.map((entry) => {
          const who = actorLabel(entry.actorId);
          return entry.kind === "comment" ? (
            <li key={entry.id} className="relative mb-4 flex gap-2 pl-5 last:mb-0">
              <span className="absolute -left-3.5 top-0">
                <Avatar name={who} />
              </span>
              <div className="ml-2 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="font-medium text-slate-900 dark:text-slate-100">{who}</span>
                  <When at={entry.at} />
                </div>
                <p className="whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-300">
                  {entry.text}
                </p>
              </div>
            </li>
          ) : (
            <li key={entry.id} className="relative mb-4 pl-5 text-sm last:mb-0">
              <span
                aria-hidden="true"
                className="absolute -left-[5px] top-1.5 size-2.5 rounded-full border-2 border-white bg-slate-400 dark:border-slate-900 dark:bg-slate-500"
              />
              <span className="font-medium text-slate-900 dark:text-slate-100">{who}</span>{" "}
              <span className="text-slate-600 dark:text-slate-300">{entry.text}</span>{" "}
              <When at={entry.at} />
            </li>
          );
        })}
      </ol>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        className="sticky bottom-0 mt-4 flex items-end gap-2 border-t border-slate-200 bg-white py-3 dark:border-slate-700 dark:bg-slate-950"
      >
        <Avatar name="You" />
        <textarea
          aria-label="Leave a comment"
          placeholder="Leave a comment"
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
          className="min-h-9 flex-1 resize-none rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:text-slate-100"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
        >
          Comment
        </button>
      </form>
    </section>
  );
}
