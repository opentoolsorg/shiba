import { z } from "zod";
import type { Env } from "../env.js";
import { readUserProviderSecret } from "../user-provider-keys.js";
import { getFile, insertFileRecord } from "../files/files-store.js";
import { filesBucket } from "../knowledge/knowledge-ingestion.js";

export const videoInputSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  sourceImageArtifactId: z.string().regex(/^file_[a-f0-9]{24}$/).optional(),
  duration: z.number().int().min(3).max(8).default(8),
  aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"),
});
export type VideoInput = z.infer<typeof videoInputSchema>;
export type VideoJob = { status: "pending" } | { status: "failed" } | { status: "completed"; mp4: Uint8Array };
export interface VideoGenerationBackend {
  start(input: VideoInput, image?: { data: string; mime: string }): Promise<string>;
  poll(jobId: string): Promise<VideoJob>;
}

export function videoCapability(env: Env): { enabled: boolean; reason: string | null } {
  if (env.SHIBA_VIDEO_GENERATION !== "1") return { enabled: false, reason: "Video generation is disabled. Set SHIBA_VIDEO_GENERATION=1." };
  if (env.SHIBA_VIDEO_BACKEND !== "google") return { enabled: false, reason: "No supported video backend is configured. Set SHIBA_VIDEO_BACKEND=google." };
  if (!env.ARTIFACTS || !env.AGENT_AUDIT || !env.AGENT_TOKENS || !env.MODEL_CREDENTIAL_KEY) return { enabled: false, reason: "Video storage or provider key storage is unavailable." };
  return { enabled: true, reason: null };
}

export async function videoCapabilityForUser(env: Env, userId?: string | null) {
  const capability = videoCapability(env);
  if (!capability.enabled) return capability;
  try {
    if (userId && await readUserProviderSecret(env, userId, "google")) return capability;
  } catch { return { enabled: false, reason: "Provider key storage is temporarily unavailable." }; }
  return { enabled: false, reason: "Connect a Google API key in Settings → Providers to generate videos." };
}

const API = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/** Google background video jobs; credentials remain inside the Worker. */
export class GoogleVideoBackend implements VideoGenerationBackend {
  constructor(private readonly key: string, private readonly request: typeof fetch = fetch) {}
  private async json(url: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.request(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-goog-api-key": this.key, "Content-Type": "application/json", "Api-Revision": "2026-05-20" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Video provider request failed.");
    return await response.json() as Record<string, unknown>;
  }
  async start(input: VideoInput, image?: { data: string; mime: string }): Promise<string> {
    const result = await this.json(API, {
      model: "gemini-omni-1.2-flash",
      input: image ? [{ type: "image", data: image.data, mime_type: image.mime }, { type: "text", text: input.prompt }] : input.prompt,
      response_format: { type: "video", duration: `${input.duration}s`, aspect_ratio: input.aspectRatio, resolution: "720p" },
      background: true,
    });
    if (typeof result.id !== "string" || !/^[A-Za-z0-9_-]{1,300}$/.test(result.id)) throw new Error("Video provider returned no job.");
    return result.id;
  }
  async poll(jobId: string): Promise<VideoJob> {
    const result = await this.json(`${API}/${encodeURIComponent(jobId)}`);
    if (result.status === "in_progress") return { status: "pending" };
    if (result.status !== "completed") return { status: "failed" };
    const steps = result.steps as Array<{ type?: string; content?: Array<{ type?: string; data?: string }> }> | undefined;
    const video = steps?.filter((step) => step.type === "model_output").flatMap((step) => step.content ?? []).find((part) => part.type === "video");
    if (!video?.data || video.data.length > MAX_VIDEO_BYTES * 4 / 3 + 4) return { status: "failed" };
    return { status: "completed", mp4: Uint8Array.from(atob(video.data), (char) => char.charCodeAt(0)) };
  }
}

export interface VideoContext { runId: string; userId: string; workspaceId: string }

