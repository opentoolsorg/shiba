import { Loader2, Plus } from "lucide-react";
import type React from "react";
import { useId, useRef, useState } from "react";
import type { WorkTaskPatch } from "../work-mutations";

export interface WorkQuickAddProps {
  /** Resolve `false` (or reject) to keep the draft; any other result clears it. `patch` carries only fields the user filled in. */
  onSubmit(text: string, patch?: WorkTaskPatch): void | boolean | Promise<boolean | void>;
  /** Team create only: enables the optional assignee, schedule and dependency fields. */
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
  placeholder = "Add a task and press Enter",
  className = "",
  "aria-label": ariaLabel,
  failureMessage = "Could not create the task. Your draft has been kept. Try again.",
}: WorkQuickAddProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState({ owner: "", start: "", end: "", dependsOn: "" });
  const panelId = useId();

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    const patch: WorkTaskPatch = {
      ...(extra.owner ? { ownerId: extra.owner } : {}),
      ...(extra.start ? { startDate: extra.start } : {}),
      ...(extra.end ? { endDate: extra.end } : {}),
      ...(extra.dependsOn ? { waitingOn: [extra.dependsOn] } : {}),
    };
    const clear = () => {
      setText("");
      setExtra({ owner: "", start: "", end: "", dependsOn: "" });
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
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
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label
        className={`w-full flex items-center gap-2 px-2.5 min-h-11 lg:min-h-8 border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg bg-transparent transition-colors hover:border-zinc-400 dark:hover:border-zinc-600 focus-within:border-solid focus-within:border-zinc-400 dark:focus-within:border-zinc-500 ${
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-text"
        } ${className}`.trim()}
      >
        <Icon
          className={`w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 shrink-0 ${pending ? "motion-safe:animate-spin" : ""}`}
          aria-hidden="true"
        />
        {/* readOnly (not disabled) while pending so focus stays in the bar for the next task. */}
        <input
          type="text"
          value={text}
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
          className="w-full bg-transparent text-xs sm:text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none disabled:cursor-not-allowed read-only:text-zinc-500"
        />
        {pending ? <span className="sr-only">Adding task</span> : null}
      </label>
      {fields ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen((value) => !value)}
            className="mt-1 min-h-11 px-1 text-xs text-[var(--muted-foreground-2)] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--ring)] lg:min-h-8"
          >
            {open ? "Hide details" : "Add details"}
          </button>
          {open ? <div id={panelId} className="grid gap-2 pb-1 sm:grid-cols-2">
            <label className={detailLabel}>
              Assignee
              <select value={extra.owner} disabled={disabled} onChange={(e) => setExtra({ ...extra, owner: e.target.value })} className={detailField}>
                <option value="">Unassigned</option>
                {fields.owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
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
          </div> : null}
        </>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-[var(--destructive-fg)]">
          {error}
        </p>
      ) : null}
    </form>
  );
}
