import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { runIngestionJob } from "../src/knowledge/knowledge-ingestion.js";
import { createNote } from "../src/notes/notes-store.js";

describe("ingestion consumer", () => {
  it("chunks, indexes FTS and upserts vectors", async () => {
    const { database, sqlite } = customAgentD1();
    sqlite.exec(readFileSync(new URL("../migrations/0050_files_notes.sql", import.meta.url), "utf8"));
    sqlite.exec(readFileSync(new URL("../migrations/0051_knowledge_indexes.sql", import.meta.url), "utf8"));
    const upsert = vi.fn(async () => {});
    const objects = new Map<string, Uint8Array>();
    const env = {
      AGENT_AUDIT: database,
      FILES: {
        async get(key: string) {
          const bytes = objects.get(key);
          return bytes ? { arrayBuffer: async () => bytes.buffer } : null;
        },
        async put(key: string, value: Uint8Array) { objects.set(key, value); return { key }; },
      },
      AI: {
        run: vi.fn(async (_model: string, input: { text?: string[] }) => ({
          data: (input.text ?? []).map((text) => text.split("").map((c) => c.charCodeAt(0) % 7)),
        })),
      },
      MEMORY_VECTORS: { upsert, query: vi.fn(async () => ({ matches: [] })) },
    } as unknown as Env;
    const note = await createNote(env, {
      workspaceId: "ws_fixture",
      scope: "workspace",
      title: "Launch",
      markdown: "Alpha bravo unique phrase PAGE3_MARKER for retrieval.",
      createdBy: "alice@example.test",
    });
    await database.prepare(
      `INSERT INTO ingestion_jobs (id, source_kind, source_id, workspace_id, sha256, version, state, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind("ingest_test", "note", note.id, note.workspaceId, note.sha256, note.version, "pending", Date.now(), Date.now()).run();
    await runIngestionJob(env, {
      jobId: "ingest_test",
      sourceKind: "note",
      sourceId: note.id,
      workspaceId: note.workspaceId,
      scope: note.scope,
      sha256: note.sha256,
      version: note.version,
      r2Key: note.r2Key,
      mime: "text/markdown",
    });
    expect(upsert).toHaveBeenCalled();
    const row = await database.prepare(`SELECT ingestion_state FROM notes WHERE id=?`).bind(note.id).first<{ ingestion_state: string }>();
    expect(row?.ingestion_state).toBe("done");
  });
});