import {
  listRegisteredSandboxProviders,
  parseSandboxProviderId,
  type SandboxProvider,
} from "@shiba/sandbox";
import { sandboxFeatureMatrix, type SandboxFeatureMatrix } from "@shiba/shared";
import type { Env } from "../env.js";
import { resolveSandboxProviderForId } from "./provider.js";

export interface SandboxProviderCatalogEntry {
  id: string;
  label: string;
  configured: boolean;
  matrix: SandboxFeatureMatrix;
  detail?: string;
}

const LABELS: Record<string, string> = {
  cloudflare: "Cloudflare (default)",
  "docker-local": "Docker (local)",
  computesdk: "ComputeSDK (+ underlying provider)",
  e2b: "E2B (stub / mock)",
};

function labelFor(id: string): string {
  return LABELS[id] ?? `Custom (${id})`;
}

function tryResolveProvider(env: Env, id: string): { provider: SandboxProvider } | { error: string } {
  try {
    const providerId = parseSandboxProviderId(id);
    const provider = resolveSandboxProviderForId(env, providerId);
    return { provider };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Operator-facing provider list with capability matrix (no secrets). */
export function listSandboxProviderCatalog(env: Env): SandboxProviderCatalogEntry[] {
  const ids = [...new Set(listRegisteredSandboxProviders())].sort();
  const entries: SandboxProviderCatalogEntry[] = [];
  for (const id of ids) {
    const resolved = tryResolveProvider(env, id);
    if ("error" in resolved) {
      entries.push({
        id,
        label: labelFor(id),
        configured: false,
        matrix: sandboxFeatureMatrix({
          edgeEgressEnforcement: false,
          previewUrls: false,
          snapshots: false,
          backgroundProcesses: false,
        }),
        detail: resolved.error,
      });
      continue;
    }
    const { provider } = resolved;
    let detail: string | undefined;
    if (id === "computesdk") {
      const backend = env.SHIBA_COMPUTESDK_PROVIDER?.trim() || "e2b";
      const runner = env.SHIBA_COMPUTESDK_RUNNER_URL?.trim();
      detail = runner
        ? `Remote runner; backend=${backend}`
        : `In-process backend=${backend} (Node/Bun host only)`;
    }
    entries.push({
      id: provider.id,
      label: labelFor(provider.id),
      configured: true,
      matrix: sandboxFeatureMatrix(provider.capabilities),
      ...(detail ? { detail } : {}),
    });
  }
  return entries;
}
