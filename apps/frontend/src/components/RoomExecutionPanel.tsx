import { useEffect, useRef, useState } from "react";
import type { ConversationRunFrame } from "../conversation-room-realtime";
import { DiffViewer } from "./DiffViewer";
import { TerminalView } from "./TerminalView";

const MAX_TERMINAL_CHARS = 250_000;
const MAX_DIFF_CHARS = 500_000;
const POLL_MS = 1_500;

interface Replay {
  roomId: string;
  handoffId: string;
  runId: string;
  runtime: "sandbox" | "local";
  status: string;
  source: "trusted-run-journal";
  readOnly: true;
  after: number;
  oldest: number;
  latest: number;
  nextCursor: number;
  gap: boolean;
  hasMore: boolean;
  frames: ConversationRunFrame[];
}

interface View {
  key: string;
  terminal: string;
  diff: string;
  diffNotice: string;
  status: string;
  runtime: Replay["runtime"] | null;
  gap: boolean;
  limited: boolean;
  error: string;
  children: Record<string, string>;
}

function emptyView(key: string): View {
  return { key, terminal: "", diff: "", diffNotice: "", status: "", runtime: null, gap: false, limited: false, error: "", children: {} };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function replayFrom(value: unknown, roomId: string, handoffId: string, runId: string | undefined, after: number): Replay | null {
  if (!record(value) || value.roomId !== roomId || value.handoffId !== handoffId ||
    typeof value.runId !== "string" || !value.runId || (runId !== undefined && value.runId !== runId) ||
    (value.runtime !== "local" && value.runtime !== "sandbox") ||
    typeof value.status !== "string" || value.status.length > 80 || value.source !== "trusted-run-journal" || value.readOnly !== true ||
    value.after !== after || ![value.oldest, value.latest, value.nextCursor].every((n) => Number.isSafeInteger(n) && Number(n) >= 0) ||
    Number(value.oldest) > Number(value.latest) || Number(value.nextCursor) > Number(value.latest) ||
    typeof value.gap !== "boolean" || typeof value.hasMore !== "boolean" || !Array.isArray(value.frames) || value.frames.length > 256) return null;
  const reset = value.gap && after > Number(value.latest);
  if ((!reset && Number(value.nextCursor) < after) || (value.hasMore &&
    (Number(value.nextCursor) >= Number(value.latest) || Number(value.nextCursor) <= (reset ? 0 : after)))) return null;
  let sequence = reset ? 0 : after;
  for (const frame of value.frames) {
    if (!record(frame) || frame.runId !== value.runId || !Number.isSafeInteger(frame.sequence) || Number(frame.sequence) <= sequence ||
      Number(frame.sequence) > Number(value.nextCursor) || !record(frame.event)) return null;
    sequence = Number(frame.sequence);
    const event = frame.event;
    if (event.kind === "terminal") {
      if ((event.stream !== "stdout" && event.stream !== "stderr") || typeof event.data !== "string" || event.data.length > 4_000) return null;
    } else if (event.kind === "diff") {
      if (typeof event.data !== "string" || event.data.length > 4_000 || typeof event.reset !== "boolean" || typeof event.complete !== "boolean") return null;
    } else if (event.kind === "status" || event.kind === "child") {
      if (typeof event.status !== "string" || event.status.length > 80 ||
        (event.message !== undefined && (typeof event.message !== "string" || event.message.length > 4_000)) ||
        (event.kind === "child" && (typeof event.childId !== "string" || event.childId.length > 200))) return null;
    } else return null;
  }
  return value as unknown as Replay;
}

/** Current room grants authorize each read; this panel cannot publish or control a run. */
export function RoomExecutionPanel({ workspaceId, roomId, handoffId, runId, onAccessLost }: {
  workspaceId?: string;
  roomId: string;
  handoffId: string;
  runId?: string;
  onAccessLost?: () => void;
}) {
  const key = JSON.stringify([workspaceId ?? "default", roomId, handoffId, runId ?? ""]);
  const activeKey = useRef(key);
  activeKey.current = key;
  const callbacks = useRef({ onAccessLost });
  callbacks.current = { onAccessLost };
  const [state, setState] = useState(() => emptyView(key));
  // A navigation render must never expose the previous room while effects clean up.
  const view = state.key === key ? state : emptyView(key);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let cursor = 0;
    let pendingDiff: string | null = null;
    let current = emptyView(key);
    const isCurrent = () => !stopped && activeKey.current === key;
    setState(current);
    const clearOutput = (error: string) => {
      cursor = 0;
      pendingDiff = null;
      current = { ...emptyView(key), error };
      setState(current);
    };
    const poll = async () => {
      controller = new AbortController();
      let delay = POLL_MS;
      try {
        const headers = new Headers();
        if (workspaceId) headers.set("X-Shiba-Workspace", workspaceId);
        const response = await fetch(`/api/collaboration/rooms/${encodeURIComponent(roomId)}/handoffs/${encodeURIComponent(handoffId)}/live?after=${cursor}`, {
          method: "GET", credentials: "same-origin", cache: "no-store", headers, signal: controller.signal,
        });
        if (!isCurrent()) return;
        if ([401, 403, 404, 409].includes(response.status)) {
          clearOutput("Shared execution access is unavailable. Reload the room to check your access.");
          stopped = true;
          callbacks.current.onAccessLost?.();
          return;
        }
        if (!response.ok) throw new Error("unavailable");
        const body: unknown = await response.json();
        if (!isCurrent()) return;
        const replay = replayFrom(body, roomId, handoffId, runId, cursor);
        if (!replay) throw new Error("invalid replay");
        if (cursor > replay.latest) { current = emptyView(key); pendingDiff = null; }
        if (replay.gap) pendingDiff = null;
        current = { ...current, error: "", gap: current.gap || replay.gap, runtime: replay.runtime, status: replay.status.replaceAll("_", " ") };
        for (const { event } of replay.frames) {
          if (event.kind === "terminal" && typeof event.data === "string") {
            const terminal = current.terminal + event.data;
            current.terminal = terminal.slice(-MAX_TERMINAL_CHARS);
            current.limited ||= terminal.length > MAX_TERMINAL_CHARS;
          } else if (event.kind === "diff" && typeof event.data === "string") {
            if (event.reset === true) pendingDiff = "";
            if (pendingDiff === null) continue;
            if (pendingDiff.length + event.data.length > MAX_DIFF_CHARS) {
              pendingDiff = null;
              current.diffNotice = "The diff preview reached its display limit. Showing the last complete snapshot.";
              continue;
            }
            pendingDiff += event.data;
            if (event.complete === true) { current.diff = pendingDiff; pendingDiff = null; current.diffNotice = ""; }
          } else if (event.kind === "status" && typeof event.status === "string") {
            if (["diff_limited", "diff_unavailable"].includes(event.status)) {
              pendingDiff = null;
              current.diffNotice = event.message || "The current diff is unavailable. Showing the last complete snapshot.";
            } else {
              if (["stream_gap", "stream_limited"].includes(event.status)) current.gap = true;
              current.status = event.message || event.status.replaceAll("_", " ");
            }
          } else if (event.kind === "child" && typeof event.childId === "string" && typeof event.status === "string") {
            current.children = Object.fromEntries([...Object.entries(current.children).filter(([id]) => id !== event.childId), [event.childId, event.status]].slice(-32));
          }
        }
        cursor = replay.nextCursor;
        setState({ ...current });
        // Drain retained pages in order, yielding between pages. Completed runs
        // still recheck membership while visible; completion does not freeze ACLs.
        if (replay.hasMore) delay = 0;
      } catch {
        if (!isCurrent()) return;
        clearOutput("Unable to verify current execution access. Retrying…");
      } finally {
        if (isCurrent()) timer = setTimeout(() => { void poll(); }, delay);
      }
    };
    if (roomId && handoffId) void poll();
    return () => { stopped = true; controller?.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [key, workspaceId, roomId, handoffId, runId]);

  return <section aria-label="Shared execution" className="min-w-0 border border-[var(--line)] bg-[var(--card)]">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-2">
      <span className="font-mono text-xs text-[var(--ink)]">Shared execution · Read only</span>
      <span className="text-xs text-[var(--ink-2)]">{view.runtime === "local" ? "Paired local runtime" : view.runtime === "sandbox" ? "Cloud sandbox" : "Checking runtime"}</span>
    </header>
    <div className="min-w-0 space-y-3 p-3">
      <p className="text-xs text-[var(--ink-2)]">Terminal and complete diff snapshots from this approved task. Computer and browser control are unavailable here.</p>
      {view.error ? <p role="alert" className="text-xs text-[var(--ink-2)]">{view.error}</p> : null}
      {view.gap || view.limited ? <p role="status" className="text-xs text-[var(--ink-2)]">Some output is unavailable. Showing retained output within the display limit.</p> : null}
      {view.status ? <p role="status" className="text-xs text-[var(--ink-2)]">{view.status}</p> : null}
      {Object.keys(view.children).length ? <ul aria-label="Task specialist status" className="flex flex-wrap gap-2 font-mono text-xs text-[var(--ink-2)]">
        {Object.entries(view.children).map(([id, status]) => <li key={id}>{id}: {status.replaceAll("_", " ")}</li>)}
      </ul> : null}
      <TerminalView text={view.terminal} />
      {view.diffNotice ? <p role="status" className="text-xs text-[var(--ink-2)]">{view.diffNotice}</p> : null}
      {view.diff ? <div className="min-w-0 overflow-auto"><DiffViewer diff={view.diff} runId={runId} /></div> : null}
    </div>
  </section>;
}
