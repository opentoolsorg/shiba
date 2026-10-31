import { parseIntegrationsProviderId, type IntegrationsProviderId } from "@shiba/shared";
import type { Env } from "../env.js";
import type { IntegrationProvider } from "./contracts.js";
import { ComposioIntegrationProvider } from "./composio-provider.js";
import { GrokbotBridgeIntegrationProvider } from "./grokbot-bridge-provider.js";
import { NoneIntegrationProvider } from "./none-provider.js";

let cached: { key: string; provider: IntegrationProvider } | null = null;

function configHash(env: Env, selected: IntegrationsProviderId): string {
  if (selected === "composio") {
    const hasKey = Boolean(env.COMPOSIO_API_KEY?.trim());
    const callback = env.INTEGRATIONS_CALLBACK_URI?.trim() ?? "";
    return `${selected}:${hasKey ? "key" : "no-key"}:${callback}`;
  }
  return selected;
}

export function getSelectedIntegrationsProviderId(env: Env): IntegrationsProviderId {
  return parseIntegrationsProviderId(env.INTEGRATIONS_PROVIDER);
}

export function getIntegrationProvider(env: Env): IntegrationProvider {
  const selected = getSelectedIntegrationsProviderId(env);
  const key = configHash(env, selected);
  if (cached?.key === key) return cached.provider;

  const provider: IntegrationProvider =
    selected === "none"
      ? new NoneIntegrationProvider()
      : selected === "grokbot"
        ? new GrokbotBridgeIntegrationProvider()
        : new ComposioIntegrationProvider({ env });

  cached = { key, provider };
  return provider;
}

/** Test helper — clears module cache between cases. */
export function resetIntegrationProviderCacheForTests(): void {
  cached = null;
}
