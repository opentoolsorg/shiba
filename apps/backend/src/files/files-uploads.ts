import type { KnowledgeScope } from "@shiba/shared";
import type { Env } from "../env.js";
import { InputError } from "../security.js";
import { randomHex } from "../mailbox-store.js";
import { filesBucket } from "../knowledge/knowledge-ingestion.js";
import { enqueueIngestion } from "../knowledge/knowledge-ingestion.js";
import { insertFileRecord } from "./files-store.js";

export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "text/plain", "text/markdown", "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/html", "application/json",
]);

export function maxUploadBytes(env: Env): number {
  const raw = env.FILES_MAX_UPLOAD_BYTES;
  if (raw === undefined) return DEFAULT_MAX_UPLOAD_BYTES;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_UPLOAD_BYTES;
}

function requireMime(mime: string): string {
  const lower = mime.split(";")[0]!.trim().toLowerCase();
  if (!ALLOWED_MIME.has(lower)) throw new InputError("MIME type is not allowed.");
  return lower;
}

export async function createMultipartUploadSession(
  env: Env,
  input: {
    workspaceId: string; scope: KnowledgeScope; folderId?: string | null;
    name: string; mime: string; createdBy: string;
  },
): Promise<{ uploadId: string; sessionId: string; partSize: number; expiresAt: number }> {
  const bucket = filesBucket(env);
  if (!bucket) throw new InputError("File storage is not provisioned.");
  const mime = requireMime(input.mime);
  const sessionId = `upload_${randomHex(12)}`;
  const r2Key = `files/${input.workspaceId}/${input.scope}/${sessionId}/${input.name}`;
  const upload = await bucket.createMultipartUpload(r2Key, { httpMetadata: { contentType: mime } });
  const now = Date.now();
  const expiresAt = now + 60 * 60 * 1000;
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO file_upload_sessions
     (id, workspace_id, scope, folder_id, name, mime, r2_upload_id, r2_key, created_by, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    sessionId, input.workspaceId, input.scope, input.folderId ?? null, input.name, mime,
    upload.uploadId, r2Key, input.createdBy, now, expiresAt,
  ).run();
  return { uploadId: upload.uploadId, sessionId, partSize: 5 * 1024 * 1024, expiresAt };
}

export async function uploadPart(
  env: Env,
  sessionId: string,
  partNumber: number,
  body: ReadableStream | ArrayBuffer | Uint8Array,
): Promise<{ etag: string; partNumber: number }> {
  const row = await env.AGENT_AUDIT.prepare(`SELECT * FROM file_upload_sessions WHERE id=? AND expires_at>?`)
    .bind(sessionId, Date.now()).first<{
      r2_key: string; r2_upload_id: string;
    }>();
  if (!row) throw new InputError("Upload session not found or expired.");
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw new InputError("Invalid part number.");
  const bucket = filesBucket(env);
  const multipart = bucket.resumeMultipartUpload(row.r2_key, row.r2_upload_id);
  const uploaded = await multipart.uploadPart(partNumber, body);
  return { etag: uploaded.etag, partNumber };
}

export async function completeMultipartUpload(
  env: Env,
  sessionId: string,
  parts: Array<{ partNumber: number; etag: string }>,
  viewer: string,
): Promise<{ file: Awaited<ReturnType<typeof insertFileRecord>>; jobId: string }> {
  const row = await env.AGENT_AUDIT.prepare(`SELECT * FROM file_upload_sessions WHERE id=? AND expires_at>? AND created_by=?`)
    .bind(sessionId, Date.now(), viewer).first<{
      workspace_id: string; scope: KnowledgeScope; folder_id: string | null; name: string; mime: string;
      r2_key: string; r2_upload_id: string;
    }>();
  if (!row) throw new InputError("Upload session not found.");
  const bucket = filesBucket(env);
  const multipart = bucket.resumeMultipartUpload(row.r2_key, row.r2_upload_id);
  const object = await multipart.complete(parts);
  const head = await bucket.head(row.r2_key);
  const size = head?.size ?? object?.size ?? 0;
  if (size > maxUploadBytes(env)) throw new InputError("File exceeds upload size limit.");
  const bytes = new Uint8Array(await (await bucket.get(row.r2_key))!.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  const file = await insertFileRecord(env, {
    workspaceId: row.workspace_id,
    scope: row.scope,
    folderId: row.folder_id,
    name: row.name,
    mime: row.mime,
    size,
    r2Key: row.r2_key,
    sha256,
    createdBy: viewer,
  });
  const jobId = await enqueueIngestion(env, {
    sourceKind: "file",
    sourceId: file.id,
    workspaceId: file.workspaceId,
    scope: file.scope,
    sha256: file.sha256,
    version: file.version,
    r2Key: row.r2_key,
    mime: row.mime,
  });
  await env.AGENT_AUDIT.prepare(`DELETE FROM file_upload_sessions WHERE id=?`).bind(sessionId).run();
  return { file, jobId };
}