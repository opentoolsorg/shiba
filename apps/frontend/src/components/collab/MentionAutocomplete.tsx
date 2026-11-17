import { useState, type JSX, type KeyboardEvent, type RefObject } from "react";

export interface MentionMember { actorId: string; actorKind: "human" | "agent"; displayName: string; userId: string; status: "active" | "removed" }
export interface MentionOption { token: string; label: string; kind: "human" | "agent" }

const TRIGGER = /(^|\s)@([^\s@]*)$/;

/** The "@query" being typed right before the caret, or null. */
export function activeMention(text: string, caret: number): { start: number; query: string } | null {
  const match = TRIGGER.exec(text.slice(0, caret));
  return match ? { start: caret - match[2]!.length - 1, query: match[2]! } : null;
}

/** Active members matching the query. Tokens match what the server parses (@user:<email>, @agent:<id>). */
export function mentionOptions(members: MentionMember[], query: string, selfUserId: string, limit = 6): MentionOption[] {
  const q = query.toLowerCase().replace(/^(user|agent):/, "");
  return members
    .filter((member) => member.status === "active" && member.actorId.startsWith(member.actorKind === "agent" ? "agent:" : "human:") &&
      !(member.actorKind === "human" && member.userId === selfUserId) &&
      (member.displayName.toLowerCase().includes(q) || member.userId.toLowerCase().includes(q)))
    .map((member) => ({
      token: member.actorKind === "agent" ? `@agent:${member.actorId.slice("agent:".length)}` : `@user:${member.userId}`,
      label: member.displayName || member.userId,
      kind: member.actorKind,
    }))
    .slice(0, limit);
}

/** Wires a textarea to the menu: arrows move, Enter/Tab insert, Escape closes. */
export function useMentionAutocomplete(opts: {
  members: MentionMember[]; selfUserId: string; value: string; setValue: (value: string) => void; input: RefObject<HTMLTextAreaElement | null>;
}) {
  const { members, selfUserId, value, setValue, input } = opts;
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const mention = activeMention(value, caret);
  const options = mention && dismissed !== `${mention.start}:${value.length}` ? mentionOptions(members, mention.query, selfUserId) : [];
  const open = options.length > 0;
  const active = Math.min(index, Math.max(0, options.length - 1));
  const insert = (option: MentionOption) => {
    if (!mention) return;
    const next = `${value.slice(0, mention.start)}${option.token} ${value.slice(caret)}`;
    const position = mention.start + option.token.length + 1;
    setValue(next); setCaret(position); setIndex(0);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(position, position); });
  };
  return {
    open, options, active, insert,
    onChange: (next: string, position: number) => { setValue(next); setCaret(position); setIndex(0); setDismissed(null); },
    onSelect: (position: number) => setCaret(position),
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!open) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((active + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault(); insert(options[active]!);
      } else if (event.key === "Escape" && mention) {
        event.preventDefault(); setDismissed(`${mention.start}:${value.length}`);
      }
    },
  };
}

export function MentionMenu({ options, active, onPick }: { options: MentionOption[]; active: number; onPick: (option: MentionOption) => void }): JSX.Element | null {
  if (options.length === 0) return null;
  return (
    <ul role="listbox" aria-label="Mention suggestions" className="absolute bottom-full left-3 z-20 mb-1 w-64 border border-[var(--line)] bg-[var(--card)] text-sm shadow-sm">
      {options.map((option, i) => (
        <li key={option.token} role="option" aria-selected={i === active}>
          <button type="button" tabIndex={-1} onMouseDown={(event) => { event.preventDefault(); onPick(option); }}
            className={`flex min-h-9 w-full items-center justify-between gap-2 px-3 text-left ${i === active ? "bg-[var(--panel-2)]" : ""}`}>
            <span className="truncate">{option.label}</span>
            <span className="font-mono text-[10px] text-[var(--ink-2)]">{option.kind === "agent" ? "employee" : "member"}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
