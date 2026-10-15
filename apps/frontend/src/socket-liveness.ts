import { useEffect } from "react";

// Off until the orchestrator answers {"type":"shiba:ping"} (plan B2); without
// a pong, every idle socket would be force-reconnected each 40 s.
const SOCKET_PING_ENABLED = false;
const PING_EVERY_MS = 15_000;
const DEAD_AFTER_MS = 40_000;

interface LiveSocket {
  readonly readyState: number;
  send(data: string): void;
  reconnect(): void;
  addEventListener(type: "open" | "close" | "message", listener: () => void): void;
  removeEventListener(type: "open" | "close" | "message", listener: () => void): void;
}

/** Calls `onReopen` after a dropped socket reconnects; pings and revives a silent one when enabled. */
export function useSocketLiveness(socket: LiveSocket, enabled: boolean, onReopen: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    let lastSeen = Date.now();
    let dropped = false;
    const onMessage = () => {
      lastSeen = Date.now();
    };
    const onClose = () => {
      dropped = true;
    };
    const onOpen = () => {
      lastSeen = Date.now();
      if (dropped) onReopen();
      dropped = false;
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("open", onOpen);
    const timer = SOCKET_PING_ENABLED
      ? window.setInterval(() => {
          if (!navigator.onLine || socket.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastSeen > DEAD_AFTER_MS) {
            lastSeen = Date.now();
            socket.reconnect();
          } else {
            socket.send('{"type":"shiba:ping"}');
          }
        }, PING_EVERY_MS)
      : undefined;
    return () => {
      window.clearInterval(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("open", onOpen);
    };
  }, [socket, enabled, onReopen]);
}
