import assert from "node:assert/strict";
import test from "node:test";
import { parseUiBlock, uiBlockFallbackQuestions, parseUiBlockFallbackReply, validateUiAnswer } from "./ui-blocks.ts";

const common = { version: 1, id: "question", prompt: "What next?" };
const options = [{ id: "keep", label: "Keep" }, { id: "delete", label: "Delete", danger: true }];
const blocks = [
  { ...common, type: "confirm", confirmLabel: "Proceed", cancelLabel: "Cancel", danger: true },
  { ...common, type: "quick_replies", options },
  { ...common, type: "choice", options, multiple: true, minSelections: 1, maxSelections: 2 },
  { ...common, type: "form", submitLabel: "Send", fields: [
    { id: "name", label: "Name", kind: "text", required: true, maxLength: 20 },
    { id: "notes", label: "Notes", kind: "textarea", placeholder: "Details" },
    { id: "action", label: "Action", kind: "select", options },
    { id: "agree", label: "Agree", kind: "checkbox", required: true },
  ] },
];

test("valid blocks of every type and fallback reply round trips", () => {
  const replies = ["yes confirm", "2 confirm", "Keep, Delete confirm", "Name: Ada\nNotes: hello\nAction: Delete\nAgree: yes\nconfirm"];
  blocks.forEach((block, index) => {
    assert.equal(parseUiBlock(block).ok, true);
    const rendered = uiBlockFallbackQuestions(block);
    assert.match(rendered, /What next\?/);
    assert.match(rendered, /\(destructive\)/);
    const answer = parseUiBlockFallbackReply(block, replies[index]);
    assert.equal("error" in answer, false, JSON.stringify(answer));
    assert.equal(validateUiAnswer(block, answer).ok, true);
  });
  assert.deepEqual(parseUiBlockFallbackReply(blocks[0], "no"), { blockId: "question", confirmed: false });
  assert.deepEqual(parseUiBlockFallbackReply(blocks[1], "Keep"), { blockId: "question", optionIds: ["keep"], confirmed: false });
  assert.equal("error" in parseUiBlockFallbackReply(blocks[2], "1 2 confirm"), false);
  assert.deepEqual(parseUiBlockFallbackReply({ ...blocks[0], confirmLabel: "Confirm" }, "Confirm"), { blockId: "question", confirmed: true });
});

function strings(value, visit, path = []) {
  if (typeof value === "string") visit(path);
  else if (Array.isArray(value)) value.forEach((item, index) => strings(item, visit, [...path, index]));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => strings(item, visit, [...path, key]));
}

test("rejects HTML and controls in every string field", () => {
  for (const block of blocks) {
    const complete = { ...block, title: "Title", fallbackText: "Fallback" };
    strings(complete, (path) => {
      for (const bad of ["<script>alert(1)</script>", "</div>", "&lt;script&gt;", "bad\ttext", "bad\rtext", "\u0000"]) {
        const changed = structuredClone(complete);
        let parent = changed;
        for (const key of path.slice(0, -1)) parent = parent[key];
        parent[path.at(-1)] = bad;
        assert.equal(parseUiBlock(changed).ok, false, `${path}: ${bad}`);
      }
    });
  }
});

test("rejects invalid ids, duplicate ids, empty strings and inconsistent bounds", () => {
  for (const id of ["", "UPPER", "bad id", "-bad", "a".repeat(65)]) assert.equal(parseUiBlock({ ...blocks[0], id }).ok, false);
  assert.equal(parseUiBlock({ ...blocks[1], options: [options[0], options[0]] }).ok, false);
  assert.equal(parseUiBlock({ ...blocks[1], id: "keep" }).ok, false);
  assert.equal(parseUiBlock({ ...blocks[3], fields: [blocks[3].fields[0], blocks[3].fields[0]] }).ok, false);
  for (const patch of [{ prompt: "  " }, { confirmLabel: "x".repeat(76) }, { prompt: "x".repeat(2001) }]) assert.equal(parseUiBlock({ ...blocks[0], ...patch }).ok, false);
  for (const patch of [{ minSelections: 3 }, { maxSelections: 3 }, { multiple: false, maxSelections: 2 }, { minSelections: 2, maxSelections: 1 }]) assert.equal(parseUiBlock({ ...blocks[2], ...patch }).ok, false);
  assert.equal(parseUiBlock({ ...blocks[1], options: [] }).ok, false);
  assert.equal(parseUiBlock({ ...blocks[3], fields: [] }).ok, false);
  assert.equal(parseUiBlock({ ...blocks[3], fields: [{ id: "a", label: "A", kind: "text", options }] }).ok, false);
});

test("enforces serialized UTF-8 size rather than character count", () => {
  const block = { ...blocks[2], options: Array.from({ length: 25 }, (_, i) => ({ id: `item_${i}`, label: "x".repeat(75), description: "😀".repeat(100) })) };
  assert.match(JSON.stringify(parseUiBlock(block)), /8 KB/);
});

test("danger choices require explicit confirmation", () => {
  for (const block of [blocks[1], blocks[2]]) {
    assert.deepEqual(validateUiAnswer(block, { blockId: block.id, optionIds: ["delete"] }), { ok: false, errors: ["danger_requires_confirm"] });
    assert.match(parseUiBlockFallbackReply(block, "Delete").error, /danger_requires_confirm/);
    assert.equal("error" in parseUiBlockFallbackReply(block, "Delete confirm"), false);
  }
  assert.match(parseUiBlockFallbackReply(blocks[0], "yes").error, /danger_requires_confirm/);
  assert.match(parseUiBlockFallbackReply(blocks[3], "Name: Ada\nAction: Delete\nAgree: yes").error, /danger_requires_confirm/);
});

test("answer validation rejects unknown ids, invalid fields and malformed replies", () => {
  const bad = (block, answer) => assert.equal(validateUiAnswer(block, { blockId: block.id, ...answer }).ok, false);
  bad(blocks[1], { optionIds: ["unknown"] });
  bad(blocks[1], { optionIds: ["keep", "keep"] });
  bad(blocks[1], { optionIds: [] });
  bad(blocks[2], { blockId: "other", optionIds: ["keep"] });
  bad(blocks[0], {});
  bad(blocks[3], { values: {} });
  bad(blocks[3], { values: { name: "Ada", agree: true, action: "unknown" } });
  bad(blocks[3], { values: { name: "Ada", agree: "true" } });
  bad(blocks[3], { values: { name: "a".repeat(21), agree: true } });
  bad(blocks[3], { values: { name: "Ada", agree: true, extra: "x" } });
  bad(blocks[3], { values: { name: "<b>Ada</b>", agree: true } });
  for (const [block, reply] of [[blocks[0], "maybe"], [blocks[1], ""], [blocks[1], "99"], [blocks[3], "Unknown: test"], [blocks[3], "Name: Ada\nName: Bob"], [blocks[3], "Agree: maybe"]]) assert.equal("error" in parseUiBlockFallbackReply(block, reply), true);
});
