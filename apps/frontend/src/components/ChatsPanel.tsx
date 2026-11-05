import { useMemo, useState, type JSX } from "react";
import { Bell, Hash, MessageSquare, Plus, Search, X } from "lucide-react";
import {
  ContextPanel,
  PanelGroup,
  PanelIconButton,
  type Scope,
} from "./ui/ContextPanel";
import { type SessionItem, statusDotClass } from "./SessionsSidebar";
import { Tooltip } from "./Tooltip";

export interface TeamRoomItem {
  id: string;
  title: string;
  updatedAt?: number;
  unread?: boolean;
  status?: string;
}

export interface ChannelItem {
  id: string;
  title: string;
  visibility?: "private" | "shared";
  memberCount?: number;
}

export interface ActivityItem {
  id: string;
  title: string;
  timestamp?: number;
  description?: string;
}

export interface ChatsPanelProps {
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  active: string;
  onSelect: (id: string) => void;
  sessions?: SessionItem[];
  onNewChat?: () => void;

  // Workspace data props
  teamRooms?: TeamRoomItem[];
  onSelectTeamRoom?: (id: string) => void;
  onNewTeamRoom?: () => void;

  channels?: ChannelItem[];
  onSelectChannel?: (id: string) => void;
  onNewChannel?: () => void;

  activityItems?: ActivityItem[];
  onSelectActivity?: (id: string) => void;

  onSearchClick?: () => void;
  className?: string;
}

/**
 * ChatsPanel — Contextual secondary panel (~265px) for the Chats destination.
 *
 * Header: Title "Chats", search toggle, and "+ New chat" action.
 * Scope switch: Personal | Workspace.
 * Personal scope:
 *   - "Recents" (SessionItem list from SessionsSidebar), empty text "No personal chats yet".
 * Workspace scope:
 *   - "Chats" (team rooms/handoffs).
 *   - "Channels" (collaboration rooms with "+" action to create rooms).
 *   - "Activity" (activity feed, else bell + "No activity yet.").
 */
