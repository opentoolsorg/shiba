import { SandboxError } from "./errors.js";
import type { SandboxProvider, SandboxProviderId, ResolveSandboxProviderOptions } from "./types.js";

const PROVIDER_IDS: SandboxProviderId[] = ["cloudflare", "docker-local", "e2b"];

export function parseSandboxProviderId(raw: string | undefined): SandboxProviderId {
  const id = (raw ?? "cloudflare").trim().toLowerCase();
  if (PROVIDER_IDS.includes(id as SandboxProviderId)) {
    return id as SandboxProviderId;
  }
  throw new SandboxError(
    "provider_misconfigured",
    `Unknown SHIBA_SANDBOX_PROVIDER "${raw}". Expected one of: ${PROVIDER_IDS.join(", ")}.`,
  );
}

/**
 * Enforces invariant: production must not run a provider without edge egress unless
 * the operator explicitly opts in (self-host dev on docker-local).
 */
export function assertProviderAllowed(
  provider: SandboxProvider,
  options: ResolveSandboxProviderOptions,
): void {
  if (provider.capabilities.edgeEgressEnforcement) return;
  if (options.allowUnenforcedEgress) return;
  throw new SandboxError(
    "provider_misconfigured",
    `Sandbox provider "${provider.id}" does not enforce egress at the edge. ` +
      `Set SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS=1 only on trusted single-box dev hosts.`,
    { provider: provider.id },
  );
}
