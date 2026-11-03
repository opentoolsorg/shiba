import { useCallback, useState } from "react";
import { type ConversationRunFrame, useConversationRoomRealtime } from "../conversation-room-realtime";
import { ConversationRoomPresence } from "./ConversationRoomPresence";
import { DiffViewer } from "./DiffViewer";
import { TerminalView } from "./TerminalView";

const NO_MESSAGES: never[] = [];
const ignoreMessage = () => {};
const MAX_TERMINAL_CHARS = 250_000;
const MAX_DIFF_CHARS = 500_000;

export function RunLivePanel({ runId, sessionId = "default", showDiff = true }: {
  runId: string;
  sessionId?: string;
  showDiff?: boolean;
}) {
  const [terminal, setTerminal] = useState("");
  const [diff, setDiff] = useState("");
  const [runStatus, setRunStatus] = useState("");
  const [streamGap, setStreamGap] = useState(false);
  const [children, setChildren] = useState<Record<string, string>>({});
  const [sessionChildren, setSessionChildren] = useState<Record<string, string>>({});
  const onRunEvent = useCallback((frame: ConversationRunFrame) => {
    const event = frame.event;
    if (frame.runId !== runId) {
      if (frame.runId.startsWith("specialist:") && event.kind === "child" && typeof event.childId === "string" && typeof event.status === "string") {
        const childId = event.childId;
        const status = event.status;
        setSessionChildren((current) => Object.fromEntries([...Object.entries(current).filter(([id]) => id !== childId), [childId, status]].slice(-32)));
      }
      return;
    }
    if (event.kind === "terminal" && typeof event.data === "string") {
      setTerminal((current) => `${current}${event.data}`.slice(-MAX_TERMINAL_CHARS));
    } else if (event.kind === "diff" && typeof event.data === "string") {
      setDiff((current) => `${event.reset ? "" : current}${event.data}`.slice(0, MAX_DIFF_CHARS));
    } else if (event.kind === "status" && typeof event.status === "string") {
      if (event.status === "stream_gap" || event.status === "stream_limited") setStreamGap(true);
      setRunStatus(event.message || event.status.replaceAll("_", " "));
    } else if (event.kind === "child" && typeof event.childId === "string" && typeof event.status === "string") {
      const childId = event.childId;
      const status = event.status;
      setChildren((current) => Object.fromEntries([...Object.entries(current).filter(([id]) => id !== childId), [childId, status]].slice(-32)));
    }
  }, [runId]);
  const room = useConversationRoomRealtime({
    sessionId,
    enabled: typeof WebSocket === "function",
    typingText: "",
    messages: NO_MESSAGES,
    onMessage: ignoreMessage,
    onRunEvent,
  });

  return (
    <section aria-label="Live run workspace" className="min-w-0 border border-[var(--line)] bg-[var(--card)]">
      <div className="px-3 py-2 font-mono text-xs text-[var(--ink)]">Live workspace</div>
      <ConversationRoomPresence status={room.status} viewers={room.viewers} viewerId={room.viewerId} />
      <div className="min-w-0 space-y-3 p-3">
        {room.replayGap || streamGap ? <p role="status" className="text-xs text-[var(--ink-2)]">Some live output is unavailable. Showing the retained stream.</p> : null}
        {runStatus ? <p role="status" className="text-xs text-[var(--ink-2)]">{runStatus}</p> : null}
        {Object.keys(children).length ? <ul aria-label="Specialist status" className="flex flex-wrap gap-2 font-mono text-xs text-[var(--ink-2)]">
          {Object.entries(children).map(([id, status]) => <li key={id}>{id}: {status.replaceAll("_", " ")}</li>)}
        </ul> : null}
        {Object.keys(sessionChildren).length ? <div className="text-xs text-[var(--ink-2)]">
          <p className="mb-1 font-mono">Session specialists</p>
          <ul aria-label="Session specialist status" className="flex flex-wrap gap-2 font-mono">
            {Object.entries(sessionChildren).map(([id, status]) => <li key={id}>{id}: {status.replaceAll("_", " ")}</li>)}
          </ul>
        </div> : null}
        <TerminalView text={terminal} />
        {showDiff && diff ? <DiffViewer diff={diff} runId={runId} /> : null}
      </div>
    </section>
  );
}
