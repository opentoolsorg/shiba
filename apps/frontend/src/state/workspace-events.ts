import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceEventsStreamPath, type WorkspaceEvent } from "@shiba/shared";

export interface UseWorkspaceEventsOptions {
  workspaceId: string | null;
  enabled: boolean;
  onEvent: (event: WorkspaceEvent) => void;
}

/** Subscribe to workspace live updates (SSE); replaces polling when connected. */
export function useWorkspaceEvents({ workspaceId, enabled, onEvent }: UseWorkspaceEventsOptions): boolean {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [connected, setConnected] = useState(false);

  const parse = useCallback((raw: string) => {
    try {
      const event = JSON.parse(raw) as WorkspaceEvent;
      if (typeof event.kind === "string" && typeof event.entityId === "string") handler.current(event);
    } catch {
      // Ignore malformed frames.
    }
  }, []);

  useEffect(() => {
    if (!enabled || !workspaceId) {
      setConnected(false);
      return;
    }
    const source = new EventSource(workspaceEventsStreamPath(workspaceId));
    source.onopen = () => setConnected(true);
    source.onmessage = (message) => {
      if (message.data) parse(message.data);
    };
    source.onerror = () => setConnected(false);
    return () => {
      source.close();
      setConnected(false);
    };
  }, [enabled, workspaceId, parse]);

  return connected;
}