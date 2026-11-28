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
  identifier?: string;
  align?: (string | null)[];
  position?: { start?: { offset?: number } };
};

type Mark = NonNullable<JSONContent["marks"]>[number];
type InlineSegment = {
  value: string;
  marks: string[];
  code: boolean;
  hardBreak?: boolean;
};
type ReferenceTarget = { url: string; title?: string | null };
type ReferenceMap = ReadonlyMap<string, ReferenceTarget>;

const markdownOptions = {
  extensions: [gfmToMarkdown()],
  bullet: "-" as const,
  emphasis: "_" as const,
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

const editorMarkOrder = ["bold", "italic", "strike", "underline", "highlight", "link", "code"];

function normalizeMarks(marks: Mark[]): Mark[] {
  return [...marks].sort(
    (left, right) => editorMarkOrder.indexOf(left.type) - editorMarkOrder.indexOf(right.type),
  );
}

function textNode(value: string, marks: Mark[]): JSONContent {
  const ordered = normalizeMarks(marks);
  return { type: "text", text: value, ...(ordered.length ? { marks: ordered } : {}) };
}

function referenceKey(identifier: string | undefined): string {
  return (identifier ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function collectReferences(root: MdastNode): ReferenceMap {
  const references = new Map<string, ReferenceTarget>();
  for (const node of root.children ?? []) {
    if (node.type === "definition" && node.url)
      if (!references.has(referenceKey(node.identifier)))
        references.set(referenceKey(node.identifier), { url: node.url, title: node.title });
  }
  return references;
}

function safeLinkHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, "https://note.invalid");
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? href
      : null;
  } catch {
    return null;
  }
}

const inlineHtmlMarks: Record<string, [string, string]> = {
  "<u>": ["underline", "</u>"],
  "<mark>": ["highlight", "</mark>"],
  "<del>": ["strike", "</del>"],
  "<code>": ["code", "</code>"],
};

const inlineRawTextTags: Record<string, [string | null, string]> = {
  "<span data-shiba-raw>": [null, "</span>"],
  "<code data-shiba-raw>": ["code", "</code>"],
};

function stripGeneratedInlineMarks(nodes: JSONContent[], baseMarks: Mark[]): JSONContent[] {
  const allowed = new Set(normalizeMarks(baseMarks).map((mark) => JSON.stringify(mark)));
  const result: JSONContent[] = [];
  for (const node of nodes) {
    if (node.type !== "text") {
      result.push(node);
      continue;
    }
    const kept = (node.marks ?? []).filter((mark) => allowed.has(JSON.stringify(mark)));
    const copy = { ...node };
    if (kept.length) copy.marks = kept;
    else delete copy.marks;
    const previous = result.at(-1);
    if (
      previous?.type === "text" &&
      JSON.stringify(previous.marks ?? null) === JSON.stringify(copy.marks ?? null)
    )
      previous.text = `${previous.text ?? ""}${copy.text ?? ""}`;
    else result.push(copy);
  }
  return result;
}

