import type { Env } from "../env.js";

export interface MediaGeneration {
  kind: "image" | "video"; mode: string; model: string; prompt: string;
  aspectRatio: string; width?: number; height?: number; durationSeconds?: number;
  sourceIds: string[]; runId?: string;
}

export async function insertMediaGeneration(env: Pick<Env, "AGENT_AUDIT">, fileId: string, workspaceId: string, userId: string, media: MediaGeneration): Promise<void> {
  await env.AGENT_AUDIT.prepare(`INSERT INTO media_generations
    (file_id, workspace_id, created_by, kind, mode, model, prompt, aspect_ratio, width, height, duration_seconds, source_file_ids, run_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(fileId, workspaceId, userId, media.kind, media.mode, media.model, media.prompt,
    media.aspectRatio, media.width ?? null, media.height ?? null, media.durationSeconds ?? null,
    JSON.stringify(media.sourceIds), media.runId ?? null, Date.now()).run();
}
