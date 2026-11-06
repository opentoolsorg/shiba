import type { JSX } from "react";
import type {
  ConversationRoomStream,
  ConversationRoomViewer,
  ConversationRoomStatus,
} from "../conversation-room-realtime.js";

export interface ConversationRoomPresenceProps {
  status: ConversationRoomStatus;
  viewers: readonly ConversationRoomViewer[];
  viewerId: string;
  className?: string;
}

/**
 * ConversationRoomPresence — Live multiplayer presence indicator for conversation rooms.
 * Shows connected viewers count, active viewer labels, and typing indicators.
 */
export function ConversationRoomPresence({
  status,
  viewers,
  viewerId,
  className = "",
}: ConversationRoomPresenceProps): JSX.Element | null {
  if (status === "offline") return null;
  const otherTyping = viewers.filter(
    (viewer) => viewer.viewerId !== viewerId && viewer.typing,
  ).length;
  const count =
    status === "connected" ? Math.max(1, viewers.length) : viewers.length;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex min-h-8 flex-wrap items-center gap-2 border-b border-[#e4e4e7] dark:border-zinc-800 px-3 py-1.5 text-[11px] text-[#71717a] dark:text-zinc-400 select-none bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm ${className}`.trim()}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${
          status === "connected" ? "bg-emerald-500 animate-pulse-subtle" : "bg-amber-500"
        }`}
      />
      <span className="font-medium">
        {status === "connected"
          ? `${count} viewer${count === 1 ? "" : "s"} here`
          : status === "connecting"
            ? "Connecting live room…"
            : "Reconnecting live room…"}
      </span>
      {status === "connected" && viewers.some((viewer) => viewer.label) ? (
        <ul aria-label="Room viewers" className="flex min-w-0 flex-wrap gap-x-2">
          {viewers.map((viewer) => (
            <li key={viewer.viewerId} className="max-w-48 truncate text-[11px]">
              {viewer.label || "Viewer"}
              {viewer.viewerId === viewerId ? " (this tab)" : " (another tab)"}
            </li>
          ))}
        </ul>
      ) : null}
      {otherTyping > 0 ? (
        <span className="text-[var(--primary,#2563eb)] dark:text-blue-400 font-medium animate-pulse">
          {otherTyping === 1
            ? "Another viewer is typing"
            : `${otherTyping} viewers are typing`}
        </span>
      ) : null}
    </div>
  );
}

export function RemoteAgentStream({
  stream,
}: {
  stream: ConversationRoomStream | null;
}): JSX.Element | null {
  if (!stream) return null;
  return (
    <section
      aria-label="Live agent response from another viewer"
      aria-live="polite"
      role="status"
      className="mb-4 rounded-xl border border-[var(--primary,#2563eb)]/35 bg-white dark:bg-zinc-900 px-4 py-3 shadow-sm"
    >
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--primary,#2563eb)] dark:text-blue-400">
        Shiba is replying · live
      </p>
      <p className="whitespace-pre-wrap break-words text-sm text-[#0a0a0a] dark:text-zinc-100">
        {stream.text || "Thinking…"}
      </p>
    </section>
  );
}
