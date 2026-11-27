// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import { NotesEditor } from "./NotesEditor";
import { NEW_NOTE_INTENT_KEY } from "./new-note-intent";
import type { UseWorkspaceEventsOptions } from "../../state/workspace-events";

const current = vi.hoisted(() => ({ editor: null as Editor | null, options: null as UseWorkspaceEventsOptions | null }));
vi.mock("@tiptap/react", async (original) => {
  const actual = await original<typeof import("@tiptap/react")>();
  return { ...actual, useEditor: (...args: Parameters<typeof actual.useEditor>) => {
    const editor = actual.useEditor(...args); current.editor = editor; return editor;
  } };
});
vi.mock("../../state/workspace-events", () => ({ useWorkspaceEvents: (options: UseWorkspaceEventsOptions) => { current.options = options; return false; } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

const note = { id: "note-1", title: "Plan", version: 1, updatedAt: 1 };
const noteMarkdown = "## Existing heading\r\n\r\nA **bold** plan for C:\\Users\\Ada.\r\n\r\n";
async function defaultFetch(url: string, init?: RequestInit) {
  if (url.endsWith("/body")) return new Response(noteMarkdown);
  if (init?.method === "PATCH") return Response.json({ note: { ...note, ...JSON.parse(String(init.body)), version: 2 } });
  if (init?.method === "POST") return Response.json({ note: { ...note, id: "new-note", title: "Untitled" } });
  return Response.json({ notes: [note, { ...note, id: "note-2", title: "Research" }] });
}
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  const rect = { top: 20, bottom: 40, left: 20, right: 40, width: 20, height: 20, x: 20, y: 20, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect;
  Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
  HTMLElement.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  fetchMock = vi.fn(defaultFetch);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); current.editor = null; });

async function openNote(onNavigate?: React.ComponentProps<typeof NotesEditor>["onNavigate"]) {
  render(<NotesEditor onNavigate={onNavigate} />);
  fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
  await screen.findByRole("textbox", { name: "Note title" });
  await waitFor(() => expect(current.editor?.isEditable).toBe(true));
}

async function openNoteWithMemoryShortcut() {
  const patches: { body: unknown; finish: (response: Response) => void }[] = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") return new Promise<Response>((finish) => {
      patches.push({ body: JSON.parse(String(init.body)), finish });
    });
    return defaultFetch(url, init);
  });
  const onNavigate = vi.fn();
  await openNote(onNavigate);
  const shortcut = screen.getByRole("button", { name: "Save reviewed text as a memory source" });
  return { patches, onNavigate, shortcut };
}

async function editBody(text: string) {
  await act(async () => {
    current.editor!.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }, true);
  });
}
async function typeTrigger(text: string) {
  await act(async () => {
    current.editor!.commands.setContent("<p></p>", false);
    current.editor!.commands.focus("end");
    current.editor!.commands.insertContent({ type: "text", text });
  });
}

