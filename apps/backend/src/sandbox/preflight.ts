import {
  formatMissingSandboxFeatures,
  missingSandboxFeatures,
  type SandboxRunFeature,
} from "@shiba/shared";
import type { SandboxProvider } from "@shiba/sandbox";
import { SandboxError } from "@shiba/sandbox";
import type { Env } from "../env.js";
import { resolveSandboxProviderForId } from "./provider.js";
import { resolveSandboxSelection, type SandboxSelectionContext } from "./selection.js";

export const DEFAULT_CODING_RUN_FEATURES: SandboxRunFeature[] = ["exec", "files", "edgeEgress"];
export const PREVIEW_RUN_FEATURES: SandboxRunFeature[] = ["exec", "files", "portsPreview"];
export const OAUTH_SANDBOX_FEATURES: SandboxRunFeature[] = ["exec", "files"];

export function assertSandboxCapabilities(
  provider: SandboxProvider,
  required: readonly SandboxRunFeature[],
): void {
  const missing = missingSandboxFeatures(provider.capabilities, required);
  if (missing.length === 0) return;
  throw new SandboxError(
    "capability_unsupported",
    `Sandbox provider "${provider.id}" is missing required capabilities: ${formatMissingSandboxFeatures(missing)}.`,
    { provider: provider.id },
  );
}

export async function assertSandboxRunPreflight(
  env: Env,
  ctx: SandboxSelectionContext,
  required: readonly SandboxRunFeature[],
): Promise<{ provider: SandboxProvider; selection: Awaited<ReturnType<typeof resolveSandboxSelection>> }> {
  const selection = await resolveSandboxSelection(env, ctx);
  const provider = resolveSandboxProviderForId(env, selection.providerId);
  assertSandboxCapabilities(provider, required);
  return { provider, selection };
}
