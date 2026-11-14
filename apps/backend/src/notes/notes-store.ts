import type { IngestionState, KnowledgeNote, KnowledgeScope } from "@shiba/shared";
import type { Env } from "../env.js";
import { filesBucket } from "../knowledge/knowledge-ingestion.js";
import { randomHex } from "../mailbox-store.js";

export class NotesStoreError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "NotesStoreError";
  }
}

export class NotesConflictError extends NotesStoreError {
  constructor() { super("Note version conflict.", 409); }
}

function noteDto(row: Record<string, unknown>): KnowledgeNote {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    scope: row.scope === "workspace" ? "workspace" : "personal",
    title: String(row.title),
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

export async function listNotes(env: Env, workspaceId: string, scope: KnowledgeScope, viewer: string): Promise<KnowledgeNote[]> {
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM notes WHERE workspace_id=? AND scope=? AND archived_at IS NULL
     AND (scope='workspace' OR created_by=?) ORDER BY updated_at DESC LIMIT 200`,
  ).bind(workspaceId, scope, viewer).all();
  return rows.results.map((row) => noteDto(row as Record<string, unknown>));
}

export async function getNote(env: Env, noteId: string): Promise<(KnowledgeNote & { r2Key: string }) | null> {
  const row = await env.AGENT_AUDIT.prepare(`SELECT * FROM notes WHERE id=?`).bind(noteId).first();
  if (!row) return null;
  return { ...noteDto(row as Record<string, unknown>), r2Key: String((row as { r2_key: string }).r2_key) };
}

export async function createNote(
  env: Env,
  input: { workspaceId: string; scope: KnowledgeScope; title: string; markdown: string; createdBy: string; projectId?: string | null },
): Promise<KnowledgeNote & { r2Key: string }> {
  const id = `note_${randomHex(12)}`;
  const now = Date.now();
  const title = input.title.trim() || "Untitled";
  const bytes = new TextEncoder().encode(input.markdown);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  const r2Key = `notes/${input.workspaceId}/${input.scope}/${id}/body.md`;
  const bucket = filesBucket(env);
  await bucket.put(r2Key, bytes, { httpMetadata: { contentType: "text/markdown" } });
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO notes
     (id, workspace_id, scope, title, r2_key, sha256, project_id, version, created_by, created_at, updated_at, ingestion_state)
     VALUES (?,?,?,?,?,?,?,1,?,?,?,'pending')`,
  ).bind(id, input.workspaceId, input.scope, title, r2Key, sha256, input.projectId ?? null, input.createdBy, now, now).run();
  const note = await getNote(env, id);
  if (!note) throw new NotesStoreError("Note missing after insert.", 500);
  return note;
}

export async function updateNoteMarkdown(
  env: Env,
  noteId: string,
  input: { markdown: string; expectedVersion: number; title?: string },
): Promise<KnowledgeNote & { r2Key: string }> {
  const current = await getNote(env, noteId);
  if (!current) throw new NotesStoreError("Note not found.", 404);
  if (current.version !== input.expectedVersion) throw new NotesConflictError();
  const now = Date.now();
  const nextVersion = current.version + 1;
  const bytes = new TextEncoder().encode(input.markdown);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  const bucket = filesBucket(env);
  const r2Key = `notes/${current.workspaceId}/${current.scope}/${noteId}/v${nextVersion}.md`;
  await bucket.put(r2Key, bytes, { httpMetadata: { contentType: "text/markdown" } });
  await env.AGENT_AUDIT.prepare(
    `UPDATE notes SET title=?, r2_key=?, sha256=?, version=?, updated_at=?, ingestion_state='pending', ingestion_error=NULL
     WHERE id=? AND version=?`,
  ).bind(input.title?.trim() || current.title, r2Key, sha256, nextVersion, now, noteId, current.version).run();
  const note = await getNote(env, noteId);
  if (!note) throw new NotesStoreError("Note missing after update.", 500);
  return note;
}