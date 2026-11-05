import { Check, FileText, Link2, MessageSquare, Plus, StickyNote, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import type { TeamWorkItem } from "../team-work-items";
import type { WorkTaskPatch } from "../work-mutations";

type ContextKind = "file" | "note" | "chat" | "link";

// Stored as plain strings: context as "kind:value", done-when as markdown task-list items.
const NOTE_KIND = { kind: "note" as const, label: "Note", icon: StickyNote };
const CONTEXT_KINDS: { kind: ContextKind; label: string; icon: typeof FileText }[] = [
  { kind: "file", label: "File", icon: FileText },
  NOTE_KIND,
  { kind: "chat", label: "Chat", icon: MessageSquare },
  { kind: "link", label: "Link", icon: Link2 },
];

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function parseContextItem(raw: string): { kind: ContextKind; value: string } {
  const match = /^(file|note|chat|link):([\s\S]*)$/.exec(raw);
  if (match) return { kind: match[1] as ContextKind, value: match[2] ?? "" };
  return { kind: SAFE_URL.test(raw) ? "link" : "note", value: raw };
}

export function parseCondition(raw: string): { done: boolean; text: string } {
  const match = /^\[( |x|X)\] ([\s\S]*)$/.exec(raw);
  return match ? { done: match[1] !== " ", text: match[2] ?? "" } : { done: false, text: raw };
}

const condition = (done: boolean, text: string) => `[${done ? "x" : " "}] ${text}`;

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g;

function renderInline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${i}-${part}`;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return (
        <code key={key} className="rounded bg-zinc-100 dark:bg-zinc-800 px-1 text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2)
      return <em key={key}>{part.slice(1, -1)}</em>;
    const [, label, href = ""] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part) ?? [];
    if (label && SAFE_URL.test(href))
      return (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="underline">
          {label}
        </a>
      );
    return part;
  });
}

/** Renders a small markdown subset to React nodes; raw input never reaches innerHTML. */
export function MarkdownPreview({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length)
      blocks.push(<p key={`p${blocks.length}`}>{renderInline(paragraph.join(" "))}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, i) => <li key={`${i}-${item}`}>{renderInline(item)}</li>);
    blocks.push(
      list.ordered ? (
        <ol key={`l${blocks.length}`} className="list-decimal pl-5">
          {items}
        </ol>
      ) : (
        <ul key={`l${blocks.length}`} className="list-disc pl-5">
          {items}
        </ul>
      ),
    );
    list = null;
  };
  for (const line of source.split("\n")) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(
        <p key={`h${blocks.length}`} className="font-semibold">
          {renderInline(heading[2] ?? "")}
        </p>,
      );
    } else if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)?.[1] ?? "");
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return <div className="flex flex-col gap-2 break-words">{blocks}</div>;
}

const LABEL = "text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400";
const ADD_BUTTON =
  "inline-flex items-center gap-1.5 min-h-11 sm:min-h-8 rounded-md px-2 text-sm text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 transition-colors motion-reduce:transition-none";
const ICON_BUTTON =
  "inline-flex items-center justify-center shrink-0 w-11 h-11 sm:w-7 sm:h-7 rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400";
const INPUT =
  "min-h-11 sm:min-h-8 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-transparent px-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400";
const ROW =
  "group flex items-center gap-2 rounded-md px-2 text-sm text-zinc-800 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800/60";

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <h3 id={id} className={LABEL}>
          {title}
        </h3>
        {hint ? <span className="text-xs text-zinc-400 dark:text-zinc-500">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

export interface TaskDetailSectionsProps {
  task: TeamWorkItem;
  onChange: (patch: WorkTaskPatch) => void;
  /** Candidate blockers; the current task and archived tasks are excluded. */
  tasks?: readonly TeamWorkItem[];
}

export function TaskDetailSections({ task, onChange, tasks = [] }: TaskDetailSectionsProps) {
  return (
    <div className="flex flex-col gap-6">
      <ObjectiveSection task={task} onChange={onChange} />
      <WaitingOnSection task={task} onChange={onChange} tasks={tasks} />
      <ContextSection task={task} onChange={onChange} />
      <DoneWhenSection task={task} onChange={onChange} />
    </div>
  );
}

function ObjectiveSection({ task, onChange }: Omit<TaskDetailSectionsProps, "tasks">) {
  const objective = task.objective ?? "";
  // Draft is keyed by task id so switching tasks never leaks an unsaved edit.
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const cancelled = useRef(false);
  const editing = draft?.id === task.id;
  const commit = () => {
    if (editing && !cancelled.current && draft.text !== objective)
      onChange({ objective: draft.text });
    cancelled.current = false;
    setDraft(null);
  };
  return (
    <Section title="Objective" hint="The outcome, not the steps">
      {editing || !objective ? (
        <textarea
          aria-label="Objective"
          // biome-ignore lint/a11y/noAutofocus: focus follows the explicit "Edit objective" action
          autoFocus={editing && objective !== ""}
          value={editing ? draft.text : objective}
          placeholder="Describe what a good result looks like. Markdown works."
          rows={4}
          onFocus={() => {
            if (!editing) setDraft({ id: task.id, text: objective });
          }}
          onChange={(event) => setDraft({ id: task.id, text: event.target.value })}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              cancelled.current = true;
              setDraft(null);
              event.currentTarget.blur();
            }
          }}
          className={`${INPUT} min-h-24 resize-y py-2 leading-relaxed`}
        />
      ) : (
        <div className="group relative rounded-md px-2 py-1 text-sm leading-relaxed text-zinc-800 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
          <MarkdownPreview source={objective} />
          <button
            type="button"
            onClick={() => setDraft({ id: task.id, text: objective })}
            className={`${ADD_BUTTON} mt-1`}
          >
            Edit objective
          </button>
        </div>
      )}
    </Section>
  );
}

function WaitingOnSection({ task, onChange, tasks = [] }: TaskDetailSectionsProps) {
  const [picking, setPicking] = useState(false);
  const waitingOn = task.waitingOn ?? [];
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const candidates = tasks.filter(
    (item) => item.id !== task.id && !item.archived && !waitingOn.includes(item.id),
  );
  return (
    <Section title="Waiting on">
      {waitingOn.length ? (
        <ul className="flex flex-col">
          {waitingOn.map((id) => {
            const title = byId.get(id)?.title ?? "Unavailable task";
            return (
              <li key={id} className={ROW}>
                <span className="flex-1 truncate">{title}</span>
                <button
                  type="button"
                  aria-label={`Stop waiting on ${title}`}
                  onClick={() => onChange({ waitingOn: waitingOn.filter((item) => item !== id) })}
                  className={ICON_BUTTON}
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {picking ? (
        candidates.length ? (
          <select
            aria-label="Task to wait on"
            // biome-ignore lint/a11y/noAutofocus: opened by an explicit click on "Wait on a task"
            autoFocus
            defaultValue=""
            onChange={(event) => {
              if (event.target.value) onChange({ waitingOn: [...waitingOn, event.target.value] });
              setPicking(false);
            }}
            onBlur={() => setPicking(false)}
            onKeyDown={(event) => event.key === "Escape" && setPicking(false)}
            className={INPUT}
          >
            <option value="" disabled>
              Choose a task
            </option>
            {candidates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        ) : (
          <p className="px-2 text-sm text-zinc-500 dark:text-zinc-400">
            No other open tasks to wait on.
          </p>
        )
      ) : (
        <button
          type="button"
          onClick={() => setPicking(true)}
          className={`${ADD_BUTTON} self-start`}
        >
          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
          Wait on a task
        </button>
      )}
    </Section>
  );
}

function ContextSection({ task, onChange }: Omit<TaskDetailSectionsProps, "tasks">) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<ContextKind>("note");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const context = task.context ?? [];
  const reset = () => {
    setAdding(false);
    setValue("");
    setError(null);
  };
  const add = () => {
    const text = value.trim();
    if (!text) return;
    if (kind === "link" && !/^https?:\/\//i.test(text)) {
      setError("Links must start with http:// or https://");
      return;
    }
    onChange({ context: [...context, `${kind}:${text}`] });
    reset();
  };
  return (
    <Section title="Context">
      {context.length ? (
        <ul className="flex flex-col">
          {context.map((raw, index) => {
            const item = parseContextItem(raw);
            const meta = CONTEXT_KINDS.find((entry) => entry.kind === item.kind) ?? NOTE_KIND;
            const Icon = meta.icon;
            return (
              <li key={`${index}-${raw}`} className={ROW}>
                <Icon className="w-4 h-4 shrink-0 text-zinc-400" aria-label={meta.label} />
                {item.kind === "link" && SAFE_URL.test(item.value) ? (
                  <a
                    href={item.value}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 truncate underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 rounded"
                  >
                    {item.value}
                  </a>
                ) : (
                  <span className="flex-1 truncate">{item.value}</span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${meta.label.toLowerCase()} ${item.value}`}
                  onClick={() => onChange({ context: context.filter((_, i) => i !== index) })}
                  className={ICON_BUTTON}
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {adding ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <fieldset className="flex flex-wrap gap-1">
            <legend className="sr-only">Context type</legend>
            {CONTEXT_KINDS.map(({ kind: option, label, icon: Icon }) => (
              <button
                key={option}
                type="button"
                aria-pressed={kind === option}
                onClick={() => {
                  setKind(option);
                  setError(null);
                }}
                className={`${ADD_BUTTON} ${kind === option ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100" : ""}`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                {label}
              </button>
            ))}
          </fieldset>
          <input
            aria-label={`${CONTEXT_KINDS.find((entry) => entry.kind === kind)?.label} context`}
            // biome-ignore lint/a11y/noAutofocus: opened by an explicit click on "Add file, note, chat or link"
            autoFocus
            value={value}
            placeholder={
              kind === "link"
                ? "https://"
                : kind === "file"
                  ? "File name or path"
                  : kind === "chat"
                    ? "Chat title or reference"
                    : "Write a note"
            }
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => event.key === "Escape" && reset()}
            className={INPUT}
          />
          {error ? (
            <p role="alert" className="text-sm text-[var(--destructive-fg)]">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!value.trim()}
              className={`${ADD_BUTTON} disabled:opacity-50`}
            >
              Add
            </button>
            <button type="button" onClick={reset} className={ADD_BUTTON}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`${ADD_BUTTON} self-start`}
        >
          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
          Add file, note, chat or link
        </button>
      )}
    </Section>
  );
}

