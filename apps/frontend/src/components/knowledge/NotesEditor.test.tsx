// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotesEditor } from "./NotesEditor";
import type { UseWorkspaceEventsOptions } from "../../state/workspace-events";

const realtime = vi.hoisted(() => ({ options: null as UseWorkspaceEventsOptions | null, setEditable: vi.fn(), setContent: vi.fn(), body: "Body" }));

vi.mock("@tiptap/react", () => {
  const editor = {
    commands: { setContent: realtime.setContent },
    setEditable: realtime.setEditable,
    getText: () => realtime.body,
    state: { doc: { forEach: (visit: (node: unknown) => void) => visit({ type: { name: "paragraph" }, textContent: realtime.body }) } },
    chain: () => ({ focus: () => ({ toggleHeading: () => ({ run: vi.fn() }), toggleBulletList: () => ({ run: vi.fn() }), insertContent: () => ({ run: vi.fn() }), toggleCodeBlock: () => ({ run: vi.fn() }), toggleBlockquote: () => ({ run: vi.fn() }) }) }),
  };
  let update: (event: { editor: typeof editor }) => void;
  return {
    useEditor: ({ onUpdate }: { onUpdate: typeof update }) => { update = onUpdate; return editor; },
    EditorContent: () => <textarea aria-label="Note body" data-testid="editor-surface" onChange={(event) => {
      realtime.body = event.target.value;
      update({ editor });
    }} />,
  };
});

vi.mock("../../state/workspace-events", () => ({ useWorkspaceEvents: (options: UseWorkspaceEventsOptions) => { realtime.options = options; return false; } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); realtime.body = "Body"; });

async function openNoteWithMemoryShortcut() {
  const note = { id: "note_1", title: "Draft", version: 1 };
  const patches: { body: unknown; finish: (response: Response) => void }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, options?: RequestInit) => {
    if (options?.method === "PATCH") return new Promise<Response>((finish) => {
      patches.push({ body: JSON.parse(String(options.body)), finish });
    });
    if (path.endsWith("/body")) return new Response("Body");
    return Response.json({ notes: [note] });
  }));
  const onNavigate = vi.fn();
  render(<NotesEditor onNavigate={onNavigate} />);
  fireEvent.click(await screen.findByRole("button", { name: "Draft" }));
  await waitFor(() => expect(realtime.setEditable).toHaveBeenLastCalledWith(true, false));
  const shortcut = screen.getByRole("button", { name: "Save reviewed text as a memory source" });
  return { note, patches, onNavigate, shortcut, body: screen.getByRole("textbox", { name: "Note body" }) };
}

