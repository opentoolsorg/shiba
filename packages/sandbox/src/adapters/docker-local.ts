import { spawn } from "node:child_process";
import { SandboxError } from "../errors.js";
import type {
  ExecResult,
  ReadFileResult,
  SandboxCapabilities,
  SandboxInstance,
  SandboxProvider,
} from "../types.js";

export interface DockerLocalSandboxProviderOptions {
  /** Image to run (must match apps/backend/Dockerfile output for harness parity). */
  image: string;
  /** Optional host published for preview URLs (defaults to localhost). */
  previewHost?: string;
  /** Run `docker` via this binary (tests may stub). */
  dockerBin?: string;
  /** Injected executor for tests; production uses real docker CLI. */
  dockerExec?: DockerExecutor;
}

export type DockerExecutor = {
  run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
};

const CAPABILITIES: SandboxCapabilities = {
  edgeEgressEnforcement: false,
  previewUrls: true,
  snapshots: false,
  streamingExec: false,
  backgroundProcesses: true,
};

function defaultDockerExec(bin: string): DockerExecutor {
  return {
    run(args) {
      return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Uint8Array | string) => {
          stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        });
        child.stderr.on("data", (chunk: Uint8Array | string) => {
          stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
      });
    },
  };
}

function containerName(instanceId: string): string {
  const safe = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
  return `shiba-sandbox-${safe}`;
}

export function createDockerLocalSandboxProvider(
  options: DockerLocalSandboxProviderOptions,
): SandboxProvider {
  const docker = options.dockerExec ?? defaultDockerExec(options.dockerBin ?? "docker");
  const image = options.image;
  const previewHost = options.previewHost ?? "127.0.0.1";
  async function ensureContainer(instanceId: string): Promise<void> {
    const name = containerName(instanceId);
    const inspect = await docker.run(["inspect", "-f", "{{.State.Running}}", name]);
    if (inspect.exitCode === 0 && inspect.stdout.trim() === "true") return;

    const run = await docker.run([
      "run",
      "-d",
      "--name",
      name,
      "--network",
      "host",
      "--label",
      "shiba.sandbox=1",
      image,
      "sleep",
      "infinity",
    ]);
    if (run.exitCode !== 0) {
      throw new SandboxError("provider_misconfigured", `docker run failed: ${run.stderr}`, {
        provider: "docker-local",
      });
    }
  }

  function instance(instanceId: string): SandboxInstance {
    return {
      id: instanceId,
      capabilities: CAPABILITIES,

      async gitCheckout(repoUrl, opts) {
        await ensureContainer(instanceId);
        const name = containerName(instanceId);
        const parent = opts.targetDir.includes("/")
          ? opts.targetDir.slice(0, opts.targetDir.lastIndexOf("/"))
          : "/workspace";
        await dockerExecIn(docker, name, `mkdir -p ${shellQuote(parent)}`);
        const cmd = `git clone --filter=blob:none ${opts.branch ? `--branch ${shellQuote(opts.branch)} ` : ""}${shellQuote(repoUrl)} ${shellQuote(opts.targetDir)}`;
        const result = await dockerExecIn(docker, name, cmd, { cwd: "/workspace" });
        if (result.exitCode !== 0) {
          throw new SandboxError("exec_failed", `git clone failed: ${result.stderr}`, {
            provider: "docker-local",
          });
        }
      },

      async writeFile(path, content) {
        await ensureContainer(instanceId);
        const name = containerName(instanceId);
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
        await dockerExecIn(docker, name, `mkdir -p ${shellQuote(dir)}`);
        const encoded = btoa(content);
        const result = await dockerExecIn(
          docker,
          name,
          `echo ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)}`,
        );
        if (result.exitCode !== 0) {
          throw new SandboxError("io_failed", result.stderr, { provider: "docker-local" });
        }
      },

      async readFile(path, opts) {
        await ensureContainer(instanceId);
        const name = containerName(instanceId);
        const result = await dockerExecIn(docker, name, `base64 ${shellQuote(path)}`);
        if (result.exitCode !== 0) {
          throw new SandboxError("io_failed", result.stderr, { provider: "docker-local" });
        }
        const raw = Uint8Array.from(atob(result.stdout.replace(/\s/g, "")), (c) => c.charCodeAt(0));
        const max = opts?.maxBytes ?? 500_000;
        if (raw.length > max) {
          throw new SandboxError("io_failed", `File exceeds ${max}-byte limit`, {
            provider: "docker-local",
          });
        }
        const decoded = tryDecodeUtf8(raw);
        if (decoded !== null) return { kind: "utf8", content: decoded };
        return { kind: "base64", content: bytesToBase64(raw) };
      },

      async exec(command, opts) {
        await ensureContainer(instanceId);
        const name = containerName(instanceId);
        return dockerExecIn(docker, name, command, {
          cwd: opts?.cwd,
          timeoutMs: opts?.timeoutMs,
          env: opts?.env,
        });
      },

      async exposePort(port) {
        await ensureContainer(instanceId);
        // Host networking: container port is reachable on the same host port.
        return { url: `http://${previewHost}:${port}/` };
      },

      async unexposePort(_port) {
        // No-op with --network host.
      },

      async startProcess(command, options) {
        await ensureContainer(instanceId);
        const name = containerName(instanceId);
        const pidFile = `/tmp/shiba-proc-${crypto.randomUUID()}.pid`;
        await dockerExecIn(
          docker,
          name,
          `cd ${shellQuote(options?.cwd ?? "/workspace")} && ${command} & echo $! > ${pidFile}`,
        );
        return {
          waitForPort: async (port, waitOpts) => {
            const deadline = Date.now() + (waitOpts?.timeoutMs ?? 30_000);
            while (Date.now() < deadline) {
              const probe = await dockerExecIn(
                docker,
                name,
                `curl -sf -o /dev/null http://127.0.0.1:${port}/ || curl -sf -o /dev/null http://127.0.0.1:${port}`,
              );
              if (probe.exitCode === 0) return;
              await delay(250);
            }
            throw new SandboxError("timeout", `Port ${port} did not become ready`, {
              provider: "docker-local",
            });
          },
          kill: async () => {
            await dockerExecIn(
              docker,
              name,
              `[ -f ${pidFile} ] && kill $(cat ${pidFile}) 2>/dev/null || true`,
            );
          },
        };
      },

      async destroy() {
        const name = containerName(instanceId);
        await docker.run(["rm", "-f", name]);
      },
    };
  }

  const cache = new Map<string, SandboxInstance>();
  return {
    id: "docker-local",
    capabilities: CAPABILITIES,
    async get(instanceId) {
      let inst = cache.get(instanceId);
      if (!inst) {
        inst = instance(instanceId);
        cache.set(instanceId, inst);
      }
      return inst;
    },
    async destroy(instanceId) {
      cache.delete(instanceId);
      await instance(instanceId).destroy();
    },
  };
}

async function dockerExecIn(
  docker: DockerExecutor,
  container: string,
  command: string,
  opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<ExecResult> {
  const envFlags = opts?.env
    ? Object.entries(opts.env).flatMap(([k, v]) => ["-e", `${k}=${v}`])
    : [];
  const cwdFlag = opts?.cwd ? ["-w", opts.cwd] : [];
  const args = ["exec", ...cwdFlag, ...envFlags, container, "sh", "-c", command];
  const result = await docker.run(args);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
