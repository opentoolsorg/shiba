import { z } from "zod";
import type { Env } from "../env.js";
import { readUserProviderSecret } from "../user-provider-keys.js";
import { getFile, insertFileRecord } from "../files/files-store.js";
import { filesBucket } from "../knowledge/knowledge-ingestion.js";
import { insertMediaGeneration } from "./media-store.js";

export const videoModes = ["text-to-video", "image-to-video", "reference-to-video", "motion-control", "video-editing"] as const;
const artifactIdSchema = z.string().regex(/^file_[a-f0-9]{24}$/);

const videoFields = z.object({
  prompt: z.string().trim().min(1).max(2000),
  mode: z.enum(videoModes).optional(),
  sourceImageArtifactId: artifactIdSchema.optional(),
  referenceImageArtifactIds: z.array(artifactIdSchema).min(1).max(3).optional(),
  referenceVideoArtifactId: artifactIdSchema.optional(),
  sourceVideoArtifactId: artifactIdSchema.optional(),
  duration: z.number().int().min(3).max(8).default(8),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
});
export const videoInputSchema = videoFields.superRefine((input, ctx) => {
  if (!validVideoSources(input)) ctx.addIssue({ code: "custom", message: "Choose only the source artifacts required by this video mode." });
});
export type VideoInput = z.infer<typeof videoFields>;
export type VideoMode = typeof videoModes[number];
export function videoMode(input: VideoInput): VideoMode { return input.mode ?? (input.sourceImageArtifactId ? "image-to-video" : "text-to-video"); }
export function validVideoSources(input: VideoInput): boolean {
  const actual = [!!input.sourceImageArtifactId, !!input.referenceImageArtifactIds, !!input.referenceVideoArtifactId, !!input.sourceVideoArtifactId];
  const expected: Record<VideoMode, boolean[]> = {
    "text-to-video": [false, false, false, false], "image-to-video": [true, false, false, false],
    "reference-to-video": [false, true, false, false], "motion-control": [true, false, true, false],
    "video-editing": [false, false, false, true],
  };
  return actual.every((value, index) => value === expected[videoMode(input)][index]);
}
export interface VideoSource { data: string; mime: string }
export interface VideoSources { references?: VideoSource[]; video?: VideoSource }
export type VideoJob = { status: "pending" } | { status: "failed" } | { status: "completed"; mp4: Uint8Array };
export interface VideoGenerationBackend {
  supportedModes?: readonly VideoMode[];
  start(input: VideoInput, image?: VideoSource, sources?: VideoSources): Promise<string>;
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
  readonly supportedModes = videoModes;
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
  async start(input: VideoInput, image?: VideoSource, sources?: VideoSources): Promise<string> {
    const parts: Array<Record<string, string>> = [];
    if (image) parts.push({ type: "image", data: image.data, mime_type: image.mime });
    for (const reference of sources?.references ?? []) parts.push({ type: "image", data: reference.data, mime_type: reference.mime });
    if (sources?.video) parts.push({ type: "video", data: sources.video.data, mime_type: sources.video.mime });
    const instruction = videoMode(input) === "reference-to-video" ? "Keep the character or subject in the reference images. " : videoMode(input) === "motion-control" ? "Animate the source image by copying the motion of the reference video. " : videoMode(input) === "video-editing" ? "Edit the source video: " : "";
    const result = await this.json(API, {
      model: "gemini-omni-1.2-flash",
      input: parts.length ? [...parts, { type: "text", text: instruction + input.prompt }] : input.prompt,
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
  if (!parsed.success) return { ok: false, error: "Use a prompt, a duration from 3 to 8 seconds, aspect ratio 16:9, 9:16 or 1:1, and only the sources required by this mode." };
  const capability = videoCapability(env);
  const bucket = env.ARTIFACTS;
  if (!capability.enabled || !bucket) return { ok: false, error: capability.reason ?? "Video storage is unavailable." };
  if (!context.userId) return { ok: false, error: "Video generation needs a signed-in owner." };
  let submitted = false;
  try {
    const key = options.backend ? null : await readUserProviderSecret(env, context.userId, "google");
    if (!options.backend && !key) return { ok: false, error: "Connect a Google API key in Settings → Providers." };
    const loadSource = async (id: string, video = false): Promise<VideoSource> => {
      const file = await getFile(env, id);
      const cap = video ? MAX_VIDEO_BYTES : 10 * 1024 * 1024;
      if (!file || file.archivedAt || file.workspaceId !== context.workspaceId || file.createdBy !== context.userId || !(video ? file.mime === "video/mp4" : ["image/png", "image/jpeg"].includes(file.mime)) || file.size > cap) {
        throw new Error(video ? "Source video must be your MP4 artifact (up to 50 MB)." : "Source image must be your PNG or JPEG artifact (up to 10 MB).");
      }
      const row = await env.AGENT_AUDIT.prepare("SELECT r2_key FROM files WHERE id=?").bind(file.id).first<{ r2_key: string }>();
      const object = row && await filesBucket(env).get(row.r2_key);
      if (!object || object.size > cap) throw new Error(video ? "Source video is unavailable." : "Source image is unavailable.");
      const bytes = new Uint8Array(await object.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { data: btoa(binary), mime: file.mime };
    };
    let image: VideoSource | undefined;
    const sources: VideoSources = {};
    try {
      if (parsed.data.sourceImageArtifactId) image = await loadSource(parsed.data.sourceImageArtifactId);
      if (parsed.data.referenceImageArtifactIds) sources.references = await Promise.all(parsed.data.referenceImageArtifactIds.map((id) => loadSource(id)));
      const videoId = parsed.data.referenceVideoArtifactId ?? parsed.data.sourceVideoArtifactId;
      if (videoId) sources.video = await loadSource(videoId, true);
    } catch (error) {
      return { ok: false, error: error instanceof Error && /^(Source image|Source video)/.test(error.message) ? error.message : "Source artifacts are unavailable." };
    }
    const backend = options.backend ?? new GoogleVideoBackend(key ?? "");
    if (!(backend.supportedModes ?? ["text-to-video", "image-to-video"]).includes(videoMode(parsed.data))) return { ok: false, error: "This video mode is not available with the configured provider." };
    submitted = true;
    const jobId = sources.references || sources.video ? await backend.start(parsed.data, image, sources) : await backend.start(parsed.data, image);
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
        await insertMediaGeneration(env, file.id, context.workspaceId, context.userId, { kind: "video", mode: videoMode(parsed.data), model: "gemini-omni-1.2-flash", prompt: parsed.data.prompt, aspectRatio: parsed.data.aspectRatio, durationSeconds: parsed.data.duration, sourceIds: [parsed.data.sourceImageArtifactId, ...(parsed.data.referenceImageArtifactIds ?? []), parsed.data.referenceVideoArtifactId, parsed.data.sourceVideoArtifactId].filter((id): id is string => !!id), runId: context.runId });
        return { ok: true, artifactId: file.id, key: storageKey, downloadPath: `/api/files/${file.id}/download`, mime: "video/mp4", bytes: bytes.byteLength };
      } catch (error) {
        // An insert may have succeeded before its read-back failed. Remove any
        // matching record first; if D1 is unavailable, retain the private bytes.
        await env.AGENT_AUDIT.prepare("DELETE FROM media_generations WHERE file_id IN (SELECT id FROM files WHERE r2_key=? AND created_by=?)").bind(storageKey, context.userId).run();
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
