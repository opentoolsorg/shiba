import { type ComponentProps, type JSX, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { EmployeeRole } from "../employee-templates";
import { AgentAvatar } from "./AgentAvatar";
import { ChatMessageComposer } from "./ChatMessageComposer";

export type MentionableAgent = { id: string; name: string; role?: EmployeeRole };

type ComposerProps = Omit<ComponentProps<typeof ChatMessageComposer>, "agentName" | "onMention" | "mentionOpen" | "textareaRef" | "children" | "placeholder">;

export function AgentComposerShell({ agentName, agents, ...composer }: ComposerProps & { agentName: string; agents: readonly MentionableAgent[] }): JSX.Element {
  const [mentionAt, setMentionAt] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const { value, onChange } = composer;

  useEffect(() => {
    if (mentionAt === null) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      const mentionButton = menuRef.current?.parentElement?.querySelector('[aria-label="Mention"]');
      // The Mention button toggles the menu itself; closing here too would reopen it with a second "@".
      if (!menuRef.current?.contains(target) && !mentionButton?.contains(target)) setMentionAt(null);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [mentionAt]);

  const placeCaret = (position: number) => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(position, position);
    });
  };

  const openMention = () => {
    if (mentionAt !== null) {
      setMentionAt(null);
      return;
    }
    const at = textareaRef.current?.selectionStart ?? value.length;
    onChange(`${value.slice(0, at)}@${value.slice(at)}`);
    setMentionAt(at);
  };

  const closeMention = () => {
    if (mentionAt !== null) placeCaret(mentionAt + 1);
    setMentionAt(null);
  };

  const choose = (agent: MentionableAgent) => {
    if (mentionAt === null) return;
    const token = `@${agent.name} `;
    // Replaces the "@" openMention inserted; the menu closes on any outside pointer, so it is still there.
    onChange(`${value.slice(0, mentionAt)}${token}${value.slice(mentionAt + 1)}`);
    placeCaret(mentionAt + token.length);
    setMentionAt(null);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      closeMention();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    }
  };

  return (
    <ChatMessageComposer
      {...composer}
      agentName={agentName}
      textareaRef={textareaRef}
      onMention={openMention}
      mentionOpen={mentionAt !== null}
    >
      {mentionAt !== null ? (
        <div ref={menuRef} id={menuId} role="menu" aria-label="Mention an agent" onKeyDown={onMenuKeyDown} className="absolute bottom-full left-3 z-20 mb-2 max-h-64 w-64 max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-[var(--border-1)] bg-[var(--popover)] p-1.5 text-sm text-[var(--fg)] shadow-overlay">
          {agents.length ? agents.map((agent) => (
            <button key={agent.id} type="button" role="menuitem" onClick={() => choose(agent)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--secondary)] focus-visible:bg-[var(--secondary)] focus-visible:outline-none">
              <AgentAvatar id={agent.id} name={agent.name} role={agent.role} size={20} decorative />
              <span className="truncate">{agent.name}</span>
            </button>
          )) : <p className="px-2.5 py-2 text-[var(--muted-foreground-2)]">No agents to mention</p>}
        </div>
      ) : null}
    </ChatMessageComposer>
  );
}
