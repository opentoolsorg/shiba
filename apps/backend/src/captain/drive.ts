import { driveObjectKey } from "@shiba/shared";
import type { Env } from "../env.js";

export async function readCaptainDriveFile(
  env: Env,
  captainAgentName: string,
  path: string,
): Promise<{ content: string; meta: { size: number; updatedAt: number } } | null> {
  const key = driveObjectKey(captainAgentName, path);
  const object = await env.ATTACHMENTS.get(key);
  if (!object) return null;
  const content = await object.text();
  return {
    content,
    meta: {
      size: content.length,
      updatedAt: object.uploaded ? object.uploaded.getTime() : Date.now(),
    },
  };
}

export async function writeCaptainDriveFile(
  env: Env,
  captainAgentName: string,
  path: string,
  content: string,
): Promise<{ size: number; updatedAt: number }> {
  const key = driveObjectKey(captainAgentName, path);
  await env.ATTACHMENTS.put(key, content, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  return { size: content.length, updatedAt: Date.now() };
}
