import { describe, expect, it } from "vitest";
import { parseNoteMarkdown, serializeNoteMarkdown } from "./note-markdown";

describe("note Markdown", () => {
  it("round trips headings, lists, quotes, code, dividers and marks", () => {
    const source =
      "# Heading\n\nA **bold** and *italic* and ~~removed~~ and `code` sentence.\n\n- First\n- Second\n  - Nested\n\n3. Third\n4. Fourth\n\n> A quote\n> \n> Another paragraph\n\n```ts\nconst a = 1;\n```\n\n---\n";
    const doc = parseNoteMarkdown(source);
    expect(doc.content?.map((node) => node.type)).toEqual([
      "heading",
      "paragraph",
      "bulletList",
      "orderedList",
      "blockquote",
      "codeBlock",
      "horizontalRule",
    ]);
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });

  it("keeps literal HTML as text rather than creating elements", () => {
    const doc = parseNoteMarkdown('<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>');
    expect(doc.content?.[0]?.content?.[0]).toEqual({
      type: "text",
      text: '<img src=x onerror="alert(1)">',
    });
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
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "# plain *text* [brackets]" }] },
        {
          type: "codeBlock",
          attrs: { language: null },
          content: [{ type: "text", text: "```\ncode" }],
        },
      ],
    };
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });

  it("keeps backticks and surrounding spaces inside inline code", () => {
    for (const text of ["`value`", " value "]) {
      const doc = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text, marks: [{ type: "code" }] }] },
        ],
      };
      expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
    }
  });

  it("preserves literal punctuation inside formatted text", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "a * literal * b", marks: [{ type: "bold" }] }],
        },
      ],
    };
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });
  it("round trips underline, highlight, task lists, and alignment", () => {
    const source =
      'A <u>underlined</u> and <mark>highlighted</mark> sentence.\n\n- [ ] Open task\n- [x] Done task\n\n<p style="text-align: center">Centered</p>\n\n<h2 style="text-align: right">Right heading</h2>\n';
    const doc = parseNoteMarkdown(source);
    expect(
      doc.content?.[0]?.content?.some((node) =>
        node.marks?.some((mark) => mark.type === "underline"),
      ),
    ).toBe(true);
    expect(
      doc.content?.[0]?.content?.some((node) =>
        node.marks?.some((mark) => mark.type === "highlight"),
      ),
    ).toBe(true);
    expect(doc.content?.[1]?.type).toBe("taskList");
    expect(doc.content?.[2]?.attrs).toEqual({ textAlign: "center" });
    expect(doc.content?.[3]?.attrs).toEqual({ level: 2, textAlign: "right" });
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });

  it("preserves alignment across hard breaks", () => {
    const source = '<p style="text-align: center">first  \nsecond</p>\n';
    const doc = parseNoteMarkdown(source);
    expect(doc.content?.[0]?.attrs).toEqual({ textAlign: "center" });
    expect(doc.content?.[0]?.content?.some((node) => node.type === "hardBreak")).toBe(true);
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });

  it("keeps nested checklist items inside their parent task", () => {
    const doc = parseNoteMarkdown(
      "- [ ] Parent\n  - [ ] Child\n  - [x] Done child\n- [ ] Next parent\n",
    );
    const list = doc.content?.[0];
    expect(list?.type).toBe("taskList");
    expect(list?.content).toHaveLength(2);
    expect(list?.content?.[0]?.content?.some((node) => node.type === "taskList")).toBe(true);
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });

  it("keeps checkboxes after an ordinary bullet", () => {
    const doc = parseNoteMarkdown("- Plain bullet\n- [ ] Toggle me\n");
    expect(doc.content?.map((node) => node.type)).toEqual(["bulletList", "taskList"]);
    expect(doc.content?.[1]?.content?.[0]?.type).toBe("taskItem");
  });

  it("keeps blank-line-separated nested checklist siblings inside the parent", () => {
    const doc = parseNoteMarkdown("- [ ] Parent\n  - [ ] Child\n\n  - [ ] Child 2\n");
    const nested = doc.content?.[0]?.content?.[0]?.content?.find(
      (node) => node.type === "taskList",
    );
    expect(nested?.content?.map((node) => node.content?.[0]?.content?.[0]?.text)).toEqual([
      "Child",
      "Child 2",
    ]);
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });

  it("keeps indented bullets and continuation text inside checklist items", () => {
    const bulletDoc = parseNoteMarkdown("- [ ] Parent\n  - plain\n");
    expect(bulletDoc.content?.[0]?.content?.[0]?.content?.map((node) => node.type)).toEqual([
      "paragraph",
      "bulletList",
    ]);
    expect(parseNoteMarkdown(serializeNoteMarkdown(bulletDoc))).toEqual(bulletDoc);

    const continuationDoc = parseNoteMarkdown("- [ ] Parent\n  continuation\n");
    expect(continuationDoc.content?.[0]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe(
      "Parent\ncontinuation",
    );
    expect(parseNoteMarkdown(serializeNoteMarkdown(continuationDoc))).toEqual(continuationDoc);
  });

  it("keeps nested checklists in position before follow-up text", () => {
    const doc = parseNoteMarkdown("- [ ] Parent\n  - [ ] Child\n\n  Follow-up text\n");
    const itemContent = doc.content?.[0]?.content?.[0]?.content;
    expect(itemContent?.map((node) => node.type)).toEqual(["paragraph", "taskList", "paragraph"]);
    expect(itemContent?.[2]?.content?.[0]?.text).toBe("Follow-up text");
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });
});
