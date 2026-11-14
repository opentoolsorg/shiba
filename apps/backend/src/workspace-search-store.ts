import { COLLAB_TENANT_ID } from "./collaboration-store.js";
import { ftsQuery } from "./mailbox-store.js";
import type { Env } from "./env.js";

export type WorkspaceSearchKind = "task" | "room" | "message" | "run";

export interface WorkspaceSearchHit {
  kind: WorkspaceSearchKind;
  id: string;
  title: string;
  snippet: string;
  updatedAt: number;
}

type StoreEnv = Pick<Env, "AGENT_AUDIT">;

export async function upsertWorkspaceSearchDoc(
  env: StoreEnv,
  workspaceId: string,
  docId: string,
  kind: WorkspaceSearchKind,
  title: string,
  body: string,
  updatedAt: number,
): Promise<void> {
  if (!env.AGENT_AUDIT) return;
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO workspace_search_docs (tenant_id, workspace_id, doc_id, kind, title, body, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, workspace_id, doc_id) DO UPDATE SET
       kind=excluded.kind, title=excluded.title, body=excluded.body, updated_at=excluded.updated_at`,
  )
    .bind(COLLAB_TENANT_ID, workspaceId, docId, kind, title.slice(0, 500), body.slice(0, 16_000), updatedAt)
    .run();
}

export async function searchWorkspace(
  env: StoreEnv,
  workspaceId: string,
  query: string,
  limit = 30,
): Promise<WorkspaceSearchHit[]> {
  if (!env.AGENT_AUDIT) return [];
  const match = ftsQuery(query);
  if (!match) return [];
  const capped = Math.max(1, Math.min(50, Math.floor(limit)));
  const { results } = await env.AGENT_AUDIT.prepare(
    `SELECT d.kind, d.doc_id, d.title, d.body, d.updated_at
     FROM workspace_search_docs d
     JOIN workspace_search_fts ON workspace_search_fts.rowid = d.rowid
     WHERE d.tenant_id = ? AND d.workspace_id = ? AND workspace_search_fts MATCH ?
     ORDER BY bm25(workspace_search_fts) LIMIT ?`,
  )
    .bind(COLLAB_TENANT_ID, workspaceId, match, capped)
    .all<{ kind: WorkspaceSearchKind; doc_id: string; title: string; body: string; updated_at: number }>();
  return results.map((row) => ({
    kind: row.kind,
    id: row.doc_id,
    title: row.title,
    snippet: row.body.slice(0, 240),
    updatedAt: row.updated_at,
  }));
}