describe("NotesEditor", () => {
  it("creates a note queued by Files navigation", async () => {
    window.sessionStorage.setItem(NEW_NOTE_INTENT_KEY, "personal");
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST" ? Response.json({ note: { ...note, id: "queued-note", title: "Untitled" } }) : _url.endsWith("/body") ? new Response("") : Response.json({ notes: [] }));
    render(<NotesEditor />);
    await screen.findByRole("textbox", { name: "Note title" });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
    expect(window.sessionStorage.getItem(NEW_NOTE_INTENT_KEY)).toBeNull();
  });

  it("navigates to Memory without saving when there are no changes", async () => {
    const { unmount } = render(<NotesEditor />);
    await screen.findByRole("button", { name: "Plan" });
    expect(screen.queryByRole("button", { name: "Save reviewed text as a memory source" })).toBeNull();
    unmount();

    const { patches, onNavigate, shortcut } = await openNoteWithMemoryShortcut();
    fireEvent.click(shortcut);
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("memory");
    expect(patches).toHaveLength(0);
  });

  it("flushes a pending body edit and waits for the save before opening Memory", async () => {
    const { patches, onNavigate, shortcut } = await openNoteWithMemoryShortcut();
    await editBody("Unsaved paragraph");
    expect(patches).toHaveLength(0);
    fireEvent.click(shortcut);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ title: "Plan", markdown: "Unsaved paragraph\n", expectedVersion: 1 });
    expect(shortcut).toHaveProperty("disabled", true);
    expect(onNavigate).not.toHaveBeenCalled();
    await act(async () => patches[0]!.finish(Response.json({ note: { ...note, version: 2 } })));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("memory");
  });

  it("waits for an in-flight save, then persists newer edits with the returned version", async () => {
    const { patches, onNavigate, shortcut } = await openNoteWithMemoryShortcut();
    const title = screen.getByRole("textbox", { name: "Note title" });
    fireEvent.change(title, { target: { value: "First edit" } });
    fireEvent.blur(title);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ title: "First edit", markdown: noteMarkdown, expectedVersion: 1 });
    await editBody("Newer body");
    fireEvent.click(shortcut);
    expect(patches).toHaveLength(1);
    expect(onNavigate).not.toHaveBeenCalled();

    await act(async () => patches[0]!.finish(Response.json({ note: { ...note, title: "First edit", version: 2 } })));
    expect(patches).toHaveLength(2);
    expect(patches[1]!.body).toEqual({ title: "First edit", markdown: "Newer body\n", expectedVersion: 2 });
    expect(onNavigate).not.toHaveBeenCalled();
    await act(async () => patches[1]!.finish(Response.json({ note: { ...note, title: "First edit", version: 3 } })));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("memory");
  });

  it("keeps the edited note open if the save fails and allows another attempt", async () => {
    const { patches, onNavigate, shortcut } = await openNoteWithMemoryShortcut();
    await editBody("Keep my draft");
    fireEvent.click(shortcut);
    await act(async () => patches[0]!.finish(Response.json({ error: "Save failed" }, { status: 500 })));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(current.editor?.getText()).toBe("Keep my draft");
    expect(shortcut).toHaveProperty("disabled", false);

    fireEvent.click(shortcut);
    expect(patches).toHaveLength(2);
    expect(patches[1]!.body).toEqual(patches[0]!.body);
    await act(async () => patches[1]!.finish(Response.json({ note: { ...note, version: 2 } })));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("memory");
  });

  it("keeps the draft and blocks Memory navigation after a version conflict", async () => {
    const { patches, onNavigate, shortcut } = await openNoteWithMemoryShortcut();
    await editBody("Conflicted draft");
    fireEvent.click(shortcut);
    await act(async () => patches[0]!.finish(Response.json({}, { status: 409 })));
    expect(screen.getByRole("button", { name: "Save draft as a copy" })).toBeTruthy();
    fireEvent.click(shortcut);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(patches).toHaveLength(1);
    expect(current.editor?.getText()).toBe("Conflicted draft");
  });

  it("uses the workspace scope queued by Files navigation", async () => {
    window.sessionStorage.setItem(NEW_NOTE_INTENT_KEY, "workspace");
    render(<NotesEditor />);
    await screen.findByRole("textbox", { name: "Note title" });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/api/notes?scope=workspace");
  });

  it("keeps an unsent chat draft when the panel is hidden and reopened", async () => {
    await openNote();
    const toggle = screen.getByRole("button", { name: "Toggle note chat" });
    fireEvent.click(toggle);
    const composer = await screen.findByPlaceholderText("Ask about this note");
    await waitFor(() => expect(composer).toHaveProperty("disabled", false));
    fireEvent.change(composer, { target: { value: "draft question" } });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(screen.getByPlaceholderText("Ask about this note")).toHaveProperty("value", "draft question");
  });

  it("renders the notes list, empty editor prompt, and loading skeleton", async () => {
    render(<NotesEditor />);
    expect(screen.getByRole("status", { name: "Loading notes" })).toBeTruthy();
    expect(screen.getByText("Select a note or create a new one")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Plan" })).toBeTruthy();
    expect(screen.getByTestId("secondary-panel")).toBeTruthy();
  });
  it("renders empty list copy and creates a note", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST" ? Response.json({ note: { ...note, title: "Untitled", id: "new-note" } }) : _url.endsWith("/body") ? new Response("") : Response.json({ notes: [] }));
    render(<NotesEditor />);
    await screen.findByText("No notes yet");
    fireEvent.click(screen.getByRole("button", { name: "+ New Note" }));
    await screen.findByRole("textbox", { name: "Note title" });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
  });
  it("renames a note using the current version and preserves its stored Markdown", async () => {
    await openNote();
    expect(screen.getByRole("heading", { name: "Existing heading" })).toBeTruthy();
    expect(current.editor?.getText()).toContain("C:\\Users\\Ada");
    fireEvent.change(screen.getByRole("textbox", { name: "Note title" }), { target: { value: "New plan" } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true), { timeout: 2000 });
    await screen.findByText("Saved");
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    const payload = JSON.parse(String(call?.[1]?.body));
    expect(payload.title).toBe("New plan");
    expect(payload.expectedVersion).toBe(1);
    expect(payload.markdown).toBe(noteMarkdown);
    fireEvent.click(screen.getByRole("button", { name: "Open formatting toolbar" }));
    expect(await screen.findByRole("toolbar", { name: "Note formatting" })).toBeTruthy();
  });
  it("keeps a draft and reports failed saves", async () => {
    await openNote();
    fetchMock.mockImplementation(async () => Response.json({ error: "Service unavailable" }, { status: 503 }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note title" }), { target: { value: "Keep draft" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "Note title" }));
    await screen.findByText("Save failed");
    expect((screen.getByRole("textbox", { name: "Note title" }) as HTMLTextAreaElement).value).toBe("Keep draft");
  });
  it("flushes an unsaved draft before opening another note, and stays put if that save fails", async () => {
    await openNote();
    fireEvent.change(screen.getByRole("textbox", { name: "Note title" }), { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Research" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Research" }).getAttribute("aria-current")).toBe("page"));
    await screen.findByRole("textbox", { name: "Note title" });
    await waitFor(() => expect(current.editor?.isEditable).toBe(true));
    fireEvent.change(screen.getByRole("textbox", { name: "Note title" }), { target: { value: "Unsaveable" } });
    fetchMock.mockImplementation(async () => Response.json({ error: "Service unavailable" }, { status: 503 }));
    fireEvent.click(screen.getByRole("button", { name: "Edited" }));
    await screen.findByText("Save failed");
    expect(screen.getByRole("button", { name: "Research" }).getAttribute("aria-current")).toBe("page");
    expect((screen.getByRole("textbox", { name: "Note title" }) as HTMLTextAreaElement).value).toBe("Unsaveable");
  });
  it("stops stale retries after a conflict and can save the intact draft as a copy", async () => {
    await openNote();
    let copyFails = true;
    const copy = { ...note, id: "note-copy", title: "Local title (copy)" };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return Response.json({}, { status: 409 });
      if (init?.method === "POST") return copyFails
        ? Response.json({}, { status: 503 })
        : Response.json({ note: copy });
      if (url === "/api/notes/note-copy/body") return new Response("Local body\n");
      return defaultFetch(url, init);
    });
    await typeTrigger("Local body");
    const title = screen.getByRole("textbox", { name: "Note title" }) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "Local title" } });
    fireEvent.blur(title);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This note changed elsewhere. Your draft is still here.");
    fireEvent.click(screen.getByRole("button", { name: "Research" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), { target: { value: "workspace" } });
    fireEvent.blur(title);
    const copyButton = screen.getByRole<HTMLButtonElement>("button", { name: "Save draft as a copy" });
    fireEvent.click(copyButton);
    await waitFor(() => expect(copyButton.disabled).toBe(false));
    expect(title.value).toBe("Local title");
    expect(current.editor?.getText()).toBe("Local body");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);

    copyFails = false;
    fireEvent.click(copyButton);
    await waitFor(() => expect(screen.getByRole("button", { name: copy.title }).getAttribute("aria-current")).toBe("page"));
    await waitFor(() => expect(current.editor?.isEditable).toBe(true));
    expect(current.editor?.getText()).toBe("Local body");
    const lastCopy = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").at(-1);
    expect(lastCopy?.[0]).toBe("/api/notes?scope=personal");
    expect(JSON.parse(String(lastCopy?.[1]?.body))).toEqual({ title: copy.title, markdown: "Local body\n" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("keeps the draft if reloading fails and uses the latest version after a successful reload", async () => {
    await openNote();
    let stale = true;
    let bodyAvailable = false;
    const latest = { ...note, title: "Server title", version: 2 };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return stale
        ? Response.json({}, { status: 409 })
        : Response.json({ note: { ...latest, title: "Renamed after reloading", version: 3 } });
      if (url === "/api/notes/note-1") return Response.json({ note: latest });
      if (url === "/api/notes/note-1/body") return bodyAvailable
        ? new Response("Latest Markdown\n")
        : new Response(null, { status: 503 });
      return defaultFetch(url, init);
    });
    const title = screen.getByRole("textbox", { name: "Note title" }) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "Local title" } });
    fireEvent.blur(title);
    const reloadButton = await screen.findByRole<HTMLButtonElement>("button", { name: "Discard draft and reload" });
    fireEvent.click(reloadButton);
    await waitFor(() => expect(reloadButton.disabled).toBe(false));
    expect(title.value).toBe("Local title");

    bodyAvailable = true;
    fireEvent.click(reloadButton);
    await waitFor(() => expect(title.value).toBe(latest.title));
    expect(current.editor?.getText()).toBe("Latest Markdown");
    expect(screen.queryByRole("alert")).toBeNull();
    stale = false;
    fireEvent.change(title, { target: { value: "Renamed after reloading" } });
    fireEvent.blur(title);
    await screen.findByText("Saved");
    const lastPatch = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH").at(-1);
    expect(JSON.parse(String(lastPatch?.[1]?.body))).toEqual({ title: "Renamed after reloading", markdown: "Latest Markdown\n", expectedVersion: 2 });
  });
  it("moves from the title into the body with Enter", async () => {
    await openNote();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Note title" }), { key: "Enter" });
    await waitFor(() => expect(current.editor!.isFocused).toBe(true));
  });
  it("filters slash blocks and applies the selected command with the keyboard", async () => {
    await openNote();
    await typeTrigger("/heading");
    expect(screen.getByRole("group", { name: "Basic blocks" })).toBeTruthy();
    fireEvent.keyDown(current.editor!.view.dom, { key: "ArrowDown" });
    fireEvent.keyDown(current.editor!.view.dom, { key: "Enter" });
    expect(current.editor!.isActive("heading", { level: 2 })).toBe(true);
    expect(current.editor!.getText()).not.toContain("/heading");
    expect(screen.queryByRole("listbox", { name: "Insert block" })).toBeNull();
  });
  it("shows no matching blocks and dismisses with Escape", async () => {
    await openNote(); await typeTrigger("/xyz");
    expect(screen.getByText("No matching blocks")).toBeTruthy();
    fireEvent.keyDown(current.editor!.view.dom, { key: "Escape" });
    expect(screen.queryByTestId("note-slash-menu")).toBeNull();
  });
  it("drills into note mentions, goes back, filters and inserts a text mention", async () => {
    await openNote(); await typeTrigger("@");
    fireEvent.keyDown(current.editor!.view.dom, { key: "Enter" });
    expect(screen.getByText("esc to go back")).toBeTruthy();
    fireEvent.keyDown(current.editor!.view.dom, { key: "Escape" });
    expect(screen.getByRole("option", { name: "Notes" })).toBeTruthy();
    await typeTrigger("@Res");
    expect(screen.getByRole("option", { name: "Research" })).toBeTruthy();
    fireEvent.keyDown(current.editor!.view.dom, { key: "Tab" });
    expect(current.editor!.getText()).toBe("@Research ");
    expect(screen.queryByTestId("note-mention-menu")).toBeNull();
  });
  it("shows empty mention results and formats using the toolbar", async () => {
    await openNote(); await typeTrigger("@missing");
    expect(screen.getByText("No results for “missing”")).toBeTruthy();
    fireEvent.keyDown(current.editor!.view.dom, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Open formatting toolbar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bold" }));
    expect(current.editor!.isActive("bold")).toBe(true);
  });
  it("shows a pending create immediately, reconciles its id, and rolls back a failed create", async () => {
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn(async (_path: string, options?: RequestInit) => options?.method === "POST"
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : new Response(JSON.stringify({ notes: [] })));
    vi.stubGlobal("fetch", fetcher);
    render(<NotesEditor workspaceId="ws_1" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(screen.getByRole("button", { name: "Untitled" }).closest("li")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => finish(new Response(JSON.stringify({ note: { id: "note_1", title: "Saved", version: 1 } }), { status: 201 })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Saved" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Untitled" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    await act(async () => finish(new Response(JSON.stringify({ error: "Failed" }), { status: 500 })));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Untitled" })).toBeNull());
    expect(screen.getByRole("button", { name: "Saved" })).toBeTruthy();
  });

  it("patches a title while saving and restores the list on failure", async () => {
    const draft = { id: "note_1", title: "Draft", version: 1 };
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (options?.method === "PATCH") return new Promise<Response>((resolve) => { finish = resolve; });
      if (path.endsWith("/body")) return new Response("Body");
      return new Response(JSON.stringify({ notes: [draft] }));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<NotesEditor workspaceId="ws_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Draft" }));
    const title = await screen.findByLabelText("Note title");
    await waitFor(() => expect(current.editor?.isEditable).toBe(true));
    fireEvent.change(title, { target: { value: "Changed" } });
    fireEvent.blur(title);
    expect(screen.getByRole("button", { name: "Changed" }).closest("li")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => finish(new Response(JSON.stringify({ error: "Failed" }), { status: 500 })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Draft" })).toBeTruthy());
    expect((screen.getByLabelText("Note title") as HTMLTextAreaElement).value).toBe("Changed");
  });

  it("ignores older active-note frames and locks editing during a newer body load", async () => {
    const latest = { id: "note_1", workspaceId: "ws_1", scope: "personal", title: "Latest", version: 3, sha256: "hash", createdBy: "alice", createdAt: 1, updatedAt: 3, projectId: null, ingestion: { state: "pending" } };
    let finishBody: (response: Response) => void = () => {};
    const fetcher = vi.fn(async (path: string) => path.endsWith("/body")
      ? new Promise<Response>((resolve) => { finishBody = resolve; })
      : new Response(JSON.stringify({ notes: [latest] })));
    vi.stubGlobal("fetch", fetcher);
    render(<NotesEditor workspaceId="ws_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Latest" }));
    expect(screen.queryByLabelText("Note title")).toBeNull();
    expect(screen.getByRole("status", { name: "Loading note" })).toBeTruthy();
    expect(current.editor?.isEditable).toBe(false);
    await act(async () => finishBody(new Response("Latest body")));
    expect(((await screen.findByLabelText("Note title")) as HTMLTextAreaElement).value).toBe("Latest");
    await waitFor(() => expect(current.editor?.isEditable).toBe(true));
    const frame = { id: "evt_1", workspaceId: "ws_1", kind: "note.updated", entityId: latest.id, at: 4, payload: { note: { ...latest, title: "Stale", version: 2 } } };
    await act(async () => current.options?.onEvent(frame));
    expect((screen.getByLabelText("Note title") as HTMLTextAreaElement).value).toBe("Latest");
    expect(fetcher.mock.calls.filter(([path]) => path.endsWith("/body"))).toHaveLength(1);
    await act(async () => current.options?.onEvent({ ...frame, payload: { note: { ...latest, title: "Newer", version: 4 } } }));
    expect(screen.queryByLabelText("Note title")).toBeNull();
    expect(current.editor?.isEditable).toBe(false);
    await act(async () => finishBody(new Response("Newer body")));
    expect(((await screen.findByLabelText("Note title")) as HTMLTextAreaElement).value).toBe("Newer");
    await waitFor(() => expect(current.editor?.isEditable).toBe(true));
  });

  it("keeps both snapshot rows and events received while the list request is pending", async () => {
    const snapshot = { id: "note_old", workspaceId: "ws_1", scope: "personal", title: "Snapshot row", version: 1, sha256: "hash", createdBy: "alice", createdAt: 1, updatedAt: 1, projectId: null, ingestion: { state: "pending" } };
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    render(<NotesEditor workspaceId="ws_1" />);
    await act(async () => current.options?.onEvent({ id: "evt_new", workspaceId: "ws_1", kind: "note.created", entityId: "note_new", at: 2,
      payload: { note: { ...snapshot, id: "note_new", title: "Event row", updatedAt: 2 } },
    }));
    expect(screen.getByRole("button", { name: "Event row" })).toBeTruthy();
    await act(async () => finish(Response.json({ notes: [snapshot] })));
    expect(screen.getByRole("button", { name: "Event row" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Snapshot row" })).toBeTruthy();
  });

  it("adds assistant Markdown to the note as structure, not escaped literal text", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/body")) return new Response("");
      if (url.endsWith("/chat")) return Response.json({ messages: [{ id: "m1", role: "assistant", content: "## Next steps\n\n- ship it" }] });
      if (init?.method === "PATCH") return Response.json({ note: { ...note, ...JSON.parse(String(init.body)), version: 2 } });
      return Response.json({ notes: [note] });
    });
    await openNote();
    expect(screen.queryByRole("button", { name: "Add to note" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle note chat" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add to note" }));
    expect(current.editor!.isActive("bulletList")).toBe(true);
    expect(screen.getByRole("heading", { name: "Next steps" })).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true), { timeout: 2000 });
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(call?.[1]?.body)).markdown).toContain("## Next steps\n\n- ship it\n");
  });
});
