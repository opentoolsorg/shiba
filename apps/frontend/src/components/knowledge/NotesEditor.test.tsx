// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotesEditor } from "./NotesEditor";

vi.mock("@tiptap/react", () => ({
  useEditor: () => ({ commands: { setContent: vi.fn() }, chain: () => ({ focus: () => ({ toggleHeading: () => ({ run: vi.fn() }), toggleBulletList: () => ({ run: vi.fn() }), insertContent: () => ({ run: vi.fn() }), toggleCodeBlock: () => ({ run: vi.fn() }), toggleBlockquote: () => ({ run: vi.fn() }) }) }) }),
  EditorContent: () => <div data-testid="editor-surface" />,
}));

describe("NotesEditor", () => {
  it("renders notes list and editor surface", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ notes: [] }), { status: 200 })));
    render(<NotesEditor />);
    expect(screen.getByText("Notes")).toBeTruthy();
    expect(screen.getByTestId("editor-surface")).toBeTruthy();
  });
});