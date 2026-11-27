import type { JSONContent } from "@tiptap/react";

const delimiters = [["**", "bold"], ["~~", "strike"], ["*", "italic"]] as const;
const escapablePunctuation = /[!-/:-@\[-\x60{-~]/;

function delimiterEnd(text: string, delimiter: string, from: number): number {
  for (let end = text.indexOf(delimiter, from); end !== -1; end = text.indexOf(delimiter, end + 1)) {
    let slashes = 0;
    for (let i = end - 1; text[i] === "\\"; i--) slashes++;
    if (slashes % 2 === 0) return end;
  }
  return -1;
}

function inline(text: string, marks: NonNullable<JSONContent["marks"]> = []): JSONContent[] {
  const result: JSONContent[] = [];
  let plain = "";
  const flush = () => {
    if (plain) result.push({ type: "text", text: plain, ...(marks.length ? { marks } : {}) });
    plain = "";
  };
  for (let i = 0; i < text.length;) {
    if (text[i] === "\\") {
      const next = text[i + 1];
      if (next === "\n") { flush(); result.push({ type: "hardBreak" }); i += 2; continue; }
      if (next && escapablePunctuation.test(next)) { plain += next; i += 2; continue; }
    }
    if (text[i] === "\n") {
      if (plain.endsWith("  ")) { plain = plain.slice(0, -2); flush(); result.push({ type: "hardBreak" }); }
      else plain += " ";
      i++; continue;
    }
    const code = /^(`+)([\s\S]*?)\1(?!`)/.exec(text.slice(i));
    if (code) {
      flush();
      const value = (code[2] ?? "").startsWith(" ") && (code[2] ?? "").endsWith(" ") ? (code[2] ?? "").slice(1, -1) : (code[2] ?? "");
      result.push({ type: "text", text: value, marks: [...marks, { type: "code" }] });
      i += code[0].length; continue;
    }
    if (text.startsWith("***", i)) {
      const end = delimiterEnd(text, "***", i + 3);
      if (end > i + 3) {
        flush(); result.push(...inline(text.slice(i + 3, end), [...marks, { type: "bold" }, { type: "italic" }]));
        i = end + 3; continue;
      }
    }
    const pair = delimiters.find(([delimiter]) => text.startsWith(delimiter, i) && delimiterEnd(text, delimiter, i + delimiter.length) > i + delimiter.length);
    if (pair) {
      const [delimiter, type] = pair;
      let end = delimiterEnd(text, delimiter, i + delimiter.length);
      if (delimiter === "**" && text[end + 2] === "*" && text.slice(i + 2, end).includes("*")) end++;
      flush(); result.push(...inline(text.slice(i + delimiter.length, end), [...marks, { type }]));
      i = end + delimiter.length; continue;
    }
    const htmlMark = ([["<u>", "</u>", "underline"], ["<mark>", "</mark>", "highlight"]] as const).find(([open]) => text.startsWith(open, i));
    if (htmlMark) {
      const [open, close, type] = htmlMark;
      const end = text.indexOf(close, i + open.length);
      if (end > i + open.length) {
        flush(); result.push(...inline(text.slice(i + open.length, end), [...marks, { type }]));
        i = end + close.length; continue;
      }
    }
    plain += text[i]; i++;
  }
  flush();
  return result;
}

const listLine = /^( *)([-+*]|\d+\.) +(.*)$/;
const taskLine = /^( *)- +\[([ xX])\] +(.*)$/;

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

function parseTaskList(lines: string[], start: number, indent: number): { node: JSONContent; next: number } {
  const items: JSONContent[] = [];
  let i = start;
  while (i < lines.length) {
    const item = taskLine.exec(lines[i] ?? "");
    if (!item || (item[1] ?? "").length !== indent) break;
    const width = item[0].length - (item[3] ?? "").length;
    const body = [(item[3] ?? "")];
    const itemContent: JSONContent[] = [];
    const flushBody = () => {
      if (!body.length) return;
      itemContent.push(...(parseNoteMarkdown(body.join("\n")).content ?? []));
      body.length = 0;
    };
    i++;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (!line.trim()) {
        const following = lines[i + 1] ?? "";
        if (following.trim() && leadingSpaces(following) > indent) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      const lineIndent = leadingSpaces(line);
      if (lineIndent <= indent) break;
      const nestedTask = taskLine.exec(line);
      if (nestedTask) {
        flushBody();
        const nested = parseTaskList(lines, i, lineIndent);
        itemContent.push(nested.node);
        i = nested.next;
        continue;
      }
      if (lineIndent < width) break;
      const strip = line.startsWith(" ".repeat(width)) ? width : lineIndent;
      body.push(line.slice(strip));
      i++;
    }
    flushBody();
    items.push({
      type: "taskItem",
      attrs: { checked: (item[2] ?? " ").toLowerCase() === "x" },
      content: itemContent,
    });
  }
  return { node: { type: "taskList", content: items }, next: i };
}

const startsBlock = (line: string) => /^(#{1,6} |>|```|~~~|(?:[-*_] *){3,}$)/.test(line) || listLine.test(line);

/** The supported Markdown subset maps to the note editor schema; inline HTML is limited to safe formatting wrappers. */
export function parseNoteMarkdown(markdown: string): JSONContent {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const content: JSONContent[] = [];
  for (let i = 0; i < lines.length;) {
    let line = (lines[i] ?? "");
    if (!line.trim()) { i++; continue; }
    const fence = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith((fence[1] ?? ""))) body.push((lines[i++] ?? ""));
      if (i < lines.length) i++;
      content.push({ type: "codeBlock", attrs: { language: (fence[2] ?? "").trim() || null }, ...(body.join("\n") ? { content: [{ type: "text", text: body.join("\n") }] } : {}) });
      continue;
    }
    const heading = /^(#{1,6}) +(.*)$/.exec(line);
    if (heading) { content.push({ type: "heading", attrs: { level: (heading[1] ?? "").length }, content: inline((heading[2] ?? "")) }); i++; continue; }
    if (/^(?:-\s*){3,}$|^(?:\*\s*){3,}$|^(?:_\s*){3,}$/.test(line)) { content.push({ type: "horizontalRule" }); i++; continue; }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) body.push((lines[i++] ?? "").replace(/^> ?/, ""));
      content.push({ type: "blockquote", content: parseNoteMarkdown(body.join("\n")).content }); continue;
    }
    const alignedOpen = /^<(p|h[1-6]) style="text-align: (?:left|center|right|justify)">/.exec(line);
    if (alignedOpen) {
      const closeTag = `</${alignedOpen[1]}>`;
      let closing = i;
      while (closing < lines.length && !(lines[closing] ?? "").includes(closeTag)) closing++;
      if (closing > i && closing < lines.length) {
        line = lines.slice(i, closing + 1).join("\n");
        i = closing;
      }
    }
    const alignedParagraph = /^<p style="text-align: (left|center|right|justify)">([\s\S]*)<\/p>$/.exec(line);
    if (alignedParagraph) {
      content.push({ type: "paragraph", attrs: { textAlign: alignedParagraph[1] }, content: inline((alignedParagraph[2] ?? "")) });
      i++; continue;
    }
    const alignedHeading = /^<h([1-6]) style="text-align: (left|center|right|justify)">([\s\S]*)<\/h\1>$/.exec(line);
    if (alignedHeading) {
      content.push({ type: "heading", attrs: { level: Number.parseInt((alignedHeading[1] ?? "1"), 10), textAlign: alignedHeading[2] }, content: inline((alignedHeading[3] ?? "")) });
      i++; continue;
    }
    const firstTask = taskLine.exec(line);
    if (firstTask) {
      const parsed = parseTaskList(lines, i, (firstTask[1] ?? "").length);
      content.push(parsed.node);
      i = parsed.next;
      continue;
    }
    const first = listLine.exec(line);
    if (first) {
      const ordered = /\d/.test((first[2] ?? ""));
      const items: JSONContent[] = [];
      const indent = (first[1] ?? "").length;
      while (i < lines.length) {
        const item = listLine.exec((lines[i] ?? ""));
        if (!item || (item[1] ?? "").length !== indent || /\d/.test((item[2] ?? "")) !== ordered || taskLine.test((lines[i] ?? ""))) break;
        const body = [(item[3] ?? "")];
        const width = item[0].length - (item[3] ?? "").length;
        i++;
        while (i < lines.length && ((lines[i] ?? "").startsWith(" ".repeat(width)) || (!(lines[i] ?? "").trim() && lines[i + 1]?.startsWith(" ".repeat(width))))) {
          body.push((lines[i++] ?? "").slice(width));
        }
        items.push({ type: "listItem", content: parseNoteMarkdown(body.join("\n")).content });
      }
      content.push({ type: ordered ? "orderedList" : "bulletList", ...(ordered ? { attrs: { start: Number.parseInt((first[2] ?? ""), 10) } } : {}), content: items }); continue;
    }
    const body = [line]; i++;
    while (i < lines.length && (lines[i] ?? "").trim() && !startsBlock((lines[i] ?? ""))) body.push((lines[i++] ?? ""));
    content.push({ type: "paragraph", content: inline(body.join("\n")) });
  }
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

function renderInline(node: JSONContent): string {
  if (node.type === "hardBreak") return "  \n";
  const value = node.text ?? "";
  if (node.marks?.some((mark) => mark.type === "code")) {
    const fence = "`".repeat(Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length)) + 1);
    const pad = value.startsWith("`") || value.endsWith("`") || (value.startsWith(" ") && value.endsWith(" ")) ? " " : "";
    return `${fence}${pad}${value}${pad}${fence}`;
  }
  let text = value.replace(/([\\`*_~[\]#>+-])/g, "\\$1").replace(/^(\d+)\./, "$1\\.");
  for (const [delimiter, type] of [...delimiters].reverse()) {
    if (node.marks?.some((mark) => mark.type === type)) text = `${delimiter}${text}${delimiter}`;
  }
  if (node.marks?.some((mark) => mark.type === "underline")) text = `<u>${text}</u>`;
  if (node.marks?.some((mark) => mark.type === "highlight")) text = `<mark>${text}</mark>`;
  return text;
}

function renderNode(node: JSONContent): string {
  const children = node.content ?? [];
  const text = () => children.map(renderInline).join("");
  switch (node.type) {
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      if (typeof node.attrs?.textAlign === "string") return `<h${level} style="text-align: ${node.attrs.textAlign}">${text()}</h${level}>`;
      return `${"#".repeat(level)} ${text()}`;
    }
    case "paragraph":
      if (typeof node.attrs?.textAlign === "string") return `<p style="text-align: ${node.attrs.textAlign}">${text()}</p>`;
      return text();
    case "horizontalRule": return "---";
    case "codeBlock": {
      const value = children.map((child) => child.text ?? "").join("");
      const fence = "`".repeat(Math.max(2, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length)) + 1);
      return `${fence}${node.attrs?.language ?? ""}\n${value}\n${fence}`;
    }
    case "blockquote": return children.map(renderNode).join("\n\n").split("\n").map((line) => `> ${line}`).join("\n");
    case "taskList": return children.map((item) => {
      const prefix = `- [${item.attrs?.checked ? "x" : " "}] `;
      const lines = (item.content ?? []).map(renderNode).join("\n\n").split("\n");
      return prefix + lines.map((line, lineIndex) => lineIndex ? " ".repeat(prefix.length) + line : line).join("\n");
    }).join("\n");
    case "bulletList":
    case "orderedList": return children.map((item, index) => {
      const prefix = node.type === "orderedList" ? `${Number(node.attrs?.start ?? 1) + index}. ` : "- ";
      const lines = (item.content ?? []).map(renderNode).join("\n\n").split("\n");
      return prefix + lines.map((line, lineIndex) => lineIndex ? " ".repeat(prefix.length) + line : line).join("\n");
    }).join("\n");
    default: return children.map(renderNode).join("\n\n");
  }
}

export function serializeNoteMarkdown(doc: JSONContent): string {
  return `${renderNode(doc)}\n`;
}
