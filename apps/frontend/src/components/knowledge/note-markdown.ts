import type { JSONContent } from "@tiptap/react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfm } from "micromark-extension-gfm";

type MdastNode = {
  type: string;
  children?: MdastNode[];
  value?: string;
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  checked?: boolean | null;
  spread?: boolean | null;
  lang?: string | null;
  url?: string;
  title?: string | null;
  alt?: string | null;
};

type Mark = NonNullable<JSONContent["marks"]>[number];

const markdownOptions = {
  extensions: [gfmToMarkdown()],
  bullet: "-" as const,
  emphasis: "*" as const,
  strong: "*" as const,
  fences: true,
  listItemIndent: "one" as const,
  rule: "-" as const,
};

function parseMarkdown(mdastMarkdown: string): MdastNode {
  return fromMarkdown(mdastMarkdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as MdastNode;
}

function textNode(value: string, marks: Mark[]): JSONContent {
  return { type: "text", text: value, ...(marks.length ? { marks } : {}) };
}

function inlineNodes(nodes: MdastNode[] = [], marks: Mark[] = []): JSONContent[] {
  const result: JSONContent[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index] ?? { type: "text", value: "" };
    if (node.type === "html" && (node.value === "<u>" || node.value === "<mark>")) {
      const markType = node.value === "<u>" ? "underline" : "highlight";
      const close = node.value === "<u>" ? "</u>" : "</mark>";
      let end = index + 1;
      while (end < nodes.length && !(nodes[end]?.type === "html" && nodes[end]?.value === close))
        end++;
      if (end < nodes.length) {
        result.push(...inlineNodes(nodes.slice(index + 1, end), [...marks, { type: markType }]));
        index = end;
        continue;
      }
    }
    switch (node.type) {
      case "text":
        result.push(textNode(node.value ?? "", marks));
        break;
      case "inlineCode":
        result.push({ type: "text", text: node.value ?? "", marks: [...marks, { type: "code" }] });
        break;
      case "break":
        result.push({ type: "hardBreak" });
        break;
      case "strong":
        result.push(...inlineNodes(node.children, [...marks, { type: "bold" }]));
        break;
      case "emphasis":
        result.push(...inlineNodes(node.children, [...marks, { type: "italic" }]));
        break;
      case "delete":
        result.push(...inlineNodes(node.children, [...marks, { type: "strike" }]));
        break;
      case "link": {
        const label = inlineNodes(node.children)
          .map((child) => child.text ?? "")
          .join("");
        result.push(
          textNode(`[${label}](${node.url ?? ""}${node.title ? ` "${node.title}"` : ""})`, marks),
        );
        break;
      }
      case "image":
        result.push(
          textNode(
            `![${node.alt ?? ""}](${node.url ?? ""}${node.title ? ` "${node.title}"` : ""})`,
            marks,
          ),
        );
        break;
      case "html":
        result.push(textNode(node.value ?? "", marks));
        break;
      default:
        if (node.children) result.push(...inlineNodes(node.children, marks));
        else if (node.value) result.push(textNode(node.value, marks));
    }
  }
  return result;
}

function inlineFragment(markdown: string): JSONContent[] {
  const root = parseMarkdown(markdown);
  const first = root.children?.[0];
  return first?.type === "paragraph" ? inlineNodes(first.children) : [];
}

function alignedHtml(node: MdastNode): JSONContent | null {
  const value = node.value ?? "";
  const paragraph = /^<p style="text-align: (left|center|right|justify)">([\s\S]*)<\/p>$/.exec(
    value,
  );
  if (paragraph)
    return {
      type: "paragraph",
      attrs: { textAlign: paragraph[1] },
      content: inlineFragment(paragraph[2] ?? ""),
    };
  const heading =
    /^<h([1-6]) style="text-align: (left|center|right|justify)">([\s\S]*)<\/h\1>$/.exec(value);
  if (heading)
    return {
      type: "heading",
      attrs: { level: Number.parseInt(heading[1] ?? "1", 10), textAlign: heading[2] },
      content: inlineFragment(heading[3] ?? ""),
    };
  return null;
}

