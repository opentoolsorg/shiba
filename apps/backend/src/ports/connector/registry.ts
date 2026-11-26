import type { Env } from "../../env.js";
import { OpenConnectorIntegrationProvider } from "../../adapters/connector/openconnector/provider.js";
import { NoneConnectorProvider } from "../../adapters/connector/none/provider.js";
import type { ConnectorProvider } from "./provider.js";
import type { FetchImpl } from "./types.js";

export interface ConnectorDependencies {
  provider?: ConnectorProvider;
  fetchImpl?: FetchImpl;
}

/** Composition boundary: supply a port directly or select an adapter from configuration. */
export function createConnectorProvider(env: Env, dependencies: ConnectorDependencies = {}): ConnectorProvider {
  if (dependencies.provider) return dependencies.provider;
  const selected = env.CONNECTOR_PROVIDER?.trim().toLowerCase();
  if (selected && selected !== "openconnector") return new NoneConnectorProvider();
  // Preserve the existing default, including its unconfigured health response.
  return new OpenConnectorIntegrationProvider({ env, fetchImpl: dependencies.fetchImpl });
}

// Only a context key is shared. Each environment owns its injected provider.
let contextKey = Symbol("connector-context");
export function getIntegrationProvider(env: Env): ConnectorProvider {
  const context = env as Env & { [key: symbol]: ConnectorProvider | undefined };
  const key = contextKey;
  const existing = Object.hasOwn(context, key) ? context[key] : undefined;
  if (existing) return existing;
  const provider = createConnectorProvider(env);
  Object.defineProperty(context, key, { value: provider, configurable: true });
  return provider;
}

/** Compatibility helper: invalidate context keys without retaining provider instances. */
export function resetIntegrationProviderCacheForTests(): void {
  contextKey = Symbol("connector-context");
}
