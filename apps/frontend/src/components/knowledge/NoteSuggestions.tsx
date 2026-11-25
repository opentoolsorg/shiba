import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import type { KnowledgeNote } from "@shiba/shared";
import { ChevronRight, FileText, Type } from "lucide-react";

const blocks = [
  ["Text", "Plain paragraph", "Basic blocks", ""],
  ["Heading 1", "Large section heading", "Basic blocks", "#"],
  ["Heading 2", "Medium section heading", "Basic blocks", "##"],
  ["Heading 3", "Small section heading", "Basic blocks", "###"],
  ["Bulleted list", "Simple bulleted list", "Basic blocks", "-"],
  ["Numbered list", "List with numbering", "Basic blocks", "1."],
  ["Quote", "Capture a quotation", "Basic blocks", ">"],
  ["Code", "Code block", "Basic blocks", "```"],
  ["Divider", "Separate sections", "Basic blocks", "---"],
  ["Equation", "Inline math", "Media", ""],
  ["Bold", "Make text bold", "Formatting", ""],
  ["Italic", "Make text italic", "Formatting", ""],
  ["Strikethrough", "Strike through text", "Formatting", ""],
  ["Inline code", "Inline code formatting", "Formatting", ""],
] as const;

type Trigger = { kind: "/" | "@"; query: string; from: number; to: number; top: number; left: number };

function applyNoteBlock(editor: Editor, title: string, range: { from: number; to: number }) {
  const chain = editor.chain().focus().deleteRange(range);
  switch (title) {
    case "Text": chain.setParagraph().run(); break;
    case "Heading 1": chain.toggleHeading({ level: 1 }).run(); break;
    case "Heading 2": chain.toggleHeading({ level: 2 }).run(); break;
    case "Heading 3": chain.toggleHeading({ level: 3 }).run(); break;
    case "Bulleted list": chain.toggleBulletList().run(); break;
    case "Numbered list": chain.toggleOrderedList().run(); break;
    case "Quote": chain.toggleBlockquote().run(); break;
    case "Code": chain.toggleCodeBlock().run(); break;
    case "Divider": chain.setHorizontalRule().run(); break;
    case "Equation": chain.insertContent({ type: "text", text: "$E=mc^2$" }).run(); break;
    case "Bold": chain.toggleBold().run(); break;
    case "Italic": chain.toggleItalic().run(); break;
    case "Strikethrough": chain.toggleStrike().run(); break;
    case "Inline code": chain.toggleCode().run(); break;
  }
}

