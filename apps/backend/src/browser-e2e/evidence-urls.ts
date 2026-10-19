import type { Env } from "../env.js";

export const e2eManifestKey = (sandboxId: string): string => `e2e/${sandboxId}/manifest.json`;

export const e2eFrameKey = (sandboxId: string, name: string, index: number): string =>
  `e2e/${sandboxId}/frames/${String(index).padStart(3, "0")}-${name}.png`;

export function e2eManifestUrlFor(env: Env, sandboxId: string): string | null {
  const host = env.WORKER_HOSTNAME?.trim();
  if (!host) return null;
  return `https://${host}/api/e2e-evidence/${encodeURIComponent(sandboxId)}/manifest.json`;
}

export function e2eFrameUrlFor(env: Env, sandboxId: string, frameFileName: string): string | null {
  const host = env.WORKER_HOSTNAME?.trim();
  if (!host) return null;
  return `https://${host}/api/e2e-evidence/${encodeURIComponent(sandboxId)}/${encodeURIComponent(frameFileName)}`;
}
