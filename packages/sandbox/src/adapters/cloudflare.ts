import { SandboxError } from "../errors.js";
import type {
  ExecResult,
  SandboxCapabilities,
  SandboxEgressPin,
  SandboxInstance,
  SandboxProvider,
} from "../types.js";

/** RPC surface of shiba's Sandbox Durable Object (SDK 1.0). Injected by the Worker. */
export interface CloudflareSandboxRpc {
  approveHarnessEgress(hosts: string[]): Promise<void>;
  approveEgressOverrides(
    overrides: Array<{ host: string; handler: string; params?: Record<string, string> }>,
  ): Promise<void>;
  approveRepoScope(allowedPath: string): Promise<void>;
  gitCheckout(repoUrl: string, opts: { branch: string; targetDir: string }): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  exec(
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
      stream?: boolean;
      onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
    },
  ): Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;
  readFileStream(path: string): Promise<ReadableStream<Uint8Array>>;
  destroy(): Promise<void>;
  exposePort(port: number, options: { hostname: string }): Promise<{ url: string }>;
  unexposePort(port: number): Promise<void>;
  startProcess(
    command: string,
    options?: { cwd?: string },
  ): Promise<{
    waitForPort(port: number, options?: { timeout?: number }): Promise<void>;
    kill(): Promise<void>;
  }>;
  snapshotContainer?(name?: string): Promise<{ id: string; size: number } | null>;
}

export interface CloudflareSandboxProviderDeps {
  resolveRpc: (instanceId: string) => CloudflareSandboxRpc;
  defaultTimeoutMs?: number;
  extraEgressHosts?: string[];
  execEnvPassthrough?: Record<string, string>;
}

const CAPABILITIES: SandboxCapabilities = {
  edgeEgressEnforcement: true,
  previewUrls: true,
  snapshots: true,
  streamingExec: true,
  backgroundProcesses: true,
  rawProviderHandle: false,
  persistentVolumes: true,
};

function wrapRpc(
  instanceId: string,
  rpc: CloudflareSandboxRpc,
  settings: Pick<CloudflareSandboxProviderDeps, "defaultTimeoutMs" | "extraEgressHosts" | "execEnvPassthrough">,
): SandboxInstance {
  return {
    id: instanceId,
    capabilities: CAPABILITIES,

    async pinEgress(pin: SandboxEgressPin) {
      const hosts = [...new Set([...pin.allowedHosts, ...(settings.extraEgressHosts ?? [])])];
      if (hosts.length > 0) {
        await rpc.approveHarnessEgress(hosts);
      }
      if (pin.outboundByHost) {
        const overrides = Object.entries(pin.outboundByHost).map(([host, spec]) => ({
          host,
          handler: spec.handler,
          ...(spec.params ? { params: spec.params } : {}),
        }));
        if (overrides.length > 0) {
          await rpc.approveEgressOverrides(overrides);
        }
      }
      if (pin.githubRepoPath) {
        await rpc.approveRepoScope(pin.githubRepoPath);
      }
    },

    gitCheckout: (repoUrl, opts) => rpc.gitCheckout(repoUrl, opts),
    writeFile: (path, content) => rpc.writeFile(path, content),

    async readFile(path, opts) {
      const stream = await rpc.readFileStream(path);
      const bytes = await collectStream(stream, opts?.maxBytes ?? 500_000, opts?.signal);
      const decoded = tryDecodeUtf8(bytes);
      if (decoded !== null) return { kind: "utf8", content: decoded };
      return { kind: "base64", content: bytesToBase64(bytes) };
    },

    readFileStream: (path) => rpc.readFileStream(path),

    async exec(command, opts) {
      opts?.signal?.throwIfAborted();
      const execPromise = rpc.exec(command, {
        cwd: opts?.cwd,
        timeout: opts?.timeoutMs ?? settings.defaultTimeoutMs,
        env: { ...settings.execEnvPassthrough, ...opts?.env },
        stream: opts?.onOutput !== undefined,
        onOutput: opts?.onOutput,
      });
      const result = opts?.signal
        ? await raceAbort(execPromise, opts.signal)
        : await execPromise;
      return normalizeExec(result);
    },

    exposePort: (port, options) => rpc.exposePort(port, options),
    unexposePort: (port) => rpc.unexposePort(port),

    async startProcess(command, options) {
      const proc = await rpc.startProcess(command, options);
      return {
        waitForPort: (port, waitOpts) =>
          proc.waitForPort(port, { timeout: waitOpts?.timeoutMs }),
        kill: () => proc.kill(),
      };
    },

    async snapshot(name) {
      if (!rpc.snapshotContainer) return null;
      return rpc.snapshotContainer(name);
    },

    destroy: () => rpc.destroy(),
  };
}

export function createCloudflareSandboxProvider(deps: CloudflareSandboxProviderDeps): SandboxProvider {
  const settings = {
    defaultTimeoutMs: deps.defaultTimeoutMs,
    extraEgressHosts: deps.extraEgressHosts,
    execEnvPassthrough: deps.execEnvPassthrough,
  };
  return {
    id: "cloudflare",
    capabilities: CAPABILITIES,
    async get(instanceId) {
      // Fresh wrap each get so test mocks can swap RPC stubs between calls.
      return wrapRpc(instanceId, deps.resolveRpc(instanceId), settings);
    },
    async destroy(instanceId) {
      try {
        await deps.resolveRpc(instanceId).destroy();
      } catch (error) {
        throw new SandboxError("unknown", `destroy failed for ${instanceId}`, {
          provider: "cloudflare",
          cause: error,
        });
      }
    },
  };
}

function normalizeExec(result: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): ExecResult {
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? 0,
  };
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          promise.catch(() => {});
          reject(new SandboxError("timeout", "Run cancelled.", { provider: "cloudflare" }));
        },
        { once: true },
      );
    }),
  ]);
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        throw new SandboxError("io_failed", `File exceeds ${maxBytes}-byte limit`, {
          provider: "cloudflare",
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function tryDecodeUtf8(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
