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
} from "@shiba/sandbox";
import type { Env } from "../env.js";
import { getSandbox, type SandboxRpcFacade } from "./client.js";
import { buildComputesdkHostLoader } from "./computesdk-lazy.js";
import "./custom-providers.js";

registerBuiltinSandboxProviders();

let cachedProvider: SandboxProvider | undefined;

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

export function resolveSandboxProvider(env: Env): SandboxProvider {
  if (cachedProvider) return cachedProvider;
  const id = parseSandboxProviderId(env.SHIBA_SANDBOX_PROVIDER);
  const config = parseSandboxProviderConfig(sandboxEnvSlice(env), id);
  const allowUnenforcedEgress = truthyFlag(env.SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS);

  const provider = createSandboxProviderFromRegistrySync(id, {
    config,
    env: sandboxEnvSlice(env),
    host: {
      cloudflareResolveRpc: (instanceId) => getSandbox(env.Sandbox, instanceId) as SandboxRpcFacade,
      computesdkLoadProvider: id === "computesdk" ? () => buildComputesdkHostLoader(env) : undefined,
    },
  });

  assertProviderAllowed(provider, { allowUnenforcedEgress });
  cachedProvider = provider;
  return provider;
}

/** Test hook — reset cached provider between cases. */
export function resetSandboxProviderCache(): void {
  cachedProvider = undefined;
}

export async function getSandboxInstance(env: Env, sandboxId: string): Promise<SandboxInstance> {
  return resolveSandboxProvider(env).get(sandboxId);
}

export async function destroySandboxInstance(env: Env, sandboxId: string): Promise<void> {
  await resolveSandboxProvider(env).destroy(sandboxId);
}
