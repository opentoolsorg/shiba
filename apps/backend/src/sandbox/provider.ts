/**
 * Resolves the configured @shiba/sandbox provider for this Worker deployment.
 */
import {
  assertProviderAllowed,
  createSandboxProviderFromRegistrySync,
  parseSandboxProviderConfig,
  parseSandboxProviderId,
  registerBuiltinSandboxProviders,
  type SandboxInstance,
  type SandboxProvider,
  type SandboxProviderId,
} from "@shiba/sandbox";
import { createComputesdkRemoteSandboxProvider } from "@shiba/sandbox/adapters/computesdk-remote";
import type { Env } from "../env.js";
import { getSandbox, type SandboxRpcFacade } from "./client.js";
import { buildComputesdkHostLoader } from "./computesdk-lazy.js";
import { resolveSandboxSelection, type SandboxSelectionContext } from "./selection.js";
import "./custom-providers.js";

registerBuiltinSandboxProviders();

const providerCache = new Map<string, SandboxProvider>();

function truthyFlag(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function sandboxEnvSlice(env: Env): Record<string, string | undefined> {
  return {
    SHIBA_SANDBOX_PROVIDER: env.SHIBA_SANDBOX_PROVIDER,
    SHIBA_SANDBOX_TIMEOUT_MS: env.SHIBA_SANDBOX_TIMEOUT_MS,
    SHIBA_SANDBOX_REGION: env.SHIBA_SANDBOX_REGION,
    SHIBA_SANDBOX_EGRESS_ALLOWLIST: env.SHIBA_SANDBOX_EGRESS_ALLOWLIST,
    SHIBA_SANDBOX_ENV_PASSTHROUGH: env.SHIBA_SANDBOX_ENV_PASSTHROUGH,
    INSTANCE_TYPE: env.INSTANCE_TYPE,
    SHIBA_DOCKER_SANDBOX_IMAGE: env.SHIBA_DOCKER_SANDBOX_IMAGE,
    SHIBA_DOCKER_PREVIEW_HOST: env.SHIBA_DOCKER_PREVIEW_HOST,
    SHIBA_COMPUTESDK_PROVIDER: env.SHIBA_COMPUTESDK_PROVIDER,
    SHIBA_E2B_MOCK: env.SHIBA_E2B_MOCK,
    E2B_API_KEY: env.E2B_API_KEY,
    MODAL_TOKEN_ID: env.MODAL_TOKEN_ID,
    MODAL_TOKEN_SECRET: env.MODAL_TOKEN_SECRET,
    DAYTONA_API_KEY: env.DAYTONA_API_KEY,
    VERCEL_TOKEN: env.VERCEL_TOKEN,
    VERCEL_OIDC_TOKEN: env.VERCEL_OIDC_TOKEN,
    CLOUDFLARE_SANDBOX_URL: env.CLOUDFLARE_SANDBOX_URL,
    CLOUDFLARE_SANDBOX_API_KEY: env.CLOUDFLARE_SANDBOX_API_KEY,
  };
}

function buildProvider(env: Env, id: SandboxProviderId): SandboxProvider {
  const cached = providerCache.get(id);
  if (cached) return cached;

  const config = parseSandboxProviderConfig({ ...sandboxEnvSlice(env), SHIBA_SANDBOX_PROVIDER: id }, id);
  const allowUnenforcedEgress = truthyFlag(env.SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS);

  const runnerUrl = env.SHIBA_COMPUTESDK_RUNNER_URL?.trim();
  const runnerToken = env.SHIBA_COMPUTESDK_RUNNER_TOKEN?.trim();
  const computesdkRemoteClient =
    id === "computesdk" && runnerUrl && runnerToken
      ? createComputesdkRemoteSandboxProvider({
          baseUrl: runnerUrl,
          token: runnerToken,
          backendProvider: env.SHIBA_COMPUTESDK_PROVIDER?.trim().toLowerCase() || "e2b",
          defaultTimeoutMs: config.options.timeoutMs,
        })
      : undefined;

  const provider =
    computesdkRemoteClient ??
    createSandboxProviderFromRegistrySync(id, {
      config,
      env: sandboxEnvSlice(env),
      host: {
        cloudflareResolveRpc: (instanceId) => getSandbox(env.Sandbox, instanceId) as SandboxRpcFacade,
        computesdkLoadProvider: id === "computesdk" ? () => buildComputesdkHostLoader(env) : undefined,
      },
    });

  assertProviderAllowed(provider, { allowUnenforcedEgress });
  providerCache.set(id, provider);
  return provider;
}

/** Resolve one provider id (built-in or registered custom name). */
export function resolveSandboxProviderForId(env: Env, providerId: SandboxProviderId): SandboxProvider {
  return buildProvider(env, providerId);
}

/** @deprecated Prefer {@link resolveSandboxProviderForSelection}. */
export function resolveSandboxProvider(env: Env): SandboxProvider {
  const id = parseSandboxProviderId(env.SHIBA_SANDBOX_PROVIDER);
  return resolveSandboxProviderForId(env, id);
}

export async function resolveSandboxProviderForSelection(
  env: Env,
  ctx: SandboxSelectionContext = {},
): Promise<SandboxProvider> {
  const selection = await resolveSandboxSelection(env, ctx);
  return resolveSandboxProviderForId(env, selection.providerId);
}

/** Test hook — reset cached providers between cases. */
export function resetSandboxProviderCache(): void {
  providerCache.clear();
}

export async function getSandboxInstance(
  env: Env,
  sandboxId: string,
  ctx: SandboxSelectionContext = {},
): Promise<SandboxInstance> {
  const provider = await resolveSandboxProviderForSelection(env, ctx);
  return provider.get(sandboxId);
}

export async function destroySandboxInstance(
  env: Env,
  sandboxId: string,
  ctx: SandboxSelectionContext = {},
): Promise<void> {
  const provider = await resolveSandboxProviderForSelection(env, ctx);
  await provider.destroy(sandboxId);
}
