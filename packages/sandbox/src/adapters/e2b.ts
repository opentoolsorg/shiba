/**
 * E2B adapter stub — API surface documented in adapters/RESEARCH.md.
 * Live calls require E2B_API_KEY; without it the provider refuses at get() time
 * so CI stays offline-safe. Unit tests inject `fetchImpl`.
 */
import { SandboxError } from "../errors.js";
import type { SandboxCapabilities, SandboxInstance, SandboxProvider } from "../types.js";

export interface E2bSandboxProviderOptions {
  apiKey?: string;
  /** Override for tests — never pass real keys in unit tests. */
  fetchImpl?: typeof fetch;
  /** When true, get() returns a no-network mock instance (contract tests). */
  mockInstance?: boolean;
}

const CAPABILITIES: SandboxCapabilities = {
  edgeEgressEnforcement: false,
  previewUrls: true,
  snapshots: false,
  streamingExec: true,
  backgroundProcesses: false,
};

function mockInstance(instanceId: string): SandboxInstance {
  const files = new Map<string, string>();
  return {
    id: instanceId,
    capabilities: CAPABILITIES,
    async gitCheckout() {
      throw new SandboxError("capability_unsupported", "mock e2b: gitCheckout not implemented", {
        provider: "e2b",
      });
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async readFile(path) {
      const content = files.get(path);
      if (content === undefined) {
        throw new SandboxError("io_failed", `missing file ${path}`, { provider: "e2b" });
      }
      return { kind: "utf8", content };
    },
    async exec(command) {
      return { stdout: `mock:${command}`, stderr: "", exitCode: 0 };
    },
    async exposePort(port) {
      return { url: `https://mock.e2b.dev/${instanceId}/${port}/` };
    },
    async unexposePort() {},
    async destroy() {},
  };
}

export function createE2bSandboxProvider(options: E2bSandboxProviderOptions): SandboxProvider {
  const cache = new Map<string, SandboxInstance>();
  return {
    id: "e2b",
    capabilities: CAPABILITIES,
    async get(instanceId) {
      if (options.mockInstance) {
        let inst = cache.get(instanceId);
        if (!inst) {
          inst = mockInstance(instanceId);
          cache.set(instanceId, inst);
        }
        return inst;
      }
      if (!options.apiKey?.trim()) {
        throw new SandboxError(
          "provider_misconfigured",
          "E2B adapter requires E2B_API_KEY (or mockInstance for tests).",
          { provider: "e2b" },
        );
      }
      throw new SandboxError(
        "capability_unsupported",
        "E2B live adapter is not wired yet — see packages/sandbox/adapters/RESEARCH.md.",
        { provider: "e2b" },
      );
    },
    async destroy(instanceId) {
      cache.delete(instanceId);
    },
  };
}
