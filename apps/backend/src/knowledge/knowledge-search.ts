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
  const out: RankedChunk[] = [];
  for (const match of matches.matches ?? []) {
    const meta = match.metadata as Record<string, string | number> | undefined;
    if (!meta?.chunkId || !meta.sourceKind || !meta.sourceId) continue;
    out.push({
      chunkId: String(meta.chunkId),
      sourceKind: meta.sourceKind === "note" ? "note" : "file",
      sourceId: String(meta.sourceId),
      ordinal: Number(meta.ordinal ?? 0),
      text: String(meta.text ?? ""),
      workspaceId: String(meta.workspace ?? workspaceId),
      scope: meta.scope === "workspace" ? "workspace" : "personal",
      createdBy: String(meta.createdBy ?? ""),
    });
  }
  return out;
}

async function ftsCandidates(env: Env, workspaceId: string, query: string): Promise<RankedChunk[]> {
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT kc.id AS chunk_id, kc.source_kind, kc.source_id, kc.ordinal, kc.text, kc.workspace_id, kc.scope,
            COALESCE(f.created_by, n.created_by) AS created_by
     FROM knowledge_fts
     JOIN knowledge_chunks kc ON kc.id = knowledge_fts.chunk_id
     LEFT JOIN files f ON kc.source_kind = 'file' AND f.id = kc.source_id
     LEFT JOIN notes n ON kc.source_kind = 'note' AND n.id = kc.source_id
     WHERE knowledge_fts MATCH ? AND kc.workspace_id = ?
     ORDER BY bm25(knowledge_fts) LIMIT ?`,
  ).bind(query, workspaceId, FTS_TOP_K).all<{
    chunk_id: string; source_kind: string; source_id: string; ordinal: number; text: string;
    workspace_id: string; scope: string; created_by: string;
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
  const vector = await embedQuery(env, trimmed);
  const [vectorList, ftsList] = await Promise.all([
    vectorCandidates(env, workspaceId, vector),
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
      ordinal: chunk.ordinal,
      text: chunk.text,
      score,
      rank: hits.length + 1,
    });
  }
  return hits;
}

export { VECTOR_TOP_K, FTS_TOP_K, RRF_K };