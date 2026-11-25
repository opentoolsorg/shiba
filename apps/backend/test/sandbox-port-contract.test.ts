import { createCloudflareSandboxProvider } from "../src/adapters/sandbox/cloudflare/index.js";
import { createComputesdkSandboxProvider } from "../src/adapters/sandbox/computesdk/index.js";
import { describeSandboxProviderContract, type SandboxContractFixture } from "../src/ports/sandbox/contract-suite.js";

type CloudflareRpc = ReturnType<Parameters<typeof createCloudflareSandboxProvider>[0]["resolveRpc"]>;
type ComputeClient = Parameters<typeof createComputesdkSandboxProvider>[0]["client"];

function cloudflareFixture(): SandboxContractFixture {
  const resources = new Set<string>();
  const handles = new Map<string, CloudflareRpc>();
  const executions: SandboxContractFixture["executions"] = [];
  const provider = createCloudflareSandboxProvider({
    execEnvPassthrough: { BASE: "base" },
    resolveRpc(id) {
      let handle = handles.get(id);
      if (handle) return handle;
      resources.add(id);
      const files = new Map<string, string>();
      handle = {
        async approveHarnessEgress() {},
        async approveEgressOverrides() {},
        async approveRepoScope() {},
        async gitCheckout() {},
        async writeFile(path, content) {
          files.set(path, typeof content === "string" ? content : await new Response(content).text());
        },
        async readFileStream(path) {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(files.get(path) ?? ""));
              controller.close();
            },
          });
        },
        async exec(command, options) {
          executions.push({ command, cwd: options?.cwd, timeout: options?.timeout, env: options?.env });
          options?.onOutput?.("stdout", "contract-ok\n");
          options?.onOutput?.("stderr", "diagnostic\n");
          return { stdout: "contract-ok\n", stderr: "diagnostic\n", exitCode: 7 };
        },
        async exposePort(port) { return { url: `https://preview.example/${port}/` }; },
        async unexposePort() {},
        async snapshotContainer(name) { return { id: name ?? "snapshot", size: 12 }; },
        async startProcess() { return { async waitForPort() {}, async kill() {} }; },
        async destroy() { resources.delete(id); },
      };
      handles.set(id, handle);
      return handle;
    },
  });
  return { provider, resources, executions };
}

function computesdkFixture(): SandboxContractFixture {
  const resources = new Set<string>();
  const executions: SandboxContractFixture["executions"] = [];
  let sequence = 0;
  const client: ComputeClient = {
    backendProvider: "e2b",
    instances: {
      async getById() { return null; },
      async destroy(id) { resources.delete(id); },
      async create() {
        const instanceId = `fake-${++sequence}`;
        resources.add(instanceId);
        const files = new Map<string, string>();
        return {
          instanceId,
          provider: "fake",
          filesystem: {
            async mkdir() {},
            async writeFile(path, content) { files.set(path, content); },
            async readFile(path) { return files.get(path) ?? ""; },
          },
          async runCommand(command, options) {
            executions.push({ command, cwd: options?.cwd, timeout: options?.timeout, env: options?.env });
            options?.onStdout?.("contract-ok\n");
            options?.onStderr?.("diagnostic\n");
            return { stdout: "contract-ok\n", stderr: "diagnostic\n", exitCode: 7 };
          },
          async getUrl({ port }) { return `https://preview.example/${port}/`; },
          async startProcess() {
            return {
              async kill() {},
              async wait() { return { stdout: "", stderr: "", exitCode: 0, signal: null }; },
            };
          },
          async destroy() { resources.delete(instanceId); },
        };
      },
    },
  };
  return {
    provider: createComputesdkSandboxProvider({ client, execEnvPassthrough: { BASE: "base" } }),
    resources,
    executions,
  };
}

describeSandboxProviderContract("cloudflare (fake RPC)", cloudflareFixture);
describeSandboxProviderContract("computesdk (fake client)", computesdkFixture);
