import { useCallback, useRef, useState } from "react";
import { type ConversationRunFrame, useConversationRoomRealtime } from "../conversation-room-realtime";
import { ConversationRoomPresence } from "./ConversationRoomPresence";
import { DiffViewer } from "./DiffViewer";
import { TerminalView } from "./TerminalView";
import { RunOutputArchivePanel } from "./RunOutputArchivePanel";

const NO_MESSAGES: never[] = [];
const ignoreMessage = () => {};
const MAX_TERMINAL_CHARS = 250_000;
const MAX_DIFF_CHARS = 500_000;

interface RunLivePanelProps {
  runId: string;
  sessionId?: string;
  showDiff?: boolean;
  roomUrl?: string;
}

export function RunLivePanel(props: RunLivePanelProps) {
  const key = JSON.stringify([props.runId, props.sessionId ?? "default", props.roomUrl ?? null]);
  return <ScopedRunLivePanel key={key} {...props} />;
}

function ScopedRunLivePanel({ runId, sessionId = "default", showDiff = true, roomUrl }: RunLivePanelProps) {
  const [terminal, setTerminal] = useState({ text: "", totalChars: 0, epoch: 0 });
  const lastSequence = useRef(0);
  const [diff, setDiff] = useState("");
  const pendingDiff = useRef<string | null>(null);
  const [diffNotice, setDiffNotice] = useState("");
  const [runStatus, setRunStatus] = useState("");
  const [streamGap, setStreamGap] = useState(false);
  const [children, setChildren] = useState<Record<string, string>>({});
  const [sessionChildren, setSessionChildren] = useState<Record<string, string>>({});
  const [archiveOpen, setArchiveOpen] = useState(false);
  const onRunEvent = useCallback((frame: ConversationRunFrame) => {
    if (frame.sequence < lastSequence.current) {
      // The room hook permits a rewind only after the durable source resets.
      setTerminal((current) => ({ text: "", totalChars: 0, epoch: current.epoch === Number.MAX_SAFE_INTEGER ? 0 : current.epoch + 1 }));
      pendingDiff.current = null;
      setDiff(""); setDiffNotice(""); setChildren({}); setSessionChildren({}); setRunStatus(""); setStreamGap(true);
    }
    lastSequence.current = frame.sequence;
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
      const data = event.data;
      if (!data) return;
      setTerminal((current) => {
        const text = `${current.text}${data}`.slice(-MAX_TERMINAL_CHARS);
        const totalChars = current.totalChars + data.length;
        return Number.isSafeInteger(totalChars) ? { ...current, text, totalChars }
          : { text, totalChars: text.length, epoch: current.epoch === Number.MAX_SAFE_INTEGER ? 0 : current.epoch + 1 };
      });
    } else if (event.kind === "diff" && typeof event.data === "string") {
      if (event.reset === true) pendingDiff.current = "";
      if (pendingDiff.current === null) return;
      if (pendingDiff.current.length + event.data.length > MAX_DIFF_CHARS) {
        pendingDiff.current = null;
        setDiffNotice("The diff preview reached its display limit. Showing the last complete snapshot.");
        return;
      }
      pendingDiff.current += event.data;
      if (event.complete === true) {
        setDiff(pendingDiff.current);
        pendingDiff.current = null;
        setDiffNotice("");
      }
    } else if (event.kind === "status" && typeof event.status === "string") {
      if (event.status === "diff_limited" || event.status === "diff_unavailable") {
        pendingDiff.current = null;
        setDiffNotice(event.message || "The current diff preview is unavailable. Showing the last complete snapshot.");
        return;
      }
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
    realtimePath: roomUrl,
  });

  return (
    <section
      aria-label="Live run workspace"
      className="relative min-w-0 border border-[var(--line)] bg-[var(--card)]"
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0) room.setCursor({
          x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
          y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
        });
      }}
      onPointerLeave={() => room.setCursor(null)}
    >
      <div className="px-3 py-2 font-mono text-xs text-[var(--ink)]">Live workspace</div>
      <ConversationRoomPresence status={room.status} viewers={room.viewers} viewerId={room.viewerId} />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
        {room.viewers.filter((viewer) => viewer.viewerId !== room.viewerId && viewer.cursor).map((viewer) => <span
          key={viewer.viewerId}
          data-room-cursor={viewer.viewerId}
          className="absolute max-w-48 truncate border border-[var(--line)] bg-[var(--paper)] px-1 font-mono text-[10px] text-[var(--ink)]"
          style={{ left: `${(viewer.cursor?.x ?? 0) * 100}%`, top: `${(viewer.cursor?.y ?? 0) * 100}%`, transform: "translate(-50%, -50%)" }}
        >{viewer.label || "Viewer"}</span>)}
      </div>
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
        <TerminalView text={terminal.text} totalChars={terminal.totalChars} epoch={terminal.epoch} />
        {!roomUrl && <button type="button" className="min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]" onClick={() => setArchiveOpen((value) => !value)}>{archiveOpen ? "Hide retained terminal archive" : "Review retained terminal archive"}</button>}
        {!roomUrl && archiveOpen && <RunOutputArchivePanel runId={runId} sessionId={sessionId} onClose={() => setArchiveOpen(false)} />}
        {showDiff && diffNotice ? <p role="status" className="text-xs text-[var(--ink-2)]">{diffNotice}</p> : null}
        {showDiff && diff ? <DiffViewer diff={diff} runId={runId} /> : null}
      </div>
    </section>
  );
}
