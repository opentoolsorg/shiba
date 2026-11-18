import type { Env } from "../env.js";
import { insertFileRecord } from "../files/files-store.js";
import { FLUX_MODEL, imageModels, imageDimensions, imageInputSchema } from "./image-models.js";
import { insertMediaGeneration } from "./media-store.js";

export interface GeneratedImageResult {
  ok: boolean;
  key?: string;
  url?: string | null;
  bytes?: number;
  error?: string;
  artifactId?: string;
  downloadPath?: string;
}

export async function generateImage(
  env: Pick<Env, "AI" | "ARTIFACTS" | "FILES" | "WORKER_HOSTNAME"> & Partial<Pick<Env, "AGENT_AUDIT">>,
  input: { prompt: string; model?: string; aspectRatio?: string; aspect?: "square" | "landscape" | "portrait"; runId: string; userId?: string; workspaceId?: string },
): Promise<GeneratedImageResult> {
  const parsed = imageInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Use a prompt of 1–2000 characters and a supported image shape." };
  const { prompt } = parsed.data;
  const aspectRatio = parsed.data.aspectRatio ?? ({ square: "1:1", landscape: "16:9", portrait: "9:16" } as const)[parsed.data.aspect ?? "square"];
  const model = imageModels.find((item) => item.id === (input.model ?? (aspectRatio === "1:1" ? FLUX_MODEL : imageModels[1].id)));
  if (!model) return { ok: false, error: "Choose an available image style." };
  if (!model.supportsDimensions && aspectRatio !== "1:1") return { ok: false, error: "Flux Schnell only makes square images. Choose another style for this shape." };
  const bucket = env.FILES ?? env.ARTIFACTS;
  if (!bucket) return { ok: false, error: "Output storage is not configured." };
  if (input.userId && input.workspaceId && !env.AGENT_AUDIT) return { ok: false, error: "Image storage is temporarily unavailable." };
  try {
    const dimensions = imageDimensions[aspectRatio];
    const response: unknown = await env.AI.run(model.id, { prompt, ...(model.supportsDimensions ? dimensions : {}) });
    let binary: Uint8Array;
    if (response && typeof response === "object" && "image" in response && typeof response.image === "string") binary = Uint8Array.from(atob(response.image), (c) => c.charCodeAt(0));
    else if (response instanceof ReadableStream) binary = new Uint8Array(await new Response(response).arrayBuffer());
    else if (response instanceof ArrayBuffer) binary = new Uint8Array(response);
    else if (response instanceof Uint8Array) binary = response;
    else return { ok: false, error: "Image model returned no image." };
    if (!binary.byteLength) return { ok: false, error: "Image model returned no image." };
    const owned = !!(input.userId && input.workspaceId && env.AGENT_AUDIT);
    const mime = binary[0] === 137 && binary[1] === 80 && binary[2] === 78 && binary[3] === 71 ? "image/png" : model.mime;
    const extension = mime === "image/png" ? "png" : "jpg";
    const key = owned ? `files/${encodeURIComponent(input.workspaceId!)}/${crypto.randomUUID()}.${extension}` : `outputs/${encodeURIComponent(input.runId)}/generated-${crypto.randomUUID()}.${extension}`;
    await bucket.put(key, binary, {
      httpMetadata: { contentType: mime },
      customMetadata: { kind: "output", runId: input.runId },
    });
    try {
      if (owned) {
        const storeEnv = env as Env;
        const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(binary));
        const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const file = await insertFileRecord(storeEnv, { workspaceId: input.workspaceId!, scope: "personal", name: `Generated image.${extension}`, mime, size: binary.byteLength, r2Key: key, sha256, createdBy: input.userId!, ingestionState: "done" });
        await insertMediaGeneration(storeEnv, file.id, input.workspaceId!, input.userId!, { kind: "image", mode: "text-to-image", model: model.id, prompt, aspectRatio, ...(model.supportsDimensions ? dimensions : {}), sourceIds: [], runId: input.runId });
        return { ok: true, artifactId: file.id, downloadPath: `/api/files/${file.id}/download`, key, url: null, bytes: binary.byteLength };
      }
      return { ok: true, key, url: null, bytes: binary.byteLength };
    } catch (error) {
      await env.AGENT_AUDIT!.prepare("DELETE FROM media_generations WHERE file_id IN (SELECT id FROM files WHERE r2_key=? AND created_by=?)").bind(key, input.userId).run();
      await env.AGENT_AUDIT!.prepare("DELETE FROM files WHERE r2_key=? AND created_by=?").bind(key, input.userId).run();
      await bucket.delete(key);
      throw error;
    }
  } catch {
    return { ok: false, error: "Your image could not be created or saved. Please try again." };
  }
}