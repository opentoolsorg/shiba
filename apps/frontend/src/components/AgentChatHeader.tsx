import { type JSX, useEffect, useId, useRef, useState } from "react";
import { ChevronRight, MoreHorizontal, PanelRight, Users } from "lucide-react";
import type { AgentMascotLook, CustomAgentMascotPreset } from "@shiba/shared";
import type { EmployeeRole } from "../employee-templates";
import { AgentAvatar } from "./AgentAvatar";

export type AgentChatParticipant = { id: string; name: string };
export type AgentChatMenuAction = { label: string; onSelect: () => void; destructive?: boolean };

const iconButton = "inline-flex min-h-9 min-w-9 items-center justify-center gap-1.5 rounded-lg px-2 text-sm text-[var(--muted-foreground-1)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]";
const popover = "absolute right-0 top-full z-20 mt-1 w-56 rounded-xl border border-[var(--border-1)] bg-[var(--popover)] p-1.5 text-sm text-[var(--fg)] shadow-overlay";

type OpenMenu = "actions" | "participants" | null;

export function AgentChatHeader({
  agent,
  participants,
  panelOpen,
  onTogglePanel,
  actions = [],
  workspaceLabel = "Workspace",
  onOpenAgents,
}: {
  agent: { id: string; name: string; role?: EmployeeRole; mascotPreset?: CustomAgentMascotPreset; look?: AgentMascotLook };
  participants: readonly AgentChatParticipant[];
  panelOpen: boolean;
  onTogglePanel: () => void;
  actions?: readonly AgentChatMenuAction[];
  workspaceLabel?: string;
  onOpenAgents?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState<OpenMenu>(null);
  const rootRef = useRef<HTMLElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      rootRef.current?.querySelector<HTMLButtonElement>(`[aria-controls="${id}-${open}"]`)?.focus();
      setOpen(null);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, id]);

  const toggle = (menu: Exclude<OpenMenu, null>) => setOpen((current) => (current === menu ? null : menu));
  const count = participants.length;

  return (
    <header ref={rootRef} className="flex min-h-14 items-center justify-between gap-3 border-b border-[var(--border-1)] bg-[var(--chrome)] px-4 py-2 sm:px-6">
      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="flex min-w-0 items-center gap-1.5 text-sm text-[var(--muted-foreground-2)]">
          <li className="hidden shrink-0 sm:block">{workspaceLabel}</li>
          <li aria-hidden="true" className="hidden sm:block"><ChevronRight className="size-3.5" /></li>
          <li className="shrink-0">
            {onOpenAgents ? (
              <button type="button" onClick={onOpenAgents} className="rounded hover:text-[var(--fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]">Agents</button>
            ) : "Agents"}
          </li>
          <li aria-hidden="true"><ChevronRight className="size-3.5" /></li>
          <li aria-current="page" className="flex min-w-0 items-center gap-2 font-medium text-[var(--fg)]">
            <AgentAvatar id={agent.id} name={agent.name} mascotPreset={agent.mascotPreset} look={agent.look} role={agent.role} size={20} decorative />
            <span className="truncate">{agent.name}</span>
          </li>
        </ol>
      </nav>
      <div className="flex shrink-0 items-center gap-1">
        {actions.length ? (
          <div className="relative">
            <button type="button" className={iconButton} aria-label="Conversation actions" aria-haspopup="menu" aria-expanded={open === "actions"} aria-controls={`${id}-actions`} onClick={() => toggle("actions")}>
              <MoreHorizontal aria-hidden="true" className="size-4" />
            </button>
            {open === "actions" ? (
              <div id={`${id}-actions`} role="menu" aria-label="Conversation actions" className={popover}>
                {actions.map((action) => (
                  <button key={action.label} type="button" role="menuitem" onClick={() => { setOpen(null); action.onSelect(); }} className={`flex w-full rounded-lg px-2.5 py-2 text-left hover:bg-[var(--secondary)] focus-visible:bg-[var(--secondary)] focus-visible:outline-none ${action.destructive ? "text-[var(--destructive)]" : ""}`}>
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="relative">
          <button type="button" className={`${iconButton} border border-[var(--border-1)]`} aria-label={`${count} ${count === 1 ? "participant" : "participants"}`} aria-expanded={open === "participants"} aria-controls={`${id}-participants`} onClick={() => toggle("participants")}>
            <Users aria-hidden="true" className="size-4" />
            <span className="tabular-nums text-xs">{count}</span>
          </button>
          {open === "participants" ? (
            <div id={`${id}-participants`} role="dialog" aria-label="Participants" className={`${popover} p-3`}>
              <p className="font-medium">Participants</p>
              <ul className="mt-2 space-y-2">
                {participants.map((participant) => (
                  <li key={participant.id} className="flex items-center gap-2">
                    <AgentAvatar id={participant.id} name={participant.name} mascotPreset={participant.id === agent.id ? agent.mascotPreset : undefined} look={participant.id === agent.id ? agent.look : undefined} size={20} decorative />
                    <span className="truncate">{participant.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <button type="button" className={iconButton} aria-label={panelOpen ? "Hide details panel" : "Show details panel"} aria-pressed={panelOpen} onClick={onTogglePanel}>
          <PanelRight aria-hidden="true" className="size-4" />
        </button>
      </div>
    </header>
  );
}
