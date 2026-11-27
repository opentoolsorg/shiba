// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesView } from "./FilesView";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function mockApi(failFirst = false) {
  const uploaded: Array<{ id: string; name: string; size: number; ingestion: { state: string } }> = [];
  let name = "";
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/files/folders" && init?.method !== "POST") return Response.json({ folders: [{ id: "folder-1", name: "Documents" }] });
    if (url.pathname === "/api/files/folders" && init?.method === "POST") {
      const folder = JSON.parse(String(init.body));
      const id = `created-${folder.name}`;
      return Response.json({ folder: { id, name: folder.name } }, { status: 201 });
    }
    if (url.pathname === "/api/files") return Response.json({ files: [...uploaded] });
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (body?.action === "begin") {
      name = body.name;
      if (failFirst && name === "bad.md") return Response.json({ error: "Upload rate limit exceeded." }, { status: 429 });
      return Response.json({ session: { sessionId: "session-1", partSize: 5 * 1024 * 1024 } });
    }
    if (body?.action === "complete") {
      uploaded.push({ id: name, name, size: 17, ingestion: { state: "done" } });
      return Response.json({ file: uploaded.at(-1) }, { status: 201 });
    }
    return Response.json({ part: { partNumber: 1, etag: "real-etag" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("FilesView", () => {
  it("opens the picker, uploads a chosen file, and refreshes the list", async () => {
    const api = mockApi();
    render(<FilesView />);
    await screen.findByRole("option", { name: "Documents" });
    const input = screen.getByLabelText("Upload files") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.multiple).toBe(true);
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Upload File/ }));
    expect(click).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { files: [new File(["A real document.\n"], "notes.md", { type: "text/markdown" })] } });
    await screen.findByText("notes.md", { selector: "span" });
    expect(screen.getByText("17 bytes")).toBeTruthy();
    expect(screen.getByText("done", { selector: "span" })).toBeTruthy();
    expect(screen.getByText(/notes.md: Uploaded · 1 \/ 1 parts/)).toBeTruthy();
    expect(api.mock.calls.filter(([url]) => url.startsWith("/api/files?"))).toHaveLength(2);
  });

  it("uploads dropped files into the selected workspace folder and continues after a per-file error", async () => {
    const api = mockApi(true);
    render(<FilesView />);
    await screen.findByRole("option", { name: "Documents" });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "workspace" } });
    await screen.findByRole("option", { name: "Documents" });
    fireEvent.change(screen.getByLabelText("Folder", { exact: true }), { target: { value: "folder-1" } });
    fireEvent.drop(screen.getByRole("region", { name: "File list" }), {
      dataTransfer: { files: [new File(["bad"], "bad.md", { type: "text/markdown" }), new File(["good"], "good.pdf", { type: "application/pdf" })] },
    });
    await screen.findByText("good.pdf", { selector: "span" });
    expect(screen.getByRole("alert").textContent).toContain("Upload rate limit exceeded.");
    const begin = api.mock.calls.find(([, init]) => typeof init?.body === "string" && init.body.includes('"name":"good.pdf"'));
    if (!begin?.[1]) throw new Error("Expected PDF begin request.");
    expect(begin[0]).toContain("scope=workspace");
    expect(JSON.parse(begin[1].body as string)).toMatchObject({ scope: "workspace", folderId: "folder-1" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(false));
    expect(api.mock.calls.some(([url]) => url.includes("folderId=folder-1"))).toBe(true);
  });

  it("refreshes ingestion state while a listed file is pending", async () => {
    let poll: (() => void) | undefined;
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback) => {
      poll = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    let lists = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/folders")
      ? Response.json({ folders: [] })
      : Response.json({ files: [{ id: "file-1", name: "pending.md", size: 12, ingestion: { state: ++lists === 1 ? "pending" : "done" } }] })));
    render(<FilesView />);
    await screen.findByText("pending", { selector: "span" });
    expect(poll).toBeTypeOf("function");
    await act(async () => { poll?.(); });
    await screen.findByText("done", { selector: "span" });
    expect(lists).toBe(2);
  });


  it("dismisses search results when the search control is closed", async () => {
    const api = vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/files/folders") return Response.json({ folders: [] });
      if (url.pathname === "/api/files") return Response.json({ files: [] });
      if (url.pathname === "/api/knowledge/search") return Response.json({
        hits: [{ chunkId: "chunk-1", sourceKind: "file", sourceId: "file-1", sourceName: "notes.md", scope: "personal", ordinal: 0, text: "needle passage", score: 1, rank: 1 }],
      });
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", api);
    render(<FilesView />);
    fireEvent.click(screen.getByRole("button", { name: "Search files" }));
    fireEvent.change(screen.getByLabelText("Search files and notes"), { target: { value: "needle" } });
    fireEvent.submit(screen.getByRole("search", { name: "Search knowledge" }));
    await waitFor(() => expect(api.mock.calls.some(([url]) => String(url).includes("/api/knowledge/search"))).toBe(true));
    await screen.findByText("notes.md");
    fireEvent.click(screen.getByRole("button", { name: "Close search files" }));
    await waitFor(() => expect(screen.queryByText("notes.md")).toBeNull());
    expect(screen.queryByRole("search", { name: "Search knowledge" })).toBeNull();
  });

  it("preserves folder upload paths through created nested folders", async () => {
    const api = mockApi();
    render(<FilesView />);
    await screen.findByRole("option", { name: "Documents" });
    const file = new File(["nested"], "inner.md", { type: "text/markdown" });
    Object.defineProperty(file, "webkitRelativePath", { value: "root/sub/inner.md" });
    fireEvent.change(screen.getByLabelText("Upload folder"), { target: { files: [file] } });
    await screen.findByText("inner.md", { selector: "span" });
    const folderPosts = api.mock.calls.filter(([url, init]) => String(url).startsWith("/api/files/folders") && init?.method === "POST");
    expect(folderPosts.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { name: "root", scope: "personal", parentId: null },
      { name: "sub", scope: "personal", parentId: "created-root" },
    ]);
    const begin = api.mock.calls.find(([, init]) => typeof init?.body === "string" && init.body.includes('"name":"inner.md"'));
    expect(JSON.parse(String(begin?.[1]?.body))).toMatchObject({ folderId: "created-sub" });
  });

  it("queues note creation when New Note navigates to Notes", async () => {
    mockApi();
    const onNavigate = vi.fn();
    render(<FilesView onNavigate={onNavigate} />);
    await screen.findByRole("option", { name: "Documents" });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /New Note/ }));
    expect(onNavigate).toHaveBeenCalledWith("notes");
    expect(window.sessionStorage.getItem("shiba:notes:create-after-navigation")).toBe("personal");

    window.sessionStorage.clear();
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "workspace" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /New Note/ }));
    expect(window.sessionStorage.getItem("shiba:notes:create-after-navigation")).toBe("workspace");
  });


  it("links to memory sources only when navigation is wired, without saving anything", async () => {
    const api = mockApi();
    const onNavigate = vi.fn();
    const { unmount } = render(<FilesView />);
    await screen.findByRole("option", { name: "Documents" });
    expect(screen.queryByRole("button", { name: "Review memory sources" })).toBeNull();
    unmount();

    render(<FilesView onNavigate={onNavigate} />);
    await screen.findByRole("option", { name: "Documents" });
    const memory = screen.getByRole("button", { name: "Review memory sources" });
    expect(memory.className).not.toContain("sr-only");
    fireEvent.click(memory);
    expect(onNavigate).toHaveBeenCalledWith("memory");
    expect(api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
});