describe("NotesEditor", () => {
  it("renders notes list and editor surface", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ notes: [] }), { status: 200 })));
    render(<NotesEditor />);
    expect(screen.getByText("Notes")).toBeTruthy();
    expect(screen.getByTestId("editor-surface")).toBeTruthy();
  });
  it("shows a pending create immediately, reconciles its id, and rolls back a failed create", async () => {
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn(async (_path: string, options?: RequestInit) => options?.method === "POST"
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : new Response(JSON.stringify({ notes: [] })));
    vi.stubGlobal("fetch", fetcher);
    render(<NotesEditor workspaceId="ws_1" />);
    await act(async () => {});
    fireEvent.click(screen.getByText("New note"));
    expect(screen.getByRole("button", { name: "Untitled" }).closest("li")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => finish(new Response(JSON.stringify({ note: { id: "note_1", title: "Saved", version: 1 } }), { status: 201 })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Saved" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Untitled" })).toBeNull();
    fireEvent.click(screen.getByText("New note"));
    await act(async () => finish(new Response(JSON.stringify({ error: "Failed" }), { status: 500 })));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Untitled" })).toBeNull());
    expect(screen.getByRole("button", { name: "Saved" })).toBeTruthy();
  });

  it("patches a title while saving and restores the list on failure", async () => {
    const note = { id: "note_1", title: "Draft", version: 1 };
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (options?.method === "PATCH") return new Promise<Response>((resolve) => { finish = resolve; });
      if (path.endsWith("/body")) return new Response("Body");
      return new Response(JSON.stringify({ notes: [note] }));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<NotesEditor workspaceId="ws_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Draft" }));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Changed" } });
    fireEvent.blur(screen.getByLabelText("Note title"));
    expect(screen.getByRole("button", { name: "Changed" }).closest("li")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => finish(new Response(JSON.stringify({ error: "Failed" }), { status: 500 })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Draft" })).toBeTruthy());
    expect((screen.getByLabelText("Note title") as HTMLInputElement).value).toBe("Changed");
  });

  it("ignores older active-note frames and locks editing during a newer body load", async () => {
    const note = { id: "note_1", workspaceId: "ws_1", scope: "personal", title: "Latest", version: 3, sha256: "hash", createdBy: "alice", createdAt: 1, updatedAt: 3, projectId: null, ingestion: { state: "pending" } };
    let finishBody: (response: Response) => void = () => {};
    const fetcher = vi.fn(async (path: string) => path.endsWith("/body")
      ? new Promise<Response>((resolve) => { finishBody = resolve; })
      : new Response(JSON.stringify({ notes: [note] })));
    vi.stubGlobal("fetch", fetcher);
    render(<NotesEditor workspaceId="ws_1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Latest" }));
    expect((screen.getByLabelText("Note title") as HTMLInputElement).readOnly).toBe(true);
    expect(realtime.setEditable).toHaveBeenLastCalledWith(false, false);
    await act(async () => finishBody(new Response("Latest body")));
    expect((screen.getByLabelText("Note title") as HTMLInputElement).readOnly).toBe(false);
    expect(realtime.setEditable).toHaveBeenLastCalledWith(true, false);
    const frame = { id: "evt_1", workspaceId: "ws_1", kind: "note.updated", entityId: note.id, at: 4, payload: { note: { ...note, title: "Stale", version: 2 } } };
    await act(async () => realtime.options?.onEvent(frame));
    expect((screen.getByLabelText("Note title") as HTMLInputElement).value).toBe("Latest");
    expect(fetcher.mock.calls.filter(([path]) => path.endsWith("/body"))).toHaveLength(1);
    await act(async () => realtime.options?.onEvent({ ...frame, payload: { note: { ...note, title: "Newer", version: 4 } } }));
    expect((screen.getByLabelText("Note title") as HTMLInputElement).value).toBe("Newer");
    expect((screen.getByLabelText("Note title") as HTMLInputElement).readOnly).toBe(true);
    expect(realtime.setEditable).toHaveBeenLastCalledWith(false, false);
    await act(async () => finishBody(new Response("Newer body")));
    expect(realtime.setEditable).toHaveBeenLastCalledWith(true, false);
  });

  it("keeps both snapshot rows and events received while the list request is pending", async () => {
    const note = { id: "note_old", workspaceId: "ws_1", scope: "personal", title: "Snapshot row", version: 1, sha256: "hash", createdBy: "alice", createdAt: 1, updatedAt: 1, projectId: null, ingestion: { state: "pending" } };
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    render(<NotesEditor workspaceId="ws_1" />);
    await act(async () => realtime.options?.onEvent({ id: "evt_new", workspaceId: "ws_1", kind: "note.created", entityId: "note_new", at: 2,
      payload: { note: { ...note, id: "note_new", title: "Event row", updatedAt: 2 } },
    }));
    expect(screen.getByRole("button", { name: "Event row" })).toBeTruthy();
    await act(async () => finish(Response.json({ notes: [note] })));
    expect(screen.getByRole("button", { name: "Event row" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Snapshot row" })).toBeTruthy();
  });

  it("navigates to memory sources without saving when there are no changes", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ notes: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const onNavigate = vi.fn();
    const { unmount } = render(<NotesEditor />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Save reviewed text as a memory source" })).toBeNull();
    unmount();

    render(<NotesEditor onNavigate={onNavigate} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed text as a memory source" }));
    expect(onNavigate).toHaveBeenCalledWith("memory");
    expect(fetcher.mock.calls.every((call) => !(call as unknown as [string, RequestInit?])[1]?.method)).toBe(true);
  });

  it("flushes a pending body edit and waits for the save before opening Memory", async () => {
    const { note, patches, onNavigate, shortcut, body } = await openNoteWithMemoryShortcut();
    fireEvent.change(body, { target: { value: "Unsaved paragraph" } });
    expect(patches).toHaveLength(0);
    fireEvent.click(shortcut);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ title: "Draft", markdown: "Unsaved paragraph\n", expectedVersion: 1 });
    expect(shortcut).toHaveProperty("disabled", true);
    expect(onNavigate).not.toHaveBeenCalled();
    await act(async () => patches[0]!.finish(Response.json({ note: { ...note, version: 2 } })));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("memory");
  });

  it("waits for an in-flight save, then persists newer edits with the returned version", async () => {
    const { note, patches, onNavigate, shortcut, body } = await openNoteWithMemoryShortcut();
    const title = screen.getByRole("textbox", { name: "Note title" });
    fireEvent.change(title, { target: { value: "First edit" } });
    fireEvent.blur(title);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ title: "First edit", markdown: "Body\n", expectedVersion: 1 });
    fireEvent.change(body, { target: { value: "Newer body" } });
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
    const { note, patches, onNavigate, shortcut, body } = await openNoteWithMemoryShortcut();
    fireEvent.change(body, { target: { value: "Keep my draft" } });
    fireEvent.click(shortcut);
    await act(async () => patches[0]!.finish(Response.json({ error: "Save failed" }, { status: 500 })));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(body).toHaveProperty("value", "Keep my draft");
    expect(shortcut).toHaveProperty("disabled", false);

    fireEvent.click(shortcut);
    expect(patches).toHaveLength(2);
    expect(patches[1]!.body).toEqual(patches[0]!.body);
    await act(async () => patches[1]!.finish(Response.json({ note: { ...note, version: 2 } })));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("memory");
  });
});
