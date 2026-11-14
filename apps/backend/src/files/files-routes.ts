import type { KnowledgeScope } from "@shiba/shared";
import type { Env } from "../env.js";
import { isAuthorizedRequest, requireSameOriginBrowserMutation, resolveUserId } from "../request-auth.js";
import { resolveOrgForApiRequest } from "../org-request-auth.js";
import { InputError } from "../security.js";
import { assertKnowledgeRead, KnowledgeAccessError } from "../knowledge/knowledge-access.js";
import { enqueueIngestion } from "../knowledge/knowledge-ingestion.js";
import { filesBucket } from "../knowledge/knowledge-ingestion.js";
import {
  createFolder, FilesStoreError, getFile, listFiles, listFolders, retryFileIngestion,
} from "./files-store.js";
import {
  completeMultipartUpload, createMultipartUploadSession, uploadPart,
} from "./files-uploads.js";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
} });

function workspaceFromRequest(request: Request, env: Env): Promise<{ workspaceId: string; userId: string } | Response> {
  return (async () => {
    if (!(await isAuthorizedRequest(request, env))) return json({ error: "Authentication required." }, 401);
    const userId = await resolveUserId(request, env);
    if (!userId) return json({ error: "Authentication required." }, 401);
    const org = await resolveOrgForApiRequest(request, env);
    if (org instanceof Response) return org;
    const workspaceId = org.workspace?.workspaceId ?? org.orgId.replace(/^team:/, "");
    return { workspaceId, userId };
  })();
}

function readScope(url: URL): KnowledgeScope {
  const raw = url.searchParams.get("scope") ?? "personal";
  return raw === "workspace" ? "workspace" : "personal";
}

export async function handleFiles(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/files")) return null;
  if (!env.AGENT_AUDIT) return json({ error: "Knowledge storage is unavailable." }, 503);
  const identity = await workspaceFromRequest(request, env);
  if (identity instanceof Response) return identity;
  const { workspaceId, userId } = identity;
  const scope = readScope(url);

  if (url.pathname === "/api/files/folders") {
    if (request.method === "GET") {
      const folders = await listFolders(env, workspaceId, scope, userId);
      return json({ folders });
    }
    if (request.method === "POST") {
      const blocked = requireSameOriginBrowserMutation(request);
      if (blocked) return blocked;
      const body = await request.json().catch(() => null) as { name?: string; parentId?: string | null } | null;
      try {
        const folder = await createFolder(env, {
          workspaceId, scope, parentId: body?.parentId ?? null, name: body?.name ?? "", createdBy: userId,
        });
        return json({ folder }, 201);
      } catch (error) {
        if (error instanceof FilesStoreError) return json({ error: error.message }, error.status);
        throw error;
      }
    }
    return json({ error: "Method not allowed." }, 405);
  }

  if (url.pathname === "/api/files") {
    if (request.method === "GET") {
      const folderId = url.searchParams.get("folderId");
      const files = await listFiles(env, workspaceId, scope, userId, folderId);
      return json({ files });
    }
    return json({ error: "Method not allowed." }, 405);
  }

  if (url.pathname === "/api/files/uploads") {
    if (request.method === "POST") {
      const blocked = requireSameOriginBrowserMutation(request);
      if (blocked) return blocked;
      if (env.UPLOAD_RATE_LIMIT) {
        const outcome = await env.UPLOAD_RATE_LIMIT.limit({ key: userId });
        if (!outcome.success) return json({ error: "Upload rate limit exceeded." }, 429);
      }
      const contentType = request.headers.get("content-type") ?? "";
      const body = contentType.includes("application/json")
        ? await request.json().catch(() => null) as {
          name?: string; mime?: string; folderId?: string | null; action?: string;
          sessionId?: string; partNumber?: number; parts?: Array<{ partNumber: number; etag: string }>;
        } | null
        : null;
      try {
        const action = body?.action ?? (contentType.includes("application/json") ? "begin" : "part");
        if (action === "begin") {
          const session = await createMultipartUploadSession(env, {
            workspaceId, scope, folderId: body?.folderId ?? null,
            name: body?.name ?? "", mime: body?.mime ?? "", createdBy: userId,
          });
          return json({ session }, 201);
        }
        if (action === "part") {
          const bytes = contentType.includes("application/json") ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
          const part = await uploadPart(env, body?.sessionId ?? url.searchParams.get("sessionId") ?? "", Number(body?.partNumber ?? url.searchParams.get("partNumber")), bytes);
          return json({ part });
        }
        if (action === "complete") {
          const result = await completeMultipartUpload(env, body?.sessionId ?? "", body?.parts ?? [], userId);
          return json(result, 201);
        }
        return json({ error: "Unknown upload action." }, 400);
      } catch (error) {
        if (error instanceof InputError || error instanceof FilesStoreError) return json({ error: error.message }, 400);
        throw error;
      }
    }
    return json({ error: "Method not allowed." }, 405);
  }

  const fileMatch = /^\/api\/files\/([^/]+)(\/(download|retry-ingest))?$/.exec(url.pathname);
  if (!fileMatch) return json({ error: "Not found." }, 404);
  const fileId = fileMatch[1]!;
  const suffix = fileMatch[2];
  const file = await getFile(env, fileId);
  if (!file || file.workspaceId !== workspaceId) return json({ error: "File not found." }, 404);
  try {
    await assertKnowledgeRead(env, userId, {
      workspaceId: file.workspaceId, scope: file.scope, createdBy: file.createdBy, resourceId: file.id, resourceKind: "file",
    });
  } catch (error) {
    if (error instanceof KnowledgeAccessError) return json({ error: error.message }, error.status);
    throw error;
  }

  if (suffix === "/retry-ingest" && request.method === "POST") {
    const blocked = requireSameOriginBrowserMutation(request);
    if (blocked) return blocked;
    try {
      const updated = await retryFileIngestion(env, fileId, userId);
      const storage = await env.AGENT_AUDIT.prepare(`SELECT r2_key, mime FROM files WHERE id=?`)
        .bind(fileId).first<{ r2_key: string; mime: string }>();
      if (!storage) return json({ error: "File not found." }, 404);
      const jobId = await enqueueIngestion(env, {
        sourceKind: "file", sourceId: updated.id, workspaceId: updated.workspaceId, scope: updated.scope,
        sha256: updated.sha256, version: updated.version, r2Key: storage.r2_key, mime: storage.mime,
      });
      return json({ file: updated, jobId });
    } catch (error) {
      if (error instanceof FilesStoreError || error instanceof KnowledgeAccessError) {
        return json({ error: error.message }, error.status);
      }
      throw error;
    }
  }

  if (suffix === "/download" && request.method === "GET") {
    const bucket = filesBucket(env);
    const object = await bucket.get((await env.AGENT_AUDIT.prepare(`SELECT r2_key FROM files WHERE id=?`).bind(fileId).first<{ r2_key: string }>())!.r2_key);
    if (!object) return json({ error: "File bytes missing." }, 404);
    return new Response(object.body, {
      headers: {
        "Content-Type": file.mime,
        "Content-Disposition": `inline; filename="${file.name.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  if (!suffix && request.method === "GET") return json({ file });
  return json({ error: "Method not allowed." }, 405);
}