import { useEffect, useRef, useState } from "react";
import { workspaceEventsPath, type WorkspaceEvent } from "@shiba/shared";

export interface UseWorkspaceEventsOptions {
  workspaceId: string | null;
  enabled: boolean;
  onEvent: (event: WorkspaceEvent) => void;
}

function parseEvent(raw: string, onEvent: (event: WorkspaceEvent) => void) {
  try {
    const event = JSON.parse(raw) as WorkspaceEvent;
    if (typeof event.kind === "string" && typeof event.entityId === "string") onEvent(event);
  } catch {
    // Ignore malformed frames.
  }
}

/** WebSocket on the WorkspaceEvents Durable Object, with SSE when the binding is absent. */
export function useWorkspaceEvents({ workspaceId, enabled, onEvent }: UseWorkspaceEventsOptions): boolean {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled || !workspaceId) {
      setConnected(false);
      return;
    }
    const path = workspaceEventsPath(workspaceId);
    let closed = false;
    let socket: WebSocket | null = null;
    const startSocket = () => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${proto}//${window.location.host}${path}`);
      socket.onopen = () => setConnected(true);
      socket.onclose = () => setConnected(false);
      socket.onerror = () => setConnected(false);
      socket.onmessage = (message) => {
        if (typeof message.data === "string" && message.data !== "pong") parseEvent(message.data, (event) => handler.current(event));
      };
    };
    void fetch(path, { headers: { Accept: "text/event-stream" }, credentials: "same-origin" }).then((response) => {
      if (closed) return;
      if (response.headers.get("content-type")?.includes("text/event-stream") && response.body) {
        setConnected(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const pump = async () => {
          while (!closed) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const data = frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
              if (data && data !== "{}") parseEvent(data, (event) => handler.current(event));
            }
          }
          if (!closed) setConnected(false);
        };
        void pump();
        return;
      }
      startSocket();
    }).catch(() => {
      if (!closed) startSocket();
    });
    const ping = window.setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
    }, 25_000);
    return () => {
      closed = true;
      window.clearInterval(ping);
      socket?.close();
      setConnected(false);
    };
  }, [enabled, workspaceId]);

  return connected;
}