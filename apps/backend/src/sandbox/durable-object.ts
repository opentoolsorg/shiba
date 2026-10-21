/**
 * Sandbox SDK 1.0 — one Durable Object + Container per run. Egress runs in
 * SandboxOutbound (WorkerEntrypoint); credentials never enter the container.
 */
import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";
import type { EgressOverride } from "../harness/types.js";
import { redactSecrets } from "../security.js";
import {
  defaultOutboundConfig,
  loadOutboundConfig,
  OUTBOUND_CONFIG_KEY,
  type NamedOutboundHandler,
  type OutboundConfig,
} from "./outbound-config.js";
import { SandboxOutbound } from "./outbound-entrypoint.js";
import {
  loadPortTokens,
  mintPreviewToken,
  PORT_TOKENS_KEY,
  type PortTokenMap,
  type PreviewRoute,
  previewUrlFor,
} from "./preview-proxy.js";

const INACTIVITY_TIMEOUT_MS = 60_000;
const KEEPALIVE_ALARM_MS = 30_000;
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const TRUST_ENV: Record<string, string> = {
  CURL_CA_BUNDLE: CA_PATH,
  SSL_CERT_FILE: CA_PATH,
  NODE_EXTRA_CA_CERTS: CA_PATH,
};

interface SandboxCtx extends DurableObjectState {
  readonly exports: Cloudflare.Exports & {
    readonly SandboxOutbound: (opts: { props: { sandboxId: string } }) => Fetcher;
  };
}

function requireContainer(ctx: DurableObjectState): Container {
  const container = ctx.container;
  if (!container) throw new Error("Container attachment is unavailable");
  return container;
}

