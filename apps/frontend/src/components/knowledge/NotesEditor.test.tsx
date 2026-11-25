// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotesEditor } from "./NotesEditor";
import type { UseWorkspaceEventsOptions } from "../../state/workspace-events";

const realtime = vi.hoisted(() => ({ options: null as UseWorkspaceEventsOptions | null, setEditable: vi.fn(), setContent: vi.fn() }));

vi.mock("@tiptap/react", () => {
  const editor = {
    commands: { setContent: realtime.setContent },
    setEditable: realtime.setEditable,
    state: { doc: { forEach: (visit: (node: unknown) => void) => visit({ type: { name: "paragraph" }, textContent: "Body" }) } },
    chain: () => ({ focus: () => ({ toggleHeading: () => ({ run: vi.fn() }), toggleBulletList: () => ({ run: vi.fn() }), insertContent: () => ({ run: vi.fn() }), toggleCodeBlock: () => ({ run: vi.fn() }), toggleBlockquote: () => ({ run: vi.fn() }) }) }),
  };
  return { useEditor: () => editor, EditorContent: () => <div data-testid="editor-surface" /> };
});

vi.mock("../../state/workspace-events", () => ({ useWorkspaceEvents: (options: UseWorkspaceEventsOptions) => { realtime.options = options; return false; } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

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

  it("navigates to memory sources without saving the note", async () => {
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
});
