import type { KnowledgeSearchHit } from "@shiba/shared";
import type { Env } from "../env.js";
import type { KnowledgeResourceAccess } from "./knowledge-access.js";
import { canAccessKnowledgeResource } from "./knowledge-access.js";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5" as const;
const VECTOR_TOP_K = 30;
const FTS_TOP_K = 30;
const RRF_K = 60;

export interface RankedChunk {
  chunkId: string;
  sourceKind: "file" | "note";
  sourceId: string;
  ordinal: number;
  text: string;
  workspaceId: string;
  scope: "personal" | "workspace";
  createdBy: string;
  sourceName: string;
}

async function embedQuery(env: Env, query: string): Promise<number[]> {
  const result = await env.AI.run(EMBEDDING_MODEL, { text: [query] }) as { data?: number[][] };
  const vector = result.data?.[0];
  if (!vector?.length) throw new Error("Embedding unavailable.");
  return vector;
}

async function vectorCandidates(env: Env, workspaceId: string, vector: number[]): Promise<RankedChunk[]> {
  const matches = await env.MEMORY_VECTORS.query(vector, {
    topK: VECTOR_TOP_K,
    returnMetadata: true,
    filter: { workspace: workspaceId, kind: "knowledge" },
  });
  const ids = (matches.matches ?? []).map((match) => match.id);
  if (!ids.length) return [];
  // Vector deletion is asynchronous; D1 is authoritative for text and source state.
  const chunks = await currentChunks(env, workspaceId, `kc.id IN (${ids.map(() => "?").join(",")})`, ids);
  const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  return ids.flatMap((id) => {
    const chunk = byId.get(id);
    return chunk ? [chunk] : [];
  });
}

/** Quotes each word so user punctuation (quotes, colons, hyphens) can never become FTS5 syntax. */
export function ftsMatchExpression(query: string): string | null {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 16);
  return terms.length ? terms.map((term) => `"${term}"`).join(" OR ") : null;
}

async function ftsCandidates(env: Env, workspaceId: string, query: string): Promise<RankedChunk[]> {
  const match = ftsMatchExpression(query);
  return match ? currentChunks(env, workspaceId, "knowledge_fts MATCH ?", [match], true) : [];
}

/** Semantic ranking is optional: without Workers AI or Vectorize, search degrades to keyword-only. */
async function semanticCandidates(env: Env, workspaceId: string, query: string): Promise<RankedChunk[]> {
  if (!env.AI || !env.MEMORY_VECTORS) return [];
  try {
    return await vectorCandidates(env, workspaceId, await embedQuery(env, query));
  } catch {
    return [];
  }
}

async function currentChunks(
  env: Env,
  workspaceId: string,
  predicate: string,
  values: string[],
  fts = false,
): Promise<RankedChunk[]> {
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT kc.id AS chunk_id, kc.source_kind, kc.source_id, kc.ordinal, kc.text, kc.workspace_id,
            COALESCE(f.scope, n.scope) AS scope, COALESCE(f.created_by, n.created_by) AS created_by,
            COALESCE(f.name, n.title) AS source_name
     FROM knowledge_chunks kc
     ${fts ? "JOIN knowledge_fts ON kc.id = knowledge_fts.chunk_id" : ""}
     LEFT JOIN files f ON kc.source_kind = 'file' AND f.id = kc.source_id
     LEFT JOIN notes n ON kc.source_kind = 'note' AND n.id = kc.source_id
     WHERE ${predicate} AND kc.workspace_id = ?
       AND ((f.version = kc.version AND f.archived_at IS NULL AND f.workspace_id = kc.workspace_id)
         OR (n.version = kc.version AND n.archived_at IS NULL AND n.workspace_id = kc.workspace_id))
     ${fts ? `ORDER BY bm25(knowledge_fts) LIMIT ${FTS_TOP_K}` : ""}`,
  ).bind(...values, workspaceId).all<{
    chunk_id: string; source_kind: string; source_id: string; ordinal: number; text: string;
    workspace_id: string; scope: string; created_by: string; source_name: string | null;
  }>();
  return rows.results.map((row) => ({
    chunkId: row.chunk_id,
    sourceKind: row.source_kind === "note" ? "note" : "file",
    sourceId: row.source_id,
    ordinal: row.ordinal,
    text: row.text,
    workspaceId: row.workspace_id,
    scope: row.scope === "workspace" ? "workspace" : "personal",
    createdBy: row.created_by,
    sourceName: row.source_name ?? "",
  }));
}

/** Reciprocal-rank fusion across vector and FTS candidate lists. */
export function reciprocalRankFusion(
  lists: Array<Array<Pick<RankedChunk, "chunkId">>>,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const rank = index + 1;
      scores.set(item.chunkId, (scores.get(item.chunkId) ?? 0) + 1 / (RRF_K + rank));
    });
  }
  return scores;
}

export async function hybridKnowledgeSearch(
  env: Env,
  viewerUserId: string,
  workspaceId: string,
  query: string,
  limit: number,
): Promise<KnowledgeSearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const [vectorList, ftsList] = await Promise.all([
    semanticCandidates(env, workspaceId, trimmed),
    ftsCandidates(env, workspaceId, trimmed),
  ]);
  const fused = reciprocalRankFusion([vectorList, ftsList]);
  const byId = new Map<string, RankedChunk>();
  for (const item of [...vectorList, ...ftsList]) byId.set(item.chunkId, item);
  const sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]);
  const hits: KnowledgeSearchHit[] = [];
  for (const [chunkId, score] of sorted) {
    if (hits.length >= limit) break;
    const chunk = byId.get(chunkId);
    if (!chunk) continue;
    const access: KnowledgeResourceAccess = {
      workspaceId: chunk.workspaceId,
      scope: chunk.scope,
      createdBy: chunk.createdBy,
      resourceId: chunk.sourceId,
      resourceKind: chunk.sourceKind,
    };
    if (!(await canAccessKnowledgeResource(env, viewerUserId, access))) continue;
    hits.push({
      chunkId,
      sourceKind: chunk.sourceKind,
      sourceId: chunk.sourceId,
      sourceName: chunk.sourceName,
      scope: chunk.scope,
      ordinal: chunk.ordinal,
      text: chunk.text,
      score,
      rank: hits.length + 1,
    });
  }
  return hits;
}

export { VECTOR_TOP_K, FTS_TOP_K, RRF_K };