import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { IngestQueueMessage } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { insertFileRecord } from "../src/files/files-store.js";
import { runIngestionJob } from "../src/knowledge/knowledge-ingestion.js";
import { hybridKnowledgeSearch } from "../src/knowledge/knowledge-search.js";
import { createNote, updateNoteMarkdown } from "../src/notes/notes-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const owner = "alice@example.test";
const marker = "PARITYPROBE1794";

type Vector = { id: string; metadata: Record<string, string | number> };

async function fixture(kind: "note" | "file") {
  const { database, sqlite } = customAgentD1({ bare: true });
  for (const migration of ["0050_files_notes.sql", "0051_knowledge_indexes.sql"]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const objects = new Map<string, Uint8Array>();
  // Keep deleted vectors queryable to model delayed Vectorize deletion.
  const vectors = new Map<string, Vector>();
  const deleteByIds = vi.fn(async (_ids: string[]) => {});
  const upsert = vi.fn(async (items: Vector[]) => {
    for (const item of items) vectors.set(item.id, item);
  });
  const query = vi.fn(async () => ({ matches: [...vectors.values()] }));
  const ai = vi.fn(async (_model: string, input: { text: string[] }) => ({ data: input.text.map(() => [1, 2, 3]) }));
  const env = {
    AGENT_AUDIT: database,
    FILES: {
      async put(key: string, bytes: Uint8Array) { objects.set(key, bytes); },
      async get(key: string) {
        const bytes = objects.get(key);
        return bytes ? { arrayBuffer: async () => bytes.buffer } : null;
      },
    },
    AI: { run: ai },
    MEMORY_VECTORS: { upsert, query, deleteByIds },
  } as unknown as Env;
  const text = `# qa note\n\n${marker}`;
  objects.set("file-v1", new TextEncoder().encode(text));
  const source = kind === "note"
    ? await createNote(env, { workspaceId: "ws", scope: "personal", title: "qa-note", markdown: text, createdBy: owner })
    : await insertFileRecord(env, {
      workspaceId: "ws", scope: "personal", name: "qa.md", mime: "text/markdown",
      size: text.length, r2Key: "file-v1", sha256: "a".repeat(64), createdBy: owner,
    });
  const message: IngestQueueMessage = {
    jobId: "job-v1", sourceKind: kind, sourceId: source.id, workspaceId: "ws", scope: "personal",
    version: 1, sha256: source.sha256, r2Key: "r2Key" in source ? source.r2Key : "file-v1", mime: "text/markdown",
  };
  const table = kind === "note" ? "notes" : "files";
  async function ingest(input = message) {
    await database.prepare(
      `INSERT OR IGNORE INTO ingestion_jobs
       (id, source_kind, source_id, workspace_id, sha256, version, state, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'pending',0,0)`,
    ).bind(input.jobId, kind, source.id, "ws", input.sha256, input.version).run();
    await runIngestionJob(env, input);
  }
  async function edit() {
    const markdown = `# qa note edited\n\n${marker}`;
    if (kind === "note") {
      const updated = await updateNoteMarkdown(env, source.id, { markdown, expectedVersion: 1 });
      return { ...message, jobId: "job-v2", version: 2, r2Key: updated.r2Key, sha256: updated.sha256 };
    }
    objects.set("file-v2", new TextEncoder().encode(markdown));
    await database.prepare(`UPDATE files SET version=2, r2_key='file-v2', ingestion_state='pending' WHERE id=?`).bind(source.id).run();
    return { ...message, jobId: "job-v2", version: 2, r2Key: "file-v2", sha256: "b".repeat(64) };
  }
  const chunks = () => database.prepare(`SELECT id, version, text FROM knowledge_chunks ORDER BY ordinal`).all<{ id: string; version: number; text: string }>();
  const search = () => hybridKnowledgeSearch(env, owner, "ws", marker, 10);
  return { env, database, sqlite, message, table, ingest, edit, chunks, search, vectors, query, ai, upsert, deleteByIds };
}

describe.each(["note", "file"] as const)("current %s knowledge", (kind) => {
  it("replaces v1 in FTS and vectors, ignores a late v1 delivery, and supports retries", async () => {
    const f = await fixture(kind);
    try {
      await f.ingest();
      const first = (await f.chunks()).results;
      expect(await f.search()).toHaveLength(1);
      const v2 = await f.edit();
      // Hide obsolete chunks even before the new ingestion finishes.
      expect(await f.search()).toEqual([]);
      await f.ingest(v2);
      expect(f.deleteByIds).toHaveBeenCalledWith(first.map((chunk) => chunk.id));
      expect((await f.chunks()).results.map((chunk) => chunk.version)).toEqual([2]);
      const current = (await f.chunks()).results;
      const calls = f.upsert.mock.calls.length;
      await f.ingest(f.message);
      expect(f.upsert).toHaveBeenCalledTimes(calls);
      expect((await f.chunks()).results).toEqual(current);
      expect(await f.database.prepare(`SELECT ingestion_state FROM ${f.table} WHERE id=?`).bind(f.message.sourceId).first()).toMatchObject({ ingestion_state: "done" });
      // FTS only, then vector only (including stale vector matches).
      f.query.mockResolvedValueOnce({ matches: [] });
      expect(await f.search()).toMatchObject([{ text: `# qa note edited\n\n${marker}` }]);
      await f.database.prepare(`DELETE FROM knowledge_fts`).run();
      expect(await f.search()).toMatchObject([{ text: `# qa note edited\n\n${marker}` }]);
      await f.ingest(v2);
      expect(f.deleteByIds).toHaveBeenLastCalledWith(current.map((chunk) => chunk.id));
      expect(await f.search()).toHaveLength(1);
      expect((await f.database.prepare(`SELECT chunk_id FROM knowledge_fts`).all()).results).toHaveLength(1);
    } finally { f.sqlite.close(); }
  });

  it.each(["archive", "delete"])("excludes sources after %s in both search paths", async (action) => {
    const f = await fixture(kind);
    try {
      await f.ingest();
      if (action === "archive") {
        await f.database.prepare(`UPDATE ${f.table} SET archived_at=1 WHERE id=?`).bind(f.message.sourceId).run();
      } else {
        await f.database.prepare(`DELETE FROM ${f.table} WHERE id=?`).bind(f.message.sourceId).run();
      }
      expect(await f.search()).toEqual([]);
      f.ai.mockClear();
      await f.ingest();
      expect(f.ai).not.toHaveBeenCalled();
    } finally { f.sqlite.close(); }
  });

  it("ignores a message superseded while embeddings are running", async () => {
    const f = await fixture(kind);
    try {
      f.ai.mockImplementationOnce(async () => {
        await f.edit();
        return { data: [[1, 2, 3]] };
      });
      await f.ingest();
      expect((await f.chunks()).results).toEqual([]);
      expect(f.upsert).not.toHaveBeenCalled();
      expect(await f.database.prepare(`SELECT ingestion_state FROM ${f.table} WHERE id=?`).bind(f.message.sourceId).first()).toMatchObject({ ingestion_state: "pending" });
    } finally { f.sqlite.close(); }
  });
});

it("deletes vectors in batches of at most 100 and permits an absent vector binding", async () => {
  const f = await fixture("note");
  try {
    for (let i = 0; i < 205; i++) {
      await f.database.prepare(
        `INSERT INTO knowledge_chunks (id, workspace_id, scope, source_kind, source_id, ordinal, text, sha256, version, created_at)
         VALUES (?,'ws','personal','note',?,?,'old','hash',0,0)`,
      ).bind(`old-${i}`, f.message.sourceId, i).run();
    }
    await f.ingest();
    expect(f.deleteByIds.mock.calls.map(([ids]) => ids.length)).toEqual([100, 100, 5]);
    expect(new Set(f.deleteByIds.mock.calls.flatMap(([ids]) => ids)).size).toBe(205);
    delete (f.env as Partial<Env>).MEMORY_VECTORS;
    await f.ingest();
    expect((await f.chunks()).results).toHaveLength(1);
  } finally { f.sqlite.close(); }
});
