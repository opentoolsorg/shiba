import { Buffer } from "node:buffer";
import type { Env } from "./env.js";
import { insertFileRecord } from "./files/files-store.js";
import { decodeScreenPng } from "./screen-control.js";

export async function saveRunComputerScreenshot(
  env: Env,
  input: { screenshotBase64: string; runId: string; userId: string; workspaceId: string },
): Promise<{ artifactId: string; downloadPath: string; bytes: number }> {
  const bucket = env.FILES ?? env.ARTIFACTS;
  if (!bucket || !env.AGENT_AUDIT) throw new Error("Private output storage is unavailable.");
  const png = decodeScreenPng(input.screenshotBase64);
  if (!png) throw new Error("The desktop screenshot was incomplete or too large.");
  const key = `files/${encodeURIComponent(input.workspaceId)}/computer-${crypto.randomUUID()}.png`;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", png));
  await bucket.put(key, png, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { kind: "output", runId: input.runId },
  });
  try {
    const file = await insertFileRecord(env, {
      workspaceId: input.workspaceId, scope: "personal", createdBy: input.userId, name: "Cloud computer screenshot.png",
      mime: "image/png", size: png.byteLength, r2Key: key, sha256: Buffer.from(hash).toString("hex"), ingestionState: "done",
    });
    return { artifactId: file.id, downloadPath: `/api/files/${file.id}/download`, bytes: png.byteLength };
  } catch (error) {
    await env.AGENT_AUDIT.prepare("DELETE FROM files WHERE r2_key=? AND created_by=?")
      .bind(key, input.userId).run().catch(() => undefined);
    await bucket.delete(key).catch(() => undefined);
    throw error;
  }
}

export async function readRunComputerScreenshot(
  env: Env,
  input: { artifactId: string; runId: string; userId: string; workspaceId: string },
): Promise<string | null> {
  const bucket = env.FILES ?? env.ARTIFACTS;
  if (!bucket || !env.AGENT_AUDIT) return null;
  const file = await env.AGENT_AUDIT.prepare(
    "SELECT r2_key FROM files WHERE id=? AND workspace_id=? AND scope='personal' AND created_by=? AND archived_at IS NULL",
  ).bind(input.artifactId, input.workspaceId, input.userId).first<{ r2_key: string }>();
  if (!file?.r2_key.startsWith(`files/${encodeURIComponent(input.workspaceId)}/computer-`)) return null;
  const object = await bucket.get(file.r2_key);
  if (!object || object.customMetadata?.runId !== input.runId || object.size > 375_000) return null;
  return Buffer.from(await object.arrayBuffer()).toString("base64");
}
