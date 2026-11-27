import { useEffect, useRef } from "react";
import { EditorContent, type Editor } from "@tiptap/react";
import type { KnowledgeNote } from "@shiba/shared";
import { Bold, Italic, Heading1, Heading2, List, ListOrdered, Code, Quote, Strikethrough, Undo2, Redo2 } from "lucide-react";
import { NoteSuggestions } from "./NoteSuggestions";

export function NoteDocument({ editor, notes, title, loading, saveStatus, readOnly = false, onTitleChange, onSave }: {
  editor: Editor; notes: KnowledgeNote[]; title: string; loading: boolean; saveStatus: string; readOnly?: boolean;
  onTitleChange: (value: string) => void; onSave: () => Promise<void>;
}) {
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (titleRef.current) { titleRef.current.style.height = "auto"; titleRef.current.style.height = `${titleRef.current.scrollHeight}px`; }
  }, [title]);
  const actions = [
    { label: "Undo", icon: Undo2, run: () => editor.chain().focus().undo().run() },
    { label: "Redo", icon: Redo2, run: () => editor.chain().focus().redo().run() },
    { label: "Heading 1", icon: Heading1, active: editor.isActive("heading", { level: 1 }), run: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: "Heading 2", icon: Heading2, active: editor.isActive("heading", { level: 2 }), run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: "Bold", icon: Bold, active: editor.isActive("bold"), run: () => editor.chain().focus().toggleBold().run() },
    { label: "Italic", icon: Italic, active: editor.isActive("italic"), run: () => editor.chain().focus().toggleItalic().run() },
    { label: "Strikethrough", icon: Strikethrough, active: editor.isActive("strike"), run: () => editor.chain().focus().toggleStrike().run() },
    { label: "Inline code", icon: Code, active: editor.isActive("code"), run: () => editor.chain().focus().toggleCode().run() },
    { label: "Bulleted list", icon: List, active: editor.isActive("bulletList"), run: () => editor.chain().focus().toggleBulletList().run() },
    { label: "Numbered list", icon: ListOrdered, active: editor.isActive("orderedList"), run: () => editor.chain().focus().toggleOrderedList().run() },
    { label: "Quote", icon: Quote, active: editor.isActive("blockquote"), run: () => editor.chain().focus().toggleBlockquote().run() },
  ];
  return <>
    <header className="flex min-h-16 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-1)] px-5">
      <span className="truncate text-sm">{title || "Untitled"}</span>
      <span role="status" className="text-xs text-[var(--knowledge-muted)]">{saveStatus}</span>
    </header>
    <div role="toolbar" aria-label="Note formatting" className="sticky top-0 flex flex-wrap items-center justify-center gap-0.5 border-b border-[var(--border-1)] bg-[var(--card)] px-3 py-2">
      {actions.map(({ label, icon: Icon, active, run }) => <button type="button" key={label} title={label} aria-label={label} aria-pressed={active} disabled={loading || readOnly}
        className={`grid size-8 place-items-center rounded-md hover:bg-[var(--surface-subtle)] disabled:opacity-40 ${active ? "bg-[var(--surface-subtle)]" : ""}`}
        onMouseDown={(event) => event.preventDefault()} onClick={run}><Icon size={15} /></button>)}
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-10 sm:px-10">
      {loading ? <div role="status" aria-label="Loading note" className="mx-auto max-w-[760px] space-y-4 motion-safe:animate-pulse"><div className="h-10 w-2/3 rounded-xl bg-[var(--surface-subtle)]" /><div className="h-4 rounded-xl bg-[var(--surface-subtle)]" /><div className="h-4 w-4/5 rounded-xl bg-[var(--surface-subtle)]" /></div> : <div className="mx-auto max-w-[760px]">
        <textarea ref={titleRef} rows={1} aria-label="Note title" placeholder="Untitled" value={title} spellCheck={false}
          readOnly={readOnly}
          className="mb-1.5 block min-h-12 w-full resize-none overflow-hidden rounded-xl border-0 bg-transparent p-0 text-[30px] font-bold leading-[1.18] tracking-[-0.02em] outline-none placeholder:text-[var(--muted-light)] read-only:cursor-default sm:text-[38px]"
          onChange={(event) => onTitleChange(event.target.value.replace(/\n/g, " "))} onBlur={() => void onSave()}
          onKeyDown={(event) => {
            if ((event.key === "Enter" || event.key === "Tab" || (event.key === "ArrowDown" && event.currentTarget.selectionStart === title.length)) && !event.shiftKey) {
              event.preventDefault(); void onSave().then(() => editor.commands.focus());
            }
          }} />
        <p className="mb-6 text-xs text-[var(--muted-light)]">{editor.getText().trim().split(/\s+/).filter(Boolean).length} words</p>
        <EditorContent editor={editor} data-testid="composer" className="note-writing-surface text-sm leading-7 [&_.ProseMirror]:min-h-[18rem] [&_.ProseMirror]:outline-none" />
      </div>}
    </div>
    {!loading && <NoteSuggestions editor={editor} notes={notes} />}
  </>;
}
