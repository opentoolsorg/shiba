import { useEffect, useState, type JSX } from "react";
import type { KnowledgeFile, KnowledgeNote, KnowledgeScope, NoteChatMention, NoteChatMessage } from "@shiba/shared";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";

export function NoteChatPanel({ noteId, notes, scope, workspaceId, onAdd, getDraftBody, disabled = false }: {
  noteId: string; notes: KnowledgeNote[]; scope: KnowledgeScope; workspaceId: string | null;
  onAdd: (text: string) => void; getDraftBody?: () => string; disabled?: boolean;
}): JSX.Element {
  const [messages, setMessages] = useState<NoteChatMessage[]>([]);
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [message, setMessage] = useState("");
  const [mentions, setMentions] = useState<NoteChatMention[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filesError, setFilesError] = useState(false);
  const endpoint = `/api/notes/${encodeURIComponent(noteId)}/chat`;

  useEffect(() => {
    const controller = new AbortController();
    const options = { credentials: "same-origin" as const, cache: "no-store" as const, headers: teamWorkspaceHeaders(workspaceId ?? undefined), signal: controller.signal };
    void fetch(endpoint, options).then(async (response) => {
      if (!response.ok) throw new Error("Chat could not be loaded.");
      const body = await response.json() as { messages?: NoteChatMessage[] };
      if (!controller.signal.aborted) setMessages(body.messages ?? []);
    }).catch(() => { if (!controller.signal.aborted) setError("Chat could not be loaded. Please reopen this note to try again."); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    void fetch(`/api/files?scope=${scope}`, options).then(async (response) => {
      if (!response.ok) throw new Error("Files unavailable");
      const body = await response.json() as { files?: KnowledgeFile[] };
      if (!controller.signal.aborted) setFiles(body.files ?? []);
    }).catch(() => { if (!controller.signal.aborted) setFilesError(true); });
    return () => controller.abort();
  }, [endpoint, scope, workspaceId]);

  async function mutate(method: "POST" | "DELETE") {
    setBusy(true); setError(null);
    try {
      const response = await fetch(endpoint, {
        method, credentials: "same-origin", headers: { ...teamWorkspaceHeaders(workspaceId ?? undefined), "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ message, mentions, ...(getDraftBody ? { noteBody: getDraftBody() } : {}) }) } : {}),
      });
      const body = await response.json() as { messages?: NoteChatMessage[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Chat is unavailable. Please try again.");
      setMessages(body.messages ?? []);
      if (method === "POST") { setMessage(""); setMentions([]); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Chat is unavailable. Please try again."); }
    finally { setBusy(false); }
  }

  const query = /(?:^|\s)@([^@\n]*)$/.exec(message);
  const candidates: NoteChatMention[] = [
    ...notes.filter((note) => note.id !== noteId).map((note) => ({ kind: "note" as const, id: note.id, name: note.title })),
    ...files.map((file) => ({ kind: "file" as const, id: file.id, name: file.name })),
  ].filter((item) => item.name.toLowerCase().includes((query?.[1] ?? "").toLowerCase()) && !mentions.some((picked) => picked.kind === item.kind && picked.id === item.id));

  return (
    <aside aria-label="Note chat" className="min-w-0 rounded border border-[var(--border-1)] bg-[var(--card)] p-4 lg:w-80 lg:shrink-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-medium">Ask about this note</h2>
        <button type="button" disabled={busy || !messages.length} onClick={() => void mutate("DELETE")} className="text-sm underline disabled:opacity-50">Clear chat</button>
      </div>
      <div role="log" aria-label="Chat messages" className="max-h-96 space-y-4 overflow-y-auto">
        {!busy && !messages.length ? <p className="text-sm">Ask a question or get help writing.</p> : null}
        {messages.map((item) => <div key={item.id} className="text-sm">
          <p className="font-medium">{item.role === "user" ? "You" : "Assistant"}</p>
          <p className="whitespace-pre-wrap break-words">{item.content}</p>
          {item.role === "assistant" ? <button type="button" disabled={disabled} onClick={() => onAdd(item.content)} className="mt-1 underline disabled:opacity-50">Add to note</button> : null}
        </div>)}
      </div>
      {busy ? <p role="status" className="my-2 text-sm">Please wait…</p> : null}
      {error ? <p role="alert" className="my-2 text-sm">{error}</p> : null}
      <form className="mt-4 space-y-2" onSubmit={(event) => { event.preventDefault(); if (!busy && message.trim()) void mutate("POST"); }}>
        <label className="block text-sm" htmlFor="note-chat-message">Type @ to include another note or file</label>
        <textarea id="note-chat-message" value={message} maxLength={4000} disabled={busy} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!busy && message.trim()) void mutate("POST"); } }} placeholder="Ask about this note" className="min-h-24 w-full rounded border border-[var(--border-1)] bg-transparent p-2 text-sm" />
        <div className="flex flex-wrap gap-1">{mentions.map((item) => <button key={`${item.kind}:${item.id}`} type="button" disabled={busy} aria-label={`Remove ${item.name}`} onClick={() => setMentions((current) => current.filter((picked) => picked !== item))} className="rounded border border-[var(--border-1)] px-2 py-1 text-xs">{item.name} ×</button>)}</div>
        {query && mentions.length < 8 ? <div role="group" aria-label="Include a note or file" className="max-h-48 overflow-y-auto rounded border border-[var(--border-1)] p-1">
          {filesError ? <p className="text-xs">Files could not be loaded.</p> : null}
          {!candidates.length ? <p className="text-sm">No matching notes or files.</p> : null}
          {candidates.slice(0, 20).map((item) => <button type="button" key={`${item.kind}:${item.id}`} className="block w-full px-2 py-1 text-left text-sm" onClick={() => { setMentions((current) => [...current, item]); setMessage(message.slice(0, message.lastIndexOf("@"))); }}>{item.name} ({item.kind})</button>)}
        </div> : null}
        <button type="submit" disabled={busy || !message.trim()} className="rounded border border-[var(--border-1)] px-3 py-1 text-sm disabled:opacity-50">Send</button>
      </form>
    </aside>
  );
}
