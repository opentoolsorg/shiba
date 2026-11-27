import { Loader2, Plus } from "lucide-react";
import type React from "react";
import { useId, useRef, useState } from "react";
import type { WorkTaskPatch } from "../work-mutations";

export interface WorkQuickAddProps {
  /** Resolve `false` (or reject) to keep the draft; any other result clears it. `patch` carries only fields the user filled in. */
  onSubmit(text: string, patch?: WorkTaskPatch): void | boolean | Promise<boolean | void>;
  /** Team create only: enables optional assignee, reviewer, schedule and dependency fields. */
  fields?: { owners: readonly { id: string; name: string }[]; tasks: readonly { id: string; title: string }[] };
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  failureMessage?: string;
}

const detailLabel = "flex flex-col gap-1 text-xs text-[var(--muted-foreground-2)]";
const detailField =
  "min-h-11 w-full min-w-0 rounded-md border border-[var(--border-1)] bg-transparent px-2 text-[13px] text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-[var(--ring)] disabled:opacity-50 lg:min-h-8 dark:[color-scheme:dark]";

export function WorkQuickAdd({
  onSubmit,
  fields,
  disabled = false,
  placeholder = "Write a task…",
  className = "",
  "aria-label": ariaLabel,
  failureMessage = "Could not create the task. Your draft has been kept. Try again.",
}: WorkQuickAddProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState({ owner: "", reviewer: "", start: "", end: "", dependsOn: "" });
  const panelId = useId();

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    const patch: WorkTaskPatch = {
      ...(extra.owner ? { ownerId: extra.owner } : {}),
      ...(extra.reviewer ? { reviewerId: extra.reviewer } : {}),
      ...(extra.start ? { startDate: extra.start } : {}),
      ...(extra.end ? { endDate: extra.end } : {}),
      ...(extra.dependsOn ? { waitingOn: [extra.dependsOn] } : {}),
    };
    const clear = () => {
      setText("");
      setExtra({ owner: "", reviewer: "", start: "", end: "", dependsOn: "" });
    };
    try {
      const result = Object.keys(patch).length ? onSubmit(trimmed, patch) : onSubmit(trimmed);
      if (result instanceof Promise) {
        setPending(true);
        if ((await result) !== false) clear();
      } else if (result !== false) {
        clear();
      }
    } catch {
      setError(failureMessage);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  const Icon = pending ? Loader2 : Plus;

  return (
    <form
      aria-busy={pending}
      className={`rounded-2xl border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 shadow-[var(--sh-card)] ${className}`.trim()}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="block cursor-text">
        <span className="sr-only">{ariaLabel || placeholder}</span>
        {/* readOnly (not disabled) while pending so focus stays in the composer for the next task. */}
        <textarea
          value={text}
          rows={2}
          disabled={disabled}
          readOnly={pending}
          placeholder={placeholder}
          aria-label={ariaLabel || placeholder}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          className="min-h-12 w-full resize-none bg-transparent px-1 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none disabled:cursor-not-allowed read-only:text-zinc-500 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
      </label>
      <div className="flex min-h-11 items-center justify-between gap-2">
        <div className="min-w-0">
          {fields ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={open ? panelId : undefined}
              onClick={() => setOpen((value) => !value)}
              className="min-h-11 rounded-md px-2 text-xs text-[var(--muted-foreground-2)] underline-offset-4 hover:text-[var(--fg)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--ring)] lg:min-h-8"
            >
              {open ? "Hide details" : "Add details"}
            </button>
          ) : null}
        </div>
        <button
          type="submit"
          disabled={disabled || pending || !text.trim()}
          aria-label="Add task"
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-text)] transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-35"
        >
          <Icon
            className={`size-4 ${pending ? "motion-safe:animate-spin" : ""}`}
            aria-hidden="true"
          />
          <span className="sr-only">{pending ? "Adding task" : "Add task"}</span>
        </button>
      </div>
      {fields && open ? (
        <div id={panelId} className="grid gap-2 border-t border-[var(--border-1)] px-1 py-3 sm:grid-cols-2">
          <label className={detailLabel}>
            Assignee
            <select value={extra.owner} disabled={disabled} onChange={(e) => setExtra({ ...extra, owner: e.target.value })} className={detailField}>
              <option value="">Unassigned</option>
              {fields.owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
            </select>
          </label>
          <label className={detailLabel}>
            Reviewer
            <select value={extra.reviewer} disabled={disabled} onChange={(e) => setExtra({ ...extra, reviewer: e.target.value })} className={detailField}>
              <option value="">No reviewer</option>
              {fields.owners.map((reviewer) => <option key={reviewer.id} value={reviewer.id}>{reviewer.name}</option>)}
            </select>
          </label>
          <label className={detailLabel}>
            Depends on
            <select value={extra.dependsOn} disabled={disabled} onChange={(e) => setExtra({ ...extra, dependsOn: e.target.value })} className={detailField}>
              <option value="">No dependency</option>
              {fields.tasks.map((task) => <option key={task.id} value={task.id}>{task.title || "Untitled task"}</option>)}
            </select>
          </label>
          <label className={detailLabel}>
            Start date
            <input type="date" value={extra.start} max={extra.end || undefined} disabled={disabled} onChange={(e) => setExtra({ ...extra, start: e.target.value })} className={detailField} />
          </label>
          <label className={detailLabel}>
            End date
            <input type="date" value={extra.end} min={extra.start || undefined} disabled={disabled} onChange={(e) => setExtra({ ...extra, end: e.target.value })} className={detailField} />
          </label>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-[var(--destructive-fg)]">
          {error}
        </p>
      ) : null}
    </form>
  );
}