export function NoteSuggestions({ editor, notes }: { editor: Editor; notes: KnowledgeNote[] }) {
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [category, setCategory] = useState(false);
  const [index, setIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const matchingBlocks = blocks.filter((item) => item[0].toLowerCase().includes(trigger?.query.toLowerCase() ?? ""));
  const matchingNotes = notes.filter((note) => note.title.toLowerCase().includes(trigger?.query.toLowerCase() ?? ""));
  const showCategory = trigger?.kind === "@" && !category && !trigger.query;
  const count = trigger?.kind === "/" ? matchingBlocks.length : showCategory ? 1 : matchingNotes.length;

  useEffect(() => {
    const update = () => {
      const { $from, empty } = editor.state.selection;
      const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\ufffc");
      const match = /(?:^|\s)([/@])([^\s/@]*)$/.exec(before);
      if (!empty || !match || editor.isActive("codeBlock")) { setTrigger(null); return; }
      const kind = match[1] as "/" | "@";
      const query = match[2] ?? "";
      const coords = editor.view.coordsAtPos($from.pos);
      setTrigger({ kind, query, from: $from.pos - query.length - 1, to: $from.pos,
        top: Math.max(8, Math.min(coords.bottom + 6, window.innerHeight - 348)),
        left: Math.max(8, Math.min(coords.left, window.innerWidth - 308)) });
      setIndex(0);
      setCategory(false);
    };
    editor.on("selectionUpdate", update);
    editor.on("update", update);
    return () => { editor.off("selectionUpdate", update); editor.off("update", update); };
  }, [editor]);

  const choose = (selected: number) => {
    if (!trigger) return;
    if (showCategory) { setCategory(true); setIndex(0); return; }
    if (trigger.kind === "/") {
      const item = matchingBlocks[selected];
      if (!item) return;
      applyNoteBlock(editor, item[0], trigger);
    } else {
      const note = matchingNotes[selected];
      if (!note) return;
      // A text mention survives the existing Markdown API without a custom node.
      editor.chain().focus().insertContentAt(trigger, { type: "text", text: `@${note.title} ` }).run();
    }
    setTrigger(null);
  };

  useEffect(() => {
    if (!trigger) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || !["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        if (category) { setCategory(false); setIndex(0); } else setTrigger(null);
      } else if (event.key === "ArrowDown") setIndex((value) => Math.min(value + 1, Math.max(0, count - 1)));
      else if (event.key === "ArrowUp") setIndex((value) => Math.max(value - 1, 0));
      else choose(index);
    };
    const outside = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setTrigger(null); };
    editor.view.dom.addEventListener("keydown", keydown, true);
    document.addEventListener("mousedown", outside);
    return () => { editor.view.dom.removeEventListener("keydown", keydown, true); document.removeEventListener("mousedown", outside); };
  });

  useEffect(() => { menuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [index]);
  if (!trigger) return null;
  const rowClass = (selected: boolean) => `flex w-full items-center gap-2.5 rounded-md p-1 text-left ${selected ? "bg-[var(--surface-subtle)]" : "hover:bg-[var(--surface-subtle)]"}`;
  return createPortal(
    <div ref={menuRef} data-testid={trigger.kind === "/" ? "note-slash-menu" : "note-mention-menu"}
      className="fixed z-50 max-h-[340px] w-[300px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-1 text-[13px] shadow-lg"
      style={{ top: trigger.top, left: trigger.left }} onMouseDown={(event) => event.preventDefault()}>
      {trigger.kind === "/" ? <div role="listbox" aria-label="Insert block">
        {trigger.query && <p className="border-b border-[var(--border-1)] px-2 py-1.5 text-xs text-[var(--muted-foreground-2)]">Filter: {trigger.query}</p>}
        {["Basic blocks", "Table", "Media", "Formatting"].map((group) => {
          const items = matchingBlocks.filter((item) => item[2] === group);
          return items.length ? <div role="group" aria-label={group} key={group}>
            <p className="px-2 pb-1 pt-1.5 text-[11.5px] text-[var(--muted-foreground-2)]">{group}</p>
            {items.map((item) => <button type="button" role="option" aria-selected={index === matchingBlocks.indexOf(item)} key={item[0]}
              className={rowClass(index === matchingBlocks.indexOf(item))} onMouseEnter={() => setIndex(matchingBlocks.indexOf(item))} onClick={() => choose(matchingBlocks.indexOf(item))}>
              <span className="grid size-8 shrink-0 place-items-center rounded-md border border-[var(--border-1)] bg-[var(--card)]"><Type size={16} /></span>
              <span className="min-w-0 flex-1"><span className="block font-medium">{item[0]}</span><span className="block text-[11.5px] text-[var(--muted-foreground-2)]">{item[1]}</span></span>
              <kbd className="text-[11px] text-[var(--muted-light)]">{item[3]}</kbd>
            </button>)}
          </div> : null;
        })}
        {!matchingBlocks.length && <p className="px-2 py-2.5 text-[var(--muted-foreground-2)]">No matching blocks</p>}
      </div> : <>
        {category && <div className="flex gap-2 border-b border-[var(--border-1)] px-2 py-1.5 text-[10px] text-[var(--muted-light)]"><button type="button" onClick={() => setCategory(false)}>All</button><ChevronRight size={12} />Notes<span className="ml-auto">esc to go back</span></div>}
        <div role="listbox" aria-label="Mention suggestions">
          {showCategory ? <button type="button" role="option" aria-selected className={rowClass(true)} onClick={() => choose(0)}><FileText size={16} /><span className="flex-1 py-1 font-medium">Notes</span><ChevronRight size={12} /></button> : matchingNotes.map((note, i) => <button type="button" role="option" aria-selected={index === i} key={note.id} className={rowClass(index === i)} onMouseEnter={() => setIndex(i)} onClick={() => choose(i)}><FileText size={14} /><span className="truncate py-1 text-xs font-medium">{note.title}</span></button>)}
          {!showCategory && !matchingNotes.length && <p className="p-4 text-center text-xs text-[var(--muted-light)]">{trigger.query ? `No results for “${trigger.query}”` : "No notes yet"}</p>}
        </div>
      </>}
    </div>, document.body,
  );
}
