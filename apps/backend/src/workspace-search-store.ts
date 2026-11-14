import { COLLAB_TENANT_ID, humanActorId } from "./collaboration-store.js";
import { ftsQuery } from "./mailbox-store.js";
import type { Env } from "./env.js";

export type WorkspaceSearchKind = "task" | "room" | "message" | "run";

export interface WorkspaceSearchHit {
  kind: WorkspaceSearchKind;
  id: string;
  title: string;
  snippet: string;
  updatedAt: number;
  roomId: string | null;
  threadRootId: string | null;
  senderActorId: string | null;
  taskStatus: string | null;
  taskOwnerId: string | null;
}

type StoreEnv = Pick<Env, "AGENT_AUDIT">;
const ALL_KINDS: readonly WorkspaceSearchKind[] = ["task", "room", "message", "run"];

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

interface SearchRow {
  kind: WorkspaceSearchKind;
  doc_id: string;
  title: string;
  body: string;
  updated_at: number;
  room_id: string | null;
  thread_root_id: string | null;
  sender_actor_id: string | null;
  task_status: string | null;
  task_owner: string | null;
}

/** Room and message hits require an active membership inside the LIMIT. */
export async function searchWorkspace(
  env: StoreEnv,
  workspaceId: string,
  query: string,
  viewerUserId: string,
  limit = 30,
  kinds: readonly WorkspaceSearchKind[] = ALL_KINDS,
): Promise<WorkspaceSearchHit[]> {
  if (!env.AGENT_AUDIT) return [];
  const match = ftsQuery(query);
  const selected = kinds.filter((kind) => ALL_KINDS.includes(kind));
  if (!match || selected.length === 0) return [];
  const capped = Math.max(1, Math.min(50, Math.floor(limit)));
  const kindClause = `AND d.kind IN (${selected.map(() => "?").join(",")})`;
  const { results } = await env.AGENT_AUDIT.prepare(
    `SELECT d.kind, d.doc_id, d.title, d.body, d.updated_at, d.room_id, d.thread_root_id, d.sender_actor_id,
            (SELECT t.status FROM team_work_tasks t
              WHERE t.tenant_id = d.tenant_id AND t.workspace_id = d.workspace_id AND t.task_id = d.doc_id) AS task_status,
            (SELECT t.owner_id FROM team_work_tasks t
              WHERE t.tenant_id = d.tenant_id AND t.workspace_id = d.workspace_id AND t.task_id = d.doc_id) AS task_owner
     FROM workspace_search_docs d
     JOIN workspace_search_fts ON workspace_search_fts.rowid = d.rowid
     WHERE d.tenant_id = ? AND d.workspace_id = ? AND workspace_search_fts MATCH ?
       AND (
         (d.kind IN ('room', 'message') AND EXISTS (
           SELECT 1 FROM collaboration_memberships m
           WHERE m.tenant_id = d.tenant_id AND m.workspace_id = d.workspace_id
             AND m.room_id = d.room_id AND m.user_id = ? AND m.status = 'active'))
         OR (d.kind = 'task' AND (
           NOT EXISTS (
             SELECT 1 FROM team_work_tasks t
             WHERE t.tenant_id = d.tenant_id AND t.workspace_id = d.workspace_id AND t.task_id = d.doc_id
               AND t.room_id IS NOT NULL AND t.room_id != '')
           OR EXISTS (
             SELECT 1 FROM team_work_tasks t
             JOIN collaboration_memberships m
               ON m.tenant_id = t.tenant_id AND m.workspace_id = t.workspace_id
              AND m.room_id = t.room_id AND m.user_id = ? AND m.status = 'active'
             WHERE t.tenant_id = d.tenant_id AND t.workspace_id = d.workspace_id AND t.task_id = d.doc_id
               AND t.room_id IS NOT NULL AND t.room_id != '')))
         OR (d.kind = 'run' AND d.sender_actor_id = ?)
       )
       ${kindClause}
     ORDER BY bm25(workspace_search_fts) LIMIT ?`,
  )
    .bind(
      COLLAB_TENANT_ID,
      workspaceId,
      match,
      viewerUserId,
      viewerUserId,
      humanActorId(viewerUserId),
      ...selected,
      capped,
    )
    .all<SearchRow>();
  return results.map((row) => ({
    kind: row.kind,
    id: row.doc_id,
    title: row.title,
    snippet: row.body.slice(0, 240),
    updatedAt: row.updated_at,
    roomId: row.room_id,
    threadRootId: row.thread_root_id,
    senderActorId: row.sender_actor_id,
    taskStatus: row.task_status,
    taskOwnerId: row.task_owner,
  }));
}
