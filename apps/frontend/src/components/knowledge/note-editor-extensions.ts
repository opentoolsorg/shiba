import Code from "@tiptap/extension-code";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import TextAlign from "@tiptap/extension-text-align";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";

const InlineCode = Code.extend({ excludes: "" });

const TextAlignWithoutShortcuts = TextAlign.extend({
  addKeyboardShortcuts() {
    return {};
  },
});

const LinkWithTitle = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      title: { default: null },
    };
  },
});

export function noteEditorExtensions() {
  return [
    StarterKit.configure({ code: false }),
    InlineCode,
    Placeholder.configure({ placeholder: "Write something, or press '/' for commands…" }),
    TextAlignWithoutShortcuts.configure({ types: ["heading", "paragraph"] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Highlight.configure({ multicolor: true }),
    Underline,
    LinkWithTitle.configure({ openOnClick: false }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
  ];
}
