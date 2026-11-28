// @vitest-environment happy-dom

import { Editor } from "@tiptap/react";
import { expect, it } from "vitest";
import { noteEditorExtensions } from "./note-editor-extensions";

it("does not repurpose browser hard reload as right alignment", () => {
  const editor = new Editor({
    extensions: noteEditorExtensions(),
    content: "<p>plain</p>",
  });
  editor.commands.focus("end");
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key: "r", ctrlKey: true, shiftKey: true, bubbles: true }),
  );
  expect(editor.getJSON().content?.[0]?.attrs?.textAlign ?? null).not.toBe("right");
  editor.destroy();
});