function ensureEditorItemContent(content: JSONContent[]): JSONContent[] {
  if (!content.length || content[0]?.type !== "paragraph")
    return [{ type: "paragraph" }, ...content];
  return content;
}

function blockNodes(nodes: MdastNode[] = []): JSONContent[] {
  const result: JSONContent[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
        result.push({ type: "paragraph", content: inlineNodes(node.children) });
        break;
      case "heading":
        result.push({
          type: "heading",
          attrs: { level: node.depth ?? 1 },
          content: inlineNodes(node.children),
        });
        break;
      case "thematicBreak":
        result.push({ type: "horizontalRule" });
        break;
      case "code":
        result.push({
          type: "codeBlock",
          attrs: { language: node.lang ?? null },
          ...(node.value ? { content: [{ type: "text", text: node.value }] } : {}),
        });
        break;
      case "blockquote":
        result.push({ type: "blockquote", content: blockNodes(node.children) });
        break;
      case "list":
        result.push(...listNodes(node));
        break;
      case "html": {
        const aligned = alignedHtml(node);
        result.push(
          aligned ?? { type: "paragraph", content: [{ type: "text", text: node.value ?? "" }] },
        );
        break;
      }
      default:
        if (node.value)
          result.push({ type: "paragraph", content: [{ type: "text", text: node.value }] });
    }
  }
  return result;
}

function listItemContent(item: MdastNode): JSONContent[] {
  return ensureEditorItemContent(blockNodes(item.children));
}

function listNodes(list: MdastNode): JSONContent[] {
  const groups: { task: boolean; items: MdastNode[] }[] = [];
  for (const item of list.children ?? []) {
    const task = typeof item.checked === "boolean";
    const last = groups.at(-1);
    if (!last || last.task !== task) groups.push({ task, items: [item] });
    else last.items.push(item);
  }
  let ordinaryOffset = 0;
  return groups.map((group) => {
    if (group.task)
      return {
        type: "taskList",
        content: group.items.map((item) => ({
          type: "taskItem",
          attrs: { checked: item.checked === true },
          content: listItemContent(item),
        })),
      };
    const ordered = list.ordered === true;
    const start = Number(list.start ?? 1) + ordinaryOffset;
    ordinaryOffset += group.items.length;
    return {
      type: ordered ? "orderedList" : "bulletList",
      ...(ordered ? { attrs: { start } } : {}),
      content: group.items.map((item) => ({ type: "listItem", content: listItemContent(item) })),
    };
  });
}

/** Parses GitHub-flavored note Markdown plus the small safe HTML subset used for underline, highlight, and alignment. */
export function parseNoteMarkdown(markdown: string): JSONContent {
  const content = blockNodes(parseMarkdown(markdown.replace(/\r\n?/g, "\n")).children);
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

function applyMark(nodes: MdastNode[], markType: string): MdastNode[] {
  if (markType === "bold") return [{ type: "strong", children: nodes }];
  if (markType === "italic") return [{ type: "emphasis", children: nodes }];
  if (markType === "strike") return [{ type: "delete", children: nodes }];
  if (markType === "underline")
    return [{ type: "html", value: "<u>" }, ...nodes, { type: "html", value: "</u>" }];
  if (markType === "highlight")
    return [{ type: "html", value: "<mark>" }, ...nodes, { type: "html", value: "</mark>" }];
  return nodes;
}

const markOrder = ["bold", "italic", "strike", "underline", "highlight"];

function inlineSegments(
  nodes: JSONContent[] = [],
): { value: string; marks: string[]; code: boolean }[] {
  const segments: { value: string; marks: string[]; code: boolean }[] = [];
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      segments.push({ value: "\n", marks: [], code: false });
      continue;
    }
    if (node.type !== "text") continue;
    const marks = node.marks ?? [];
    const markTypes = markOrder.filter((type) => marks.some((mark) => mark.type === type));
    const code = marks.some((mark) => mark.type === "code");
    const value = node.text ?? "";
    const previous = segments.at(-1);
    if (
      previous &&
      previous.value !== "\n" &&
      previous.code === code &&
      previous.marks.join("\0") === markTypes.join("\0")
    )
      previous.value += value;
    else segments.push({ value, marks: code ? [] : markTypes, code });
  }
  return segments;
}

