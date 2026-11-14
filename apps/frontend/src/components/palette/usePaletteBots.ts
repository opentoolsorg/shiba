import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMascotLook, CustomAgentMascotPreset } from "@shiba/shared";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";
import { useWorkspaceEvents } from "../../state/workspace-events";

export interface PaletteBot {
  agentId: string;
  actorId: string;
  name: string;
  avatar: { mascotPreset?: CustomAgentMascotPreset; look?: AgentMascotLook } | null;
  pinnedSlot: number | null;
  preview: string | null;
  previewAt: number | null;
  roomId: string | null;
  threadRootId: string | null;
  state: "working" | "needs_you" | "idle";
  unread: number | null;
}

const cache = new Map<string, { at: number; bots: PaletteBot[] }>();

export function usePaletteBots(workspaceId: string | null, open: boolean): { bots: PaletteBot[]; refresh: () => Promise<void> } {
  const [bots, setBots] = useState<PaletteBot[]>([]);
  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const response = await fetch("/api/palette/bots", { credentials: "same-origin", headers: teamWorkspaceHeaders(workspaceId) });
    if (!response.ok) return;
    const body = await response.json() as { bots?: PaletteBot[] };
    const next = body.bots ?? [];
    cache.set(workspaceId, { at: Date.now(), bots: next });
    setBots(next);
  }, [workspaceId]);

  useEffect(() => {
    if (!open || !workspaceId) return;
    const hit = cache.get(workspaceId);
    if (hit && Date.now() - hit.at < 30_000) { setBots(hit.bots); return; }
    void refresh();
  }, [open, refresh, workspaceId]);

  const last = useRef(0);
  const wait = useRef<number | null>(null);
  useWorkspaceEvents({
    workspaceId,
    enabled: open && Boolean(workspaceId),
    onEvent: (event) => {
      if (event.kind !== "room.message" && event.kind !== "run.updated") return;
      const due = 2000 - (Date.now() - last.current);
      if (due <= 0) { last.current = Date.now(); void refresh(); return; }
      if (wait.current != null) return;
      wait.current = window.setTimeout(() => { wait.current = null; last.current = Date.now(); void refresh(); }, due);
    },
  });

  return { bots, refresh };
}