function inlineNodes(
  nodes: MdastNode[] = [],
  marks: Mark[] = [],
  references: ReferenceMap = new Map(),
): JSONContent[] {
  const result: JSONContent[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index] ?? { type: "text", value: "" };
    const rawTextTag = node.type === "html" ? inlineRawTextTags[node.value ?? ""] : undefined;
    if (rawTextTag) {
      const [markType, close] = rawTextTag;
      let end = index + 1;
      while (end < nodes.length && !(nodes[end]?.type === "html" && nodes[end]?.value === close))
        end++;
      if (end < nodes.length) {
        const rawMarks = markType ? [...marks, { type: markType }] : marks;
        result.push(
          ...stripGeneratedInlineMarks(
            inlineNodes(nodes.slice(index + 1, end), rawMarks, references),
            rawMarks,
          ),
        );
        index = end;
        continue;
      }
    }
    const encodedInline =
      node.type === "html"
        ? /^<(span|code) data-shiba-text="([^"]*)">$/.exec(node.value ?? "")
        : null;
    if (encodedInline) {
      try {
        const encodedMarks =
          encodedInline[1] === "code" ? [...marks, { type: "code" as const }] : marks;
        result.push(textNode(decodeURIComponent(encodedInline[2] ?? ""), encodedMarks));
        const close = `</${encodedInline[1]}>`;
        if (nodes[index + 1]?.type === "html" && nodes[index + 1]?.value === close) index++;
        continue;
      } catch {
        // malformed copied HTML falls through as literal text
      }
    }
    const htmlMark = node.type === "html" ? inlineHtmlMarks[node.value ?? ""] : undefined;
    if (htmlMark) {
      const [markType, close] = htmlMark;
      let end = index + 1;
      while (end < nodes.length && !(nodes[end]?.type === "html" && nodes[end]?.value === close))
        end++;
      if (end < nodes.length) {
        result.push(
          ...inlineNodes(nodes.slice(index + 1, end), [...marks, { type: markType }], references),
        );
        index = end;
        continue;
      }
    }
    switch (node.type) {
      case "text":
        result.push(textNode(node.value ?? "", marks));
        break;
      case "inlineCode":
        result.push({
          type: "text",
          text: node.value ?? "",
          marks: normalizeMarks([...marks, { type: "code" }]),
        });
        break;
      case "break":
        result.push({ type: "hardBreak" });
        break;
      case "strong":
        result.push(...inlineNodes(node.children, [...marks, { type: "bold" }], references));
        break;
      case "emphasis":
        result.push(...inlineNodes(node.children, [...marks, { type: "italic" }], references));
        break;
      case "delete":
        result.push(...inlineNodes(node.children, [...marks, { type: "strike" }], references));
        break;
      case "link":
      case "linkReference": {
        const target = node.url
          ? { url: node.url, title: node.title }
          : references.get(referenceKey(node.identifier));
        const href = safeLinkHref(target?.url);
        const linkMarks = href
          ? [
              ...marks,
              {
                type: "link",
                attrs: { href, ...(target?.title ? { title: target.title } : {}) },
              },
            ]
          : marks;
        result.push(...inlineNodes(node.children, linkMarks, references));
        break;
      }
      case "image": {
        const href = node.url ?? references.get(referenceKey(node.identifier))?.url;
        result.push(
          textNode(
            `![${node.alt ?? ""}](${href ?? ""}${node.title ? ` "${node.title}"` : ""})`,
            marks,
          ),
        );
        break;
      }
      case "imageReference": {
        const href = references.get(referenceKey(node.identifier))?.url;
        result.push(
          textNode(
            href
              ? `![${node.alt ?? ""}](${href})`
              : `![${node.alt ?? ""}][${node.identifier ?? ""}]`,
            marks,
          ),
        );
        break;
      }
      case "html":
        if (node.value === "<br>" || node.value === "<br/>" || node.value === "<br />")
          result.push({ type: "hardBreak" });
        else result.push(textNode(node.value ?? "", marks));
        break;
      default:
        if (node.children) result.push(...inlineNodes(node.children, marks, references));
        else if (node.value) result.push(textNode(node.value, marks));
    }
  }
  return result;
}

function alignedHtml(node: MdastNode, references: ReferenceMap): JSONContent | null {
  const value = node.value ?? "";
  const paragraph = /^<p style="text-align: (left|center|right|justify)">([\s\S]*)<\/p>$/.exec(
    value,
  );
  if (paragraph)
    return {
      type: "paragraph",
      attrs: { textAlign: paragraph[1] },
      content: inlineFragmentWithReferences(paragraph[2] ?? "", references),
    };
  const heading =
    /^<h([1-6]) style="text-align: (left|center|right|justify)">([\s\S]*)<\/h\1>$/.exec(value);
  if (heading)
    return {
      type: "heading",
      attrs: { level: Number.parseInt(heading[1] ?? "1", 10), textAlign: heading[2] },
      content: inlineFragmentWithReferences(heading[3] ?? "", references),
    };
  return null;
}

