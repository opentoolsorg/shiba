import { useEffect, useRef, useState } from "react";
import { workspaceEventsPath, type WorkspaceEventMessage } from "@shiba/shared";

export interface UseWorkspaceEventsOptions {
  workspaceId: string | null;
  enabled: boolean;
  onEvent: (event: WorkspaceEventMessage) => void;
}

/** WebSocket subscriber for the WorkspaceEvents Durable Object. */
export function useWorkspaceEvents({ workspaceId, enabled, onEvent }: UseWorkspaceEventsOptions): boolean {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled || !workspaceId || typeof WebSocket === "undefined") {
      setConnected(false);
      return;
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${window.location.host}${workspaceEventsPath(workspaceId)}`);
    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onerror = () => setConnected(false);
    socket.onmessage = (message) => {
      if (typeof message.data !== "string" || message.data === "pong") return;
      try {
        const event = JSON.parse(message.data) as WorkspaceEventMessage;
        if (typeof event.type === "string" && typeof event.resourceId === "string") handler.current(event);
      } catch {
        // Ignore malformed frames.
      }
    };
    const ping = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send("ping");
    }, 25_000);
    return () => {
      window.clearInterval(ping);
      socket.close();
      setConnected(false);
    };
  }, [enabled, workspaceId]);

  return connected;
}