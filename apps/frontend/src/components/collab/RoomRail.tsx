import type { FormEvent, JSX } from "react";
import type { CollabRoomKind } from "@shiba/shared";

type RoomListTab = CollabRoomKind | "saved";

interface RailRoom {
  roomId: string;
  title: string;
  visibility: string;
  memberCount?: number;
  unreadCount?: number;
}

interface SavedRef {
  roomId: string;
  messageId: string;
  savedAt: number;
}

export function RoomRail({
  roomListTab,
  tabUnread,
  rooms,
  savedItems,
  activeRoomId,
  roomTitle,
  roomVisibility,
  busy,
  onTab,
  onCreate,
  onTitle,
  onVisibility,
  onOpenSaved,
  onSelectRoom,
}: {
  roomListTab: RoomListTab;
  tabUnread: Record<CollabRoomKind, number>;
  rooms: RailRoom[];
  savedItems: SavedRef[];
  activeRoomId: string;
  roomTitle: string;
  roomVisibility: "private" | "shared";
  busy: boolean;
  onTab: (tab: RoomListTab) => void;
  onCreate: (event: FormEvent) => void;
  onTitle: (value: string) => void;
  onVisibility: (value: "private" | "shared") => void;
  onOpenSaved: (roomId: string) => void;
  onSelectRoom: (roomId: string) => void;
}): JSX.Element {
  return (
    <aside aria-label="Group chats" className="flex min-w-0 flex-col gap-3 border border-[var(--line)] bg-[var(--card)] p-3">
      <div role="tablist" aria-label="Conversation kinds" className="flex flex-wrap gap-1 border-b border-[var(--line)] pb-2">
        {(
          [
            { id: "channel" as const, label: "Channels" },
            { id: "dm" as const, label: "DMs" },
            { id: "room" as const, label: "Rooms" },
            { id: "saved" as const, label: "Saved" },
          ] as const
        ).map((tab) => {
          const unread = tab.id === "saved" ? 0 : tabUnread[tab.id] ?? 0;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={roomListTab === tab.id}
              onClick={() => onTab(tab.id)}
              className={`min-h-11 flex-1 px-1 py-1 text-[10px] font-semibold uppercase tracking-wide focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)] ${roomListTab === tab.id ? "border-b-2 border-[var(--navy)] text-[var(--ink)]" : "text-[var(--ink-2)]"}`}
            >
              {tab.label}
              {unread > 0 ? <span className="ml-1 font-mono text-[9px] text-[var(--navy)]">({unread})</span> : null}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.12em]">
          {roomListTab === "saved" ? "Saved messages" : roomListTab}
        </h2>
        <span className="font-mono text-[10px] text-[var(--ink-2)]">
          {roomListTab === "saved" ? savedItems.length : rooms.length}
        </span>
      </div>
      {roomListTab !== "saved" ? (
        <form onSubmit={onCreate} className="flex flex-col gap-2">
          <input
            aria-label="New room title"
            value={roomTitle}
            onChange={(event) => onTitle(event.target.value)}
            placeholder="Name a group chat"
            maxLength={120}
            className="min-h-11 min-w-0 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-sm"
          />
          <div className="flex gap-2">
            <select
              aria-label="Room visibility"
              value={roomVisibility}
              onChange={(event) => onVisibility(event.target.value as "private" | "shared")}
              className="min-h-11 min-w-0 flex-1 rounded-none border border-[var(--line)] bg-[var(--card)] px-2 py-2 text-xs"
            >
              <option value="private">Private</option>
              <option value="shared">Shared (membership required)</option>
            </select>
            <button
              type="submit"
              disabled={busy || !roomTitle.trim()}
              className="min-h-11 rounded-none bg-[var(--navy)] px-3 py-2 text-xs font-semibold text-[var(--paper-title-fg)] disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </form>
      ) : null}
      {roomListTab === "saved" ? (
        <ul aria-label="Saved messages" className="flex max-h-60 flex-col gap-1 overflow-y-auto lg:max-h-none">
          {savedItems.map((item) => (
            <li key={`${item.roomId}-${item.messageId}`}>
              <button
                type="button"
                onClick={() => onOpenSaved(item.roomId)}
                className="min-h-11 w-full border-l-2 border-transparent px-3 py-2 text-left text-sm hover:bg-[var(--panel-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]"
              >
                <span className="block truncate font-mono text-xs text-[var(--ink)]">{item.messageId}</span>
                <span className="block text-[10px] text-[var(--ink-2)]">
                  Room {item.roomId} · {new Date(item.savedAt).toLocaleString()}
                </span>
              </button>
            </li>
          ))}
          {savedItems.length === 0 ? (
            <li className="px-2 py-4 text-xs text-[var(--ink-2)]">Save messages from a conversation to find them here.</li>
          ) : null}
        </ul>
      ) : (
        <ul aria-label="Rooms" className="flex max-h-60 flex-col gap-1 overflow-y-auto lg:max-h-none">
          {rooms.map((room) => (
            <li key={room.roomId}>
              <button
                type="button"
                onClick={() => onSelectRoom(room.roomId)}
                aria-current={room.roomId === activeRoomId ? "page" : undefined}
                className={`min-h-11 w-full border-l-2 px-3 py-2 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)] ${room.roomId === activeRoomId ? "border-[var(--navy)] bg-[var(--panel-2)] text-[var(--ink)]" : "border-transparent text-[var(--ink-2)] hover:bg-[var(--panel-2)]"}`}
              >
                <span className="flex items-center gap-2 truncate font-medium">
                  <span className="truncate">{room.title}</span>
                  {(room.unreadCount ?? 0) > 0 ? (
                    <span className="shrink-0 font-mono text-[9px] text-[var(--navy)]">{room.unreadCount}</span>
                  ) : null}
                </span>
                <span className="block text-[10px] text-[var(--ink-2)]">
                  {room.visibility} · {room.memberCount ?? 0} members
                </span>
              </button>
            </li>
          ))}
          {rooms.length === 0 ? (
            <li className="px-2 py-4 text-xs text-[var(--ink-2)]">Create a group chat, then choose who can join.</li>
          ) : null}
        </ul>
      )}
    </aside>
  );
}
