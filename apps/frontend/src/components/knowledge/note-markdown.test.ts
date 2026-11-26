import { describe, expect, it } from "vitest";
import { parseNoteMarkdown, serializeNoteMarkdown } from "./note-markdown";

describe("note Markdown", () => {
  it("round trips headings, lists, quotes, code, dividers and marks", () => {
    const source = "# Heading\n\nA **bold** and *italic* and ~~removed~~ and `code` sentence.\n\n- First\n- Second\n  - Nested\n\n3. Third\n4. Fourth\n\n> A quote\n> \n> Another paragraph\n\n```ts\nconst a = 1;\n```\n\n---\n";
    const doc = parseNoteMarkdown(source);
    expect(doc.content?.map((node) => node.type)).toEqual(["heading", "paragraph", "bulletList", "orderedList", "blockquote", "codeBlock", "horizontalRule"]);
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });

  it("keeps literal HTML as text rather than creating elements", () => {
    const doc = parseNoteMarkdown('<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>');
    expect(doc.content?.[0]?.content?.[0]).toEqual({ type: "text", text: '<img src=x onerror="alert(1)">' });
    expect(doc.content?.[1]?.content?.[0]?.text).toBe("<script>alert(1)</script>");
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });

  it("preserves hard breaks and empty input", () => {
    const doc = parseNoteMarkdown("first  \nsecond\\\nthird");
    expect(doc.content?.[0]?.content?.[1]).toEqual({ type: "hardBreak" });
    expect(doc.content?.[0]?.content?.[3]).toEqual({ type: "hardBreak" });
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
    expect(parseNoteMarkdown("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });

  it("preserves literal backslashes while decoding Markdown punctuation escapes", () => {
    const doc = parseNoteMarkdown("C:\\Users\\Ada \\*literal\\* \\\\ \\+ \\");
    expect(doc.content?.[0]?.content?.[0]?.text).toBe("C:\\Users\\Ada *literal* \\ + \\");
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });

  it("round trips combined bold and italic marks", () => {
    for (const source of ["***both***", "**bold *and italic***"]) {
      const doc = parseNoteMarkdown(source);
      expect(doc.content?.[0]?.content?.some((node) => node.marks?.length === 2)).toBe(true);
      expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
    }
  });

  it("escapes plain punctuation and code fences when saving", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "# plain *text* [brackets]" }] }, { type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: "```\ncode" }] }] };
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });

  it("keeps backticks and surrounding spaces inside inline code", () => {
    for (const text of ["`value`", " value "]) {
      const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text, marks: [{ type: "code" }] }] }] };
      expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
    }
  });

  it("preserves literal punctuation inside formatted text", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a * literal * b", marks: [{ type: "bold" }] }] }] };
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });
});
