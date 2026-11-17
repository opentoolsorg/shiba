import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadFile } from "./files-upload-client";

const partSize = 5 * 1024 * 1024;
const options = { scope: "personal" as const, folderId: null };
const json = (body: unknown, status = 200) => Response.json(body, { status });
const session = () => json({ session: { sessionId: "session /1", partSize } }, 201);

afterEach(() => vi.unstubAllGlobals());

describe("uploadFile", () => {
  it("sends a 12 MiB file as three byte parts and completes with the returned etags in order", async () => {
    const bytes = new Uint8Array(12 * 1024 * 1024);
    bytes.fill(11, 0, partSize);
    bytes.fill(22, partSize, partSize * 2);
    bytes.fill(33, partSize * 2);
    const file = new File([bytes], "report.pdf", { type: "application/pdf" });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(json({ part: { partNumber: 1, etag: "real-1" } }))
      .mockResolvedValueOnce(json({ part: { partNumber: 2, etag: "real-2" } }))
      .mockResolvedValueOnce(json({ part: { partNumber: 3, etag: "real-3" } }))
      .mockResolvedValueOnce(json({ file: { id: "file-1" } }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn();

    await uploadFile(file, { scope: "workspace", folderId: "folder-1", onProgress });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (let index = 0; index < 3; index++) {
      const [url, init = {}] = fetchMock.mock.calls[index + 1] ?? [];
      const query = new URL(String(url), "https://example.test").searchParams;
      expect(query.get("sessionId")).toBe("session /1");
      expect(query.get("partNumber")).toBe(String(index + 1));
      expect(query.get("scope")).toBe("workspace");
      expect(init).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" } });
      expect(init.body).toBeInstanceOf(Blob);
      const sent = new Uint8Array(await (init.body as Blob).arrayBuffer());
      expect(sent.length).toBe(Math.min(partSize, bytes.length - index * partSize));
      expect(sent.every((value, offset) => value === bytes[index * partSize + offset])).toBe(true);
    }
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      action: "begin", name: "report.pdf", mime: "application/pdf", scope: "workspace", folderId: "folder-1",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({
      action: "complete", sessionId: "session /1", parts: [
        { partNumber: 1, etag: "real-1" }, { partNumber: 2, etag: "real-2" }, { partNumber: 3, etag: "real-3" },
      ],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/files/uploads?scope=workspace");
    expect(fetchMock.mock.calls[4]?.[0]).toBe("/api/files/uploads?scope=workspace");
    expect(onProgress.mock.calls).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
  });

  it("stops after a failed part and reports the server error without completing", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(json({ error: "Part rejected." }, 400));
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadFile(new File([new Uint8Array(partSize + 1)], "notes.md", { type: "text/markdown" }), options))
      .rejects.toMatchObject({ message: "Part rejected." });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the filename and fallback MIME in the JSON begin request, including an empty file", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(json({ part: { partNumber: 1, etag: "empty-part" } }))
      .mockResolvedValueOnce(json({ file: {} }, 201));
    vi.stubGlobal("fetch", fetchMock);
    await uploadFile(new File([], "empty.md"), options);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      action: "begin", name: "empty.md", mime: "application/octet-stream", scope: "personal", folderId: null,
    });
    expect(fetchMock.mock.calls[1]?.[1]?.body).toMatchObject({ size: 0 });
  });

  it.each([json({ error: "Upload rate limit exceeded." }, 429), new Response("Too many requests", { status: 429 })])(
    "reports rate limiting for JSON and non-JSON responses", async (response) => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
      await expect(uploadFile(new File(["notes"], "notes.md"), options)).rejects.toMatchObject({ message: "Upload rate limit exceeded." });
    },
  );

  it("reports non-JSON failures with the HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("Service unavailable", { status: 503 })));
    await expect(uploadFile(new File(["notes"], "notes.md"), options)).rejects.toMatchObject({ message: "Upload failed (503)." });
  });

  it.each([{}, { sessionId: "session-1", partSize: 0 }, { sessionId: "session-1", partSize: 1.5 }])(
    "rejects an invalid session response", async (invalidSession) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ session: invalidSession }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(uploadFile(new File(["notes"], "notes.md"), options)).rejects.toMatchObject({ message: "Invalid upload session response." });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not complete when a part response has no real etag", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(session()).mockResolvedValueOnce(json({ part: { partNumber: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadFile(new File(["notes"], "notes.md"), options)).rejects.toMatchObject({ message: "Invalid upload response for part 1." });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