export function ChatsPanel({
  scope,
  onScopeChange,
  active,
  onSelect,
  sessions = [],
  onNewChat,
  teamRooms = [],
  onSelectTeamRoom,
  onNewTeamRoom,
  channels = [],
  onSelectChannel,
  onNewChannel,
  activityItems = [],
  onSelectActivity,
  onSearchClick,
  className = "",
}: ChatsPanelProps): JSX.Element {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  const handleSearchToggle = () => {
    if (onSearchClick) {
      onSearchClick();
      return;
    }
    setIsSearchOpen((prev) => !prev);
  };

  const normalizedQuery = query.trim().toLowerCase();

  const filteredSessions = useMemo(() => {
    if (!normalizedQuery) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(normalizedQuery) ||
        s.repoName.toLowerCase().includes(normalizedQuery),
    );
  }, [sessions, normalizedQuery]);

  const filteredTeamRooms = useMemo(() => {
    if (!normalizedQuery) return teamRooms;
    return teamRooms.filter((r) => r.title.toLowerCase().includes(normalizedQuery));
  }, [teamRooms, normalizedQuery]);

  const filteredChannels = useMemo(() => {
    if (!normalizedQuery) return channels;
    return channels.filter((c) => c.title.toLowerCase().includes(normalizedQuery));
  }, [channels, normalizedQuery]);

  const filteredActivity = useMemo(() => {
    if (!normalizedQuery) return activityItems;
    return activityItems.filter(
      (a) =>
        a.title.toLowerCase().includes(normalizedQuery) ||
        (a.description && a.description.toLowerCase().includes(normalizedQuery)),
    );
  }, [activityItems, normalizedQuery]);

  const headerActions = (
    <>
      <PanelIconButton label="Search chats" onClick={handleSearchToggle}>
        <Search className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </PanelIconButton>
      {onNewChat ? (
        <PanelIconButton label="New chat" onClick={onNewChat}>
          <Plus className="size-4" strokeWidth={1.75} aria-hidden="true" />
        </PanelIconButton>
      ) : null}
    </>
  );

  return (
    <ContextPanel
      title="Chats"
      actions={headerActions}
      scope={scope}
      onScopeChange={onScopeChange}
      className={className}
    >
      {/* Search Input Bar */}
      {isSearchOpen || query ? (
        <div className="px-1 pb-2 pt-0.5 shrink-0">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-[#71717a] dark:text-zinc-400 pointer-events-none"
              strokeWidth={1.75}
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats…"
              aria-label="Search chats"
              // biome-ignore lint/a11y/noAutofocus: field is revealed by an explicit user action
              autoFocus
              className="w-full h-7 bg-[#f4f4f5] dark:bg-zinc-800/60 rounded-md pl-7 pr-6 text-[12px] text-[#0a0a0a] dark:text-zinc-100 placeholder:text-[#a1a1aa] focus:outline-none focus:ring-1 focus:ring-zinc-400"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 text-xs"
              >
                <X className="size-3" strokeWidth={2} />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Scope: Personal */}
      {scope === "personal" ? (
        <PanelGroup
          label="Recents"
          emptyText={normalizedQuery ? "No chats match your search" : "No personal chats yet"}
          action={
            onNewChat ? (
              <PanelIconButton label="New chat" onClick={onNewChat}>
                <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
              </PanelIconButton>
            ) : undefined
          }
        >
          {filteredSessions.map((session) => {
            const isSelected = session.id === active;
            return (
              <button
                key={session.id}
                type="button"
                onClick={() => onSelect(session.id)}
                aria-current={isSelected ? "page" : undefined}
                className={`group w-full text-left rounded-lg px-2.5 py-1.5 flex items-center gap-2.5 transition-colors ${
                  isSelected
                    ? "bg-[#e4e4e7] dark:bg-zinc-800 text-[#0a0a0a] dark:text-zinc-100 font-medium"
                    : "hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/60 text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100"
                }`}
              >
                <span
                  className={`size-1.5 rounded-full shrink-0 ${statusDotClass(session)}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">
                  {session.title || "Untitled session"}
                </span>
              </button>
            );
          })}
        </PanelGroup>
      ) : null}

      {/* Scope: Workspace */}
      {scope === "workspace" ? (
        <>
          {/* PanelGroup: Chats */}
          <PanelGroup
            label="Chats"
            emptyText={normalizedQuery ? "No team chats match your search" : "No team chats yet"}
            action={
              onNewTeamRoom ? (
                <PanelIconButton label="New team chat" onClick={onNewTeamRoom}>
                  <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
                </PanelIconButton>
              ) : undefined
            }
          >
            {filteredTeamRooms.map((room) => {
              const isSelected = room.id === active;
              const handleSelect = onSelectTeamRoom ?? onSelect;
              return (
                <button
                  key={room.id}
                  type="button"
                  onClick={() => handleSelect(room.id)}
                  aria-current={isSelected ? "page" : undefined}
                  className={`group w-full text-left rounded-lg px-2.5 py-1.5 flex items-center gap-2.5 transition-colors ${
                    isSelected
                      ? "bg-[#e4e4e7] dark:bg-zinc-800 text-[#0a0a0a] dark:text-zinc-100 font-medium"
                      : "hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/60 text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100"
                  }`}
                >
                  <MessageSquare className="size-3.5 shrink-0 text-[#71717a] dark:text-zinc-400" />
                  <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">
                    {room.title}
                  </span>
                  {room.unread ? (
                    <span
                      role="img"
                      aria-label="Unread messages"
                      className="size-1.5 rounded-full bg-blue-500 shrink-0"
                    />
                  ) : null}
                </button>
              );
            })}
          </PanelGroup>

          {/* PanelGroup: Channels */}
          <PanelGroup
            label="Channels"
            emptyText={normalizedQuery ? "No channels match your search" : "No channels yet"}
            action={
              onNewChannel ? (
                <PanelIconButton label="New channel" onClick={onNewChannel}>
                  <Plus className="size-3.5" strokeWidth={2} aria-hidden="true" />
                </PanelIconButton>
              ) : undefined
            }
          >
            {filteredChannels.map((channel) => {
              const isSelected = channel.id === active;
              const handleSelect = onSelectChannel ?? onSelect;
              return (
                <button
                  key={channel.id}
                  type="button"
                  onClick={() => handleSelect(channel.id)}
                  aria-current={isSelected ? "page" : undefined}
                  className={`group w-full text-left rounded-lg px-2.5 py-1.5 flex items-center gap-2.5 transition-colors ${
                    isSelected
                      ? "bg-[#e4e4e7] dark:bg-zinc-800 text-[#0a0a0a] dark:text-zinc-100 font-medium"
                      : "hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/60 text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100"
                  }`}
                >
                  <Hash className="size-3.5 shrink-0 text-[#71717a] dark:text-zinc-400" />
                  <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">
                    {channel.title}
                  </span>
                  {channel.memberCount !== undefined && channel.memberCount > 1 ? (
                    <span className="text-[11px] font-mono text-[#a1a1aa] dark:text-zinc-500 shrink-0">
                      {channel.memberCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </PanelGroup>

          {/* PanelGroup: Activity */}
          <PanelGroup label="Activity">
            {filteredActivity.length > 0 ? (
              filteredActivity.map((activity) => {
                const isSelected = activity.id === active;
                const handleSelect = onSelectActivity ?? onSelect;
                return (
                  <button
                    key={activity.id}
                    type="button"
                    onClick={() => handleSelect(activity.id)}
                    aria-current={isSelected ? "page" : undefined}
                    className={`group w-full text-left rounded-lg px-2.5 py-1.5 flex items-start gap-2.5 transition-colors ${
                      isSelected
                        ? "bg-[#e4e4e7] dark:bg-zinc-800 text-[#0a0a0a] dark:text-zinc-100 font-medium"
                        : "hover:bg-[#f4f4f5] dark:hover:bg-zinc-800/60 text-[#71717a] dark:text-zinc-400 hover:text-[#0a0a0a] dark:hover:text-zinc-100"
                    }`}
                  >
                    <Bell className="size-3.5 shrink-0 mt-0.5 text-[#71717a] dark:text-zinc-400" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] leading-tight text-[#0a0a0a] dark:text-zinc-200">
                        {activity.title}
                      </p>
                      {activity.description ? (
                        <p className="truncate text-[11px] text-[#71717a] dark:text-zinc-400 mt-0.5">
                          {activity.description}
                        </p>
                      ) : null}
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="flex items-center gap-2 px-1 py-1.5 text-[12px] text-[#71717a] dark:text-zinc-500">
                <Bell className="size-3.5 shrink-0" aria-hidden="true" />
                <span>No activity yet.</span>
              </div>
            )}
          </PanelGroup>
        </>
      ) : null}
    </ContextPanel>
  );
}
