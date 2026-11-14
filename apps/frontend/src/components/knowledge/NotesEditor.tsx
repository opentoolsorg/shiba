import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { KnowledgeNote, KnowledgeScope } from "@shiba/shared";
import { LoadErrorState } from "../LoadErrorState";
import { MainCard } from "../ui/ContextPanel";

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

export function NotesEditor(): JSX.Element {
  const [scope, setScope] = useState<KnowledgeScope>("personal");
  const [notes, setNotes] = useState<KnowledgeNote[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState("Untitled");
  const [version, setVersion] = useState(1);
  const [menu, setMenu] = useState<typeof SLASH_COMMANDS[number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "Start writing. Type / for commands." }),
    ],
    content: "<p></p>",
    onUpdate: ({ editor: ed }) => {
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
    const response = await fetch(`/api/notes?scope=${scope}`, { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as { notes?: KnowledgeNote[]; error?: string };
    if (!response.ok || !Array.isArray(body.notes)) throw new Error(body.error ?? "Notes unavailable.");
    setNotes(body.notes);
  }, [scope]);

  useEffect(() => { void loadNotes().catch((err: unknown) => setError(err instanceof Error ? err.message : "Notes failed to load.")); }, [loadNotes]);

  async function persist(ed: NonNullable<typeof editor>) {
    if (!activeId) return;
    const response = await fetch(`/api/notes/${encodeURIComponent(activeId)}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, markdown: editorMarkdown(ed), expectedVersion: version }),
    });
    const body = await response.json() as { note?: KnowledgeNote; error?: string };
    if (!response.ok || !body.note) throw new Error(body.error ?? "Autosave failed.");
    setVersion(body.note.version);
  }

  async function createNote() {
    const response = await fetch("/api/notes", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Untitled", markdown: "", scope }),
    });
    const body = await response.json() as { note?: KnowledgeNote; error?: string };
    if (!response.ok || !body.note) throw new Error(body.error ?? "Create note failed.");
    setActiveId(body.note.id);
    setTitle(body.note.title);
    setVersion(body.note.version);
    editor?.commands.setContent("<p></p>");
    await loadNotes();
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
              <li key={note.id}>
                <button type="button" className={`w-full truncate rounded px-2 py-1 text-left ${activeId === note.id ? "bg-[var(--panel)]" : ""}`} onClick={() => { setActiveId(note.id); setTitle(note.title); setVersion(note.version); }}>
                  {note.title}
                </button>
              </li>
            ))}
          </ul>
        </MainCard>
      </aside>
      <section className="min-h-[24rem] flex-1 rounded border border-[var(--border-1)] bg-[var(--card)] p-4">
        {error ? <LoadErrorState message={error} onRetry={() => void loadNotes()} /> : null}
        <input className="mb-3 w-full border-0 border-b border-[var(--border-1)] bg-transparent text-lg font-medium outline-none" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Note title" />
        {menu ? (
          <div className="mb-2 flex flex-wrap gap-1 rounded border border-[var(--border-1)] bg-[var(--panel)] p-2 text-xs">
            {SLASH_COMMANDS.map((command) => (
              <button key={command.id} type="button" className="rounded px-2 py-1 hover:bg-[var(--card)]" onClick={() => applySlash(command)}>{command.label}</button>
            ))}
          </div>
        ) : null}
        <EditorContent editor={editor} className="prose prose-sm max-w-none min-h-[18rem] text-[var(--fg)] [&_.ProseMirror]:min-h-[18rem] [&_.ProseMirror]:outline-none" />
      </section>
    </div>
  );
}