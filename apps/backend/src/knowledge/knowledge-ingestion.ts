import type { IngestQueueMessage, KnowledgeScope } from "@shiba/shared";
import type { Env } from "../env.js";
import { randomHex } from "../mailbox-store.js";
import { enqueue } from "../platform/queues.js";
import { publishWorkspaceEvent } from "../platform/workspace-events-do.js";
import { chunkText } from "./knowledge-chunk.js";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5" as const;
const TO_MARKDOWN = "@cf/meta/to-markdown" as const;

export function filesBucket(env: Env): R2Bucket {
  if (env.FILES) return env.FILES;
  if (env.ARTIFACTS) return env.ARTIFACTS;
  throw new Error("FILES binding is not configured.");
}

export async function extractText(bytes: Uint8Array, mime: string, env: Env): Promise<string> {
  const lower = mime.toLowerCase();
  if (lower.startsWith("text/") || lower === "application/json") {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  if (lower === "application/pdf" || lower.includes("word") || lower.includes("html")) {
    const result = await env.AI.run(TO_MARKDOWN, { blob: [...bytes], contentType: mime }) as { data?: string };
    if (typeof result.data === "string" && result.data.trim()) return result.data;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function embedMany(env: Env, texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const result = await env.AI.run(EMBEDDING_MODEL, { text: texts }) as { data?: number[][] };
  return result.data ?? [];
}

export async function runIngestionJob(env: Env, message: IngestQueueMessage): Promise<void> {
  const now = Date.now();
  await env.AGENT_AUDIT.prepare(
    `UPDATE ingestion_jobs SET state='processing', updated_at=? WHERE id=? AND state IN ('pending','failed')`,
  ).bind(now, message.jobId).run();
  await env.AGENT_AUDIT.prepare(
    `UPDATE ${message.sourceKind === "file" ? "files" : "notes"}
     SET ingestion_state='processing', ingestion_error=NULL, updated_at=? WHERE id=?`,
  ).bind(now, message.sourceId).run();
  try {
    const object = await filesBucket(env).get(message.r2Key);
    if (!object) throw new Error("Object missing from file storage.");
    const bytes = new Uint8Array(await object.arrayBuffer());
    const text = await extractText(bytes, message.mime, env);
    const chunks = chunkText(text);
  const createdByRow = await env.AGENT_AUDIT.prepare(
      `SELECT created_by AS created_by FROM ${message.sourceKind === "file" ? "files" : "notes"} WHERE id=?`,
    ).bind(message.sourceId).first<{ created_by: string }>();
    const createdBy = createdByRow?.created_by ?? "unknown";
    const stale = await env.AGENT_AUDIT.prepare(
      `SELECT id FROM knowledge_chunks WHERE source_kind=? AND source_id=? AND version=?`,
    ).bind(message.sourceKind, message.sourceId, message.version).all<{ id: string }>();
    for (const row of stale.results) {
      await env.AGENT_AUDIT.prepare(`DELETE FROM knowledge_fts WHERE chunk_id=?`).bind(row.id).run();
    }
    await env.AGENT_AUDIT.prepare(
      `DELETE FROM knowledge_chunks WHERE source_kind=? AND source_id=? AND version=?`,
    ).bind(message.sourceKind, message.sourceId, message.version).run();
    const vectors: Array<{ id: string; values: number[]; metadata: Record<string, string | number> }> = [];
    const embeddings = await embedMany(env, chunks);
    for (let ordinal = 0; ordinal < chunks.length; ordinal++) {
      const chunkId = `kchunk_${randomHex(12)}`;
      const chunkTextValue = chunks[ordinal]!;
      await env.AGENT_AUDIT.prepare(
        `INSERT INTO knowledge_chunks
         (id, workspace_id, scope, source_kind, source_id, ordinal, text, sha256, version, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        chunkId, message.workspaceId, message.scope, message.sourceKind, message.sourceId,
        ordinal, chunkTextValue, message.sha256, message.version, now,
      ).run();
      await env.AGENT_AUDIT.prepare(
        `INSERT INTO knowledge_fts (chunk_id, workspace_id, scope, source_kind, source_id, text)
         VALUES (?,?,?,?,?,?)`,
      ).bind(chunkId, message.workspaceId, message.scope, message.sourceKind, message.sourceId, chunkTextValue).run();
      const values = embeddings[ordinal];
      if (values?.length) {
        vectors.push({
          id: chunkId,
          values,
          metadata: {
            kind: "knowledge",
            workspace: message.workspaceId,
            scope: message.scope,
            source: `${message.sourceKind}:${message.sourceId}`,
            sourceKind: message.sourceKind,
            sourceId: message.sourceId,
            chunkId,
            ordinal,
            text: chunkTextValue.slice(0, 800),
            createdBy,
          },
        });
      }
    }
    if (vectors.length) await env.MEMORY_VECTORS.upsert(vectors);
    await env.AGENT_AUDIT.prepare(
      `UPDATE ingestion_jobs SET state='done', error=NULL, updated_at=? WHERE id=?`,
    ).bind(now, message.jobId).run();
    await env.AGENT_AUDIT.prepare(
      `UPDATE ${message.sourceKind === "file" ? "files" : "notes"}
       SET ingestion_state='done', ingestion_error=NULL, updated_at=? WHERE id=?`,
    ).bind(now, message.sourceId).run();
    await publishWorkspaceEvent(env, message.workspaceId, {
      type: message.sourceKind === "file" ? "file.ingestion.done" : "note.ingestion.done",
      resourceId: message.sourceId,
      version: message.version,
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Ingestion failed.";
    await env.AGENT_AUDIT.prepare(
      `UPDATE ingestion_jobs SET state='failed', error=?, updated_at=? WHERE id=?`,
    ).bind(messageText.slice(0, 500), now, message.jobId).run();
    await env.AGENT_AUDIT.prepare(
      `UPDATE ${message.sourceKind === "file" ? "files" : "notes"}
       SET ingestion_state='failed', ingestion_error=?, updated_at=? WHERE id=?`,
    ).bind(messageText.slice(0, 500), now, message.sourceId).run();
    throw error;
  }
}

export async function enqueueIngestion(
  env: Env,
  input: Omit<IngestQueueMessage, "jobId"> & { mime: string },
): Promise<string> {
  const jobId = `ingest_${randomHex(12)}`;
  const now = Date.now();
  await env.AGENT_AUDIT.prepare(
    `INSERT OR IGNORE INTO ingestion_jobs
     (id, source_kind, source_id, workspace_id, sha256, version, state, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(jobId, input.sourceKind, input.sourceId, input.workspaceId, input.sha256, input.version, "pending", now, now).run();
  const message: IngestQueueMessage = { jobId, ...input };
  if (env.INGEST_QUEUE) {
    await enqueue("INGEST_QUEUE", message as unknown as Record<string, unknown>, env);
  } else {
    await runIngestionJob(env, message);
  }
  return jobId;
}

export function parseIngestMessage(body: unknown): IngestQueueMessage | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const required = ["jobId", "sourceKind", "sourceId", "workspaceId", "scope", "sha256", "version", "r2Key", "mime"] as const;
  for (const key of required) {
    if (typeof record[key] !== "string" && typeof record[key] !== "number") return null;
  }
  return record as unknown as IngestQueueMessage;
}

export type { KnowledgeScope };