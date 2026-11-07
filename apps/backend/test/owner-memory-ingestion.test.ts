import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { Memory } from "../src/memory-do.js";
import { handleMemory } from "../src/memory-routes.js";
import { memoryContentHash } from "../src/owner-memory-ingestion.js";
import type { OwnerMemorySource } from "../src/owner-memory-store.js";
import type { SqlRow, SqlScalar } from "../src/memory-store.js";

function fixture() {
  const objects = new Map<string, Uint8Array>();
  const controls = { failPut: false, failGet: false, failDelete: false, failCommit: false, failJournal: false, puts: 0, beforePut: undefined as (() => Promise<void>) | undefined, beforeGet: undefined as (() => Promise<void>) | undefined };
  const databases = new Map<string, DatabaseSync>();
  const instances = new Map<string, { memory: Memory; ready: Promise<void> }>();
  const env = { REQUIRE_ACCESS: "1", MEMORY_ENABLED: "false", ATTACHMENTS: {
    async get(key: string) {
      const bytes = objects.get(key)?.slice();
      await controls.beforeGet?.();
      if (controls.failGet) throw new Error("Storage unavailable");
      return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.buffer } : null;
    },
    async put(key: string, bytes: Uint8Array) {
      controls.puts += 1;
      await controls.beforePut?.();
      if (controls.failPut) throw new Error("Storage unavailable");
      if (objects.has(key)) throw new Error("Immutable object overwritten");
      objects.set(key, bytes.slice());
      return { key };
    },
    async delete(keys: string | string[]) {
      if (controls.failDelete) throw new Error("Storage unavailable");
      for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key);
    },
  } } as unknown as Env;
  env.Memory = {
    idFromName: (name: string) => name,
    get(name: string) {
      return { async fetch(input: RequestInfo | URL, init?: RequestInit) {
        if (!instances.has(name)) {
          const db = databases.get(name) ?? new DatabaseSync(":memory:");
          databases.set(name, db);
          let ready = Promise.resolve();
          const ctx = {
            id: { name }, storage: {
              sql: { exec(sql: string, ...params: SqlScalar[]) {
                if ((controls.failCommit && sql.startsWith("INSERT INTO owner_memory_versions")) || (controls.failJournal && sql.startsWith("INSERT INTO owner_memory_upload_journal"))) throw new Error("Injected SQL failure");
                return { toArray: () => db.prepare(sql).all(...params) as SqlRow[] };
              } },
              transactionSync<T>(fn: () => T): T { db.exec("BEGIN"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } },
              async getAlarm() { return null; }, async setAlarm() {},
            },
            blockConcurrencyWhile(fn: () => Promise<void>) { ready = fn(); },
          } as unknown as DurableObjectState;
          const memory = new Memory(ctx, env);
          instances.set(name, { memory, ready });
        }
        const instance = instances.get(name);
        if (!instance) throw new Error("Memory fixture did not initialize.");
        await instance.ready;
        return instance.memory.fetch(input instanceof Request ? input : new Request(input, init));
      } };
    },
  } as unknown as Env["Memory"];
  async function call(path: string, owner = "alice@example.test", init?: RequestInit) {
    const response = await handleMemory(new Request(`https://app.test/api/memory${path}`, {
      ...init, headers: { "CF-Access-Authenticated-User-Email": owner, Origin: "https://app.test", ...init?.headers },
    }), env);
    if (!response) throw new Error("Memory route did not match.");
    return response;
  }
  const upload = (body: string | Uint8Array, extraHeaders: Record<string, string> = {}) => call("/sources/upload", undefined, {
    method: "POST", headers: { "Content-Type": "text/markdown", "X-Source-Filename": "brand.md", ...extraHeaders }, body: body as BodyInit,
  });
  const patch = (id: string, body: object, owner?: string) => call(`/sources/${id}`, owner, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const snapshot = (sourceIds: string[], expectedRefs?: object[], owner?: string) => call("/sources/snapshot", owner, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceIds, ...(expectedRefs ? { expectedRefs } : {}) }) });
  return { call, upload, patch, snapshot, objects, controls, databases, restart: () => instances.clear() };
}

