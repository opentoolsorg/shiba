import { Command } from "cmdk";
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";
import { CommandDialog } from "../ui/command-menu";
import { BotRow, botOptionName } from "./BotRow";
import { detectPlatform, detectStandalone, jumpEventMatches, jumpKeyAria, jumpKeyLabel } from "./jump-keys";
import { pushRecent, readRecents } from "./palette-recents";
import { ChatResult, TaskResult } from "./ResultRow";
import { usePaletteBots, type PaletteBot } from "./usePaletteBots";
import { usePaletteSearch, type PaletteChatHit, type PaletteTaskHit } from "./usePaletteSearch";

export interface PaletteAction { id: string; label: string; hint?: string; run: () => void }
export interface PaletteSetting { id: string; label: string }

const itemClass = "min-h-11 w-full px-3 text-left data-[selected=true]:bg-[var(--primary-soft)]";

function matches(query: string, label: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = label.toLowerCase();
  if (hay.includes(q)) return true;
  let index = 0;
  for (const char of hay) if (char === q[index]) index += 1;
  return index === q.length;
}

function nextSlot(bots: PaletteBot[], bot: PaletteBot): number {
  if (bot.pinnedSlot) return bot.pinnedSlot;
  const used = new Set(bots.map((item) => item.pinnedSlot).filter((slot): slot is number => slot != null));
  for (let slot = 1; slot <= 9; slot += 1) if (!used.has(slot)) return slot;
  return 9;
}

