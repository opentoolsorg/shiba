import { describe, expect, it, vi } from "vitest";
import {
  getSandboxProviderFactory,
  registerSandboxProvider,
  type SandboxProvider,
} from "@shiba/sandbox";
import type { Env } from "../src/env.js";
import {
  createSandboxRegistry,
  sandboxRegistryFor,
  type SandboxRegistryDependencies,
} from "../src/ports/sandbox/registry.js";

function fakeProvider(id = "cloudflare"): SandboxProvider {
  return {
    id,
    capabilities: {
      edgeEgressEnforcement: true,
      previewUrls: false,
      snapshots: false,
      streamingExec: false,
      backgroundProcesses: false,
      rawProviderHandle: false,
    },
    get: vi.fn(),
    destroy: vi.fn(),
  };
}

function env(extra: Partial<Env> = {}): Env {
  return { Sandbox: {}, ...extra } as Env;
}

describe("sandbox port registry", () => {
  it("passes selected config and injected RPC resolution to the provider factory", async () => {
    const provider = fakeProvider();
    const createProvider = vi.fn<NonNullable<SandboxRegistryDependencies["createProvider"]>>(() => provider);
    const resolveRpc = vi.fn();
    const registry = createSandboxRegistry(env({ SHIBA_SANDBOX_TIMEOUT_MS: "1234" }), {
      createProvider,
      resolveRpc,
    });

    expect(await registry.resolveForSelection({ taskProviderId: "cloudflare" })).toBe(provider);
    expect(createProvider).toHaveBeenCalledWith("cloudflare", expect.objectContaining({
      config: expect.objectContaining({ options: expect.objectContaining({ timeoutMs: 1234 }) }),
      host: expect.objectContaining({ cloudflareResolveRpc: resolveRpc }),
    }));
  });

  it("keeps provider caches local to the injected registry", () => {
    const createProvider = vi.fn(() => fakeProvider());
    const context = env();
    const first = createSandboxRegistry(context, { createProvider });
    const second = createSandboxRegistry(context, { createProvider });
    const provider = first.resolve();

    expect(first.resolve()).toBe(provider);
    expect(second.resolve()).not.toBe(provider);
    expect(createProvider).toHaveBeenCalledTimes(2);
  });

  it("scopes compatibility registries to the Worker env", () => {
    const first = env();
    const second = env();
    expect(sandboxRegistryFor(first)).toBe(sandboxRegistryFor(first));
    expect(sandboxRegistryFor(second)).not.toBe(sandboxRegistryFor(first));
  });

  it("injects remote ComputeSDK creation without loading a host provider", () => {
    const provider = fakeProvider("computesdk");
    const createRemoteProvider = vi.fn(() => provider);
    const createProvider = vi.fn();
    const registry = createSandboxRegistry(env({
      SHIBA_SANDBOX_PROVIDER: "computesdk",
      SHIBA_COMPUTESDK_RUNNER_URL: "https://runner.example.com",
      SHIBA_COMPUTESDK_RUNNER_TOKEN: "test-runner-token",
    }), { createRemoteProvider, createProvider });

    expect(registry.resolve()).toBe(provider);
    expect(createRemoteProvider).toHaveBeenCalledOnce();
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("passes the injected ComputeSDK host loader to lazy construction", async () => {
    const provider = fakeProvider("computesdk");
    const loadComputesdkProvider = vi.fn(async () => provider);
    const createProvider = vi.fn<NonNullable<SandboxRegistryDependencies["createProvider"]>>(() => provider);
    const context = env({ SHIBA_SANDBOX_PROVIDER: "computesdk" });
    const registry = createSandboxRegistry(context, { createProvider, loadComputesdkProvider });
    registry.resolve();

    const factoryContext = createProvider.mock.calls[0]?.[1];
    expect(factoryContext).toBeDefined();
    expect(await factoryContext?.host?.computesdkLoadProvider?.()).toBe(provider);
    expect(loadComputesdkProvider).toHaveBeenCalledWith(context);
  });

  it("preserves an externally registered factory for a built-in name", () => {
    const previous = getSandboxProviderFactory("cloudflare");
    const provider = fakeProvider();
    const factory = vi.fn(() => provider);
    registerSandboxProvider("cloudflare", factory);
    try {
      expect(createSandboxRegistry(env()).resolve()).toBe(provider);
      expect(factory).toHaveBeenCalledOnce();
    } finally {
      registerSandboxProvider("cloudflare", previous);
    }
  });
});