function inlineFragmentWithReferences(markdown: string, references: ReferenceMap): JSONContent[] {
  const root = parseMarkdown(markdown);
  const first = root.children?.[0];
  return first?.type === "paragraph" ? inlineNodes(first.children, [], references) : [];
}

function ensureEditorItemContent(content: JSONContent[]): JSONContent[] {
  if (!content.length || content[0]?.type !== "paragraph")
    return [{ type: "paragraph" }, ...content];
  return content;
}

function tableNode(node: MdastNode, references: ReferenceMap): JSONContent {
  return {
    type: "table",
    content: (node.children ?? []).map((row, rowIndex) => ({
      type: "tableRow",
      content: (row.children ?? []).map((cell, cellIndex) => {
        const align = node.align?.[cellIndex];
        return {
          type: rowIndex === 0 ? "tableHeader" : "tableCell",
          content: [
            {
              type: "paragraph",
              ...(align === "left" || align === "center" || align === "right"
                ? { attrs: { textAlign: align } }
                : {}),
              content: inlineNodes(cell.children, [], references),
            },
          ],
        };
      }),
    })),
  };
}

function applyListItemAlignmentMarker(result: JSONContent[], node: MdastNode): boolean {
  if (node.type !== "html") return false;
  const marker = /^<!-- shiba-align:(paragraph|heading):(left|center|right|justify) -->$/.exec(
    node.value ?? "",
  );
  if (!marker) return false;
  const target = result.at(-1);
  if (target && target.type === marker[1])
    target.attrs = { ...(target.attrs ?? {}), textAlign: marker[2] };
  return true;
}

