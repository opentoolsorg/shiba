import { afterEach, describe, expect, it, vi } from "vitest";
import { listAttachableFiles, listAuthorizedFiles, readBotLibraryLink } from "./bot-files";

const file = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, workspaceId: "ws_1", scope: "personal", folderId: null, name: `${id}.md`, mime: "text/markdown",
  size: 12, sha256: "a".repeat(64), projectId: null, version: 1, createdBy: "me",
  createdAt: 1, updatedAt: 2, ingestion: { state: "done" }, ...overrides,
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("authorized file lists", () => {
  it("lists only what the file route already returned for this viewer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ files: [file("file_a"), file("file_b")] }));
    vi.stubGlobal("fetch", fetchMock);
    const files = await listAuthorizedFiles("personal");
    expect(fetchMock).toHaveBeenCalledWith("/api/files?scope=personal", expect.objectContaining({ credentials: "same-origin" }));
    expect(files.map((item) => item.id)).toEqual(["file_a", "file_b"]);
    // Each row keeps the scope the file route reported for it.
    expect(files[0]?.scope).toBe("personal");
    expect(files[0]?.scope).not.toBe("workspace");
  });

  it("drops archived rows and sorts by name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ files: [
      file("file_b", { name: "b.md" }), file("file_a", { name: "a.md" }), file("file_c", { name: "c.md", archivedAt: 5 }),
    ] })));
    const files = await listAuthorizedFiles("personal");
    expect(files.map((item) => item.name)).toEqual(["a.md", "b.md"]);
  });

  it("surfaces a refusal instead of an empty library", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Authentication required." }, { status: 401 })));
    const failure = await listAuthorizedFiles("personal").then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Authentication required.");
  });

  it("keeps one scope's files when the other scope fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ files: [file("file_a")] }))
      .mockResolvedValueOnce(Response.json({ error: "Workspace files unavailable." }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await listAttachableFiles();
    expect(result.files.map((item) => item.id)).toEqual(["file_a"]);
    expect(result.error).toBeNull();
  });

  it("reports a total failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Files down." }, { status: 503 })));
    const result = await listAttachableFiles();
    expect(result.files).toEqual([]);
    expect(result.error).toBe("Files down.");
  });
});

describe("linked file resolution", () => {
  it("returns the file record when the viewer may read it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ file: file("file_a", { scope: "workspace", name: "brief.md" }) })));
    const link = await readBotLibraryLink("file_a");
    expect(link).toMatchObject({ fileId: "file_a", status: "ready", name: "brief.md", scope: "workspace" });
  });

  it("reports a link this viewer may not read as missing, without saying whether the file exists", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "File not found." }, { status: 404 })));
    const link = await readBotLibraryLink("file_other");
    expect(link.status).toBe("missing");
    expect(link.error).toBe("Removed, or not available to you.");
    expect(link.name).toBeUndefined();
  });

  it("keeps a transient failure as an error, not a missing file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Knowledge storage is unavailable." }, { status: 503 })));
    const link = await readBotLibraryLink("file_a");
    expect(link.status).toBe("error");
    expect(link.error).toBe("Knowledge storage is unavailable.");
  });

  it("never treats a network failure as a removed file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Failed to fetch")));
    const link = await readBotLibraryLink("file_a");
    expect(link.status).toBe("error");
  });
});
