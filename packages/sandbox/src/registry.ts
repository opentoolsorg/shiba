import { SandboxError } from "./errors.js";
import type { SandboxHostDeps } from "./host-deps.js";
import type { ParsedSandboxProviderConfig } from "./options.js";
import type { SandboxProvider } from "./types.js";

export interface SandboxProviderFactoryContext {
  config: ParsedSandboxProviderConfig;
  /** Credential env slice — adapters read keys; never log values. */
  env: Record<string, string | undefined>;
  host?: SandboxHostDeps;
}

export type SandboxProviderFactory = (
  ctx: SandboxProviderFactoryContext,
) => SandboxProvider | Promise<SandboxProvider>;

const factories = new Map<string, SandboxProviderFactory>();

/**
 * Register a sandbox provider factory. Names are case-insensitive.
 * Built-in adapters call this at module load; self-hosters can register custom ids.
 */
export function registerSandboxProvider(name: string, factory: SandboxProviderFactory): void {
  const id = name.trim().toLowerCase();
  if (!id) {
    throw new SandboxError("provider_misconfigured", "registerSandboxProvider: name must be non-empty.", {
      provider: "registry",
    });
  }
  factories.set(id, factory);
}

export function unregisterSandboxProvider(name: string): void {
  factories.delete(name.trim().toLowerCase());
}

export function listRegisteredSandboxProviders(): string[] {
  return [...factories.keys()].sort();
}

export function getSandboxProviderFactory(name: string): SandboxProviderFactory {
  const id = name.trim().toLowerCase();
  const factory = factories.get(id);
  if (!factory) {
    throw new SandboxError(
      "provider_misconfigured",
      `Unknown sandbox provider "${name}". Registered: ${listRegisteredSandboxProviders().join(", ") || "(none)"}.`,
      { provider: "registry" },
    );
  }
  return factory;
}

export async function createSandboxProviderFromRegistry(
  name: string,
  ctx: SandboxProviderFactoryContext,
): Promise<SandboxProvider> {
  const factory = getSandboxProviderFactory(name);
  return factory(ctx);
}

export function createSandboxProviderFromRegistrySync(
  name: string,
  ctx: SandboxProviderFactoryContext,
): SandboxProvider {
  const result = getSandboxProviderFactory(name)(ctx);
  if (result instanceof Promise) {
    throw new SandboxError(
      "provider_misconfigured",
      `Sandbox provider "${name}" factory returned a Promise; use a lazy wrapper or async bootstrap.`,
      { provider: name },
    );
  }
  return result;
}

/** Test hook — clear custom registrations (built-ins re-registered on next import). */
export function clearSandboxProviderRegistry(): void {
  factories.clear();
}
