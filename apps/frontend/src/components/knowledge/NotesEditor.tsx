import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { knowledgeNoteSchema, type KnowledgeNote, type KnowledgeScope } from "@shiba/shared";
import type { AppNavView } from "../AppNavRail";
import { LoadErrorState } from "../LoadErrorState";
import { teamWorkspaceHeaders } from "../../team-workspaces-client";
import { toast } from "sonner";
import { useWorkspaceEvents } from "../../state/workspace-events";
import { optimisticMutation } from "../../state/optimistic";
import { patchNotes } from "../../state/note-events";
import { MainCard } from "../ui/ContextPanel";
import { NoteChatPanel } from "./NoteChatPanel";

const SLASH_COMMANDS = [
  { id: "heading", label: "Heading", prefix: "## " },
  { id: "list", label: "Bullet list", prefix: "- " },
  { id: "todo", label: "Todo", prefix: "- [ ] " },
  { id: "code", label: "Code block", prefix: "```\n\n```" },
  { id: "quote", label: "Quote", prefix: "> " },
] as const;

function editorMarkdown(editor: NonNullable<ReturnType<typeof useEditor>>): string {
  const lines: string[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name === "heading") {
      lines.push(`${"#".repeat(node.attrs.level as number)} ${node.textContent}`);
    } else if (node.type.name === "bulletList") {
      node.forEach((item) => lines.push(`- ${item.textContent}`));
    } else if (node.type.name === "codeBlock") {
      lines.push("```", node.textContent, "```");
    } else if (node.type.name === "blockquote") {
      lines.push(`> ${node.textContent}`);
    } else {
      const text = node.textContent.trim();
      if (text) lines.push(text);
    }
  });
  return `${lines.join("\n")}\n`;
}

