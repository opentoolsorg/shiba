// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { KnowledgeNote } from "@shiba/shared";
import { NoteChatPanel } from "./NoteChatPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("picks and removes mentions, sends context, and adds an answer to the note", async () => {
  const add = vi.fn();
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.startsWith("/api/files")) return Response.json({ files: [{ id: "file_1", name: "Report" }] });
    if (options?.method === "POST") return Response.json({ messages: [{ id: "reply", role: "assistant", content: "Suggested text" }] });
    return Response.json({ messages: [] });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<NoteChatPanel noteId="note_1" notes={[{ id: "note_2", title: "Reference" } as KnowledgeNote]} scope="personal" workspaceId="ws_1" onAdd={add} />);
  const composer = screen.getByRole("textbox");
  await waitFor(() => expect(composer.hasAttribute("disabled")).toBe(false));
  fireEvent.change(composer, { target: { value: "@Ref" } });
  fireEvent.click(screen.getByRole("button", { name: "Reference (note)" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Reference" }));
  fireEvent.change(composer, { target: { value: "Summarize @Rep" } });
  fireEvent.click(screen.getByRole("button", { name: "Report (file)" }));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  fireEvent.click(await screen.findByRole("button", { name: "Add to note" }));
  expect(add).toHaveBeenCalledWith("Suggested text");
  expect(fetcher).toHaveBeenCalledWith("/api/notes/note_1/chat", expect.objectContaining({ method: "POST", body: JSON.stringify({ message: "Summarize ", mentions: [{ kind: "file", id: "file_1", name: "Report" }] }) }));
});

it("shows empty matches and retains a failed draft", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_path: string, options?: RequestInit) => options?.method === "POST" ? Response.json({ error: "Please try again." }, { status: 502 }) : Response.json({ messages: [], files: [] })));
  render(<NoteChatPanel noteId="note_1" notes={[]} scope="personal" workspaceId={null} onAdd={vi.fn()} />);
  const composer = screen.getByRole("textbox");
  await waitFor(() => expect(composer.hasAttribute("disabled")).toBe(false));
  fireEvent.change(composer, { target: { value: "@missing" } });
  expect(screen.getByText("No matching notes or files.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Please try again.");
  expect(composer).toHaveProperty("value", "@missing");
});
