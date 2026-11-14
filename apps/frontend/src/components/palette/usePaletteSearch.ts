import { useEffect, useRef, useState } from "react";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";

export interface PaletteChatHit {
  roomId: string;
  threadRootId: string | null;
  messageId: string | null;
  title: string;
  snippet: string;
  updatedAt: number;
}

export interface PaletteTaskHit {
  taskId: string;
  title: string;
  snippet: string;
  updatedAt: number;
  status?: string | null;
  ownerId?: string | null;
}

export function usePaletteSearch(workspaceId: string | null, query: string, open: boolean) {
  const [chats, setChats] = useState<PaletteChatHit[]>([]);
  const [tasks, setTasks] = useState<PaletteTaskHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [skeleton, setSkeleton] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!open || !workspaceId || trimmed.length < 2) {
      setChats([]); setTasks([]); setLoading(false); setSkeleton(false); setUnavailable(false);
      return;
    }
    const id = ++seq.current;
    const ctrl = new AbortController();
    setLoading(true);
    setSkeleton(false);
    const timer = window.setTimeout(() => {
      const bones = window.setTimeout(() => { if (seq.current === id) setSkeleton(true); }, 150);
      void fetch(`/api/search?q=${encodeURIComponent(trimmed)}&types=chats,tasks`, {
        credentials: "same-origin",
        headers: teamWorkspaceHeaders(workspaceId),
        signal: ctrl.signal,
      }).then(async (response) => {
        if (seq.current !== id) return;
        if (response.status === 503) { setUnavailable(true); setChats([]); setTasks([]); return; }
        setUnavailable(false);
        if (!response.ok) return;
        const body = await response.json() as { chats?: PaletteChatHit[]; tasks?: PaletteTaskHit[] };
        setChats(body.chats ?? []);
        setTasks(body.tasks ?? []);
      }).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (seq.current !== id) return;
      }).finally(() => {
        window.clearTimeout(bones);
        if (seq.current === id) { setLoading(false); setSkeleton(false); }
      });
    }, 120);
    return () => { seq.current += 1; ctrl.abort(); window.clearTimeout(timer); };
  }, [open, query, workspaceId]);

  return { chats, tasks, loading, skeleton, unavailable };
}
