import { z } from "zod";
import type { Env } from "../env.js";
import { assertKnowledgeRead, KnowledgeAccessError } from "../knowledge/knowledge-access.js";
import { resolveOrgForApiRequest } from "../org-request-auth.js";
import { getUserId } from "../request-auth.js";
import { getFile } from "./files-store.js";

const MAX_BYTES = 64 * 1024;
const MAX_COLUMNS = 8;
const plainText = (value: string) =>
  !/[<>]/.test(value) &&
  ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const cell = z.union([z.string().max(500).refine(plainText), z.number(), z.boolean(), z.null()]);
const previewSchema = z
  .strictObject({
    specVersion: z.literal(1),
    title: z.string().trim().min(1).max(60).refine(plainText),
    description: z.string().max(280).refine(plainText),
    columns: z.array(z.string().trim().min(1).max(60).refine(plainText)).min(1).max(MAX_COLUMNS),
    rows: z.array(z.array(cell).max(MAX_COLUMNS)).max(20),
  })
  .refine((preview) => preview.rows.every((row) => row.length === preview.columns.length));

function json(body: unknown, status: number, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
  return Response.json(body, { status, headers });
}

export async function handleFileAppPreview(
  request: Request,
  env: Env,
  fileId: string,
): Promise<Response> {
  const userId = env.ACCESS_AUD ? getUserId(request) : null;
  if (!userId || request.headers.has("Authorization"))
    return json({ error: "Verified Access identity required." }, 401);
  if (request.method !== "GET")
    return json({ error: "Method not allowed." }, 405, { Allow: "GET" });
  const origin = request.headers.get("Origin");
  if (
    (origin !== null && origin !== new URL(request.url).origin) ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  ) {
    return json({ error: "Same-origin request required." }, 403);
  }
  const missing = () => json({ error: "App preview not found." }, 404);
  const invalid = () => json({ error: "Invalid app preview." }, 422);
  const oversized = () => json({ error: "App preview exceeds 64 KiB." }, 413);
  const unavailable = () => json({ error: "App preview storage unavailable." }, 503);
  if (!/^file_[a-f0-9]{24}$/.test(fileId)) return missing();
  if (!env.AGENT_AUDIT) return unavailable();
  try {
    const org = await resolveOrgForApiRequest(request, env);
    if (org instanceof Response) return org.status === 503 ? unavailable() : missing();
    const workspaceId = org.workspace?.workspaceId ?? org.orgId;
    const file = await getFile(env, fileId);
    if (
      !file ||
      file.workspaceId !== workspaceId ||
      file.scope !== "personal" ||
      file.archivedAt !== null ||
      file.mime !== "application/json"
    )
      return missing();
    await assertKnowledgeRead(env, userId, {
      workspaceId,
      scope: file.scope,
      createdBy: file.createdBy,
      resourceId: fileId,
      resourceKind: "file",
    });
    const currentSource = () =>
      env.AGENT_AUDIT.prepare(
        `SELECT r2_key FROM files WHERE id=? AND workspace_id=? AND scope='personal' AND created_by=?
        AND archived_at IS NULL AND version=? AND mime='application/json' AND sha256=? AND size=?`,
      )
        .bind(fileId, workspaceId, file.createdBy, file.version, file.sha256, file.size)
        .first<{ r2_key: string }>();
    const stored = await currentSource();
    if (!stored?.r2_key.startsWith(`files/${workspaceId}/personal/`)) return missing();
    if (file.size > MAX_BYTES) return oversized();
    if (!Number.isSafeInteger(file.size) || file.size < 1) return invalid();
    const bucket = env.FILES ?? env.ARTIFACTS;
    if (!bucket) return unavailable();
    const object = await bucket.get(stored.r2_key);
    if (!object) return missing();
    const reader = object.body.getReader();
    const bytes = new Uint8Array(file.size);
    let read = 0;
    try {
      if (object.size > MAX_BYTES) return oversized();
      if (object.size !== file.size) return invalid();
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (read + part.value.byteLength > MAX_BYTES) return oversized();
        if (read + part.value.byteLength > file.size) return invalid();
        bytes.set(part.value, read);
        read += part.value.byteLength;
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (read !== file.size) return invalid();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (sha256 !== file.sha256) return invalid();
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return invalid();
    }
    const preview = previewSchema.safeParse(data);
    if (!preview.success) return invalid();
    if (org.workspace && (await resolveOrgForApiRequest(request, env)) instanceof Response)
      return missing();
    if ((await currentSource())?.r2_key !== stored.r2_key) return missing();
    return json({ preview: preview.data }, 200);
  } catch (error) {
    return error instanceof KnowledgeAccessError ? missing() : unavailable();
  }
}
