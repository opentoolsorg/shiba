import type { Env } from "../env.js";
import { OpenConnectorIntegrationProvider } from "./openconnector-provider.js";

let cached: { env: Env; provider: OpenConnectorIntegrationProvider } | null = null;

export function getIntegrationProvider(env: Env): OpenConnectorIntegrationProvider {
  if (cached?.env === env) return cached.provider;
  const provider = new OpenConnectorIntegrationProvider({ env });
  cached = { env, provider };
  return provider;
}

/** Test helper — clears module cache between cases. */
export function resetIntegrationProviderCacheForTests(): void {
  cached = null;
}
