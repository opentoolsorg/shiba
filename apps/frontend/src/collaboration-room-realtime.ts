import { useCallback, useEffect, useRef, useState } from "react";

export interface CollaborationRoomCursor { x: number; y: number }

export interface CollaborationRoomViewer {
  viewerId: string;
  label: string;
  typing: boolean;
  cursor: CollaborationRoomCursor | null;
}

type ConnectionStatus = "offline" | "connecting" | "connected" | "reconnecting";

interface Options {
  roomId: string;
  workspaceId?: string;
  enabled: boolean;
  typingText: string;
  onRefresh: (roomId: string) => void;
  onAccessLost: (roomId: string) => void;
}

const VIEWER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isCursor(value: unknown): value is CollaborationRoomCursor {
  if (!value || typeof value !== "object") return false;
  const cursor = value as Partial<CollaborationRoomCursor>;
  return typeof cursor.x === "number" && Number.isFinite(cursor.x) && cursor.x >= 0 && cursor.x <= 1 && typeof cursor.y === "number" && Number.isFinite(cursor.y) && cursor.y >= 0 && cursor.y <= 1;
}

function viewersFrom(value: unknown): CollaborationRoomViewer[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const viewers: CollaborationRoomViewer[] = [];
  for (const viewer of value) {
    if (!viewer || typeof viewer !== "object" || typeof viewer.viewerId !== "string" || !VIEWER_ID.test(viewer.viewerId) ||
      typeof viewer.label !== "string" || !viewer.label || viewer.label.length > 320 ||
      typeof viewer.typing !== "boolean" || viewer.cursor !== undefined && viewer.cursor !== null && !isCursor(viewer.cursor)) return null;
    viewers.push({ viewerId: viewer.viewerId, label: viewer.label, typing: viewer.typing, cursor: isCursor(viewer.cursor) ? { x: viewer.cursor.x, y: viewer.cursor.y } : null });
  }
  return viewers;
}

