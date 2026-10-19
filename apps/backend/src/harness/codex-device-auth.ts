/**
 * Codex `login --device-auth` fallback — auth.json stays on a per-user sandbox
 * volume only; the Worker never reads or stores it.
 */
import type { CodingTaskInput } from "../opencode-input.js";
import type { Env } from "../env.js";

export const CODEX_DEVICE_AUTH_HOSTS = ["chatgpt.com", "auth.openai.com"] as const;

export interface CodexDeviceAuthVolume {
  userId: string;
  hostPath: string;
  containerPath: string;
}

/** Stub until per-user persistent volumes ship (#119/#123). */
export function codexDeviceAuthVolumeForUser(userId: string): CodexDeviceAuthVolume | null {
  const trimmed = userId.trim();
  if (trimmed === "") return null;
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
  return {
    userId: trimmed,
    hostPath: `/var/shiba/codex-device-auth/${safe}`,
    containerPath: `/root/.shiba/codex/device-auth/${safe}`,
  };
}

export function codexDeviceAuthDeploymentEnabled(env: Pick<Env, "SHIBA_CODEX_DEVICE_AUTH">): boolean {
  return env.SHIBA_CODEX_DEVICE_AUTH === "1";
}

export function usesCodexDeviceAuth(input: Pick<CodingTaskInput, "codexAuthMode">): boolean {
  return input.codexAuthMode === "device-auth";
}

export function codexDeviceAuthHomeDir(input: Pick<CodingTaskInput, "initiatorUserId">): string {
  const userId = input.initiatorUserId ?? "";
  const mount = codexDeviceAuthVolumeForUser(userId);
  return mount?.containerPath ?? "/root/.shiba/codex/device-auth/unprovisioned";
}
