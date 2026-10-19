/**
 * Node/Bun-only ComputeSDK bootstrap (computesdk@4.1.12). Loaded lazily via dynamic
 * `import()` from a host control plane — never from the default Cloudflare Worker bundle path.
 */
import { SandboxError } from "../errors.js";
import { COMPUTESDK_PINNED_CORE_VERSION } from "./computesdk-capabilities.js";
import type { ComputesdkClient } from "./computesdk-types.js";

export interface ComputesdkLoadEnv {
  SHIBA_COMPUTESDK_PROVIDER?: string | undefined;
  E2B_API_KEY?: string | undefined;
  MODAL_TOKEN_ID?: string | undefined;
  MODAL_TOKEN_SECRET?: string | undefined;
  DAYTONA_API_KEY?: string | undefined;
  VERCEL_TOKEN?: string | undefined;
  VERCEL_OIDC_TOKEN?: string | undefined;
  CLOUDFLARE_SANDBOX_URL?: string | undefined;
  CLOUDFLARE_SANDBOX_API_KEY?: string | undefined;
}

const PACKAGE_BY_BACKEND: Record<string, string> = {
  e2b: "@computesdk/e2b",
  modal: "@computesdk/modal",
  daytona: "@computesdk/daytona",
  vercel: "@computesdk/vercel",
  cloudflare: "@computesdk/cloudflare",
};

function providerOptions(backend: string, env: ComputesdkLoadEnv): Record<string, string> {
  switch (backend) {
    case "e2b": {
      const apiKey = env.E2B_API_KEY?.trim();
      if (!apiKey) throw missingCred("E2B_API_KEY");
      return { apiKey };
    }
    case "modal": {
      const tokenId = env.MODAL_TOKEN_ID?.trim();
      const tokenSecret = env.MODAL_TOKEN_SECRET?.trim();
      if (!tokenId || !tokenSecret) throw missingCred("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET");
      return { tokenId, tokenSecret };
    }
    case "daytona": {
      const apiKey = env.DAYTONA_API_KEY?.trim();
      if (!apiKey) throw missingCred("DAYTONA_API_KEY");
      return { apiKey };
    }
    case "vercel": {
      const token = env.VERCEL_OIDC_TOKEN?.trim() || env.VERCEL_TOKEN?.trim();
      if (!token) throw missingCred("VERCEL_TOKEN or VERCEL_OIDC_TOKEN");
      return env.VERCEL_OIDC_TOKEN?.trim() ? { oidcToken: token } : { token };
    }
    case "cloudflare": {
      const url = env.CLOUDFLARE_SANDBOX_URL?.trim();
      const apiKey = env.CLOUDFLARE_SANDBOX_API_KEY?.trim();
      if (!url || !apiKey) throw missingCred("CLOUDFLARE_SANDBOX_URL and CLOUDFLARE_SANDBOX_API_KEY");
      return { url, apiKey };
    }
    default:
      throw new SandboxError(
        "provider_misconfigured",
        `SHIBA_COMPUTESDK_PROVIDER "${backend}" is not wired in shiba yet. ` +
          `Extend PACKAGE_BY_BACKEND in computesdk-load.ts or pick e2b, modal, daytona, vercel, cloudflare.`,
        { provider: "computesdk" },
      );
  }
}

function missingCred(names: string): SandboxError {
  return new SandboxError(
    "provider_misconfigured",
    `ComputeSDK credentials missing (${names}). Set via Worker secrets / .dev.vars — never log values.`,
    { provider: "computesdk" },
  );
}

export async function loadComputesdkClient(env: ComputesdkLoadEnv): Promise<ComputesdkClient> {
  const backend = env.SHIBA_COMPUTESDK_PROVIDER?.trim().toLowerCase();
  if (!backend) {
    throw new SandboxError(
      "provider_misconfigured",
      "SHIBA_COMPUTESDK_PROVIDER is required when SHIBA_SANDBOX_PROVIDER=computesdk (e.g. e2b, modal, daytona).",
      { provider: "computesdk" },
    );
  }

  const pkg = PACKAGE_BY_BACKEND[backend];
  if (!pkg) {
    throw new SandboxError(
      "provider_misconfigured",
      `Unknown SHIBA_COMPUTESDK_PROVIDER "${backend}". Known quick-start backends: ${Object.keys(PACKAGE_BY_BACKEND).join(", ")}.`,
      { provider: "computesdk" },
    );
  }

  type ComputeModule = {
    compute: {
      setConfig: (config: { provider: unknown }) => void;
      instances: ComputesdkClient["instances"];
    };
  };

  let computeMod: ComputeModule;
  try {
    computeMod = (await import("computesdk")) as ComputeModule;
  } catch (error) {
    throw new SandboxError(
      "provider_misconfigured",
      `Optional dependency computesdk@${COMPUTESDK_PINNED_CORE_VERSION} is not installed. ` +
        `Install it on the Node/Bun control plane host (not in the Worker bundle).`,
      { provider: "computesdk", cause: error },
    );
  }

  let providerMod: Record<string, unknown>;
  try {
    providerMod = (await import(pkg)) as Record<string, unknown>;
  } catch (error) {
    throw new SandboxError(
      "provider_misconfigured",
      `Optional provider package ${pkg} is not installed on this host.`,
      { provider: "computesdk", cause: error },
    );
  }

  const factory = providerMod[backend] ?? providerMod.default;
  if (typeof factory !== "function") {
    throw new SandboxError("provider_misconfigured", `${pkg} did not export a callable provider factory.`, {
      provider: "computesdk",
    });
  }

  const providerInstance = factory(providerOptions(backend, env));
  computeMod.compute.setConfig({ provider: providerInstance });

  return {
    backendProvider: backend,
    instances: {
      create: (options) => computeMod.compute.instances.create(options),
      getById: (id) => computeMod.compute.instances.getById(id),
      destroy: (id) => computeMod.compute.instances.destroy(id),
    },
  };
}

/** True when Node/Bun child_process is available (not workerd-only isolate). */
export async function isComputesdkHostRuntime(): Promise<boolean> {
  try {
    await import("node:child_process");
    return true;
  } catch {
    return false;
  }
}
