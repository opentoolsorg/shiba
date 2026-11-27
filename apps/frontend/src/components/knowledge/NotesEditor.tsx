import { useEditor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { knowledgeNoteSchema, type KnowledgeNote, type KnowledgeScope } from "@shiba/shared";
import type { AppNavView } from "../AppNavRail";
import { LoadErrorState } from "../LoadErrorState";
import { Plus } from "lucide-react";
import { consumeNewNoteIntent } from "./new-note-intent";
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

function loadEditorBody(editor: NonNullable<ReturnType<typeof useEditor>>, markdown: string) {
  editor.commands.setContent(parseNoteMarkdown(markdown), false);
  return { markdown, doc: editor.state.doc };
}

async function readNoteBody(id: string, workspaceId: string | null) {
  const response = await fetch(`/api/notes/${encodeURIComponent(id)}/body`, { credentials: "same-origin", cache: "no-store", headers: teamWorkspaceHeaders(workspaceId ?? undefined) });
  if (!response.ok) throw new Error("Note body unavailable.");
  return response.text();
}

class NoteVersionConflict extends Error {}

export function NotesEditor({ workspaceId = null, workspaceRole, actorId, onNavigate }: { workspaceId?: string | null; workspaceRole?: "owner" | "admin" | "member"; actorId?: string; onNavigate?: (view: AppNavView) => void }): JSX.Element {
  const [scope, setScope] = useState<KnowledgeScope>("personal");
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitleState] = useState("Untitled");
  const titleRef = useRef(title);
  const setTitle = useCallback((value: string) => {
    titleRef.current = value;
    setTitleState(value);
  }, []);
  const activeVersionRef = useRef(1);
  const [loading, setLoading] = useState(true);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [openingMemory, setOpeningMemory] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState("Saved");
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const saving = useRef<Promise<boolean> | null>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const bodyReady = useRef(false);
  const savedBody = useRef<{ markdown: string; doc: ProseMirrorNode } | null>(null);
  const [bodyRevision, setBodyRevision] = useState(0);
  const dirty = useRef(false);
  const conflicted = useRef(false);
  const draftRevision = useRef(0);
  const latestSave = useRef<() => Promise<boolean>>(async () => false);
  const eventRevision = useRef(0);
  const pendingIdsRef = useRef(new Set<string>());
  const normalizedActorId = actorId?.trim().toLowerCase();
  const canWriteNote = useCallback((note: KnowledgeNote) => {
    if (!workspaceId || !workspaceRole) return true;
    if (workspaceRole === "owner" || workspaceRole === "admin") return true;
    return Boolean(normalizedActorId && note.createdBy.trim().toLowerCase() === normalizedActorId);
  }, [workspaceId, workspaceRole, normalizedActorId]);

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
    if (conflicted.current) return;
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
      setTitle(selected.title); setBodyRevision((value) => value + 1);
    }
  }, [scope, workspaceId, context, setTitle]);

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
          setTitle(note.title); setBodyRevision((value) => value + 1);
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
    savedBody.current = null;
    dirty.current = false;
    conflicted.current = false;
    if (!editor) return;
    editor.setEditable(false, false);
    if (!activeId) { setBodyLoading(false); return; }
    setBodyLoading(true);
    setSaveStatus("Saved");
    let stopped = false;
    void readNoteBody(activeId, workspaceId)
      .then((markdown) => {
        if (stopped) return;
        savedBody.current = loadEditorBody(editor, markdown);
        bodyReady.current = true;
        const loadedNote = notesRef.current.find((note) => note.id === activeId);
        editor.setEditable(loadedNote ? canWriteNote(loadedNote) : false, false);
        setBodyLoading(false);
      }).catch((cause: unknown) => {
        if (stopped) return;
        setBodyLoading(false);
        setError(cause instanceof Error ? cause.message : "Note body unavailable.");
      });
    return () => { stopped = true; if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [activeId, workspaceId, bodyRevision, editor, canWriteNote]);

  useEffect(() => {
    if (!editor || !bodyReady.current) return;
    const note = notes.find((item) => item.id === activeId);
    editor.setEditable(note ? canWriteNote(note) : false, false);
  }, [editor, notes, activeId, canWriteNote]);

  useEffect(() => { setNotes([]); setActiveId(null); setError(null); }, [scope, workspaceId]);

  function pending(id: string, value: boolean) {
    if (value) pendingIdsRef.current.add(id); else pendingIdsRef.current.delete(id);
    setPendingIds((current) => {
      const next = new Set(current);
      if (value) next.add(id); else next.delete(id);
      return next;
    });
  }

  function draftMarkdown(ed: NonNullable<typeof editor>) {
    const saved = savedBody.current;
    return saved?.doc.eq(ed.state.doc) ? saved.markdown : editorMarkdown(ed);
  }

  async function persist(ed: NonNullable<typeof editor>): Promise<boolean> {
    if (saving.current) return saving.current;
    if (!dirty.current) return true;
    const id = activeIdRef.current;
    if (!id || !bodyReady.current || conflicted.current || id.startsWith("pending:")) return false;
    const stillEditing = () => activeIdRef.current === id && contextRef.current === context && !ed.isDestroyed;
    const flushDraft = async () => {
      let previous = notesRef.current.find((note) => note.id === id);
      while (stillEditing() && dirty.current) {
        const doc = ed.state.doc;
        const markdown = draftMarkdown(ed);
        const title = titleRef.current;
        const expectedVersion = activeVersionRef.current;
        const savedRevision = draftRevision.current;
        const beforeSave = previous;
        setSaveStatus("Saving…");
        const saved = await optimisticMutation({
          apply: () => setNotes((current) => current.map((note) => note.id === id ? { ...note, title, updatedAt: Date.now() } : note)),
          commit: async () => {
            const response = await fetch(`/api/notes/${encodeURIComponent(id)}`, {
              method: "PATCH", credentials: "same-origin", headers: { ...teamWorkspaceHeaders(workspaceId ?? undefined), "Content-Type": "application/json" },
              body: JSON.stringify({ title, markdown, expectedVersion }),
            });
            if (response.status === 409) throw new NoteVersionConflict();
            const body = await response.json() as { note?: KnowledgeNote; error?: string };
            if (!response.ok || !body.note) throw new Error(body.error ?? "Autosave failed.");
            return body.note;
          },
          reconcile: (note) => {
            if (contextRef.current !== context) return;
            if (stillEditing()) {
              savedBody.current = { markdown, doc };
              activeVersionRef.current = note.version;
              if (draftRevision.current === savedRevision) dirty.current = false;
            }
            setNotes((current) => current.map((item) => item.id === id ? note : item));
          },
          rollback: () => {
            if (beforeSave && contextRef.current === context) setNotes((current) => current.map((note) => note.id === id ? beforeSave : note));
          },
          onError: (cause) => {
            if (!stillEditing()) return;
            if (cause instanceof NoteVersionConflict) {
              conflicted.current = true;
              if (saveTimer.current) clearTimeout(saveTimer.current);
            } else {
              toast.error("Note could not be saved. Your draft is still in the editor.");
            }
          },
        });
        if (!saved) {
          if (stillEditing()) setSaveStatus(conflicted.current ? "Version conflict" : "Save failed");
          return false;
        }
        previous = saved;
      }
      if (!stillEditing()) return false;
      setSaveStatus("Saved");
      return true;
    };
    pending(id, true);
    saving.current = flushDraft().finally(() => {
      pending(id, false);
      saving.current = null;
    });
    return saving.current;
  }

  latestSave.current = async () => editor ? persist(editor) : !dirty.current;

  // Resolves true once nothing unsaved remains, so callers never navigate away from a draft that failed to save.
  async function saveDraft(): Promise<boolean> {
    const id = activeIdRef.current;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    do {
      if (!await latestSave.current()) return false;
      if (contextRef.current !== context || activeIdRef.current !== id || editor?.isDestroyed) return false;
    } while (dirty.current);
    return true;
  }

  async function openMemory() {
    if (!onNavigate || openingMemory) return;
    if (!dirty.current && !saving.current) { onNavigate("memory"); return; }
    setOpeningMemory(true);
    try {
      if (await saveDraft()) onNavigate("memory");
    } finally {
      setOpeningMemory(false);
    }
  }

  async function createNote(draft = { title: "Untitled", markdown: "" }) {
    const id = `pending:${crypto.randomUUID()}`;
    const now = Date.now();
    const optimistic: KnowledgeNote = {
      id, workspaceId: workspaceId ?? "", scope, title: draft.title, sha256: "", projectId: null,
      version: 1, createdBy: "", createdAt: now, updatedAt: now, ingestion: { state: "pending" },
    };
    pending(id, true);
    const created = await optimisticMutation({
      apply: () => setNotes((current) => [optimistic, ...current]),
      commit: async () => {
        const response = await fetch(`/api/notes?scope=${scope}`, {
          method: "POST", credentials: "same-origin", headers: { ...teamWorkspaceHeaders(workspaceId ?? undefined), "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        });
        const body = await response.json() as { note?: KnowledgeNote; error?: string };
        if (!response.ok || !body.note) throw new Error(body.error ?? "Create note failed.");
        return body.note;
      },
      reconcile: (note) => {
        if (contextRef.current !== context) return;
        setNotes((current) => [note, ...current.filter((item) => item.id !== id && item.id !== note.id)]);
      },
      rollback: () => setNotes((current) => current.filter((note) => note.id !== id)),
      onError: () => toast.error("Note could not be created."),
    });
    pending(id, false);
    return created;
  }

  function selectNote(note: KnowledgeNote) {
    setActiveId(note.id); setTitle(note.title); activeVersionRef.current = note.version;
  }

  async function openNote(note: KnowledgeNote) {
    if (activeIdRef.current === note.id) return;
    if (dirty.current && !await saveDraft()) return;
    selectNote(note);
  }

  async function newNote() {
    if (creating || (dirty.current && !await saveDraft())) return;
    setCreating(true);
    try {
      const note = await createNote();
      if (note && contextRef.current === context) selectNote(note);
    }
    finally { setCreating(false); }
  }

  const newNoteRef = useRef(newNote);
  newNoteRef.current = newNote;
  const queuedNoteScope = useRef<"personal" | "workspace" | null>(null);
  useEffect(() => {
    queuedNoteScope.current = consumeNewNoteIntent();
    if (queuedNoteScope.current && queuedNoteScope.current !== scope) setScope(queuedNoteScope.current);
  }, []);
  useEffect(() => {
    if (!queuedNoteScope.current || queuedNoteScope.current !== scope) return;
    queuedNoteScope.current = null;
    void newNoteRef.current();
  }, [scope]);

  async function recoverConflict(action: "copy" | "reload") {
    const id = activeIdRef.current;
    if (!editor || !id || !conflicted.current || recovering) return;
    const revision = draftRevision.current;
    const isCurrent = () => contextRef.current === context && activeIdRef.current === id;
    setRecovering(true);
    try {
      if (action === "copy") {
        const note = await createNote({ title: `${titleRef.current.trim() || "Untitled"} (copy)`, markdown: draftMarkdown(editor) });
        if (note && isCurrent()) {
          if (draftRevision.current === revision) selectNote(note);
          else toast.info("Draft copied. Your newer changes are still in the editor.");
        }
        return;
      }
      const response = await fetch(`/api/notes/${encodeURIComponent(id)}`, {
        credentials: "same-origin", cache: "no-store", headers: teamWorkspaceHeaders(workspaceId ?? undefined),
      });
      if (!response.ok) throw new Error("Note unavailable.");
      const { note } = await response.json() as { note?: KnowledgeNote };
      if (note?.id !== id) throw new Error("Note unavailable.");
      const markdown = await readNoteBody(id, workspaceId);
      if (!isCurrent()) return;
      if (draftRevision.current !== revision) {
        toast.info("The draft changed while reloading and was kept.");
        return;
      }
      savedBody.current = loadEditorBody(editor, markdown);
      activeVersionRef.current = note.version;
      setTitle(note.title);
      setNotes((current) => current.map((item) => item.id === id && item.version <= note.version ? note : item));
      conflicted.current = false;
      dirty.current = false;
      setSaveStatus("Saved");
    } catch {
      if (isCurrent()) toast.error("Could not reload the latest note. Your draft is still in the editor.");
    } finally {
      setRecovering(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div data-testid="notes-workspace" className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--card)] text-[var(--fg)] md:flex-row">
        <aside data-testid="secondary-panel" aria-label="Notes" className="flex w-full shrink-0 flex-col border-b border-[var(--border-1)] bg-[var(--sidebar-surface)] md:w-52 md:border-b-0 md:border-r">
          <div className="flex min-h-16 items-center gap-2 border-b border-[var(--border-1)] px-3">
            <button type="button" disabled={creating} className="flex flex-1 items-center gap-2 rounded-xl border border-[var(--border-1)] bg-[var(--card)] px-3 py-2 text-left text-xs disabled:opacity-50" onClick={() => void newNote()}><Plus size={13} /> New note</button>
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
        <section data-testid="note-editor" aria-label="Note editor" className="relative flex min-h-[28rem] min-w-0 flex-1 flex-col">
          {saveStatus === "Version conflict" && <div className="border-b border-[var(--border-1)] px-5 py-2 text-sm">
            <p role="alert">This note changed elsewhere. Your draft is still here.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={recovering} className="min-h-11 px-2 underline disabled:opacity-50" onClick={() => void recoverConflict("copy")}>Save draft as a copy</button>
              <button type="button" disabled={recovering} className="min-h-11 px-2 underline disabled:opacity-50" onClick={() => void recoverConflict("reload")}>Discard draft and reload</button>
            </div>
          </div>}
          {error && <LoadErrorState message={error} onRetry={() => {
            setError(null);
            if (!dirty.current) setBodyRevision((value) => value + 1);
            void loadNotes().catch((err: unknown) => setError(err instanceof Error ? err.message : "Notes failed to load."));
          }} />}
          {activeId && editor ? <NoteDocument editor={editor} notes={notes} title={title} loading={bodyLoading} saveStatus={activeId && notes.find((note) => note.id === activeId && !canWriteNote(note)) ? "Read-only" : saveStatus} readOnly={Boolean(activeId && notes.find((note) => note.id === activeId && !canWriteNote(note)))}
            chatOpen={chatOpen} onToggleChat={() => setChatOpen((open) => !open)}
            onTitleChange={(value) => { setTitle(value); markDirty(); }} onSave={async () => { await saveDraft(); }} /> : <div className="flex flex-1 items-center justify-center px-6 py-16 text-center"><div>
              <h1 className="mb-2 font-serif text-3xl font-normal">notes</h1>
              <p className="mb-4 text-sm text-[var(--knowledge-muted)]">Select a note or create a new one</p>
              <button type="button" disabled={creating} onClick={() => void newNote()} className="rounded-xl border border-[var(--border-1)] px-3 py-2 text-sm">+ New Note</button>
            </div></div>}
          {onNavigate && <p className="sr-only">
            Notes are not memory until you add them as a source.{" "}
            <button type="button" disabled={openingMemory} className="min-h-11 font-medium text-[var(--fg)] underline underline-offset-2 disabled:opacity-50" onClick={() => void openMemory()}>Save reviewed text as a memory source</button>
          </p>}
        </section>
      </div>
      {activeId ? <div hidden={!chatOpen} className={chatOpen ? "border-t border-[var(--border-1)] p-3 lg:border-l lg:border-t-0" : "hidden"}>
        <NoteChatPanel key={`${workspaceId}:${scope}:${activeId}`} noteId={activeId} notes={notes} scope={scope} workspaceId={workspaceId} disabled={bodyLoading || !editor || Boolean(activeId && notes.find((note) => note.id === activeId && !canWriteNote(note)))} getDraftBody={() => (editor ? editorMarkdown(editor).slice(0, 24000) : "")} onAdd={(text) => {
          if (!editor || !bodyReady.current) return;
          // Parsed, not inserted as plain text: the serializer escapes literal Markdown characters.
          editor.commands.insertContentAt(editor.state.doc.content.size, parseNoteMarkdown(text).content ?? []);
        }} />
      </div> : null}
    </div>
  );
}