describe("managed owner text ingestion through authenticated routes", () => {
  it("downloads exact private upload bytes with pinned version and safe attachment headers", async () => {
    const { upload, call, patch } = fixture();
    const raw = "# Brand\r\nOrion ships Tuesday.\r\n";
    const { source } = await (await upload(raw)).json() as { source: OwnerMemorySource };
    const path = `/sources/${source.id}/download?version=1`;
    const downloaded = await call(`${path}&owner=bob&objectKey=foreign`);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe(raw);
    expect(downloaded.headers.get("Content-Disposition")).toBe('attachment; filename="brand.md"');
    expect(downloaded.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(downloaded.headers.get("Cache-Control")).toBe("private, no-store");
    expect(downloaded.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(downloaded.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(downloaded.headers.get("X-Source-Sha256")).toBe(source.sha256);
    expect(downloaded.headers.get("X-Source-Version")).toBe("1");
    expect((await call(path, "bob@example.test")).status).toBe(404);
    expect((await call(path, "")).status).toBe(401);
    expect((await call(path, undefined, { method: "POST" })).status).toBe(405);
    for (const query of ["", "?version=0", "?version=01", "?version=-1", "?version=1.1", "?version=9007199254740993", "?version=1&version=2"]) {
      expect((await call(`/sources/${source.id}/download${query}`)).status).toBe(400);
    }
    await patch(source.id, { content: "Updated content", expectedVersion: 1 });
    expect((await call(path)).status).toBe(409);
    expect(await (await call(`/sources/${source.id}/download?version=2`)).text()).toBe("Updated content");
  });

  it("refuses disabled, expired, forgotten and unversioned downloads without exposing retained objects", async () => {
    const { upload, call, patch, objects, controls, databases } = fixture();
    const { source } = await (await upload("Private facts")).json() as { source: OwnerMemorySource };
    const path = `/sources/${source.id}/download?version=1`;
    await patch(source.id, { enabled: false });
    expect((await call(path)).status).toBe(404);
    await patch(source.id, { enabled: true });
    for (const db of databases.values()) db.prepare("UPDATE owner_memory_sources SET expires_at=1 WHERE id=?").run(source.id);
    expect((await call(path)).status).toBe(404);
    for (const db of databases.values()) db.prepare("UPDATE owner_memory_sources SET expires_at=NULL WHERE id=?").run(source.id);
    controls.failDelete = true;
    await call(`/sources/${source.id}`, undefined, { method: "DELETE" });
    expect(objects.size).toBe(1);
    expect((await call(path)).status).toBe(404);
    const note = await (await call("/sources", undefined, { method: "POST", body: JSON.stringify({ title: "Note", content: "Note text", kind: "note" }) })).json() as { source: OwnerMemorySource };
    expect((await call(`/sources/${note.source.id}/download?version=1`)).status).toBe(404);
  });

  it.each(["missing", "corrupt", "truncated", "unavailable"])("fails closed when stored download is %s", async (failure) => {
    const { upload, call, objects, controls } = fixture();
    const { source } = await (await upload("Private facts")).json() as { source: OwnerMemorySource };
    const key = [...objects.keys()][0];
    if (!key) throw new Error("Upload fixture did not retain a file.");
    if (failure === "missing") objects.delete(key);
    if (failure === "corrupt") objects.set(key, new TextEncoder().encode("Altered facts"));
    if (failure === "truncated") objects.set(key, new Uint8Array([1]));
    controls.failGet = failure === "unavailable";
    const response = await call(`/sources/${source.id}/download?version=1`);
    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Disposition")).toBeNull();
    expect(await response.text()).not.toContain(key);
  });

  it.each(["disable", "delete", "correct"])("rechecks visibility after an in-flight download and concurrent %s", async (operation) => {
    const { upload, call, patch, controls } = fixture();
    const { source } = await (await upload("Private facts")).json() as { source: OwnerMemorySource };
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    controls.beforeGet = () => new Promise<void>((resolve) => { release = resolve; entered(); });
    const download = call(`/sources/${source.id}/download?version=1`);
    await started;
    if (operation === "delete") await call(`/sources/${source.id}`, undefined, { method: "DELETE" });
    if (operation === "disable") await patch(source.id, { enabled: false });
    if (operation === "correct") await patch(source.id, { content: "New facts", expectedVersion: 1 });
    release();
    const result = await download;
    expect(result.status).toBe(operation === "correct" ? 409 : 404);
    expect(await result.text()).not.toContain("Private facts");
  });

  it("uploads actual private bytes, retrieves versioned line/section citations, corrects and freezes old snapshots", async () => {
    const { upload, call, patch, snapshot, objects } = fixture();
    const raw = "# Brand\r\n\r\nOrion ships Tuesday.\r\n";
    const created = await upload(raw);
    expect(created.status).toBe(201);
    const { source } = await created.json() as { source: OwnerMemorySource };
    expect(source).toMatchObject({ version: 1, sha256: await memoryContentHash(new TextEncoder().encode(raw)), ingestion: { state: "ready", filename: "brand.md", mediaType: "text/markdown", bytes: raw.length } });
    expect(new TextDecoder().decode([...objects.values()][0])).toBe(raw);
    const recall = await (await call("/recall?q=Orion")).json() as { hits: Array<{ citations: object[] }> };
    expect(recall.hits[0]?.citations).toEqual([{ sourceId: source.id, version: 1, sha256: source.sha256, lineStart: 3, lineEnd: 3, section: "Brand", text: "Orion ships Tuesday.", textTruncated: false }]);
    const frozen = await (await snapshot([source.id])).json();
    const project = await (await call("/projects", undefined, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Launch", purpose: "", sourceIds: [source.id] }) })).json() as { project: { id: string } };
    const projectSnapshot = await (await call("/projects/snapshot", undefined, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: project.project.id }) })).json();
    const changed = await patch(source.id, { content: "# Brand\n\nOrion ships Friday.", expectedVersion: 1 });
    expect(changed.status).toBe(200);
    const next = (await changed.json() as { source: OwnerMemorySource }).source;
    expect(next.version).toBe(2);
    expect(next.sha256).not.toBe(source.sha256);
    expect(objects.size).toBe(2);
    expect(frozen).toMatchObject({ snapshot: { sources: [{ version: 1, content: "# Brand\n\nOrion ships Tuesday.\n" }] } });
    expect(projectSnapshot).toMatchObject({ snapshot: { sources: [{ version: 1, sha256: source.sha256, content: "# Brand\n\nOrion ships Tuesday.\n" }] } });
    expect((await snapshot([source.id], [{ id: source.id, version: 1, sha256: source.sha256 }])).status).toBe(400);
    expect((await snapshot([source.id], [{ id: source.id, version: 2, sha256: next.sha256 }])).status).toBe(200);
    expect(await (await call("/recall?q=Tuesday")).json()).toMatchObject({ hits: [] });
    expect((await patch(source.id, { content: "Stale text", expectedVersion: 1 })).status).toBe(409);
    expect((await patch(source.id, { title: "Missing revision" })).status).toBe(400);
    const metadataChange = await patch(source.id, { title: "Revised brand", expectedVersion: 2 });
    expect(await metadataChange.json()).toMatchObject({ source: { version: 3 } });
  });

  it("denies foreign reads/corrections/snapshot refs and excludes disabled/forgotten sources immediately", async () => {
    const { upload, call, patch, snapshot, controls, objects } = fixture();
    const { source } = await (await upload("# Brand\nOrion private facts")).json() as { source: OwnerMemorySource };
    expect((await call(`/sources/${source.id}`, "bob@example.test")).status).toBe(404);
    expect((await patch(source.id, { content: "stolen" }, "bob@example.test")).status).toBe(404);
    expect((await snapshot([source.id], undefined, "bob@example.test")).status).toBe(400);
    expect(await (await call("/recall?q=Orion", "bob@example.test")).json()).toMatchObject({ hits: [] });
    await patch(source.id, { enabled: false });
    expect(await (await call("/recall?q=Orion")).json()).toMatchObject({ hits: [] });
    expect((await snapshot([source.id])).status).toBe(400);
    await patch(source.id, { enabled: true });
    controls.failDelete = true;
    expect(await (await call(`/sources/${source.id}`, undefined, { method: "DELETE" })).json()).toMatchObject({ ok: true, cleanup: "pending" });
    expect((await call(`/sources/${source.id}`)).status).toBe(404);
    expect(await (await call("/recall?q=Orion")).json()).toMatchObject({ hits: [] });
    expect((await snapshot([source.id])).status).toBe(400);
    expect(objects.size).toBe(1);
    controls.failDelete = false;
    expect(await (await call(`/sources/${source.id}`, undefined, { method: "DELETE" })).json()).toMatchObject({ cleanup: "complete" });
    expect(objects.size).toBe(0);
  });

  it.each([
    { body: new Uint8Array([0xc3, 0x28]) },
    { body: new Uint8Array([0xff, 0xfe, 0x41, 0x00]) },
    { body: "hello\0world" }, { body: "%PDF-1.7 pretend text" }, { body: "PK archive" },
    { body: "# Fine\n<script>alert(1)</script>" }, { body: "<svg onload=alert(1)>" },
    { body: "hello", headers: { "Content-Type": "application/pdf", "X-Source-Filename": "brand.pdf" } },
    { body: "hello", headers: { "X-Source-Filename": "../brand.md" } },
    { body: "hello", headers: { "Content-Length": "20" } },
    { body: "é".repeat(20_001) },
  ] as Array<{ body: string | Uint8Array; headers?: Record<string, string> }>)("rejects invalid, unsupported, oversized or truncated bytes before ready state (%#)", async ({ body, headers }) => {
    const { upload, call, objects } = fixture();
    expect((await upload(body, headers)).status).toBe(400);
    expect(await (await call("/sources")).json()).toMatchObject({ sources: [] });
    expect(objects.size).toBe(0);
  });

  it("never marks failed storage ready and rejects unversioned note pins truthfully", async () => {
    const { upload, call, snapshot, controls } = fixture();
    controls.failPut = true;
    expect((await upload("Brand facts")).status).toBe(503);
    expect(await (await call("/sources")).json()).toMatchObject({ sources: [] });
    const note = await (await call("/sources", undefined, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Note", content: "Pasted fact", kind: "note" }) })).json() as { source: OwnerMemorySource };
    expect(await (await snapshot([note.source.id])).json()).toMatchObject({ error: expect.stringContaining("Upload TXT or Markdown") });
  });

  it("does not resurrect a forgotten source when an in-flight correction finishes", async () => {
    const { upload, patch, call, controls, objects } = fixture();
    const { source } = await (await upload("Orion original")).json() as { source: OwnerMemorySource };
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    controls.beforePut = () => new Promise<void>((resolve) => { release = resolve; entered(); });
    const correction = patch(source.id, { content: "Orion correction", expectedVersion: 1 });
    await started;
    await call(`/sources/${source.id}`, undefined, { method: "DELETE" });
    release();
    expect((await correction).status).toBe(409);
    expect((await call(`/sources/${source.id}`)).status).toBe(404);
    expect(objects.size).toBe(0);
  });

  it("journals failed SQL plus failed compensation durably, then retries only the uncommitted object", async () => {
    const { upload, patch, call, objects, controls, restart } = fixture();
    const { source } = await (await upload("Orion original")).json() as { source: OwnerMemorySource };
    controls.failCommit = true;
    controls.failDelete = true;
    const failed = await patch(source.id, { content: "Orion failed correction", expectedVersion: 1 });
    expect(failed.status).toBe(503);
    const failure = await failed.json() as { uploadId: string; cleanup: string };
    expect(failure.cleanup).toBe("pending");
    expect(objects.size).toBe(2);
    restart();
    expect(await (await call("/sources")).json()).toMatchObject({ sources: [{ id: source.id, version: 1 }], cleanupPending: [{ id: failure.uploadId, filename: "brand.md" }] });
    expect(await (await call("/recall?q=failed")).json()).toMatchObject({ hits: [] });
    expect((await call(`/sources/${failure.uploadId}`, "bob@example.test", { method: "DELETE" })).status).toBe(404);
    controls.failDelete = false;
    expect(await (await call(`/sources/${failure.uploadId}`, undefined, { method: "DELETE" })).json()).toMatchObject({ cleanup: "complete" });
    expect(objects.size).toBe(1);
    expect(new TextDecoder().decode([...objects.values()][0])).toBe("Orion original");
    expect(await (await call("/sources")).json()).toMatchObject({ cleanupPending: [], sources: [{ id: source.id, version: 1 }] });
  });

  it("never writes without a durable journal and never cleans an active or committed upload", async () => {
    const { upload, call, controls, objects, databases } = fixture();
    controls.failJournal = true;
    expect((await upload("Orion blocked")).status).toBe(503);
    expect(controls.puts).toBe(0);
    controls.failJournal = false;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    controls.beforePut = () => new Promise<void>((resolve) => { release = resolve; entered(); });
    const pending = upload("Orion original");
    await started;
    const state = await (await call("/sources")).json() as { uploadsPending: Array<{ id: string }> };
    const uploadId = state.uploadsPending[0]?.id;
    expect(uploadId).toMatch(/^upload_[a-f0-9]{24}$/);
    expect(await (await call(`/sources/${uploadId}`, undefined, { method: "DELETE" })).json()).toMatchObject({ cleanup: "pending" });
    release();
    expect((await pending).status).toBe(201);
    // Even an erroneously failed journal row cannot authorize deleting a referenced version.
    for (const db of databases.values()) db.prepare("UPDATE owner_memory_upload_journal SET state='failed' WHERE id=?").run(uploadId ?? "");
    expect(await (await call(`/sources/${uploadId}`, undefined, { method: "DELETE" })).json()).toMatchObject({ cleanup: "pending" });
    expect(objects.size).toBe(1);
  });

  it("marks shortened citations as excerpts while retaining absolute immutable line references", async () => {
    const { upload, snapshot, call } = fixture();
    const { source } = await (await upload(`# ${"h".repeat(300)}\n${"word ".repeat(400)}`)).json() as { source: OwnerMemorySource };
    const result = await (await snapshot([source.id])).json() as { snapshot: { sources: Array<{ citations: Array<{ section?: string; lineStart: number; textTruncated: boolean; text: string }> }> } };
    expect(result.snapshot.sources[0]?.citations[1]).toMatchObject({ lineStart: 2, textTruncated: true });
    expect(result.snapshot.sources[0]?.citations[1]?.text.length).toBeLessThanOrEqual(1000);
    expect(result.snapshot.sources[0]?.citations[1]?.section?.length).toBeLessThanOrEqual(200);
    const recall = await (await call("/recall?q=word")).json() as { hits: Array<{ citations: Array<{ lineStart: number; textTruncated: boolean }> }> };
    expect(recall.hits[0]?.citations[0]).toMatchObject({ lineStart: 2, textTruncated: true });
  });
});
