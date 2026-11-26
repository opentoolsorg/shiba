/**
 * Resolves the configured @shiba/sandbox provider for this Worker deployment.
 */
import {
  assertProviderAllowed,
  createSandboxProviderFromRegistrySync,
  parseSandboxProviderConfig,
  parseSandboxProviderId,
  SandboxError,
  registerBuiltinSandboxProviders,
  type SandboxInstance,
  type SandboxProvider,
  type SandboxProviderId,
  type SandboxHostDeps,
} from "@shiba/sandbox";
import { createComputesdkRemoteSandboxProvider, buildComputesdkHostLoader } from "../../adapters/sandbox/computesdk/index.js";
import type { Env } from "../../env.js";
import { getSandbox, type SandboxRpcFacade } from "./client.js";
import { resolveSandboxSelection, type SandboxSelectionContext } from "../../sandbox/selection.js";
import { getDecryptedOrgRunnerToken } from "../../org-sandbox-store.js";
import "../../sandbox/custom-providers.js";

registerBuiltinSandboxProviders();

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

/** A registry belongs to one execution context and can be injected into callers. */
export interface SandboxRegistry {
  resolveForId(providerId: SandboxProviderId): SandboxProvider;
  resolve(): SandboxProvider;
  resolveForSelection(ctx?: SandboxSelectionContext): Promise<SandboxProvider>;
  get(sandboxId: string, ctx?: SandboxSelectionContext): Promise<SandboxInstance>;
  destroy(sandboxId: string, ctx?: SandboxSelectionContext): Promise<void>;
}

export interface SandboxRegistryDependencies {
  createProvider?: typeof createSandboxProviderFromRegistrySync;
  createRemoteProvider?: typeof createComputesdkRemoteSandboxProvider;
  loadComputesdkProvider?: typeof buildComputesdkHostLoader;
  resolveRpc?: SandboxHostDeps["cloudflareResolveRpc"];
}

