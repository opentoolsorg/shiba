import { SandboxError } from "../errors.js";
import { capabilitiesForComputesdkBackend } from "./computesdk-capabilities.js";
import type {
  ComputesdkClient,
  ComputesdkInstance,
} from "./computesdk-types.js";
import type {
  BackgroundProcess,
  ExecResult,
  ReadFileResult,
  SandboxCapabilities,
  SandboxEgressPin,
  SandboxInstance,
  SandboxProvider,
} from "../types.js";

export interface ComputesdkSandboxProviderOptions {
  client: ComputesdkClient;
  /** Override capabilities (defaults from backend provider name). */
  capabilities?: SandboxCapabilities;
  defaultTimeoutMs?: number;
  execEnvPassthrough?: Record<string, string>;
}

function assertRaw(capabilities: SandboxCapabilities): void {
  if (!capabilities.rawProviderHandle) {
    throw new SandboxError("capability_unsupported", "raw() is not available for this sandbox adapter.", {
      provider: "computesdk",
    });
  }
}

function wrapInstance(
  shibaId: string,
  capabilities: SandboxCapabilities,
  instance: ComputesdkInstance,
  settings: { defaultTimeoutMs?: number; execEnvPassthrough?: Record<string, string> },
): SandboxInstance {
  return {
    id: shibaId,
    capabilities,

    async pinEgress(_pin: SandboxEgressPin) {
      throw new SandboxError(
        "capability_unsupported",
        "ComputeSDK backends do not implement shiba Worker egress pins. Use native cloudflare or configure ComputeSDK instance egress at create time.",
        { provider: "computesdk" },
      );
    },

    async gitCheckout(repoUrl, opts) {
      const parent = opts.targetDir.includes("/")
        ? opts.targetDir.slice(0, opts.targetDir.lastIndexOf("/"))
        : "/workspace";
      await instance.filesystem.mkdir(parent).catch(() => undefined);
      const branch = opts.branch ? `--branch ${shellQuote(opts.branch)} ` : "";
      const cmd = `git clone --filter=blob:none ${branch}-- ${shellQuote(repoUrl)} ${shellQuote(opts.targetDir)}`;
      const result = await instance.runCommand(cmd, { cwd: "/workspace" });
      if (result.exitCode !== 0) {
        throw new SandboxError("exec_failed", `git clone failed: ${result.stderr}`, { provider: "computesdk" });
      }
    },

    writeFile: (path, content) => instance.filesystem.writeFile(path, content),

    async readFile(path, opts) {
      const content = await instance.filesystem.readFile(path);
      const bytes = new TextEncoder().encode(content);
      const max = opts?.maxBytes ?? 500_000;
      if (bytes.length > max) {
        throw new SandboxError("io_failed", `File exceeds ${max}-byte limit`, { provider: "computesdk" });
      }
      if (bytes.includes(0)) {
        return { kind: "base64", content: bytesToBase64(bytes) };
      }
      return { kind: "utf8", content };
    },

    async exec(command, opts) {
      opts?.signal?.throwIfAborted();
      const result = await instance.runCommand(command, {
        cwd: opts?.cwd,
        env: { ...settings.execEnvPassthrough, ...opts?.env },
        timeout: opts?.timeoutMs ?? settings.defaultTimeoutMs,
        onStdout: opts?.onOutput ? (chunk) => opts.onOutput!("stdout", chunk) : undefined,
        onStderr: opts?.onOutput ? (chunk) => opts.onOutput!("stderr", chunk) : undefined,
      });
      return normalizeExec(result);
    },

    async exposePort(port, _options) {
      const url = await instance.getUrl({ port, protocol: "https" });
      return { url };
    },

    async unexposePort(_port) {
      throw new SandboxError(
        "capability_unsupported",
        "ComputeSDK does not support per-port preview revocation; destroy the sandbox to drop preview URLs.",
        { provider: "computesdk" },
      );
    },

    async startProcess(command, options) {
      const handle = await instance.startProcess(command, { cwd: options?.cwd });
      return {
        waitForPort: async (port, waitOpts) => {
          const deadline = Date.now() + (waitOpts?.timeoutMs ?? 30_000);
          while (Date.now() < deadline) {
            try {
              const url = await instance.getUrl({ port });
              const res = await fetch(url, { method: "HEAD", redirect: "manual" });
              if (res.status >= 300 && res.status < 400) {
                throw new SandboxError(
                  "capability_unsupported",
                  "Port readiness probe rejected an HTTP redirect.",
                  { provider: "computesdk" },
                );
              }
              if (res.status < 500) return;
            } catch (error) {
              if (error instanceof SandboxError) throw error;
              // retry
            }
            await delay(250);
          }
          throw new SandboxError("timeout", `Port ${port} did not become ready`, { provider: "computesdk" });
        },
        kill: () => handle.kill(),
      };
    },

    async destroy() {
      await instance.destroy();
    },

    raw<T = unknown>() {
      assertRaw(capabilities);
      return instance as T;
    },
  };
}

export function createComputesdkSandboxProvider(options: ComputesdkSandboxProviderOptions): SandboxProvider {
  const capabilities =
    options.capabilities ?? capabilitiesForComputesdkBackend(options.client.backendProvider);
  const settings = {
    defaultTimeoutMs: options.defaultTimeoutMs,
    execEnvPassthrough: options.execEnvPassthrough,
  };
  /** shiba run id → ComputeSDK instance id */
  const idMap = new Map<string, string>();
  const instanceCache = new Map<string, ComputesdkInstance>();
  const pendingCreates = new Map<string, Promise<ComputesdkInstance>>();

  async function resolveComputeInstance(shibaId: string): Promise<ComputesdkInstance> {
    const cached = instanceCache.get(shibaId);
    if (cached) return cached;

    const pending = pendingCreates.get(shibaId);
    if (pending) return pending;

    const mappedId = idMap.get(shibaId);
    if (mappedId) {
      const existing = await options.client.instances.getById(mappedId);
      if (existing) {
        instanceCache.set(shibaId, existing);
        return existing;
      }
      idMap.delete(shibaId);
    }

    const createPromise = (async () => {
      const created = await options.client.instances.create({
        metadata: { shibaSandboxId: shibaId },
      });
      idMap.set(shibaId, created.instanceId);
      instanceCache.set(shibaId, created);
      return created;
    })();
    pendingCreates.set(shibaId, createPromise);
    try {
      return await createPromise;
    } finally {
      pendingCreates.delete(shibaId);
    }
  }

  return {
    id: "computesdk",
    capabilities,
    async get(instanceId) {
      const instance = await resolveComputeInstance(instanceId);
      return wrapInstance(instanceId, capabilities, instance, settings);
    },
    async destroy(instanceId) {
      const pending = pendingCreates.get(instanceId);
      if (pending) {
        try {
          await pending;
        } catch {
          pendingCreates.delete(instanceId);
          instanceCache.delete(instanceId);
          idMap.delete(instanceId);
          return;
        }
      }
      instanceCache.delete(instanceId);
      const mapped = idMap.get(instanceId);
      if (!mapped) return;
      try {
        await options.client.instances.destroy(mapped);
        idMap.delete(instanceId);
      } catch (error) {
        throw new SandboxError("unknown", `destroy failed for ${instanceId}`, {
          provider: "computesdk",
          cause: error,
        });
      }
    },
  };
}

function normalizeExec(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): ExecResult {
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? 0,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { ComputesdkClient, ComputesdkInstance } from "./computesdk-types.js";
