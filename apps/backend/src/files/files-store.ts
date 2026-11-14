import type { IngestionState, KnowledgeFile, KnowledgeScope } from "@shiba/shared";
import type { Env } from "../env.js";
import { randomHex } from "../mailbox-store.js";
import { KnowledgeAccessError } from "../knowledge/knowledge-access.js";

export class FilesStoreError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "FilesStoreError";
  }
}

export interface FolderRow {
  id: string; workspace_id: string; scope: KnowledgeScope; parent_id: string | null; name: string;
  created_by: string; created_at: number;
}

function fileDto(row: Record<string, unknown>): KnowledgeFile {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    scope: row.scope === "workspace" ? "workspace" : "personal",
    folderId: row.folder_id ? String(row.folder_id) : null,
    name: String(row.name),
    mime: String(row.mime),
    size: Number(row.size),
    sha256: String(row.sha256),
    projectId: row.project_id ? String(row.project_id) : null,
    version: Number(row.version),
    createdBy: String(row.created_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: row.archived_at ? Number(row.archived_at) : null,
    ingestion: {
      state: String(row.ingestion_state) as IngestionState,
      error: row.ingestion_error ? String(row.ingestion_error) : null,
    },
  };
}

export async function createFolder(
  env: Env,
  input: { workspaceId: string; scope: KnowledgeScope; parentId?: string | null; name: string; createdBy: string },
): Promise<FolderRow> {
  const id = `folder_${randomHex(10)}`;
  const now = Date.now();
  const name = input.name.trim();
  if (!name || name.length > 200) throw new FilesStoreError("Folder name must be 1–200 characters.");
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO folders (id, workspace_id, scope, parent_id, name, created_by, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(id, input.workspaceId, input.scope, input.parentId ?? null, name, input.createdBy, now).run();
  return { id, workspace_id: input.workspaceId, scope: input.scope, parent_id: input.parentId ?? null, name, created_by: input.createdBy, created_at: now };
}

export async function listFolders(env: Env, workspaceId: string, scope: KnowledgeScope, viewer: string): Promise<FolderRow[]> {
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM folders WHERE workspace_id=? AND scope=? AND (scope='workspace' OR created_by=?)
     ORDER BY created_at ASC`,
  ).bind(workspaceId, scope, viewer).all<FolderRow>();
  return rows.results;
}

export async function listFiles(env: Env, workspaceId: string, scope: KnowledgeScope, viewer: string, folderId?: string | null): Promise<KnowledgeFile[]> {
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM files WHERE workspace_id=? AND scope=? AND archived_at IS NULL
       AND (scope='workspace' OR created_by=?)
       AND (? IS NULL OR folder_id IS ?)
     ORDER BY updated_at DESC LIMIT 200`,
  ).bind(workspaceId, scope, viewer, folderId ?? null, folderId ?? null).all();
  return rows.results.map((row) => fileDto(row as Record<string, unknown>));
}

export async function getFile(env: Env, fileId: string): Promise<KnowledgeFile | null> {
  const row = await env.AGENT_AUDIT.prepare(`SELECT * FROM files WHERE id=?`).bind(fileId).first();
  return row ? fileDto(row as Record<string, unknown>) : null;
}

export async function insertFileRecord(
  env: Env,
  input: {
    workspaceId: string; scope: KnowledgeScope; folderId?: string | null; name: string; mime: string;
    size: number; r2Key: string; sha256: string; createdBy: string; projectId?: string | null;
  },
): Promise<KnowledgeFile> {
  const id = `file_${randomHex(12)}`;
  const now = Date.now();
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO files
     (id, workspace_id, scope, folder_id, name, mime, size, r2_key, sha256, project_id, created_by, version, created_at, updated_at, ingestion_state)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,'pending')`,
  ).bind(
    id, input.workspaceId, input.scope, input.folderId ?? null, input.name, input.mime, input.size,
    input.r2Key, input.sha256, input.projectId ?? null, input.createdBy, now, now,
  ).run();
  const file = await getFile(env, id);
  if (!file) throw new FilesStoreError("File record missing after insert.", 500);
  return file;
}

export async function retryFileIngestion(env: Env, fileId: string, viewer: string): Promise<KnowledgeFile> {
  const file = await getFile(env, fileId);
  if (!file) throw new KnowledgeAccessError("File not found.", 404);
  if (file.scope === "personal" && file.createdBy !== viewer) throw new KnowledgeAccessError("File not found.", 404);
  if (file.ingestion.state !== "failed") throw new FilesStoreError("Only failed ingestions can be retried.");
  await env.AGENT_AUDIT.prepare(
    `UPDATE files SET ingestion_state='pending', ingestion_error=NULL, updated_at=? WHERE id=?`,
  ).bind(Date.now(), fileId).run();
  const updated = await getFile(env, fileId);
  if (!updated) throw new FilesStoreError("File missing.", 500);
  return updated;
}