export function createSandboxRegistry(
  env: Env,
  deps: SandboxRegistryDependencies = {},
): SandboxRegistry {
  const providerCache = new Map<string, SandboxProvider>();
  function buildProvider(
    id: SandboxProviderId,
    cacheKey = id,
    remoteOverrides?: { runnerUrl?: string; runnerToken?: string; backendProvider?: string },
  ): SandboxProvider {
    const cached = providerCache.get(cacheKey);
    if (cached) return cached;

    // An org-supplied URL must never be paired with the deployment token.
    const orgRunnerUrl = remoteOverrides?.runnerUrl?.trim();
    const runnerUrl = orgRunnerUrl || env.SHIBA_COMPUTESDK_RUNNER_URL?.trim();
    const runnerToken = orgRunnerUrl
      ? remoteOverrides?.runnerToken?.trim()
      : env.SHIBA_COMPUTESDK_RUNNER_TOKEN?.trim();
    if (id === "computesdk" && orgRunnerUrl && !runnerToken) {
      throw new SandboxError(
        "provider_misconfigured",
        "Org sandbox runner token is missing or unreadable; save the runner token again.",
        { provider: "computesdk" },
      );
    }
    const backendProvider =
      remoteOverrides?.backendProvider?.trim().toLowerCase() ||
      env.SHIBA_COMPUTESDK_PROVIDER?.trim().toLowerCase() ||
      "e2b";

    const config = parseSandboxProviderConfig(
      {
        ...sandboxEnvSlice(env),
        SHIBA_SANDBOX_PROVIDER: id,
        ...(id === "computesdk" && backendProvider ? { SHIBA_COMPUTESDK_PROVIDER: backendProvider } : {}),
      },
      id,
    );
    const allowUnenforcedEgress = truthyFlag(env.SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS);

    const computesdkRemoteClient =
      id === "computesdk" && runnerUrl && runnerToken
        ? (deps.createRemoteProvider ?? createComputesdkRemoteSandboxProvider)({
            baseUrl: runnerUrl,
            token: runnerToken,
            backendProvider,
            defaultTimeoutMs: config.options.timeoutMs,
          })
        : undefined;

    const provider =
      computesdkRemoteClient ??
      (deps.createProvider ?? createSandboxProviderFromRegistrySync)(id, {
        config,
        env: sandboxEnvSlice(env),
        host: {
          cloudflareResolveRpc: deps.resolveRpc ?? ((instanceId) => getSandbox(env.Sandbox, instanceId) as SandboxRpcFacade),
          computesdkLoadProvider: id === "computesdk"
            ? () => (deps.loadComputesdkProvider ?? buildComputesdkHostLoader)(env)
            : undefined,
        },
      });

    assertProviderAllowed(provider, { allowUnenforcedEgress });
    providerCache.set(cacheKey, provider);
    return provider;
  }

  /** Resolve one provider id (built-in or registered custom name). */
  function resolveForId(providerId: SandboxProviderId): SandboxProvider {
    return buildProvider(providerId);
  }

  /** @deprecated Prefer {@link resolveSandboxProviderForSelection}. */
  function resolve(): SandboxProvider {
    const id = parseSandboxProviderId(env.SHIBA_SANDBOX_PROVIDER);
    return resolveForId(id);
  }

  async function resolveForSelection(
    ctx: SandboxSelectionContext = {},
  ): Promise<SandboxProvider> {
    const selection = await resolveSandboxSelection(env, ctx);
    if (selection.source === "org" && selection.providerId === "computesdk" && selection.orgSettings?.orgId) {
      const orgId = selection.orgSettings.orgId;
      const updatedAt = selection.orgSettings.updatedAt ?? 0;
      const cacheKey = `org:${orgId}:computesdk:${updatedAt}`;
      const cached = providerCache.get(cacheKey);
      if (cached) return cached;

      const orgPrefix = `org:${orgId}:computesdk:`;
      for (const key of providerCache.keys()) {
        if (key.startsWith(orgPrefix)) providerCache.delete(key);
      }

      const runnerUrl = selection.orgSettings.runnerUrl;
      const runnerToken = (await getDecryptedOrgRunnerToken(env, orgId)) ?? undefined;
      const backendProvider = selection.orgSettings.computesdkBackend;

      return buildProvider("computesdk", cacheKey, {
        runnerUrl,
        runnerToken,
        backendProvider,
      });
    }
    return resolveForId(selection.providerId);
  }

  async function get(
    sandboxId: string,
    ctx: SandboxSelectionContext = {},
  ): Promise<SandboxInstance> {
    const provider = await resolveForSelection(ctx);
    return provider.get(sandboxId);
  }

  async function destroy(
    sandboxId: string,
    ctx: SandboxSelectionContext = {},
  ): Promise<void> {
    const provider = await resolveForSelection(ctx);
    await provider.destroy(sandboxId);
  }

  return { resolveForId, resolve, resolveForSelection, get, destroy };
}

// Compatibility callers share a registry only within the same Worker env.
let registries = new WeakMap<Env, SandboxRegistry>();

export function sandboxRegistryFor(env: Env): SandboxRegistry {
  let registry = registries.get(env);
  if (!registry) {
    registry = createSandboxRegistry(env);
    registries.set(env, registry);
  }
  return registry;
}

export function resolveSandboxProviderForId(env: Env, providerId: SandboxProviderId): SandboxProvider {
  return sandboxRegistryFor(env).resolveForId(providerId);
}

/** @deprecated Prefer {@link resolveSandboxProviderForSelection}. */
export function resolveSandboxProvider(env: Env): SandboxProvider {
  return sandboxRegistryFor(env).resolve();
}

export function resolveSandboxProviderForSelection(
  env: Env,
  ctx: SandboxSelectionContext = {},
): Promise<SandboxProvider> {
  return sandboxRegistryFor(env).resolveForSelection(ctx);
}

/** Test hook — reset compatibility registries between cases. */
export function resetSandboxProviderCache(): void {
  registries = new WeakMap();
}

export function getSandboxInstance(
  env: Env,
  sandboxId: string,
  ctx: SandboxSelectionContext = {},
): Promise<SandboxInstance> {
  return sandboxRegistryFor(env).get(sandboxId, ctx);
}

export function destroySandboxInstance(
  env: Env,
  sandboxId: string,
  ctx: SandboxSelectionContext = {},
): Promise<void> {
  return sandboxRegistryFor(env).destroy(sandboxId, ctx);
}