export class Sandbox extends DurableObject<Env> {
  readonly #container: Container;
  readonly #files: Files;
  constructor(ctx: SandboxCtx, env: Env) {
    super(ctx, env);
    this.#container = requireContainer(ctx);
    this.#files = new Files(this.#container);
    if (this.#container.running) {
      void ctx.blockConcurrencyWhile(() => this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
      void this.#armKeepalive();
    }
  }

  /** Binds the run's DNS-safe sandbox id (used in preview hostnames). */
  async registerSandboxName(sandboxId: string): Promise<void> {
    if (!this.ctx.storage.kv.get("sandbox-name")) {
      this.ctx.storage.kv.put("sandbox-name", sandboxId);
    }
  }

  private logicalSandboxId(): string {
    return this.ctx.storage.kv.get<string>("sandbox-name") ?? this.ctx.id.toString();
  }

  getOutboundConfig(): OutboundConfig {
    return loadOutboundConfig(this.ctx.storage.kv.get(OUTBOUND_CONFIG_KEY));
  }

  private persistOutbound(config: OutboundConfig): void {
    this.ctx.storage.kv.put(OUTBOUND_CONFIG_KEY, config);
  }

  async setOutboundOrgId(orgId: string): Promise<void> {
    const normalizedOrgId = orgId.trim();
    if (!normalizedOrgId) throw new Error("Sandbox organization ID is required.");
    const config = this.getOutboundConfig();
    if (config.orgId && config.orgId !== normalizedOrgId) {
      throw new Error("Sandbox is already bound to a different organization.");
    }
    if (config.orgId === normalizedOrgId) return;
    config.orgId = normalizedOrgId;
    this.persistOutbound(config);
  }

  async approveHarnessEgress(hosts: string[]): Promise<void> {
    const config = this.getOutboundConfig();
    config.allowedHosts = [...hosts];
    this.persistOutbound(config);
  }

  async approveEgressOverrides(overrides: EgressOverride[]): Promise<void> {
    const config = this.getOutboundConfig();
    for (const override of overrides) {
      config.outboundByHost[override.host] = {
        kind: "named",
        handler: override.handler as NamedOutboundHandler,
        ...(override.params ? { params: override.params } : {}),
      };
    }
    this.persistOutbound(config);
  }

  async approveRepoScope(allowedPath: string): Promise<void> {
    const config = this.getOutboundConfig();
    config.outboundByHost["github.com"] = {
      kind: "named",
      handler: "githubScoped",
      params: { allowedPath },
    };
    this.persistOutbound(config);
  }

  async destroy(): Promise<void> {
    if (this.#container.running) await this.#container.destroy();
    await this.ctx.storage.deleteAll();
  }

  async snapshotContainer(name?: string): Promise<{ id: string; size: number } | null> {
    if (!this.#container.running) return null;
    const snapshot = await this.#container.snapshotContainer({ name: name ?? `shiba-${this.logicalSandboxId()}` });
    await this.ctx.storage.put("container-snapshot-id", snapshot.id);
    return { id: snapshot.id, size: snapshot.size };
  }

  async gitCheckout(repoUrl: string, opts: { branch: string; targetDir: string }): Promise<void> {
    await this.#ensureRunning();
    const parent = opts.targetDir.includes("/") ? opts.targetDir.slice(0, opts.targetDir.lastIndexOf("/")) : "/workspace";
    await this.#files.mkdir(parent, { recursive: true }).catch(() => undefined);
    const argv = ["git", "clone", "--filter=blob:none"];
    if (opts.branch) argv.push("--branch", opts.branch);
    argv.push(repoUrl, opts.targetDir);
    const proc = await this.#container.exec(argv, { cwd: "/workspace", env: TRUST_ENV });
    const { exitCode, stderr } = await proc.output();
    if (exitCode !== 0) {
      const tail = new TextDecoder().decode(stderr).slice(-2000);
      throw new Error(`git clone failed (${exitCode}): ${redactSecrets(tail)}`);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#ensureRunning();
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
    await this.#files.mkdir(dir, { recursive: true }).catch(() => undefined);
    await this.#files.writeFile(path, content);
  }

  async exec(
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
      stream?: boolean;
      onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    await this.#ensureRunning();
    const cwd = options?.cwd ?? "/workspace";
    const env = { ...TRUST_ENV, ...options?.env };
    const abort = new AbortController();
    const timer =
      options?.timeout && options.timeout > 0
        ? setTimeout(() => abort.abort(), options.timeout)
        : undefined;
    try {
      const proc = await this.#container.exec(["sh", "-c", command], {
        cwd,
        env,
        signal: abort.signal,
      });
      let stdout = "";
      let stderr = "";
      if (options?.stream && options.onOutput) {
        const decoder = new TextDecoder();
        const readStream = async (stream: ReadableStream<Uint8Array>, onChunk: (t: string) => void) => {
          const reader = stream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              onChunk(text);
            }
          } finally {
            reader.releaseLock();
          }
        };
        await Promise.all([
          readStream(proc.stdout ?? new ReadableStream(), (chunk) => {
            stdout += chunk;
            options.onOutput!("stdout", chunk);
          }),
          readStream(proc.stderr ?? new ReadableStream(), (chunk) => {
            stderr += chunk;
            options.onOutput!("stderr", chunk);
          }),
        ]);
        const out = await proc.output();
        return {
          stdout,
          stderr,
          exitCode: out.exitCode,
        };
      }
      const out = await proc.output();
      const decoder = new TextDecoder();
      return {
        stdout: decoder.decode(out.stdout),
        stderr: decoder.decode(out.stderr),
        exitCode: out.exitCode,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async readFileStream(path: string): Promise<ReadableStream<Uint8Array>> {
    await this.#ensureRunning();
    const response = await this.#files.readFile(path);
    if (!response.body) throw new Error(`Empty body for ${path}`);
    return response.body;
  }

  async listFiles(targetPath: string): Promise<{ files: unknown[] }> {
    await this.#ensureRunning();
    const entries = await this.#files.readDirectory(targetPath);
    return { files: entries };
  }

  async readFile(path: string): Promise<{ content: string }> {
    await this.#ensureRunning();
    const response = await this.#files.readFile(path);
    return { content: await response.text() };
  }

  async listProcesses(): Promise<unknown[]> {
    const raw = await this.ctx.storage.kv.get<Record<string, unknown>>("processes-v1");
    return raw ? Object.values(raw) : [];
  }

  async getContainerPlacementId(): Promise<string | null> {
    if (!this.#container.running) return null;
    const proc = await this.#container.exec(["sh", "-c", "tr '\\0' '\\n' < /proc/1/environ | grep CLOUDFLARE_PLACEMENT_ID"], {
      env: TRUST_ENV,
    });
    const out = await proc.output();
    const line = new TextDecoder().decode(out.stdout).trim();
    const eq = line.indexOf("=");
    return eq > 0 ? line.slice(eq + 1) : null;
  }

  async exposePort(port: number, options: { hostname: string }): Promise<{ url: string }> {
    await this.#ensureRunning();
    const tokens = loadPortTokens(this.ctx.storage.kv.get(PORT_TOKENS_KEY));
    const token = mintPreviewToken();
    tokens[String(port)] = token;
    this.ctx.storage.kv.put(PORT_TOKENS_KEY, tokens);
    return { url: previewUrlFor(port, this.logicalSandboxId(), token, options.hostname) };
  }

  async unexposePort(port: number): Promise<void> {
    const tokens = loadPortTokens(this.ctx.storage.kv.get(PORT_TOKENS_KEY));
    delete tokens[String(port)];
    this.ctx.storage.kv.put(PORT_TOKENS_KEY, tokens);
  }

  async startProcess(
    command: string,
    options?: { cwd?: string },
  ): Promise<{
    waitForPort(port: number, options?: { timeout?: number }): Promise<void>;
    kill(): Promise<void>;
  }> {
    await this.#ensureRunning();
    const id = crypto.randomUUID();
    const cwd = options?.cwd ?? "/workspace";
    const pidFile = `/tmp/shiba-proc-${id}.pid`;
    const proc = await this.#container.exec(
      ["sh", "-c", `cd ${shellQuote(cwd)} && ${command} & echo $! > ${pidFile}`],
      { cwd, env: TRUST_ENV },
    );
    await proc.output();
    const processes = (await this.ctx.storage.kv.get<Record<string, string>>("processes-v1")) ?? {};
    processes[id] = pidFile;
    this.ctx.storage.kv.put("processes-v1", processes);
    return {
      waitForPort: async (port, waitOpts) => {
        const deadline = Date.now() + (waitOpts?.timeout ?? 30_000);
        while (Date.now() < deadline) {
          try {
            const res = await this.#container.getTcpPort(port).fetch("http://127.0.0.1/");
            if (res.status < 500) return;
          } catch {
            // retry
          }
          await delay(250);
        }
        throw new Error(`Port ${port} did not become ready.`);
      },
      kill: async () => {
        const killProc = await this.#container.exec(["sh", "-c", `[ -f ${pidFile} ] && kill $(cat ${pidFile}) 2>/dev/null || true`], {
          env: TRUST_ENV,
        });
        await killProc.output();
      },
    };
  }

  async proxyPreviewRequest(request: Request, route: PreviewRoute): Promise<Response> {
    const tokens = loadPortTokens(this.ctx.storage.kv.get(PORT_TOKENS_KEY));
    const expected = tokens[String(route.port)];
    if (!expected || expected !== route.token) {
      return new Response("Invalid preview token.", { status: 403 });
    }
    if (!this.#container.running) {
      return new Response("Sandbox container is not running.", { status: 503 });
    }
    return this.#container.getTcpPort(route.port).fetch(request);
  }

  override async alarm(): Promise<void> {
    if (!this.#container.running) return;
    try {
      await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      await this.#container.getTcpPort(8080).fetch("http://127.0.0.1/", { method: "HEAD" }).catch(() => undefined);
    } catch {
      // keepalive is best-effort
    }
    await this.#armKeepalive();
  }

  async #ensureRunning(): Promise<void> {
    if (this.#container.running) {
      await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      return;
    }
    const instanceType = (this.env.INSTANCE_TYPE?.trim() || "standard-1") as
      | "lite"
      | "standard-1"
      | "standard-2"
      | "standard-3"
      | "standard-4";
    const snapshotId = await this.ctx.storage.get<string>("container-snapshot-id");
    if (snapshotId) {
      this.#container.start({
        containerSnapshot: { id: snapshotId },
        enableInternet: false,
        instance: instanceType,
      });
    } else {
      this.#container.start({
        image: this.#container.images.sandbox,
        enableInternet: false,
        instance: instanceType,
      });
    }
    const outbound = (this.ctx as SandboxCtx).exports.SandboxOutbound({
      props: { sandboxId: this.logicalSandboxId() },
    });
    await this.#container.interceptAllOutboundHttp(outbound);
    await this.#container.interceptOutboundHttps("*", outbound);
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    await this.#armKeepalive();
    this.persistOutbound(loadOutboundConfig(this.ctx.storage.kv.get(OUTBOUND_CONFIG_KEY)));
  }

  async #armKeepalive(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_ALARM_MS);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