export function CommandPalette({
  open, onClose, workspaceId, roomThreadOpen, needsYouCount, settings, extraActions = [],
  onNewTask, onNewChannel, onOpenBot, onOpenChat, onOpenTask, onOpenSettings, onOpenNeedsYou,
  onToggleTheme, onOpenShortcuts, onInsertAgentMention, onSearchAll, onMessageAbout,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string | null;
  roomThreadOpen: boolean;
  needsYouCount?: number | null;
  settings: PaletteSetting[];
  extraActions?: PaletteAction[];
  onNewTask: () => void;
  onNewChannel: () => void;
  onOpenBot: (bot: PaletteBot, focusComposer: boolean) => void;
  onOpenChat: (hit: PaletteChatHit) => void;
  onOpenTask: (hit: PaletteTaskHit) => void;
  onOpenSettings: (sectionId: string) => void;
  onOpenNeedsYou: () => void;
  onToggleTheme: () => void;
  onOpenShortcuts: () => void;
  onInsertAgentMention: (agentId: string) => void;
  onSearchAll: (query: string) => void;
  onMessageAbout: (bot: PaletteBot, query: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState<null | "dm" | "mention" | "about">(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [needs, setNeeds] = useState<number | null>(needsYouCount ?? null);
  const [menu, setMenu] = useState<{ id: string; slot: number } | null>(null);
  const [live, setLive] = useState("");
  const modifier = useRef(false);
  const { bots, refresh } = usePaletteBots(workspaceId, open);
  const search = usePaletteSearch(workspaceId, query, open && !pick);
  const platform = detectPlatform();
  const standalone = detectStandalone();
  const trimmed = query.trim();

  useEffect(() => { if (!open) { setQuery(""); setPick(null); setMenu(null); } }, [open]);
  useEffect(() => { if (open && workspaceId) setRecents(readRecents(workspaceId)); }, [open, workspaceId]);
  useEffect(() => { setNeeds(needsYouCount ?? null); }, [needsYouCount]);
  useEffect(() => {
    if (!open || !workspaceId || needsYouCount != null) return;
    let cancelled = false;
    void fetch("/api/needs-you", { credentials: "same-origin", headers: teamWorkspaceHeaders(workspaceId) })
      .then((response) => response.ok ? response.json() : null)
      .then((body: { approvals?: unknown[]; questions?: unknown[]; mentions?: unknown[]; handoffs?: unknown[]; blocked?: unknown[] } | null) => {
        if (cancelled || !body) return;
        setNeeds((body.approvals?.length ?? 0) + (body.questions?.length ?? 0) + (body.mentions?.length ?? 0) + (body.handoffs?.length ?? 0) + (body.blocked?.length ?? 0));
      }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [needsYouCount, open, workspaceId]);

  const actions = useMemo<PaletteAction[]>(() => [
    { id: "new-task", label: "New task…", run: onNewTask },
    { id: "new-channel", label: "New channel", run: onNewChannel },
    { id: "message-bot", label: "Message @bot…", run: () => setPick("dm") },
    ...(roomThreadOpen ? [{ id: "mention-thread", label: "@bot in this thread", run: () => setPick("mention") }] : []),
    { id: "needs-you", label: `Open Needs you${needs == null ? "" : ` (${needs})`}`, run: onOpenNeedsYou },
    { id: "theme", label: "Toggle theme", run: onToggleTheme },
    { id: "shortcuts", label: "Keyboard shortcuts", run: onOpenShortcuts },
    ...(trimmed ? extraActions : []),
  ], [extraActions, needs, onNewChannel, onNewTask, onOpenNeedsYou, onOpenShortcuts, onToggleTheme, roomThreadOpen, trimmed]);

  const remember = (id: string) => { if (workspaceId) setRecents(pushRecent(workspaceId, id)); };
  const openBot = (bot: PaletteBot, focus: boolean) => {
    remember(`bot:${bot.agentId}`);
    if (pick === "mention") { onInsertAgentMention(bot.agentId); setPick(null); onClose(); return; }
    if (pick === "about") { onMessageAbout(bot, trimmed); onClose(); return; }
    onOpenBot(bot, focus || pick === "dm");
    onClose();
  };
  const pin = async (bot: PaletteBot) => {
    if (!workspaceId) return;
    const slot = nextSlot(bots, bot);
    await fetch(`/api/palette/pins/${slot}`, {
      method: "PUT", credentials: "same-origin",
      headers: { "content-type": "application/json", ...teamWorkspaceHeaders(workspaceId) },
      body: JSON.stringify({ actorId: bot.actorId }),
    });
    setMenu(null);
    await refresh();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      for (let slot = 1; slot <= 9; slot += 1) {
        if (!jumpEventMatches(event, slot, platform, standalone)) continue;
        const bot = bots.find((item) => item.pinnedSlot === slot);
        if (!bot) return;
        event.preventDefault();
        onOpenBot(bot, true);
        return;
      }
      if (!open || !event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "p") return;
      const selected = document.querySelector<HTMLElement>("[role='option'][aria-selected='true']");
      const bot = bots.find((item) => selected?.dataset.agent === item.agentId);
      if (!bot) return;
      event.preventDefault();
      void pin(bot);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const visibleBots = bots.filter((bot) => !trimmed || matches(trimmed, `${bot.name} ${bot.preview ?? ""}`));
  const visibleSettings = trimmed ? settings.filter((item) => matches(trimmed, item.label)) : [];
  const visibleActions = actions.filter((item) => !trimmed || matches(trimmed, item.label));
  const recentRows = trimmed ? [] : recents;
  const count = (pick ? visibleBots.length : visibleBots.length + (trimmed ? search.chats.length + search.tasks.length : 0) + visibleSettings.length + visibleActions.length + recentRows.length);
  useEffect(() => {
    const timer = window.setTimeout(() => setLive(`${count} results`), 500);
    return () => window.clearTimeout(timer);
  }, [count]);

  const onTab = (event: ReactKeyboardEvent) => {
    if (event.key !== "Tab") return;
    const options = [...event.currentTarget.querySelectorAll<HTMLElement>("[role='option']")];
    const current = Math.max(0, options.findIndex((option) => option.getAttribute("aria-selected") === "true"));
    const group = options[current]?.dataset.group;
    const next = options.find((option, index) => index > current && option.dataset.group !== group) ?? options.find((option) => option.dataset.group !== group);
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.click();
  };

  const empty = trimmed.length >= 2 && !pick && !search.loading && visibleBots.length + visibleSettings.length + visibleActions.length + search.chats.length + search.tasks.length === 0;

  return (
    <CommandDialog open={open} onClose={onClose} wide label="Search">
      <Command key={trimmed ? "query" : visibleBots[0]?.agentId ?? "empty"} label="Search bots, chats, tasks, settings" shouldFilter loop onKeyDownCapture={(event) => { if (event.key === "Enter") modifier.current = event.metaKey || event.ctrlKey; }}>
        <Command.Input autoFocus placeholder="Search bots, chats, tasks, settings…" value={query} onValueChange={setQuery} className="w-full bg-transparent px-4 py-3 text-base text-[var(--fg)] placeholder:text-[var(--muted-foreground-2)] border-b border-[var(--border-1)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-[var(--primary)]" />
        <Command.List className="max-h-96 overflow-y-auto py-1.5" onKeyDown={onTab}>
          {pick ? <p className="px-4 py-2 text-xs text-[var(--muted-foreground-2)]">Choose a bot</p> : null}
          <Group id="palette-bots" title={pick ? "Bots" : "Bots"} show={visibleBots.length > 0}>
            {visibleBots.map((bot) => (
              <Command.Item key={bot.agentId} value={`bot ${bot.name}`} data-group="bots" data-agent={bot.agentId} className={itemClass} aria-label={botOptionName(bot)} aria-keyshortcuts={bot.pinnedSlot ? jumpKeyAria(bot.pinnedSlot, platform, standalone) : undefined} onContextMenu={(event) => { event.preventDefault(); setMenu({ id: bot.agentId, slot: nextSlot(bots, bot) }); }} onSelect={() => { const focus = modifier.current; modifier.current = false; openBot(bot, focus); }}>
                <BotRow bot={bot} shortcut={bot.pinnedSlot ? jumpKeyLabel(bot.pinnedSlot, platform, standalone) : null} />
              </Command.Item>
            ))}
          </Group>
          {!pick && trimmed ? <Group id="palette-chats" title="Chats & threads" show={search.chats.length > 0} force>
            {search.chats.map((hit) => <Command.Item key={`${hit.roomId}:${hit.messageId ?? "room"}`} forceMount value={`chat ${hit.roomId}`} data-group="chats" className={itemClass} onSelect={() => { remember(`chat:${hit.roomId}`); onOpenChat(hit); onClose(); }}><ChatResult hit={hit} query={trimmed} /></Command.Item>)}
          </Group> : null}
          {!pick && trimmed ? <Group id="palette-tasks" title="Tasks" show={search.tasks.length > 0} force>
            {search.tasks.map((hit) => <Command.Item key={hit.taskId} forceMount value={`task ${hit.taskId}`} data-group="tasks" className={itemClass} onSelect={() => { remember(`task:${hit.taskId}`); onOpenTask(hit); onClose(); }}><TaskResult hit={hit} /></Command.Item>)}
          </Group> : null}
          {!pick ? <Group id="palette-settings" title="Settings" show={visibleSettings.length > 0}>
            {visibleSettings.map((item) => <Command.Item key={item.id} value={`settings ${item.label}`} data-group="settings" className={itemClass} onSelect={() => { remember(`settings:${item.id}`); onOpenSettings(item.id); onClose(); }}>{item.label}</Command.Item>)}
          </Group> : null}
          {!pick && !trimmed ? <Group id="palette-recent" title="Recent" show={recentRows.length > 0}>
            {recentRows.map((id) => <Command.Item key={id} value={`recent ${id}`} data-group="recent" className={itemClass} onSelect={() => { remember(id); onClose(); }}>{id}</Command.Item>)}
          </Group> : null}
          {!pick ? <Group id="palette-actions" title="Actions" show={visibleActions.length > 0}>
            {visibleActions.map((item) => <Command.Item key={item.id} value={item.label} data-group="actions" className={itemClass} onSelect={() => { remember(`action:${item.id}`); item.run(); if (item.id !== "message-bot" && item.id !== "mention-thread") onClose(); }}>{item.label}</Command.Item>)}
          </Group> : null}
          {search.skeleton ? <div data-testid="palette-skeleton" aria-hidden="true"><div className="min-h-11" /><div className="min-h-11" /></div> : null}
          {search.unavailable ? <p className="px-4 py-2 text-xs text-[var(--muted-foreground-2)]">Message search is unavailable right now</p> : null}
          {empty ? <div className="px-4 py-4 text-sm text-[var(--muted-foreground-2)]"><p>No matches for ‘{trimmed}’.</p><button type="button" className="min-h-11" onClick={() => { onSearchAll(trimmed); onClose(); }}>Search all messages for ‘{trimmed}’</button><button type="button" className="min-h-11" onClick={() => setPick("about")}>Message @bot about ‘{trimmed}’</button></div> : null}
        </Command.List>
        <div aria-live="polite" className="sr-only">{live}</div>
        {menu ? <button type="button" className="min-h-11 w-full border-t border-[var(--border-1)] px-4 text-left text-sm" onClick={() => { const bot = bots.find((item) => item.agentId === menu.id); if (bot) void pin(bot); }}>Pin to {menu.slot}</button> : null}
      </Command>
    </CommandDialog>
  );
}

function Group({ id, title, show, force = false, children }: { id: string; title: string; show: boolean; force?: boolean; children: ReactNode }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("[role='group']")?.setAttribute("aria-labelledby", id);
  });
  if (!show) return null;
  return (
    <Command.Group ref={ref} forceMount={force}>
      <h2 id={id} className="px-3 text-xs font-medium text-[var(--muted-foreground-2)]">{title}</h2>
      {children}
    </Command.Group>
  );
}
