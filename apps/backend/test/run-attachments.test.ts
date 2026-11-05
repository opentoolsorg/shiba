import { describe, expect, it, vi } from "vitest";
import { MAX_RUN_ATTACHMENT_BYTES, parseRunAttachments, runInputHash } from "@shiba/shared";
import { attachmentName, openRunAttachment, placeRunAttachments, storeRunAttachment, verifyRunAttachments } from "../src/run-attachments.js";
import type { SandboxOps } from "../src/runtime.js";

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const attachment = { name: "notes.txt", sha256: "a".repeat(64), size: 5 };
function bucket() {
  const objects = new Map<string, { bytes: ArrayBuffer; digest: ArrayBuffer }>();
  return {
    objects,
    async put(key: string, bytes: ArrayBuffer, opts: { sha256: string }) {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      expect(opts.sha256).toBe(hex(digest));
      objects.set(key, { bytes, digest });
    },
    async head(key: string) {
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength, checksums: { sha256: object.digest } } : null;
    },
    async get(key: string) {
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength, checksums: { sha256: object.digest }, body: new Response(object.bytes).body } : null;
    },
  };
}
const env = (storage: ReturnType<typeof bucket>) => ({ ATTACHMENTS: storage }) as never;
const upload = (body: string, length?: number) => new Request("https://internal/api/runs/attachments", {
  method: "POST", body, headers: length === undefined ? {} : { "content-length": String(length) },
});

describe("run attachments", () => {
  it("validates counts, sizes, names, digests and duplicate names", () => {
    expect(parseRunAttachments([attachment])).toEqual([attachment]);
    expect(parseRunAttachments([])).toBeUndefined();
    for (const input of ["notes.txt", [{ ...attachment, name: "../escape" }], [{ ...attachment, name: ".env" }],
      [attachment, attachment], [{ ...attachment, sha256: "bad" }], [{ ...attachment, size: MAX_RUN_ATTACHMENT_BYTES + 1 }],
      Array.from({ length: 9 }, (_, i) => ({ ...attachment, name: `f${i}` })),
      Array.from({ length: 3 }, (_, i) => ({ ...attachment, name: `f${i}`, size: 9 * 1024 * 1024 }))]) {
      expect(() => parseRunAttachments(input)).toThrow();
    }
    expect(attachmentName("../../etc/passwd")).toBe("passwd");
    expect(attachmentName("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
    expect(attachmentName(".env")).toBe("file-.env");
  });

  it("stores and opens checksum-verified bytes only for their owner", async () => {
    const storage = bucket();
    const stored = await storeRunAttachment(env(storage), "alice", "notes.txt", upload("hello", 5));
    expect(stored.size).toBe(5);
    expect([...storage.objects.keys()]).toEqual([`run-attachments/alice/${stored.sha256}`]);
    await expect(verifyRunAttachments(env(storage), "alice", [stored])).resolves.toBeUndefined();
    await expect(verifyRunAttachments(env(storage), "bob", [stored])).rejects.toThrow(/isn't uploaded/);
    await expect(verifyRunAttachments(env(storage), "alice", [{ ...stored, size: 6 }])).rejects.toThrow();
    expect(await new Response(await openRunAttachment(env(storage), "alice", stored)).text()).toBe("hello");
    await expect(openRunAttachment(env(storage), "alice", { ...stored, size: 6 })).rejects.toThrow(/doesn't match/);
  });

  it("rejects absent length, over-limit declarations and truncated uploads", async () => {
    const storage = bucket();
    await expect(storeRunAttachment(env(storage), "o", "a", upload("x"))).rejects.toThrow(/Content-Length/);
    await expect(storeRunAttachment(env(storage), "o", "a", upload("x", MAX_RUN_ATTACHMENT_BYTES + 1))).rejects.toThrow(/at most/);
    await expect(storeRunAttachment(env(storage), "o", "a", upload("x", 4))).rejects.toThrow(/cut short/);
    expect(storage.objects.size).toBe(0);
  });

  it("cancels a stream as soon as it exceeds its declared length, before storing", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2)); }, cancel,
    });
    const request = new Request("https://internal", { method: "POST", body, headers: { "content-length": "1" }, duplex: "half" } as RequestInit);
    const storage = bucket();
    await expect(storeRunAttachment(env(storage), "o", "a", request)).rejects.toThrow(/exceeds/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(storage.objects.size).toBe(0);
  });

  it("binds attachment content into approval hashes", () => {
    const base = { repoUrl: "https://github.com/o/r", task: "t", baseBranch: "main", publishPullRequest: false };
    expect(runInputHash({ ...base, attachments: [attachment] })).not.toBe(runInputHash(base));
    expect(runInputHash({ ...base, attachments: [attachment] })).not.toBe(runInputHash({ ...base, attachments: [{ ...attachment, sha256: "b".repeat(64) }] }));
  });
});

describe("attachment sandbox placement", () => {
  function ops(options: { tracked?: boolean; symlink?: string; hash?: string; testExit?: number } = {}) {
    return {
      writeFile: vi.fn(), writeFileStream: vi.fn(async (_path: string, body: ReadableStream<Uint8Array>) => { await new Response(body).arrayBuffer(); }),
      readFile: vi.fn(async () => ({ kind: "utf8", content: "# existing" })),
      exec: vi.fn(async (command: string) => {
        if (command.includes("ls-files")) return { exitCode: 0, stdout: options.tracked ? "tracked\0" : "", stderr: "" };
        if (command.startsWith("'test' ")) return { exitCode: options.testExit ?? (options.symlink && command.includes(`'${options.symlink}'`) ? 0 : 1), stdout: "", stderr: "" };
        return { exitCode: 0, stdout: `${options.hash ?? attachment.sha256}  .shiba/attachments/notes.txt\n`, stderr: "" };
      }),
    };
  }
  const place = (sandbox: ReturnType<typeof ops>) => placeRunAttachments(sandbox as unknown as SandboxOps, "/workspace/run", [attachment],
    async () => new Response("hello").body as ReadableStream<Uint8Array>, { signals: [] });

  it("writes excluded attachment bytes and verifies their on-disk digest", async () => {
    const sandbox = ops();
    expect(await place(sandbox)).toBeNull();
    expect(sandbox.writeFile).toHaveBeenCalledWith("/workspace/run/.git/info/exclude", "# existing\n/.shiba/attachments/\n");
    expect(sandbox.writeFileStream.mock.calls[0]?.[0]).toBe("/workspace/run/.shiba/attachments/notes.txt");
    expect(await place(ops({ hash: "b".repeat(64) }))).toMatch(/doesn't match/);
  });

  it.each([".shiba", ".shiba/attachments", ".shiba/attachments/notes.txt", ".git", ".git/info", ".git/info/exclude"])("rejects symlink %s before writing", async (symlink) => {
    const sandbox = ops({ symlink });
    expect(await place(sandbox)).toMatch(/symlink/);
    expect(sandbox.writeFile).not.toHaveBeenCalled();
    expect(sandbox.writeFileStream).not.toHaveBeenCalled();
  });

  it("fails closed for tracked destinations, unsupported providers or failed path checks", async () => {
    const tracked = ops({ tracked: true });
    expect(await place(tracked)).toMatch(/already tracks/);
    expect(tracked.writeFile).not.toHaveBeenCalled();
    expect(await place(ops({ testExit: 2 }))).toMatch(/Could not check/);
    expect(await placeRunAttachments({} as SandboxOps, "/workspace/run", [attachment], async () => new Response("hello").body!, { signals: [] })).toMatch(/can't take/);
  });
});
