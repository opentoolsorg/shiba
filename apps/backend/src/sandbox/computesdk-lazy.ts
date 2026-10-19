import { createComputesdkSandboxProvider } from "@shiba/sandbox/adapters/computesdk";
import { capabilitiesForComputesdkBackend } from "@shiba/sandbox/adapters/computesdk-capabilities";
import { loadComputesdkClient, isComputesdkHostRuntime } from "@shiba/sandbox/adapters/computesdk-load";
import { SandboxError, type SandboxProvider } from "@shiba/sandbox";
import type { Env } from "../env.js";

/** Loads a fully wired ComputeSDK provider on Node/Bun hosts. */
export async function buildComputesdkHostLoader(env: Env): Promise<SandboxProvider> {
  if (!(await isComputesdkHostRuntime())) {
    throw new SandboxError(
      "provider_misconfigured",
      "SHIBA_SANDBOX_PROVIDER=computesdk cannot run inside the Cloudflare Worker isolate. " +
        "Use SHIBA_SANDBOX_PROVIDER=cloudflare (default), docker-local on a trusted host, or run ComputeSDK from a Node/Bun control plane.",
      { provider: "computesdk" },
    );
  }
  const backend = env.SHIBA_COMPUTESDK_PROVIDER?.trim().toLowerCase() ?? "";
  const client = await loadComputesdkClient({
    SHIBA_COMPUTESDK_PROVIDER: env.SHIBA_COMPUTESDK_PROVIDER,
    E2B_API_KEY: env.E2B_API_KEY,
    MODAL_TOKEN_ID: env.MODAL_TOKEN_ID,
    MODAL_TOKEN_SECRET: env.MODAL_TOKEN_SECRET,
    DAYTONA_API_KEY: env.DAYTONA_API_KEY,
    VERCEL_TOKEN: env.VERCEL_TOKEN,
    VERCEL_OIDC_TOKEN: env.VERCEL_OIDC_TOKEN,
    CLOUDFLARE_SANDBOX_URL: env.CLOUDFLARE_SANDBOX_URL,
    CLOUDFLARE_SANDBOX_API_KEY: env.CLOUDFLARE_SANDBOX_API_KEY,
  });
  const timeoutMs = env.SHIBA_SANDBOX_TIMEOUT_MS
    ? Number.parseInt(env.SHIBA_SANDBOX_TIMEOUT_MS, 10)
    : undefined;
  return createComputesdkSandboxProvider({
    client,
    capabilities: capabilitiesForComputesdkBackend(backend),
    defaultTimeoutMs: timeoutMs,
  });
}
