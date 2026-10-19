/**
 * Resolves the configured @shiba/sandbox provider for this Worker deployment.
 */
import {
  assertProviderAllowed,
  parseSandboxProviderId,
  type SandboxInstance,
  type SandboxProvider,
} from "@shiba/sandbox";
import { createCloudflareSandboxProvider } from "@shiba/sandbox/adapters/cloudflare";
import { createDockerLocalSandboxProvider } from "@shiba/sandbox/adapters/docker-local";
import type { Env } from "../env.js";
import { getSandbox, type SandboxRpcFacade } from "./client.js";

let cachedProvider: SandboxProvider | undefined;

function truthyFlag(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function resolveSandboxProvider(env: Env): SandboxProvider {
  if (cachedProvider) return cachedProvider;
  const id = parseSandboxProviderId(env.SHIBA_SANDBOX_PROVIDER);
  const allowUnenforcedEgress = truthyFlag(env.SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS);
  let provider: SandboxProvider;
  switch (id) {
    case "cloudflare":
      provider = createCloudflareSandboxProvider({
        resolveRpc: (instanceId) => getSandbox(env.Sandbox, instanceId) as SandboxRpcFacade,
      });
      break;
    case "docker-local":
      provider = createDockerLocalSandboxProvider({
        image: env.SHIBA_DOCKER_SANDBOX_IMAGE?.trim() || "shiba-sandbox:local",
        previewHost: env.SHIBA_DOCKER_PREVIEW_HOST?.trim() || "127.0.0.1",
      });
      break;
    default:
      throw new Error(`Sandbox provider ${id} is not wired in this Worker build.`);
  }
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