function markedMdast(
  segments: { value: string; marks: string[]; code: boolean }[],
  depth = 0,
): MdastNode[] {
  const mark = markOrder[depth];
  if (!mark) {
    return segments.map((segment) =>
      segment.value === "\n"
        ? { type: "break" }
        : segment.code
          ? { type: "inlineCode", value: segment.value }
          : { type: "text", value: segment.value },
    );
  }
  const result: MdastNode[] = [];
  let index = 0;
  while (index < segments.length) {
    const hasMark = segments[index]?.marks.includes(mark) === true;
    let end = index + 1;
    while (end < segments.length && (segments[end]?.marks.includes(mark) === true) === hasMark)
      end++;
    const children = markedMdast(segments.slice(index, end), depth + 1);
    result.push(...(hasMark ? applyMark(children, mark) : children));
    index = end;
  }
  return result;
}

function inlineMdast(nodes: JSONContent[] = []): MdastNode[] {
  return markedMdast(inlineSegments(nodes));
}

function inlineMarkdown(children: JSONContent[] | undefined): string {
  return toMarkdown(
    { type: "root", children: [{ type: "paragraph", children: inlineMdast(children) }] } as never,
    markdownOptions as never,
  ).replace(/\n$/, "");
}

function listItems(node: JSONContent, task: boolean): MdastNode[] {
  return (node.content ?? []).map((item) => {
    const children = blockMdast(item.content ?? []);
    return {
      type: "listItem",
      checked: task ? item.attrs?.checked === true : null,
      spread: children.length > 1,
      children,
    };
  });
}

function blockMdast(nodes: JSONContent[] = []): MdastNode[] {
  const result: MdastNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph": {
        if (typeof node.attrs?.textAlign === "string") {
          result.push({
            type: "html",
            value: `<p style="text-align: ${node.attrs.textAlign}">${inlineMarkdown(node.content)}</p>`,
          });
        } else {
          result.push({ type: "paragraph", children: inlineMdast(node.content) });
        }
        break;
      }
      case "heading": {
        const level = Number(node.attrs?.level ?? 1);
        if (typeof node.attrs?.textAlign === "string") {
          result.push({
            type: "html",
            value: `<h${level} style="text-align: ${node.attrs.textAlign}">${inlineMarkdown(node.content)}</h${level}>`,
          });
        } else {
          result.push({ type: "heading", depth: level, children: inlineMdast(node.content) });
        }
        break;
      }
      case "horizontalRule":
        result.push({ type: "thematicBreak" });
        break;
      case "codeBlock":
        result.push({
          type: "code",
          lang: typeof node.attrs?.language === "string" ? node.attrs.language : null,
          value: (node.content ?? []).map((child) => child.text ?? "").join(""),
        });
        break;
      case "blockquote":
        result.push({ type: "blockquote", children: blockMdast(node.content ?? []) });
        break;
      case "bulletList":
        result.push({
          type: "list",
          ordered: false,
          spread: false,
          children: listItems(node, false),
        });
        break;
      case "orderedList":
        result.push({
          type: "list",
          ordered: true,
          start: Number(node.attrs?.start ?? 1),
          spread: false,
          children: listItems(node, false),
        });
        break;
      case "taskList":
        result.push({
          type: "list",
          ordered: false,
          spread: false,
          children: listItems(node, true),
        });
        break;
      default:
        if (node.content) result.push(...blockMdast(node.content));
    }
  }
  return result;
}

export function serializeNoteMarkdown(doc: JSONContent): string {
  const markdown = toMarkdown(
    { type: "root", children: blockMdast(doc.content ?? []) } as never,
    markdownOptions as never,
  );
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}
