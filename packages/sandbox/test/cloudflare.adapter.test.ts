import { describe, expect, it } from "vitest";
import { createCloudflareSandboxProvider, type CloudflareSandboxRpc } from "../src/adapters/cloudflare.js";
import { describeSandboxProviderContract } from "../src/contract-suite.js";

function mockRpc(): CloudflareSandboxRpc {
  const files = new Map<string, string>();
  return {
    approveHarnessEgress: async () => {},
    approveEgressOverrides: async () => {},
    approveRepoScope: async () => {},
    gitCheckout: async () => {},
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    exec: async (command) => ({ stdout: command.includes("echo") ? "contract-ok\n" : "", exitCode: 0 }),
    readFileStream: async (path) => {
      const text = files.get(path) ?? "";
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
    },
    destroy: async () => {},
    exposePort: async (port) => ({ url: `https://preview.example/${port}/` }),
    unexposePort: async () => {},
    startProcess: async () => ({
      waitForPort: async () => {},
      kill: async () => {},
    }),
  };
}

describeSandboxProviderContract("cloudflare (mock rpc)", () =>
  createCloudflareSandboxProvider({
    resolveRpc: () => mockRpc(),
  }),
);

describe("cloudflare pinEgress", () => {
  it("forwards host and repo pins", async () => {
    const calls: string[] = [];
    const rpc = mockRpc();
    rpc.approveHarnessEgress = async (hosts) => {
      calls.push(`hosts:${hosts.join(",")}`);
    };
    rpc.approveRepoScope = async (path) => {
      calls.push(`repo:${path}`);
    };
    const provider = createCloudflareSandboxProvider({ resolveRpc: () => rpc });
    const instance = await provider.get("pin-test");
    await instance.pinEgress?.({
      allowedHosts: ["api.anthropic.com"],
      githubRepoPath: "/o/r",
    });
    expect(calls).toEqual(["hosts:api.anthropic.com", "repo:/o/r"]);
  });

  it("applies an explicit empty host allowlist (deny-all)", async () => {
    const calls: string[][] = [];
    const rpc = mockRpc();
    rpc.approveHarnessEgress = async (hosts) => {
      calls.push(hosts);
    };
    const provider = createCloudflareSandboxProvider({ resolveRpc: () => rpc });
    const instance = await provider.get("empty-pin");
    await instance.pinEgress?.({ allowedHosts: [] });
    expect(calls).toEqual([[]]);
  });
});
