/**
 * Outputs gallery: run deliverables and generated media (`kind=output` in FILES).
 */
import type { Env } from "../env.js";
import { resolveRequestIdentity, rejectCrossSiteDashboardMutation } from "../request-auth.js";
import { resolveOrgForApiRequest } from "../org-request-auth.js";
import { filesBucket } from "./knowledge-ingestion.js";
import { generateImage } from "../tools/image-gen.js";
import { imageModels, imageAspectRatios, imageInputSchema } from "../tools/image-models.js";
import { videoCapabilityForUser, videoModes } from "../tools/video-gen.js";
import type { MediaGeneration } from "../tools/media-store.js";
import { GENERATED_DOCUMENT_PREFIX } from "../tools/document-gen.js";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
} });

export interface OutputItem {
  id: string;
  kind: "run-deliverable" | "output";
  title: string;
  mime: string;
  bytes?: number;
  downloadPath: string;
  createdAt: number;
  runId?: string;
  media?: MediaGeneration & { label: string };
  documentKind?: "report" | "page";
}

const GENERATED_DOCUMENT_SQL = `f.r2_key GLOB '${GENERATED_DOCUMENT_PREFIX}*' AND f.mime IN ('text/markdown','text/html')`;

export async function handleKnowledgeOutputs(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/outputs")) return null;
  const rejected = rejectCrossSiteDashboardMutation(request);
  if (rejected) return rejected;
  const { userId, authorized } = await resolveRequestIdentity(request, env);
  if (!authorized) return json({ error: "Authentication required." }, 401);
  if (!userId) return json({ error: "Authentication required." }, 401);
  const org = await resolveOrgForApiRequest(request, env);
  if (org instanceof Response) return org;
  const workspaceId = org.workspace?.workspaceId ?? org.orgId.replace(/^team:/, "");

  if (url.pathname === "/api/outputs/media-options" && request.method === "GET") {
    const video = await videoCapabilityForUser(env, userId);
    return json({ imageModels: env.AI && (env.FILES || env.ARTIFACTS) ? imageModels.map(({ id, label, supportsDimensions }) => ({ id, label, supportsDimensions })) : [], imageAspectRatios,
      video: { enabled: video.enabled, reason: video.reason, modes: video.enabled ? videoModes : [], aspectRatios: video.enabled ? ["16:9", "9:16", "1:1"] : [] } });
  }
  if (url.pathname === "/api/outputs/images" && request.method === "POST") {
    let body: unknown;
    try { body = await request.json(); } catch { return json({ error: "Enter an image description." }, 400); }
    const parsed = imageInputSchema.safeParse(body);
    if (!parsed.success) return json({ error: "Use a description of 1–2000 characters and an available shape." }, 400);
    const result = await generateImage(env, { ...parsed.data, userId, workspaceId, runId: `outputs-${crypto.randomUUID()}` });
    return json(result, result.ok ? 201 : 400);
  }

  if (url.pathname === "/api/outputs" && request.method === "GET") {
    const type = url.searchParams.get("type");
    if (type && !["image", "video", "document", "archive", "output"].includes(type)) return json({ error: "Unknown output type." }, 400);
    const items: OutputItem[] = [];
    if (env.AGENT_AUDIT) {
      const archives = await env.AGENT_AUDIT.prepare(
        `SELECT id, run_id, created_at FROM run_output_archive_reservations
         WHERE owner_id=? AND state='reserved' AND expires_at>? ORDER BY created_at DESC LIMIT 20`,
      ).bind(userId, Date.now()).all<{ id: string; run_id: string; created_at: number }>();
      for (const row of archives.results) {
        if (type && type !== "archive") continue;
        items.push({
          id: row.id,
          kind: "run-deliverable",
          title: `Run ${row.run_id}`,
          mime: "application/zip",
          downloadPath: `/api/run-output-archives/${row.id}`,
          createdAt: row.created_at,
          runId: row.run_id,
        });
      }
    }
    if (env.AGENT_AUDIT && type !== "archive") {
      const files = await env.AGENT_AUDIT.prepare(
        `SELECT f.id, f.name, f.mime, f.size, f.updated_at, f.r2_key, m.kind AS media_kind, m.mode, m.model, m.prompt, m.aspect_ratio, m.width, m.height, m.duration_seconds, m.source_file_ids
         FROM files f LEFT JOIN media_generations m ON m.file_id=f.id AND m.workspace_id=f.workspace_id
         WHERE f.workspace_id=? AND f.archived_at IS NULL AND (f.mime LIKE 'image/%' OR f.mime='video/mp4' OR (${GENERATED_DOCUMENT_SQL})) AND (f.scope='workspace' OR f.created_by=?)
         AND (? IS NULL OR ?='output' OR (?='image' AND f.mime LIKE 'image/%') OR (?='video' AND f.mime='video/mp4') OR (?='document' AND ${GENERATED_DOCUMENT_SQL})) ORDER BY f.updated_at DESC LIMIT 40`,
      ).bind(workspaceId, userId, type, type, type, type, type).all<{ id: string; name: string; mime: string; size: number; updated_at: number; r2_key: string; media_kind: "image" | "video" | null; mode: string; model: string; prompt: string; aspect_ratio: string; width: number | null; height: number | null; duration_seconds: number | null; source_file_ids: string }>();
      for (const row of files.results) {
        items.push({
          id: row.id,
          kind: "output",
          title: row.name,
          mime: row.mime,
          bytes: row.size,
          downloadPath: `/api/files/${row.id}/download`,
          createdAt: row.updated_at,
          ...(row.r2_key.startsWith(GENERATED_DOCUMENT_PREFIX) && (row.mime === "text/markdown" || row.mime === "text/html") ? { documentKind: row.mime === "text/html" ? "page" as const : "report" as const } : {}),
          ...(row.media_kind ? { media: { kind: row.media_kind, mode: row.mode, model: row.model, label: imageModels.find((model) => model.id === row.model)?.label ?? "Video studio", prompt: row.prompt, aspectRatio: row.aspect_ratio,
            width: row.width ?? undefined, height: row.height ?? undefined, durationSeconds: row.duration_seconds ?? undefined, sourceIds: JSON.parse(row.source_file_ids) as string[] } } : {}),
        });
      }
    }
    return json({ items: items.sort((a, b) => b.createdAt - a.createdAt) });
  }

  const downloadMatch = /^\/api\/outputs\/([^/]+)\/download$/.exec(url.pathname);
  if (downloadMatch && request.method === "GET") {
    const key = `outputs/${workspaceId}/${downloadMatch[1]}`;
    const object = await filesBucket(env).get(key);
    if (!object) return json({ error: "Output not found." }, 404);
    return new Response(object.body, { headers: { "Cache-Control": "private, no-store" } });
  }

  return json({ error: "Method not allowed." }, 405);
}