export function NotesEditor({ workspaceId = null, onNavigate }: { workspaceId?: string | null; onNavigate?: (view: AppNavView) => void }): JSX.Element {
  const [scope, setScope] = useState<KnowledgeScope>("personal");
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState("Untitled");
  const [version, setVersion] = useState(1);
  const activeVersionRef = useRef(version);
  activeVersionRef.current = version;
  const [bodyLoading, setBodyLoading] = useState(false);
  const [menu, setMenu] = useState<typeof SLASH_COMMANDS[number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const saving = useRef(false);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const bodyReady = useRef(false);
  const [bodyRevision, setBodyRevision] = useState(0);
  const dirty = useRef(false);
  const draftRevision = useRef(0);
  const persistRef = useRef<(ed: NonNullable<ReturnType<typeof useEditor>>) => Promise<void>>(async () => {});
  const eventRevision = useRef(0);
  const pendingIdsRef = useRef(new Set<string>());
  const context = `${workspaceId}:${scope}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "Start writing. Type / for commands." }),
    ],
    content: "<p></p>",
    onUpdate: ({ editor: ed }) => {
      if (!bodyReady.current) return;
      dirty.current = true;
      draftRevision.current++;
      const text = ed.getText();
      if (text.endsWith("/")) setMenu(SLASH_COMMANDS[0] ?? null);
      else setMenu(null);
      if (!activeId) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void persist(ed);
      }, 600);
    },
  });

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

  useEffect(() => { void loadNotes().catch((err: unknown) => setError(err instanceof Error ? err.message : "Notes failed to load.")); }, [loadNotes]);

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
    let stopped = false;
    void fetch(`/api/notes/${encodeURIComponent(activeId)}/body`, { credentials: "same-origin", cache: "no-store", headers: teamWorkspaceHeaders(workspaceId ?? undefined) })
      .then(async (response) => {
        if (!response.ok) throw new Error("Note body unavailable.");
        const markdown = await response.text();
        if (stopped) return;
        editor.commands.setContent({ type: "doc", content: markdown.split("\n").map((text) => ({ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) })) });
        bodyReady.current = true;
        editor.setEditable(true, false);
        setBodyLoading(false);
      }).catch(() => { if (!stopped) toast.error("Note body could not be loaded."); });
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

  async function persist(ed: NonNullable<typeof editor>) {
    if (!activeId || !bodyReady.current || !dirty.current || activeId.startsWith("pending:") || saving.current) return;
    const id = activeId;
    const previous = notes.find((note) => note.id === id);
    const markdown = editorMarkdown(ed);
    const savedRevision = draftRevision.current;
    saving.current = true;
    pending(id, true);
    const saved = await optimisticMutation({
      apply: () => setNotes((current) => current.map((note) => note.id === id ? { ...note, title, updatedAt: Date.now() } : note)),
      commit: async () => {
        const response = await fetch(`/api/notes/${encodeURIComponent(id)}`, {
          method: "PATCH", credentials: "same-origin", headers: { ...teamWorkspaceHeaders(workspaceId ?? undefined), "Content-Type": "application/json" },
          body: JSON.stringify({ title, markdown, expectedVersion: version }),
        });
        const body = await response.json() as { note?: KnowledgeNote; error?: string };
        if (!response.ok || !body.note) throw new Error(body.error ?? "Autosave failed.");
        return body.note;
      },
      reconcile: (note) => {
        if (contextRef.current !== context) return;
        if (activeIdRef.current === id) { setVersion(note.version); if (draftRevision.current === savedRevision) dirty.current = false; }
        setNotes((current) => current.map((item) => item.id === id ? note : item));
      },
      rollback: () => {
        if (previous) setNotes((current) => current.map((note) => note.id === id ? previous : note));
      },
      onError: () => toast.error("Note could not be saved. Your draft is still in the editor."),
    });
    pending(id, false);
    saving.current = false;
    if (saved && dirty.current && activeIdRef.current === id) saveTimer.current = setTimeout(() => void persistRef.current(ed), 600);
  }
  persistRef.current = persist;

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

  function applySlash(command: typeof SLASH_COMMANDS[number]) {
    if (!editor) return;
    if (command.id === "heading") editor.chain().focus().toggleHeading({ level: 2 }).run();
    if (command.id === "list") editor.chain().focus().toggleBulletList().run();
    if (command.id === "todo") editor.chain().focus().insertContent("<p>- [ ] </p>").run();
    if (command.id === "code") editor.chain().focus().toggleCodeBlock().run();
    if (command.id === "quote") editor.chain().focus().toggleBlockquote().run();
    setMenu(null);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
      <aside className="w-full shrink-0 lg:w-64">
        <MainCard>
          <header className="mb-3">
            <h1 className="text-lg font-medium">Notes</h1>
            <p className="text-sm text-[var(--muted-foreground-2)]">Rich notes with slash commands and autosave.</p>
          </header>
          <label className="mb-3 block text-xs text-[var(--muted-foreground-2)]">
            Scope
            <select className="ml-2 border border-[var(--border-1)] bg-[var(--card)] px-2 py-1 text-sm" value={scope} onChange={(e) => setScope(e.target.value as KnowledgeScope)}>
              <option value="personal">Personal</option>
              <option value="workspace">Workspace</option>
            </select>
          </label>
          <button type="button" className="mb-3 w-full rounded border border-[var(--border-1)] px-2 py-1 text-sm" onClick={() => void createNote().catch((err: unknown) => setError(err instanceof Error ? err.message : "Create failed."))}>New note</button>
          <ul className="space-y-1 text-sm">
            {notes.map((note) => (
              <li key={note.id} className={pendingIds.has(note.id) ? "opacity-60" : undefined} aria-busy={pendingIds.has(note.id)}>
                <button type="button" disabled={note.id.startsWith("pending:")} className={`w-full truncate rounded px-2 py-1 text-left ${activeId === note.id ? "bg-[var(--panel)]" : ""}`} onClick={() => { setActiveId(note.id); setTitle(note.title); setVersion(note.version); }}>
                  {note.title}
                </button>
              </li>
            ))}
          </ul>
        </MainCard>
      </aside>
      <section className="min-h-[24rem] flex-1 rounded border border-[var(--border-1)] bg-[var(--card)] p-4">
        {error ? <LoadErrorState message={error} onRetry={() => void loadNotes()} /> : null}
        <input className="mb-3 w-full border-0 border-b border-[var(--border-1)] bg-transparent text-lg font-medium outline-none" value={title} onChange={(e) => { dirty.current = true; draftRevision.current++; setTitle(e.target.value); }} onBlur={() => { if (editor) void persist(editor); }} readOnly={bodyLoading || !activeId} aria-label="Note title" />
        {menu ? (
          <div className="mb-2 flex flex-wrap gap-1 rounded border border-[var(--border-1)] bg-[var(--panel)] p-2 text-xs">
            {SLASH_COMMANDS.map((command) => (
              <button key={command.id} type="button" className="rounded px-2 py-1 hover:bg-[var(--card)]" onClick={() => applySlash(command)}>{command.label}</button>
            ))}
          </div>
        ) : null}
        <EditorContent editor={editor} className="prose prose-sm max-w-none min-h-[18rem] text-[var(--fg)] [&_.ProseMirror]:min-h-[18rem] [&_.ProseMirror]:outline-none" />
        {onNavigate ? (
          <p className="mt-3 border-t border-[var(--border-1)] pt-3 text-xs text-[var(--muted-foreground-2)]">
            Notes are not memory until you add them as a source.{" "}
            <button type="button" className="font-medium text-[var(--fg)] underline underline-offset-2" onClick={() => onNavigate("memory")}>Save reviewed text as a memory source</button>
          </p>
        ) : null}
      </section>
      {activeId ? <NoteChatPanel key={`${workspaceId}:${scope}:${activeId}`} noteId={activeId} notes={notes} scope={scope} workspaceId={workspaceId} disabled={bodyLoading || !editor} getDraftBody={() => (editor ? editorMarkdown(editor).slice(0, 24000) : "")} onAdd={(text) => {
        if (!editor || !bodyReady.current) return;
        editor.commands.insertContentAt(editor.state.doc.content.size, text.split("\n").map((line) => ({ type: "paragraph", ...(line ? { content: [{ type: "text", text: line }] } : {}) })));
      }} /> : null}
    </div>
  );
}