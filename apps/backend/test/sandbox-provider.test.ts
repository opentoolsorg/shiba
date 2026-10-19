import { describe, expect, it, beforeEach } from "vitest";
import { createCloudflareSandboxProvider } from "@shiba/sandbox/adapters/cloudflare";
import { resetSandboxProviderCache, resolveSandboxProvider } from "../src/sandbox/provider.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

describe("resolveSandboxProvider", () => {
  beforeEach(() => {
    resetSandboxProviderCache();
    setSandboxHandleResolver(undefined);
  });

  it("defaults to cloudflare with edge egress", () => {
    const provider = resolveSandboxProvider({ Sandbox: {} as never } as unknown as import("../src/env.js").Env);
    expect(provider.id).toBe("cloudflare");
    expect(provider.capabilities.edgeEgressEnforcement).toBe(true);
  });

  it("refuses docker-local without opt-in", () => {
    expect(() =>
      resolveSandboxProvider({
        Sandbox: {} as never,
        SHIBA_SANDBOX_PROVIDER: "docker-local",
      } as unknown as import("../src/env.js").Env),
    ).toThrow(/SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS/);
  });

  it("admits docker-local with opt-in", () => {
    const provider = resolveSandboxProvider({
      Sandbox: {} as never,
      SHIBA_SANDBOX_PROVIDER: "docker-local",
      SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS: "1",
    } as unknown as import("../src/env.js").Env);
    expect(provider.id).toBe("docker-local");
    expect(provider.capabilities.edgeEgressEnforcement).toBe(false);
  });
});

describe("cloudflare adapter + destroy path", () => {
  it("destroy calls rpc", async () => {
    let destroyed = false;
    const provider = createCloudflareSandboxProvider({
      resolveRpc: () => ({
        approveHarnessEgress: async () => {},
        approveEgressOverrides: async () => {},
        approveRepoScope: async () => {},
        gitCheckout: async () => {},
        writeFile: async () => {},
        exec: async () => ({ exitCode: 0 }),
        readFileStream: async () => new ReadableStream(),
        destroy: async () => {
          destroyed = true;
        },
        exposePort: async () => ({ url: "https://x/" }),
        unexposePort: async () => {},
        startProcess: async () => ({ waitForPort: async () => {}, kill: async () => {} }),
      }),
    });
    await provider.destroy("id-1");
    expect(destroyed).toBe(true);
  });
});
