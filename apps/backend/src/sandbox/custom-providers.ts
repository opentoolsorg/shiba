/**
 * Load self-hosted sandbox provider plugins (before any run uses sandboxes).
 *
 * Set `SHIBA_SANDBOX_PLUGIN` to a module id that calls `registerSandboxProvider`
 * from `@shiba/sandbox` (see docs/sandbox-custom-provider.md).
 */
import { registerSandboxProvider } from "@shiba/sandbox";

export async function loadSandboxPlugins(env: { SHIBA_SANDBOX_PLUGIN?: string }): Promise<void> {
  const plugin = env.SHIBA_SANDBOX_PLUGIN?.trim();
  if (!plugin) return;
  await import(/* @vite-ignore */ plugin);
}

/** Example in-repo fake used by tests — register when SHIBA_SANDBOX_PLUGIN=./sandbox/test-fake-plugin.js */
export function registerTestFakeSandboxProvider(): void {
  registerSandboxProvider("test-fake", () => ({
    id: "test-fake",
    capabilities: {
      edgeEgressEnforcement: false,
      previewUrls: true,
      snapshots: false,
      streamingExec: true,
      backgroundProcesses: true,
      rawProviderHandle: false,
    },
    async get(instanceId) {
      return {
        id: instanceId,
        capabilities: {
          edgeEgressEnforcement: false,
          previewUrls: true,
          snapshots: false,
          streamingExec: true,
          backgroundProcesses: true,
          rawProviderHandle: false,
        },
        async gitCheckout() {},
        async writeFile() {},
        async readFile() {
          return { kind: "utf8", content: "" };
        },
        async exec() {
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        async destroy() {},
      };
    },
    async destroy() {},
  }));
}

void loadSandboxPlugins(
  typeof process !== "undefined" ? (process.env as { SHIBA_SANDBOX_PLUGIN?: string }) : {},
).catch(() => undefined);