function DoneWhenSection({ task, onChange }: Omit<TaskDetailSectionsProps, "tasks">) {
  const [value, setValue] = useState("");
  const doneWhen = task.doneWhen ?? [];
  const add = () => {
    const text = value.trim();
    if (!text) return;
    onChange({ doneWhen: [...doneWhen, condition(false, text)] });
    setValue("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    } else if (event.key === "Escape") setValue("");
  };
  return (
    <Section title="Done when">
      {doneWhen.length ? (
        <ul className="flex flex-col">
          {doneWhen.map((raw, index) => {
            const item = parseCondition(raw);
            return (
              <li key={`${index}-${raw}`} className={ROW}>
                <label className="flex flex-1 items-center gap-2 min-h-11 sm:min-h-8 cursor-pointer min-w-0">
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={() =>
                      onChange({
                        doneWhen: doneWhen.map((entry, i) =>
                          i === index ? condition(!item.done, item.text) : entry,
                        ),
                      })
                    }
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className="flex items-center justify-center w-4 h-4 shrink-0 rounded border border-zinc-300 dark:border-zinc-600 peer-checked:bg-zinc-900 peer-checked:border-zinc-900 dark:peer-checked:bg-zinc-100 dark:peer-checked:border-zinc-100 peer-focus-visible:ring-2 peer-focus-visible:ring-zinc-400 text-white dark:text-zinc-900"
                  >
                    {item.done ? <Check className="w-3 h-3" /> : null}
                  </span>
                  <span
                    className={`truncate ${item.done ? "line-through text-zinc-400 dark:text-zinc-500" : ""}`}
                  >
                    {item.text}
                  </span>
                </label>
                <button
                  type="button"
                  aria-label={`Remove condition ${item.text}`}
                  onClick={() => onChange({ doneWhen: doneWhen.filter((_, i) => i !== index) })}
                  className={ICON_BUTTON}
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex items-center gap-2 px-2">
        <Plus className="w-3.5 h-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
        <input
          aria-label="Add a condition"
          value={value}
          placeholder="Add a condition"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={add}
          className="min-h-11 sm:min-h-8 w-full bg-transparent text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 rounded"
        />
      </div>
    </Section>
  );
}