function blockNodes(
  nodes: MdastNode[] = [],
  references: ReferenceMap = new Map(),
  source = "",
): JSONContent[] {
  const result: JSONContent[] = [];
  for (const node of nodes) {
    if (applyListItemAlignmentMarker(result, node)) continue;
    switch (node.type) {
      case "paragraph":
        result.push({ type: "paragraph", content: inlineNodes(node.children, [], references) });
        break;
      case "heading":
        result.push({
          type: "heading",
          attrs: { level: node.depth ?? 1 },
          content: inlineNodes(node.children, [], references),
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
        result.push({ type: "blockquote", content: blockNodes(node.children, references, source) });
        break;
      case "list":
        result.push(...listNodes(node, references, source));
        break;
      case "table":
        result.push(tableNode(node, references));
        break;
      case "definition":
        break;
      case "html": {
        const aligned = alignedHtml(node, references);
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

function legacyTaskChildren(item: MdastNode, task: boolean, source: string): MdastNode[] {
  return (item.children ?? []).flatMap((node) => {
    if (!task || node.type !== "code" || !/^\s*[-+*] +\[[ xX]\] +/.test(node.value ?? ""))
      return [node];
    const offset = node.position?.start?.offset;
    const fenced = typeof offset === "number" && /^(?:`{3,}|~{3,})/.test(source.slice(offset));
    return fenced ? [node] : (parseMarkdown(node.value ?? "").children ?? []);
  });
}

function listItemContent(
  item: MdastNode,
  references: ReferenceMap,
  task: boolean,
  source: string,
): JSONContent[] {
  return ensureEditorItemContent(
    blockNodes(legacyTaskChildren(item, task, source), references, source),
  );
}

function listNodes(list: MdastNode, references: ReferenceMap, source: string): JSONContent[] {
  const groups: { task: boolean; items: MdastNode[]; startIndex: number }[] = [];
  (list.children ?? []).forEach((item, itemIndex) => {
    const task = typeof item.checked === "boolean";
    const last = groups.at(-1);
    if (!last || last.task !== task) groups.push({ task, items: [item], startIndex: itemIndex });
    else last.items.push(item);
  });
  return groups.map((group) => {
    if (group.task)
      return {
        type: "taskList",
        content: group.items.map((item) => ({
          type: "taskItem",
          attrs: { checked: item.checked === true },
          content: listItemContent(item, references, true, source),
        })),
      };
    const ordered = list.ordered === true;
    const start = Number(list.start ?? 1) + group.startIndex;
    return {
      type: ordered ? "orderedList" : "bulletList",
      ...(ordered ? { attrs: { start } } : {}),
      content: group.items.map((item) => ({
        type: "listItem",
        content: listItemContent(item, references, false, source),
      })),
    };
  });
}

/** Parses GitHub-flavored note Markdown plus the small safe HTML subset used for underline, highlight, and alignment. */
export function parseNoteMarkdown(markdown: string): JSONContent {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const root = parseMarkdown(normalized);
  const content = blockNodes(root.children, collectReferences(root), normalized);
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

function encodeLinkKey(href: string, title: string | null): string {
  return `link:${encodeURIComponent(JSON.stringify([href, title]))}`;
}

function decodeLinkKey(key: string): { href: string; title: string | null } {
  try {
    const [href, title] = JSON.parse(decodeURIComponent(key.slice("link:".length))) as [
      string,
      string | null,
    ];
    return { href, title };
  } catch {
    return { href: decodeURIComponent(key.slice("link:".length)), title: null };
  }
}

function applyMark(nodes: MdastNode[], markType: string): MdastNode[] {
  if (markType === "bold") return [{ type: "strong", children: nodes }];
  if (markType === "italic") return [{ type: "emphasis", children: nodes }];
  if (markType === "strike")
    return [{ type: "html", value: "<del>" }, ...nodes, { type: "html", value: "</del>" }];
  if (markType === "underline")
    return [{ type: "html", value: "<u>" }, ...nodes, { type: "html", value: "</u>" }];
  if (markType === "highlight")
    return [{ type: "html", value: "<mark>" }, ...nodes, { type: "html", value: "</mark>" }];
  if (markType.startsWith("link:")) {
    const target = decodeLinkKey(markType);
    return [{ type: "link", url: target.href, title: target.title, children: nodes }];
  }
  return nodes;
}

const markOrder = ["bold", "italic", "strike", "underline", "highlight", "link"];

function inlineSegments(nodes: JSONContent[] = []): InlineSegment[] {
  const segments: InlineSegment[] = [];
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      segments.push({ value: "", marks: [], code: false, hardBreak: true });
      continue;
    }
    if (node.type !== "text") continue;
    const marks = node.marks ?? [];
    const link = marks.find((mark) => mark.type === "link");
    const href = safeLinkHref(typeof link?.attrs?.href === "string" ? link.attrs.href : undefined);
    const title = typeof link?.attrs?.title === "string" ? link.attrs.title : null;
    const markTypes = [
      ...markOrder
        .filter((type) => type !== "link")
        .filter((type) => marks.some((mark) => mark.type === type)),
      ...(href ? [encodeLinkKey(href, title)] : []),
    ];
    const code = marks.some((mark) => mark.type === "code");
    const value = node.text ?? "";
    const previous = segments.at(-1);
    if (
      previous &&
      !previous.hardBreak &&
      previous.code === code &&
      previous.marks.join("\0") === markTypes.join("\0")
    )
      previous.value += value;
    else segments.push({ value, marks: markTypes, code });
  }
  return segments;
}

function segmentMarkKey(segment: InlineSegment, mark: string): string | null {
  if (mark === "link") return segment.marks.find((key) => key.startsWith("link:")) ?? null;
  return segment.marks.includes(mark) ? mark : null;
}

const autolinkLikeText = /(?:https?:\/\/|www\.|[\w.+-]+@[\w-]+\.)/i;

function rawTextNodes(tag: "span" | "code", value: string): MdastNode[] {
  return [
    { type: "html", value: `<${tag} data-shiba-raw>` },
    ...newlineFallbackNodes(value),
    { type: "html", value: `</${tag}>` },
  ];
}

function markedMdast(segments: InlineSegment[], depth = 0): MdastNode[] {
  const mark = markOrder[depth];
  if (!mark) {
    return segments.flatMap((segment) => {
      if (segment.hardBreak) return [{ type: "html", value: "<br>" }];
      if (segment.code) {
        if (!segment.value.includes("\n")) return [{ type: "inlineCode", value: segment.value }];
        return rawTextNodes("code", segment.value);
      }
      if (autolinkLikeText.test(segment.value)) return rawTextNodes("span", segment.value);
      if (segment.value.includes("\n")) return newlineFallbackNodes(segment.value);
      return [{ type: "text", value: segment.value }];
    });
  }
  const result: MdastNode[] = [];
  let index = 0;
  while (index < segments.length) {
    const activeKey = segmentMarkKey(
      segments[index] ?? { value: "", marks: [], code: false },
      mark,
    );
    let end = index + 1;
    while (
      end < segments.length &&
      segmentMarkKey(segments[end] ?? { value: "", marks: [], code: false }, mark) === activeKey
    )
      end++;
    const children = markedMdast(segments.slice(index, end), depth + 1);
    result.push(...(activeKey ? applyMark(children, activeKey) : children));
    index = end;
  }
  return result;
}

function inlineMdast(nodes: JSONContent[] = []): MdastNode[] {
  return markedMdast(inlineSegments(nodes));
}

function newlineFallbackNodes(value: string): MdastNode[] {
  const nodes: MdastNode[] = [];
  let spaces = "";
  for (const char of value) {
    if (char === "\n") {
      if (spaces) {
        nodes.push({ type: "text", value: spaces });
        spaces = "";
      }
      nodes.push({ type: "html", value: "&#10;" });
    } else spaces += char;
  }
  if (spaces) nodes.push({ type: "text", value: spaces });
  return nodes;
}

function inlineMarkdown(children: JSONContent[] | undefined): string {
  return toMarkdown(
    {
      type: "root",
      children: [{ type: "paragraph", children: inlineMdast(children) }],
    } as never,
    markdownOptions as never,
  ).replace(/\n$/, "");
}

function listItems(node: JSONContent, task: boolean): MdastNode[] {
  return (node.content ?? []).map((item) => {
    const children = blockMdast(item.content ?? [], true);
    return {
      type: "listItem",
      checked: task ? item.attrs?.checked === true : null,
      spread: children.length > 1,
      children,
    };
  });
}

function tableMdast(node: JSONContent): MdastNode {
  const firstRow = node.content?.[0]?.content ?? [];
  const align = firstRow.map((cell) => {
    const value = cell.content?.[0]?.attrs?.textAlign;
    return value === "left" || value === "center" || value === "right" ? value : null;
  });
  return {
    type: "table",
    align,
    children: (node.content ?? []).map((row) => ({
      type: "tableRow",
      children: (row.content ?? []).map((cell) => ({
        type: "tableCell",
        children: inlineMdast((cell.content ?? []).flatMap((child) => child.content ?? [])),
      })),
    })),
  };
}

function alignedListMarker(type: "paragraph" | "heading", align: string): MdastNode {
  return { type: "html", value: `<!-- shiba-align:${type}:${align} -->` };
}

function blockMdast(nodes: JSONContent[] = [], inListItem = false): MdastNode[] {
  const result: MdastNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph": {
        const align = typeof node.attrs?.textAlign === "string" ? node.attrs.textAlign : null;
        if (align && !inListItem) {
          result.push({
            type: "html",
            value: `<p style="text-align: ${align}">${inlineMarkdown(node.content)}</p>`,
          });
        } else {
          result.push({ type: "paragraph", children: inlineMdast(node.content) });
          if (align) result.push(alignedListMarker("paragraph", align));
        }
        break;
      }
      case "heading": {
        const level = Number(node.attrs?.level ?? 1);
        const align = typeof node.attrs?.textAlign === "string" ? node.attrs.textAlign : null;
        if (align && !inListItem) {
          result.push({
            type: "html",
            value: `<h${level} style="text-align: ${align}">${inlineMarkdown(node.content)}</h${level}>`,
          });
        } else {
          result.push({ type: "heading", depth: level, children: inlineMdast(node.content) });
          if (align) result.push(alignedListMarker("heading", align));
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
      case "table":
        result.push(tableMdast(node));
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