/** Called only by the direct AI SDK tool after its human approval. */
export async function generateVideo(env: Env, raw: unknown, context: VideoContext, options: {
  backend?: VideoGenerationBackend; wait?: () => Promise<void>; maxPolls?: number;
} = {}): Promise<Record<string, unknown>> {
  const parsed = videoInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Use a prompt, a duration from 3 to 8 seconds, and aspect ratio 16:9 or 9:16." };
  const capability = videoCapability(env);
  const bucket = env.ARTIFACTS;
  if (!capability.enabled || !bucket) return { ok: false, error: capability.reason ?? "Video storage is unavailable." };
  if (!context.userId) return { ok: false, error: "Video generation needs a signed-in owner." };
  let submitted = false;
  try {
    const key = options.backend ? null : await readUserProviderSecret(env, context.userId, "google");
    if (!options.backend && !key) return { ok: false, error: "Connect a Google API key in Settings → Providers." };
    let image: { data: string; mime: string } | undefined;
    if (parsed.data.sourceImageArtifactId) {
      const file = await getFile(env, parsed.data.sourceImageArtifactId);
      if (!file || file.archivedAt || file.workspaceId !== context.workspaceId || file.createdBy !== context.userId || !["image/png", "image/jpeg"].includes(file.mime) || file.size > 10 * 1024 * 1024) {
        return { ok: false, error: "Source image must be your PNG or JPEG artifact (up to 10 MB)." };
      }
      const row = await env.AGENT_AUDIT.prepare("SELECT r2_key FROM files WHERE id=?").bind(file.id).first<{ r2_key: string }>();
      const object = row && await filesBucket(env).get(row.r2_key);
      if (!object || object.size > 10 * 1024 * 1024) return { ok: false, error: "Source image is unavailable." };
      const bytes = new Uint8Array(await object.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      image = { data: btoa(binary), mime: file.mime };
    }
    const backend = options.backend ?? new GoogleVideoBackend(key ?? "");
    submitted = true;
    const jobId = await backend.start(parsed.data, image);
    const wait = options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 10_000)));
    for (let attempt = 0; attempt < (options.maxPolls ?? 60); attempt++) {
      await wait();
      const result = await backend.poll(jobId);
      if (result.status === "failed") return { ok: false, error: "Video generation failed. Try another prompt." };
      if (result.status === "pending") continue;
      const bytes = new Uint8Array(result.mp4);
      if (bytes.byteLength < 12 || bytes.byteLength > MAX_VIDEO_BYTES || new TextDecoder().decode(bytes.subarray(4, 8)) !== "ftyp") {
        return { ok: false, error: "Video provider returned an invalid MP4." };
      }
      const storageKey = `outputs/videos/${crypto.randomUUID()}.mp4`;
      await bucket.put(storageKey, bytes, { httpMetadata: { contentType: "video/mp4" }, customMetadata: { kind: "output", runId: context.runId, ownerId: context.userId } });
      try {
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const file = await insertFileRecord(env, { workspaceId: context.workspaceId, scope: "personal", name: "Generated video.mp4", mime: "video/mp4", size: bytes.byteLength, r2Key: storageKey, sha256, createdBy: context.userId, ingestionState: "done" });
        return { ok: true, artifactId: file.id, key: storageKey, downloadPath: `/api/files/${file.id}/download`, mime: "video/mp4", bytes: bytes.byteLength };
      } catch (error) {
        // An insert may have succeeded before its read-back failed. Remove any
        // matching record first; if D1 is unavailable, retain the private bytes.
        await env.AGENT_AUDIT.prepare("DELETE FROM files WHERE r2_key=? AND created_by=?").bind(storageKey, context.userId).run();
        await bucket.delete(storageKey);
        throw error;
      }
    }
    return { ok: false, error: "Video generation timed out. The provider may still charge for this job; check your account before retrying." };
  } catch {
    return { ok: false, error: submitted
      ? "Video generation could not be completed or saved. The provider may have charged for this job; check your account before retrying."
      : "Video generation is unavailable. Check your provider connection." };
  }
}
