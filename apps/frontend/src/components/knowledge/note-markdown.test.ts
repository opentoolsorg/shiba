import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { getSchema } from "@tiptap/react";
import { describe, expect, it } from "vitest";
import { noteEditorExtensions } from "./note-editor-extensions";
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

  it("recovers legacy six-space nested checklist serialization", () => {
    const doc = parseNoteMarkdown("- [ ] Parent\n\n      - [ ] Child\n");
    const itemContent = doc.content?.[0]?.content?.[0]?.content;
    expect(itemContent?.map((node) => node.type)).toEqual(["paragraph", "taskList"]);
    expect(itemContent?.[1]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe("Child");
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });

  it("keeps bare and reference links stable", () => {
    const bare = parseNoteMarkdown("Visit https://example.com now\n");
    const bareLinked = bare.content?.[0]?.content?.find((node) =>
      node.marks?.some((mark) => mark.type === "link"),
    );
    expect(bareLinked?.text).toBe("https://example.com");
    expect(parseNoteMarkdown(serializeNoteMarkdown(bare))).toEqual(bare);

    const reference = parseNoteMarkdown(
      "Read [the guide][guide]\n\n[guide]: https://example.com/docs\n",
    );
    const linked = reference.content?.[0]?.content?.find((node) =>
      node.marks?.some((mark) => mark.type === "link"),
    );
    expect(linked?.text).toBe("the guide");
    expect(linked?.marks?.find((mark) => mark.type === "link")?.attrs?.href).toBe(
      "https://example.com/docs",
    );
    expect(parseNoteMarkdown(serializeNoteMarkdown(reference))).toEqual(reference);
  });

  it("round trips Markdown tables from chat replies", () => {
    const doc = parseNoteMarkdown("| Name | State |\n| - | - |\n| Alpha | Done |\n");
    expect(doc.content?.[0]?.type).toBe("table");
    expect(
      doc.content?.[0]?.content?.[1]?.content?.map((cell) => cell.content?.[0]?.content?.[0]?.text),
    ).toEqual(["Alpha", "Done"]);
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });

  it("preserves checkboxes and alignment inside aligned tasks", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [
                {
                  type: "paragraph",
                  attrs: { textAlign: "center" },
                  content: [{ type: "text", text: "Aligned" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const saved = serializeNoteMarkdown(doc);
    expect(saved).toContain("- [x] Aligned");
    expect(parseNoteMarkdown(saved)).toEqual(doc);
  });

  it("round trips overlapping bold and italic ranges without literal asterisks", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a ", marks: [{ type: "bold" }] },
            { type: "text", text: "b", marks: [{ type: "bold" }, { type: "italic" }] },
            { type: "text", text: " c", marks: [{ type: "italic" }] },
          ],
        },
      ],
    };
    const reopened = parseNoteMarkdown(serializeNoteMarkdown(doc));
    expect(reopened).toEqual(doc);
    expect(reopened.content?.[0]?.content?.some((node) => node.text?.includes("*"))).toBe(false);
  });

  it("round trips a trailing hard break without a literal backslash", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "line" }, { type: "hardBreak" }] },
      ],
    };
    const saved = serializeNoteMarkdown(doc);
    expect(saved).not.toContain("\\");
    expect(parseNoteMarkdown(saved)).toEqual(doc);
  });

  it("resumes ordered numbering after mixed checklist items", () => {
    const doc = parseNoteMarkdown("1. [ ] task\n2. plain\n3. next\n");
    expect(doc.content?.map((node) => node.type)).toEqual(["taskList", "orderedList"]);
    expect(doc.content?.[1]?.attrs).toEqual({ start: 2 });
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });

  it("parses links and tables into the live editor schema", () => {
    const doc = parseNoteMarkdown("| Name | Link |\n| - | - |\n| Alpha | https://example.com |\n");
    const schema = getSchema(noteEditorExtensions());
    expect(() => ProseMirrorNode.fromJSON(schema, doc)).not.toThrow();
  });

  it("does not preserve unsafe link protocols", () => {
    const doc = parseNoteMarkdown("[click](javascript:alert(1))\n");
    expect(doc.content?.[0]?.content?.[0]?.text).toBe("click");
    expect(doc.content?.[0]?.content?.[0]?.marks).toBeUndefined();
  });

  it("preserves link titles", () => {
    const doc = parseNoteMarkdown('[guide](https://example.com "Guide title")\n');
    const linked = doc.content?.[0]?.content?.[0];
    expect(linked?.marks?.find((mark) => mark.type === "link")?.attrs).toEqual({
      href: "https://example.com",
      title: "Guide title",
    });
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });
  it("keeps fenced checkbox samples as literal code inside tasks", () => {
    const doc = parseNoteMarkdown("- [ ] Parent\n\n  ```\n  - [ ] sample\n  ```\n");
    const itemContent = doc.content?.[0]?.content?.[0]?.content;
    expect(itemContent?.map((node) => node.type)).toEqual(["paragraph", "codeBlock"]);
    expect(itemContent?.[1]?.content?.[0]?.text).toBe("- [ ] sample");
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
  });

  it("preserves link destinations on inline code labels", () => {
    const doc = parseNoteMarkdown("[`guide`](https://example.com/docs)\n");
    const linked = doc.content?.[0]?.content?.[0];
    expect(linked?.text).toBe("guide");
    expect(linked?.marks?.some((mark) => mark.type === "link")).toBe(true);
    expect(linked?.marks?.find((mark) => mark.type === "link")?.attrs?.href).toBe(
      "https://example.com/docs",
    );
    expect(linked?.marks?.some((mark) => mark.type === "code")).toBe(true);
    expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);

    const schema = getSchema(noteEditorExtensions());
    expect(() => ProseMirrorNode.fromJSON(schema, doc)).not.toThrow();
  });

  it("uses the first duplicate link reference definition", () => {
    const doc = parseNoteMarkdown(
      "Read [guide][docs]\n\n[docs]: https://example.com/first\n[docs]: https://example.com/second\n",
    );
    const linked = doc.content?.[0]?.content?.find((node) =>
      node.marks?.some((mark) => mark.type === "link"),
    );
    const link = linked?.marks?.find((mark) => mark.type === "link");
    expect(link?.attrs?.href).toBe("https://example.com/first");
  });

  it("keeps link titles in the live editor schema", () => {
    const doc = parseNoteMarkdown('[guide](https://example.com "Guide title")\n');
    const schema = getSchema(noteEditorExtensions());
    const parsed = ProseMirrorNode.fromJSON(schema, doc);
    const link = parsed.firstChild?.firstChild?.marks.find((mark) => mark.type.name === "link");
    expect(link?.attrs.title).toBe("Guide title");
  });
  it("preserves bold and italic inline code through the live schema", () => {
    for (const source of ["**`code`**\n", "*`code`*\n"]) {
      const doc = parseNoteMarkdown(source);
      const marked = doc.content?.[0]?.content?.[0];
      expect(marked?.marks?.some((mark) => mark.type === "code")).toBe(true);
      const schema = getSchema(noteEditorExtensions());
      expect(() => ProseMirrorNode.fromJSON(schema, doc)).not.toThrow();
      expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
    }
  });
  it("preserves struck-through inline code next to plain letters", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "code",
              marks: [{ type: "strike" }, { type: "code" }],
            },
            { type: "text", text: "x" },
          ],
        },
      ],
    };
    const saved = serializeNoteMarkdown(doc);
    expect(saved).not.toContain("~~`code`~~x");
    expect(parseNoteMarkdown(saved)).toEqual(doc);
  });
  it("keeps soft line breaks before ordinary strikethrough", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "first\n" },
            { type: "text", text: "second", marks: [{ type: "strike" }] },
          ],
        },
      ],
    };
    const saved = serializeNoteMarkdown(doc);
    expect(saved).toContain("first&#10;<del>second</del>");
    expect(parseNoteMarkdown(saved)).toEqual(doc);
  });
  it("uses del HTML for trailing-space and punctuation strike boundaries", () => {
    for (const segments of [
      [
        { type: "text", text: "trim ", marks: [{ type: "strike" }] },
        { type: "text", text: "plain" },
      ],
      [
        { type: "text", text: "!", marks: [{ type: "strike" }] },
        { type: "text", text: "plain" },
      ],
    ]) {
      const doc = { type: "doc", content: [{ type: "paragraph", content: segments }] };
      const saved = serializeNoteMarkdown(doc);
      expect(saved).toContain("<del>");
      expect(parseNoteMarkdown(saved)).toEqual(doc);
    }
  });
  it("preserves newline characters inside code and at paragraph edges", () => {
    for (const content of [
      [{ type: "text", text: "one\ntwo", marks: [{ type: "code" }] }],
      [{ type: "text", text: "\nleading" }],
      [{ type: "text", text: "trailing\n" }],
      [{ type: "text", text: "under\nline", marks: [{ type: "underline" }] }],
    ]) {
      const doc = { type: "doc", content: [{ type: "paragraph", content }] };
      expect(parseNoteMarkdown(serializeNoteMarkdown(doc))).toEqual(doc);
    }
  });
});
