import { useEffect, useRef, useState } from "react";
import { workspaceEventsPath, type WorkspaceEvent } from "@shiba/shared";

export interface UseWorkspaceEventsOptions {
  workspaceId: string | null;
  enabled: boolean;
  onEvent: (event: WorkspaceEvent) => void;
  onReconnect?: () => void;
}

type Subscriber = {
  event: (event: WorkspaceEvent) => void;
  status: (connected: boolean) => void;
  catchUp: () => void;
};

// All mounted consumers of one workspace share its transport and retry timer.
const connections = new Map<string, ReturnType<typeof connectWorkspace>>();

function connectWorkspace(workspaceId: string) {
  const subscribers = new Set<Subscriber>();
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let connected = false;
  let attempted = false;
  let failures = 0;
  const status = (value: boolean) => {
    connected = value;
    for (const subscriber of subscribers) subscriber.status(value);
  };
  const schedule = () => {
    status(false);
    if (stopped) return;
    retry = setTimeout(start, Math.min(30_000, 500 * 2 ** Math.min(failures++, 6)));
  };
  const start = () => {
    if (stopped) return;
    const catchUp = attempted;
    attempted = true;
    const url = new URL(workspaceEventsPath(workspaceId), window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let current: WebSocket;
    try { current = new WebSocket(url); } catch { schedule(); return; }
    socket = current;
    let lastFrame = Date.now();
    const active = () => !stopped && socket === current;
    current.onopen = () => {
      if (!active()) return;
      failures = 0;
      lastFrame = Date.now();
      status(true);
      if (catchUp) for (const subscriber of subscribers) subscriber.catchUp();
      heartbeat = setInterval(() => {
        if (!active()) return;
        if (Date.now() - lastFrame > 65_000) current.close();
        else { try { current.send("ping"); } catch { current.close(); } }
      }, 25_000);
    };
    current.onmessage = (message) => {
      if (!active() || typeof message.data !== "string") return;
      lastFrame = Date.now();
      if (message.data === "pong" || message.data.length > 65_536) return;
      try {
        const event = JSON.parse(message.data) as WorkspaceEvent;
        if (!event || event.workspaceId !== workspaceId || typeof event.kind !== "string" || typeof event.entityId !== "string") return;
        for (const subscriber of subscribers) subscriber.event(event);
      } catch { /* Ignore malformed frames. */ }
    };
    current.onclose = () => {
      if (!active()) return;
      socket = undefined;
      clearInterval(heartbeat);
      schedule();
    };
    current.onerror = () => { if (active()) current.close(); };
  };
  return {
    subscribers,
    start,
    get connected() { return connected; },
    stop() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      socket?.close();
    },
  };
}

/** Disconnected callers keep their existing HTTP polling; reconnect repairs missed events. */
export function useWorkspaceEvents(options: UseWorkspaceEventsOptions): boolean {
  const callbacks = useRef(options);
  callbacks.current = options;
  const [state, setState] = useState({ workspaceId: "", connected: false });
  const { enabled } = options;
  const workspaceId = options.workspaceId?.trim().toLowerCase() ?? "";
  useEffect(() => {
    if (!enabled || !workspaceId || typeof WebSocket === "undefined") return;
    let connection = connections.get(workspaceId);
    const fresh = !connection;
    if (!connection) {
      connection = connectWorkspace(workspaceId);
      connections.set(workspaceId, connection);
    }
    const subscriber: Subscriber = {
      event: (event) => callbacks.current.onEvent(event),
      status: (connected) => setState({ workspaceId, connected }),
      catchUp: () => callbacks.current.onReconnect?.(),
    };
    connection.subscribers.add(subscriber);
    subscriber.status(connection.connected);
    if (fresh) connection.start();
    return () => {
      connection.subscribers.delete(subscriber);
      if (!connection.subscribers.size) {
        connection.stop();
        connections.delete(workspaceId);
      }
    };
  }, [enabled, workspaceId]);
  return enabled && state.workspaceId === workspaceId && state.connected;
}
