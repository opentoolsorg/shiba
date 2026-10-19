import { createCloudflareSandboxProvider } from "./adapters/cloudflare.js";
import { createComputesdkSandboxProvider } from "./adapters/computesdk.js";
import { capabilitiesForComputesdkBackend } from "./adapters/computesdk-capabilities.js";
import { createDockerLocalSandboxProvider } from "./adapters/docker-local.js";
import { createE2bSandboxProvider } from "./adapters/e2b.js";
import { SandboxError } from "./errors.js";
import type { ComputesdkProviderOptions, DockerLocalProviderOptions, E2bStubProviderOptions } from "./options.js";
import { registerSandboxProvider } from "./registry.js";
import type { CloudflareProviderOptions } from "./options.js";

let registered = false;

export function registerBuiltinSandboxProviders(): void {
  if (registered) return;
  registered = true;

  registerSandboxProvider("cloudflare", (ctx) => {
    const resolveRpc = ctx.host?.cloudflareResolveRpc;
    if (!resolveRpc) {
      throw new SandboxError(
        "provider_misconfigured",
        "cloudflare provider requires host.deps.cloudflareResolveRpc.",
        { provider: "cloudflare" },
      );
    }
    if (ctx.config.id !== "cloudflare") {
      throw new SandboxError("provider_misconfigured", "cloudflare config mismatch.", { provider: "cloudflare" });
    }
    const opts = ctx.config.options as CloudflareProviderOptions;
    return createCloudflareSandboxProvider({
      resolveRpc,
      defaultTimeoutMs: opts.timeoutMs,
      extraEgressHosts: opts.egressAllowlist,
      execEnvPassthrough: opts.envPassthrough,
    });
  });

  registerSandboxProvider("docker-local", (ctx) => {
    if (ctx.config.id !== "docker-local") {
      throw new SandboxError("provider_misconfigured", "docker-local config mismatch.", {
        provider: "docker-local",
      });
    }
    const o = ctx.config.options as DockerLocalProviderOptions;
    return createDockerLocalSandboxProvider({
      image: o.image,
      previewHost: o.previewHost,
      defaultTimeoutMs: o.timeoutMs,
      execEnvPassthrough: o.envPassthrough,
    });
  });

  registerSandboxProvider("computesdk", (ctx) => {
    const base = ctx.config.options;
    const backend =
      ctx.config.id === "computesdk"
        ? (ctx.config.options as ComputesdkProviderOptions).backend
        : (ctx.env.SHIBA_COMPUTESDK_PROVIDER?.trim().toLowerCase() ?? "e2b");
    const capabilities = capabilitiesForComputesdkBackend(String(backend));

    if (ctx.host?.computesdkClient) {
      return createComputesdkSandboxProvider({
        client: ctx.host.computesdkClient,
        capabilities,
        defaultTimeoutMs: base.timeoutMs,
        execEnvPassthrough: base.envPassthrough,
      });
    }

    const load = ctx.host?.computesdkLoadProvider;
    if (!load) {
      throw new SandboxError(
        "provider_misconfigured",
        "computesdk requires host.deps.computesdkLoadProvider (Node/Bun) or computesdkClient.",
        { provider: "computesdk" },
      );
    }

    let inner: import("./types.js").SandboxProvider | undefined;
    let loading: Promise<import("./types.js").SandboxProvider> | undefined;
    return {
      id: "computesdk",
      capabilities,
      async get(instanceId) {
        if (!inner) {
          loading ??= load();
          inner = await loading;
        }
        return inner.get(instanceId);
      },
      async destroy(instanceId) {
        if (!inner) {
          loading ??= load();
          inner = await loading;
        }
        await inner.destroy(instanceId);
      },
    };
  });

  registerSandboxProvider("e2b", (ctx) => {
    const mock =
      ctx.config.id === "e2b" ? (ctx.config.options as E2bStubProviderOptions).mockInstance : false;
    return createE2bSandboxProvider({ mockInstance: mock });
  });
}
