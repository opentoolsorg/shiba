import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { dispatchQueueBatch } from "../src/platform/queues.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { insertFileRecord } from "../src/files/files-store.js";
import "../src/knowledge/knowledge-ingest-queue.js";

describe("knowledge ingest queue", () => {
  it("consumes WS01 QueuePayload on shiba-ingest", async () => {
    const { database, sqlite } = customAgentD1();
    sqlite.exec(readFileSync(new URL("../migrations/0050_files_notes.sql", import.meta.url), "utf8"));
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
      MEMORY_VECTORS: { upsert: vi.fn(async () => {}), query: vi.fn(async () => ({ matches: [] })) },
    } as unknown as Env & { FILES: R2Bucket };
    const bytes = new TextEncoder().encode("queued body");
    await env.FILES.put("files/ws_q/workspace/queued.md", bytes);
    const file = await insertFileRecord(env, {
      workspaceId: "ws_q", scope: "workspace", name: "queued.md", mime: "text/markdown",
      size: bytes.byteLength, r2Key: "files/ws_q/workspace/queued.md", sha256: "c".repeat(64), createdBy: "alice@example.test",
    });
    await database.prepare(
      `INSERT INTO ingestion_jobs (id, source_kind, source_id, workspace_id, sha256, version, state, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind("ingest_q", "file", file.id, file.workspaceId, file.sha256, file.version, "pending", Date.now(), Date.now()).run();
    const ack = vi.fn();
    const batch = {
      queue: "shiba-ingest",
      messages: [{
        ack,
        retry: vi.fn(),
        body: {
          kind: "INGEST_QUEUE",
          v: 1,
          body: {
            jobId: "ingest_q",
            sourceKind: "file",
            sourceId: file.id,
            workspaceId: file.workspaceId,
            scope: file.scope,
            sha256: file.sha256,
            version: file.version,
            r2Key: "files/ws_q/workspace/queued.md",
            mime: "text/markdown",
          },
        },
      }],
    } as unknown as MessageBatch<unknown>;
    await dispatchQueueBatch(batch, env, {} as ExecutionContext);
    expect(ack).toHaveBeenCalledTimes(1);
    const row = await database.prepare(`SELECT ingestion_state FROM files WHERE id=?`).bind(file.id).first<{ ingestion_state: string }>();
    expect(row?.ingestion_state).toBe("done");
  });
});
