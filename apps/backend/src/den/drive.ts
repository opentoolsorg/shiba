import { driveObjectKey, legacyCaptainDriveObjectKey } from "@shiba/shared";
import type { Env } from "../env.js";

export async function readDenDriveFile(
  env: Env,
  denAgentName: string,
  path: string,
): Promise<{ content: string; meta: { path: string; size: number; updatedAt: number } } | null> {
  const keys = [driveObjectKey(denAgentName, path), legacyCaptainDriveObjectKey(denAgentName, path)];
  for (const key of keys) {
    const object = await env.ATTACHMENTS?.get(key);
    if (!object) continue;
    const content = await object.text();
    return {
      content,
      meta: {
        path,
        size: content.length,
        updatedAt: object.uploaded?.getTime() ?? Date.now(),
      },
    };
  }
  return null;
}

export async function writeDenDriveFile(
  env: Env,
  denAgentName: string,
  path: string,
  content: string,
): Promise<{ path: string; size: number; updatedAt: number }> {
  const key = driveObjectKey(denAgentName, path);
  const now = Date.now();
  await env.ATTACHMENTS?.put(key, content, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  return { path, size: content.length, updatedAt: now };
}

/** @deprecated Use {@link readDenDriveFile}. */
export const readCaptainDriveFile = readDenDriveFile;

/** @deprecated Use {@link writeDenDriveFile}. */
export const writeCaptainDriveFile = writeDenDriveFile;
