import { SandboxError } from "./errors.js";
import { listRegisteredSandboxProviders } from "./registry.js";
import type { ResolveSandboxProviderOptions, SandboxProvider, SandboxProviderId } from "./types.js";

export function parseSandboxProviderId(raw: string | undefined): SandboxProviderId {
  const id = (raw ?? "cloudflare").trim().toLowerCase();
  const registered = listRegisteredSandboxProviders();
  if (registered.includes(id)) return id;
  throw new SandboxError(
    "provider_misconfigured",
    `Unknown SHIBA_SANDBOX_PROVIDER "${raw}". Registered: ${registered.join(", ") || "(none — call registerBuiltinSandboxProviders())"}.`,
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
