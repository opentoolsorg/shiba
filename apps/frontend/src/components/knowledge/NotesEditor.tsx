import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { knowledgeNoteSchema, type KnowledgeNote, type KnowledgeScope } from "@shiba/shared";
import { LoadErrorState } from "../LoadErrorState";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";
import { toast } from "sonner";
import { useWorkspaceEvents } from "../../state/workspace-events";
import { optimisticMutation } from "../../state/optimistic";
import { patchNotes } from "../../state/note-events";
import { NoteChatPanel } from "./NoteChatPanel";
import { NoteDocument } from "./NoteDocument";
import { parseNoteMarkdown, serializeNoteMarkdown } from "./note-markdown";

function editorMarkdown(editor: NonNullable<ReturnType<typeof useEditor>>): string {
  return serializeNoteMarkdown(editor.getJSON());
}

export function NotesEditor({ workspaceId = null }: { workspaceId?: string | null }): JSX.Element {
  const [scope, setScope] = useState<KnowledgeScope>("personal");
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState("Untitled");
  const titleRef = useRef(title);
  titleRef.current = title;
  const [version, setVersion] = useState(1);
  const activeVersionRef = useRef(version);
  activeVersionRef.current = version;
  const [loading, setLoading] = useState(true);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saveStatus, setSaveStatus] = useState("Saved");
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const saving = useRef(false);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const bodyReady = useRef(false);
  const [bodyRevision, setBodyRevision] = useState(0);
  const dirty = useRef(false);
  const draftRevision = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const latestSave = useRef<() => Promise<void>>(async () => {});
  const eventRevision = useRef(0);
  const pendingIdsRef = useRef(new Set<string>());
  const context = `${workspaceId}:${scope}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editor = useEditor({
    extensions: [StarterKit, Placeholder.configure({ placeholder: "Write something, or press '/' for commands…" })],
    content: "<p></p>",
    editable: false,
    onUpdate: () => { if (bodyReady.current) markDirty(); },
  });

  function markDirty() {
    dirty.current = true;
    draftRevision.current++;
    setSaveStatus("Unsaved changes");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void latestSave.current(); }, 600);
  }

  const loadNotes = useCallback(async () => {
    const revision = eventRevision.current;
    const response = await fetch(`/api/notes?scope=${scope}`, { credentials: "same-origin", cache: "no-store", headers: teamWorkspaceHeaders(workspaceId ?? undefined) });
    const body = await response.json() as { notes?: KnowledgeNote[]; error?: string };
    if (!response.ok || !Array.isArray(body.notes)) throw new Error(body.error ?? "Notes unavailable.");
    if (contextRef.current !== context) return;
    const loaded = body.notes;
    setNotes((current) => {
      const rows = new Map(loaded.map((note) => [note.id, note]));
      for (const note of current) {
        const fetched = rows.get(note.id);
        if (pendingIdsRef.current.has(note.id) || (revision !== eventRevision.current && (!fetched || fetched.version <= note.version))) rows.set(note.id, note);
      }
      return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    });
    const selected = loaded.find((note) => note.id === activeIdRef.current);
    if (selected && !dirty.current && !pendingIdsRef.current.has(selected.id) && selected.version > activeVersionRef.current) {
      activeVersionRef.current = selected.version;
      setTitle(selected.title); setVersion(selected.version); setBodyRevision((value) => value + 1);
    }
  }, [scope, workspaceId, context]);

  useEffect(() => { setLoading(true); void loadNotes().catch((err: unknown) => setError(err instanceof Error ? err.message : "Notes failed to load.")).finally(() => setLoading(false)); }, [loadNotes]);

  const live = useWorkspaceEvents({
    workspaceId, enabled: Boolean(workspaceId),
    onEvent: (event) => {
      if (!workspaceId || !event.kind.startsWith("note.")) return;
      eventRevision.current++;
      if (pendingIdsRef.current.has(event.entityId)) return;
      setNotes((current) => patchNotes(current, event, workspaceId, scope));
      if (event.entityId === activeIdRef.current && !dirty.current && event.kind === "note.updated") {
        const parsed = knowledgeNoteSchema.safeParse(event.payload?.note);
        const note = parsed.success ? parsed.data : undefined;
        if (note?.scope === scope && note.workspaceId === workspaceId && note.id === event.entityId && note.version > activeVersionRef.current) {
          activeVersionRef.current = note.version;
          setTitle(note.title); setVersion(note.version); setBodyRevision((value) => value + 1);
        }
      }
    },
    onReconnect: () => { void loadNotes().catch(() => {}); },
  });

  useEffect(() => {
    if (live) return;
    const timer = setInterval(() => { void loadNotes().catch(() => {}); }, 5_000);
    return () => clearInterval(timer);
  }, [live, loadNotes]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, [scope, workspaceId]);

  useEffect(() => {
    bodyReady.current = false;
    dirty.current = false;
    if (!editor) return;
    editor.setEditable(false, false);
    if (!activeId) { setBodyLoading(false); return; }
    setBodyLoading(true);
    setSaveStatus("Saved");
    let stopped = false;
    void fetch(`/api/notes/${encodeURIComponent(activeId)}/body`, { credentials: "same-origin", cache: "no-store", headers: teamWorkspaceHeaders(workspaceId ?? undefined) })
      .then(async (response) => {
        if (!response.ok) throw new Error("Note body unavailable.");
        const markdown = await response.text();
        if (stopped) return;
        editor.commands.setContent(parseNoteMarkdown(markdown), false);
        bodyReady.current = true;
        editor.setEditable(true, false);
        setBodyLoading(false);
      }).catch((cause: unknown) => {
        if (stopped) return;
        setBodyLoading(false);
        setError(cause instanceof Error ? cause.message : "Note body unavailable.");
      });
    return () => { stopped = true; if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [activeId, workspaceId, bodyRevision, editor]);

  useEffect(() => { setNotes([]); setActiveId(null); setError(null); }, [scope, workspaceId]);

  function pending(id: string, value: boolean) {
    if (value) pendingIdsRef.current.add(id); else pendingIdsRef.current.delete(id);
    setPendingIds((current) => {
      const next = new Set(current);
      if (value) next.add(id); else next.delete(id);
      return next;
    });
  }

  // Reads everything it needs from refs so a call queued behind an in-flight save never sends a stale version or title.
  async function persist(ed: NonNullable<typeof editor>) {
    const id = activeIdRef.current;
    if (!id || !bodyReady.current || !dirty.current || id.startsWith("pending:") || saving.current) return;
    const previous = notesRef.current.find((note) => note.id === id);
    const markdown = editorMarkdown(ed);
    const draftTitle = titleRef.current;
    const expectedVersion = activeVersionRef.current;
    const savedRevision = draftRevision.current;
    const savedContext = contextRef.current;
    saving.current = true;
    pending(id, true);
    setSaveStatus("Saving…");
    const saved = await optimisticMutation({
      apply: () => setNotes((current) => current.map((note) => note.id === id ? { ...note, title: draftTitle, updatedAt: Date.now() } : note)),
      commit: async () => {
        const response = await fetch(`/api/notes/${encodeURIComponent(id)}`, {
          method: "PATCH", credentials: "same-origin", headers: { ...teamWorkspaceHeaders(workspaceId ?? undefined), "Content-Type": "application/json" },
          body: JSON.stringify({ title: draftTitle, markdown, expectedVersion }),
        });
        const body = await response.json() as { note?: KnowledgeNote; error?: string };
        if (!response.ok || !body.note) throw new Error(body.error ?? "Autosave failed.");
        return body.note;
      },
      reconcile: (note) => {
        if (contextRef.current !== savedContext) return;
        if (activeIdRef.current === id) {
          activeVersionRef.current = note.version;
          setVersion(note.version);
          if (draftRevision.current === savedRevision) dirty.current = false;
        }
        setNotes((current) => current.map((item) => item.id === id ? note : item));
      },
      rollback: () => {
        if (previous) setNotes((current) => current.map((note) => note.id === id ? previous : note));
      },
      onError: () => toast.error("Note could not be saved. Your draft is still in the editor."),
    });
    pending(id, false);
    saving.current = false;
    if (!saved) { setSaveStatus("Save failed"); return; }
    setSaveStatus(dirty.current ? "Unsaved changes" : "Saved");
    if (dirty.current && activeIdRef.current === id) saveTimer.current = setTimeout(() => { void latestSave.current(); }, 600);
  }

  latestSave.current = async () => {
    if (inFlight.current) await inFlight.current;
    if (!editor) return;
    const request = persist(editor);
    inFlight.current = request;
    await request;
    if (inFlight.current === request) inFlight.current = null;
  };

  // Resolves true once nothing unsaved remains, so callers never navigate away from a draft that failed to save.
  async function saveDraft(): Promise<boolean> {
    await latestSave.current();
    return !dirty.current;
  }

  async function createNote() {
    const id = `pending:${crypto.randomUUID()}`;
    const now = Date.now();
    const optimistic: KnowledgeNote = {
      id, workspaceId: workspaceId ?? "", scope, title: "Untitled", sha256: "", projectId: null,
      version: 1, createdBy: "", createdAt: now, updatedAt: now, ingestion: { state: "pending" },
    };
    pending(id, true);
    await optimisticMutation({
      apply: () => setNotes((current) => [optimistic, ...current]),
      commit: async () => {
        const response = await fetch(`/api/notes?scope=${scope}`, {
          method: "POST", credentials: "same-origin", headers: { ...teamWorkspaceHeaders(workspaceId ?? undefined), "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Untitled", markdown: "" }),
        });
        const body = await response.json() as { note?: KnowledgeNote; error?: string };
        if (!response.ok || !body.note) throw new Error(body.error ?? "Create note failed.");
        return body.note;
      },
      reconcile: (note) => {
        if (contextRef.current !== context) return;
        setNotes((current) => [note, ...current.filter((item) => item.id !== id && item.id !== note.id)]);
        setActiveId(note.id); setTitle(note.title); setVersion(note.version);
        editor?.commands.setContent("<p></p>");
      },
      rollback: () => setNotes((current) => current.filter((note) => note.id !== id)),
      onError: () => toast.error("Note could not be created."),
    });
    pending(id, false);
  }

  async function openNote(note: KnowledgeNote) {
    if (dirty.current && !await saveDraft()) return;
    setActiveId(note.id); setTitle(note.title); setVersion(note.version);
  }

  async function newNote() {
    if (creating || (dirty.current && !await saveDraft())) return;
    setCreating(true);
    try { await createNote(); }
    finally { setCreating(false); }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div data-testid="notes-workspace" className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--card)] text-[var(--fg)] md:flex-row">
        <aside data-testid="secondary-panel" aria-label="Notes" className="flex w-full shrink-0 flex-col border-b border-[var(--border-1)] bg-[var(--sidebar-surface)] md:w-52 md:border-b-0 md:border-r">
          <div className="flex min-h-16 items-center gap-2 border-b border-[var(--border-1)] px-3">
            <button type="button" disabled={creating} className="flex-1 rounded-xl border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-left text-xs disabled:opacity-50" onClick={() => void newNote()}>+ New note</button>
          </div>
          <label className="px-3 py-2 text-xs text-[var(--knowledge-muted)]">Scope
            <select aria-label="Scope" className="ml-2 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-1" value={scope} onChange={(event) => {
              const next = event.target.value as KnowledgeScope;
              if (!dirty.current) setScope(next);
              else void saveDraft().then((clean) => { if (clean) setScope(next); });
            }}><option value="personal">Personal</option><option value="workspace">Workspace</option></select>
          </label>
          <div className="max-h-48 overflow-y-auto p-2 md:max-h-none md:flex-1">
            {loading && !notes.length ? <div role="status" aria-label="Loading notes" className="space-y-2 p-2">{[0, 1, 2].map((i) => <div key={i} className="h-6 rounded-md bg-[var(--surface-subtle)] motion-safe:animate-pulse" />)}</div> : notes.length ? <ul className="space-y-0.5">{notes.map((note) => <li key={note.id} className={pendingIds.has(note.id) ? "opacity-60" : undefined} aria-busy={pendingIds.has(note.id)}>
              <button type="button" disabled={note.id.startsWith("pending:")} aria-current={activeId === note.id ? "page" : undefined} onClick={() => void openNote(note)} className={`w-full truncate rounded-md px-2.5 py-1.5 text-left text-xs ${activeId === note.id ? "bg-[var(--surface-subtle)] text-[var(--fg)]" : "text-[var(--knowledge-muted)] hover:bg-[var(--surface-subtle)]"}`}>{note.title || "Untitled"}</button>
            </li>)}</ul> : <p className="p-2 text-xs text-[var(--knowledge-muted)]">No notes yet</p>}
          </div>
        </aside>
        <section data-testid="note-editor" aria-label="Note editor" className="flex min-h-[28rem] min-w-0 flex-1 flex-col">
          {error && <LoadErrorState message={error} onRetry={() => {
            setError(null);
            if (!dirty.current) setBodyRevision((value) => value + 1);
            void loadNotes().catch((err: unknown) => setError(err instanceof Error ? err.message : "Notes failed to load."));
          }} />}
          {activeId && editor ? <NoteDocument editor={editor} notes={notes} title={title} loading={bodyLoading} saveStatus={saveStatus}
            onTitleChange={(value) => { titleRef.current = value; setTitle(value); markDirty(); }} onSave={() => latestSave.current()} /> : <div className="flex flex-1 items-center justify-center px-6 py-16 text-center"><div>
              <h1 className="mb-2 text-3xl">notes</h1>
              <p className="mb-4 text-sm text-[var(--knowledge-muted)]">Select a note or create a new one</p>
              <button type="button" disabled={creating} onClick={() => void newNote()} className="rounded-xl border border-[var(--border-1)] px-3 py-2 text-sm">+ New Note</button>
            </div></div>}
        </section>
      </div>
      {activeId ? <div className="border-t border-[var(--border-1)] p-3 lg:border-l lg:border-t-0">
        <NoteChatPanel key={`${workspaceId}:${scope}:${activeId}`} noteId={activeId} notes={notes} scope={scope} workspaceId={workspaceId} disabled={bodyLoading || !editor} getDraftBody={() => (editor ? editorMarkdown(editor).slice(0, 24000) : "")} onAdd={(text) => {
          if (!editor || !bodyReady.current) return;
          // Parsed, not inserted as plain text: the serializer escapes literal Markdown characters.
          editor.commands.insertContentAt(editor.state.doc.content.size, parseNoteMarkdown(text).content ?? []);
        }} />
      </div> : null}
    </div>
  );
}