/** Presence and invalidation only: durable content and all actions use authenticated HTTP. */
export function useCollaborationRoomRealtime(options: Options) {
  const { roomId, workspaceId, enabled, typingText } = options;
  const scopeKey = JSON.stringify([workspaceId ?? "default", roomId]);
  const callbacks = useRef(options);
  callbacks.current = options;
  const socketRef = useRef<WebSocket | null>(null);
  const selfViewerRef = useRef<string | null>(null);
  const cursorRef = useRef({ scopeKey, at: -Infinity, visible: false });
  const viewerRef = useRef<string | null>(null);
  const typingRef = useRef(Boolean(typingText.trim()));
  typingRef.current = Boolean(typingText.trim());
  const [state, setState] = useState<{
    scopeKey: string;
    roomId: string;
    status: ConnectionStatus;
    viewers: CollaborationRoomViewer[];
  }>({ scopeKey: "", roomId: "", status: "offline", viewers: [] });

  const publishCursor = useCallback((cursor: CollaborationRoomCursor | null) => {
    if (!enabled || callbacks.current.roomId !== roomId || (callbacks.current.workspaceId ?? "default") !== (workspaceId ?? "default") || !callbacks.current.enabled || cursor !== null && !isCursor(cursor)) return;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (cursorRef.current.scopeKey !== scopeKey) cursorRef.current = { scopeKey, at: -Infinity, visible: false };
    const previous = cursorRef.current;
    if (cursor === null ? !previous.visible : Date.now() - previous.at < 100) return;
    try {
      socket.send(JSON.stringify({ type: "client_presence", cursor: cursor === null ? null : { x: cursor.x, y: cursor.y } }));
      cursorRef.current = { scopeKey, at: cursor === null ? previous.at : Date.now(), visible: cursor !== null };
    } catch { /* A fresh connection starts with no cursor. */ }
  }, [enabled, roomId, workspaceId, scopeKey]);

  useEffect(() => {
    selfViewerRef.current = null;
    cursorRef.current = { scopeKey, at: -Infinity, visible: false };
    setState({ scopeKey, roomId, status: "offline", viewers: [] });
    if (!enabled || !roomId || typeof WebSocket === "undefined") return;
    viewerRef.current ??= crypto.randomUUID();
    let stopped = false;
    let failures = 0;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const setStatus = (status: ConnectionStatus) => {
      setState((current) => ({ ...current, scopeKey, roomId, status }));
    };
    const connect = () => {
      if (stopped) return;
      setStatus(failures === 0 ? "connecting" : "reconnecting");
      const url = new URL(`/api/collaboration/rooms/${encodeURIComponent(roomId)}/realtime`, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("viewer", viewerRef.current!);
      if (workspaceId) url.searchParams.set("workspaceId", workspaceId);
      let socket: WebSocket;
      const retry = () => {
        if (stopped) return;
        failures++;
        if (failures > 8) { setStatus("offline"); return; }
        setStatus("reconnecting");
        reconnect = setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(failures - 1, 5)));
      };
      try { socket = new WebSocket(url); } catch { retry(); return; }
      socketRef.current = socket;
      let lastFrameAt = Date.now();
      const current = () => !stopped && socketRef.current === socket &&
        callbacks.current.roomId === roomId && (callbacks.current.workspaceId ?? "default") === (workspaceId ?? "default") && callbacks.current.enabled;
      socket.addEventListener("open", () => {
        if (!current()) return;
        failures = 0;
        lastFrameAt = Date.now();
        setStatus("connected");
        callbacks.current.onRefresh(roomId);
        socket.send(JSON.stringify({ type: "client_presence", typing: typingRef.current }));
        heartbeat = setInterval(() => {
          if (!current()) return;
          if (Date.now() - lastFrameAt > 65_000) socket.close();
          else { try { socket.send("ping"); } catch { socket.close(); } }
        }, 25_000);
      });
      socket.addEventListener("message", (event: MessageEvent) => {
        if (!current() || typeof event.data !== "string" || event.data.length > 65_536) return;
        lastFrameAt = Date.now();
        if (event.data === "pong") return;
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
        if (!frame || typeof frame !== "object" || frame.roomId !== roomId) return;
        if (frame.type === "collaboration:snapshot" || frame.type === "collaboration:presence") {
          const viewers = viewersFrom(frame.viewers);
          if (!viewers) return;
          if (frame.type === "collaboration:snapshot" && typeof frame.selfViewerId === "string" && VIEWER_ID.test(frame.selfViewerId)) selfViewerRef.current = frame.selfViewerId;
          setState({ scopeKey, roomId, status: "connected", viewers });
          if (frame.type === "collaboration:snapshot") callbacks.current.onRefresh(roomId);
        } else if (frame.type === "collaboration:refresh") {
          callbacks.current.onRefresh(roomId);
        }
      });
      socket.addEventListener("close", (event: CloseEvent) => {
        if (!current()) return;
        socketRef.current = null;
        selfViewerRef.current = null;
        cursorRef.current = { scopeKey, at: -Infinity, visible: false };
        if (heartbeat) clearInterval(heartbeat);
        setState({ scopeKey, roomId, status: "offline", viewers: [] });
        if (event.code === 1008) {
          stopped = true;
          callbacks.current.onAccessLost(roomId);
          return;
        }
        retry();
      });
      socket.addEventListener("error", () => { if (current()) socket.close(); });
    };
    connect();
    return () => {
      stopped = true;
      if (reconnect) clearTimeout(reconnect);
      if (heartbeat) clearInterval(heartbeat);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [roomId, workspaceId, scopeKey, enabled]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify({ type: "client_presence", typing: Boolean(typingText.trim()) })); } catch { /* Reconnect restores presence. */ }
  }, [typingText]);

  useEffect(() => {
    const clear = () => publishCursor(null);
    const hidden = () => { if (document.visibilityState === "hidden") clear(); };
    window.addEventListener("blur", clear); document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("blur", clear); document.removeEventListener("visibilitychange", hidden); };
  }, [publishCursor]);

  return state.scopeKey === scopeKey && enabled
    ? { roomId, status: state.status, viewers: state.viewers, viewerId: selfViewerRef.current, publishCursor }
    : { roomId, status: "offline" as const, viewers: [], viewerId: null, publishCursor };
}
