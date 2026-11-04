import { useEffect, useRef, useState } from "react";

export interface CollaborationRoomViewer {
  viewerId: string;
  label: string;
  typing: boolean;
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

function viewersFrom(value: unknown): CollaborationRoomViewer[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const viewers: CollaborationRoomViewer[] = [];
  for (const viewer of value) {
    if (!viewer || typeof viewer !== "object" || typeof viewer.viewerId !== "string" || !VIEWER_ID.test(viewer.viewerId) ||
      typeof viewer.label !== "string" || !viewer.label || viewer.label.length > 320 ||
      typeof viewer.typing !== "boolean") return null;
    viewers.push({ viewerId: viewer.viewerId, label: viewer.label, typing: viewer.typing });
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
  const viewerRef = useRef<string | null>(null);
  const typingRef = useRef(Boolean(typingText.trim()));
  typingRef.current = Boolean(typingText.trim());
  const [state, setState] = useState<{
    scopeKey: string;
    roomId: string;
    status: ConnectionStatus;
    viewers: CollaborationRoomViewer[];
  }>({ scopeKey: "", roomId: "", status: "offline", viewers: [] });

  useEffect(() => {
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
          setState({ scopeKey, roomId, status: "connected", viewers });
          if (frame.type === "collaboration:snapshot") callbacks.current.onRefresh(roomId);
        } else if (frame.type === "collaboration:refresh") {
          callbacks.current.onRefresh(roomId);
        }
      });
      socket.addEventListener("close", (event: CloseEvent) => {
        if (!current()) return;
        socketRef.current = null;
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

  return state.scopeKey === scopeKey && enabled
    ? { roomId, status: state.status, viewers: state.viewers }
    : { roomId, status: "offline" as const, viewers: [] };
}
