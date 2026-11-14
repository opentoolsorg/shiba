import type { Env } from "../env.js";
import { redactSecrets } from "../security.js";

export const FLUX_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export interface GeneratedImageResult {
  ok: boolean;
  key?: string;
  url?: string | null;
  bytes?: number;
  error?: string;
}

export async function generateImage(
  env: Pick<Env, "AI" | "ARTIFACTS" | "FILES" | "WORKER_HOSTNAME">,
  input: { prompt: string; aspect?: "square" | "landscape" | "portrait"; runId: string },
): Promise<GeneratedImageResult> {
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 2000) {
    return { ok: false, error: "Prompt must be non-empty and at most 2000 characters." };
  }
  const bucket = env.FILES ?? env.ARTIFACTS;
  if (!bucket) return { ok: false, error: "Output storage is not configured." };
  try {
    const response = await env.AI.run(FLUX_MODEL, { prompt });
    const image = (response as { image?: string }).image;
    if (!image || typeof image !== "string") return { ok: false, error: "Image model returned no image." };
    const binary = Uint8Array.from(atob(image), (c) => c.charCodeAt(0));
    const key = `outputs/${encodeURIComponent(input.runId)}/generated-${Date.now()}.png`;
    await bucket.put(key, binary, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { kind: "output", runId: input.runId },
    });
    return { ok: true, key, url: null, bytes: binary.byteLength };
  } catch (error) {
    return { ok: false, error: redactSecrets(error instanceof Error ? error.message : String(error)) };
  }
}