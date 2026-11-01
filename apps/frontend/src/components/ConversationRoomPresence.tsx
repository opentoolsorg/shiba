import type { ConversationRoomStream, ConversationRoomViewer, ConversationRoomStatus } from "../conversation-room-realtime.js";

interface ConversationRoomPresenceProps {
  status: ConversationRoomStatus;
  viewers: readonly ConversationRoomViewer[];
  viewerId: string;
}

export function ConversationRoomPresence({
  status,
  viewers,
  viewerId,
}: ConversationRoomPresenceProps) {
  if (status === "offline") return null;
  const otherTyping = viewers.filter((viewer) => viewer.viewerId !== viewerId && viewer.typing).length;
  const count = status === "connected" ? Math.max(1, viewers.length) : viewers.length;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-8 items-center gap-2 border-b border-[var(--border-1)] px-3 py-1.5 text-[11px] text-[var(--muted-foreground-1)]"
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${status === "connected" ? "bg-emerald-500" : "bg-amber-500"}`}
      />
      <span>
        {status === "connected"
          ? `${count} viewer${count === 1 ? "" : "s"} here`
          : status === "connecting" ? "Connecting live room…" : "Reconnecting live room…"}
      </span>
      {otherTyping > 0 ? (
        <span className="text-[var(--primary)]">
          {otherTyping === 1 ? "Another viewer is typing" : `${otherTyping} viewers are typing`}
        </span>
      ) : null}
    </div>
  );
}

export function RemoteAgentStream({ stream }: { stream: ConversationRoomStream | null }) {
  if (!stream) return null;
  return (
    <section
      aria-label="Live agent response from another viewer"
      aria-live="polite"
      role="status"
      className="mb-4 rounded-[var(--radius-button)] border border-[var(--primary)]/35 bg-[var(--card)] px-4 py-3"
    >
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--primary)]">
        Shiba is replying · live
      </p>
      <p className="whitespace-pre-wrap break-words text-sm text-[var(--fg)]">
        {stream.text || "Thinking…"}
      </p>
    </section>
  );
}
