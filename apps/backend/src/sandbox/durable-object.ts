/**
 * Sandbox SDK 1.0 — one Durable Object + Container per run. Egress runs in
 * SandboxOutbound (WorkerEntrypoint); credentials never enter the container.
 */
import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";
import type { EgressOverride } from "../harness/types.js";
import { boundTail, redactSecrets } from "../security.js";
import {
  defaultOutboundConfig,
  loadOutboundConfig,
  OUTBOUND_CONFIG_KEY,
  type NamedOutboundHandler,
  type OutboundConfig,
} from "./outbound-config.js";
import { SandboxOutbound } from "./outbound-entrypoint.js";
import type { JournalExecutionInput, JournalPage, JournalState } from "@shiba/sandbox";
import {
  assertJournalJobId, emptyJournalPage, executionInputDigest, EXECUTION_EPOCH_LABEL, EXECUTION_JOURNAL_SOURCE,
  JOURNAL_MAX_REPLY_BYTES, JOURNAL_START_GRACE_MS, JournalIntegrityError, type JournalClaim,
} from "./execution-journal.js";
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
const JOURNAL_DEADLINES_KEY = "execution-journal-deadlines:v1";
const JOURNAL_DRAIN_GRACE_MS = 1_500;
/** Max stdout/stderr retained in the DO while a process runs (before scopedExec caps). */
const EXEC_COLLECT_CAP = 512_000;

function appendExecOutput(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= EXEC_COLLECT_CAP ? next : boundTail(next, EXEC_COLLECT_CAP);
}
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

  async setOutboundInitiatorUserId(userId: string): Promise<void> {
    const normalized = userId.trim();
    if (!normalized) throw new Error("Sandbox initiator user ID is required.");
    const config = this.getOutboundConfig();
    if (config.initiatorUserId && config.initiatorUserId !== normalized) {
      throw new Error("Sandbox is already bound to a different initiator.");
    }
    config.initiatorUserId = normalized;
    this.persistOutbound(config);
  }

  async setOutboundGatewayByokAlias(alias: string): Promise<void> {
    const normalized = alias.trim();
    if (!normalized) throw new Error("Gateway BYOK alias is required.");
    const config = this.getOutboundConfig();
    if (config.gatewayByokAlias && config.gatewayByokAlias !== normalized) {
      throw new Error("Sandbox is already bound to a different gateway credential.");
    }
    if (config.gatewayByokAlias === normalized) return;
    config.gatewayByokAlias = normalized;
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
      requiredJournalJobId?: string;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let settlementClaim: JournalClaim | undefined;
    if (options?.requiredJournalJobId !== undefined) {
      const jobId = options.requiredJournalJobId;
      assertJournalJobId(jobId);
      const claim = this.ctx.storage.kv.get<JournalClaim>(`execution-journal:${jobId}`);
      if (!claim?.epoch || claim.state !== "exited" || await this.#journalEpoch() !== claim.epoch || !this.#container.running) {
        throw new Error("The completed execution container is unavailable. Settlement was not restarted.");
      }
      settlementClaim = claim;
    } else {
      await this.#ensureRunning();
    }
    const cwd = options?.cwd ?? "/workspace";
    const env = { ...TRUST_ENV, ...options?.env };
    const abort = new AbortController();
    const timer =
      options?.timeout && options.timeout > 0
        ? setTimeout(() => abort.abort(), options.timeout)
        : undefined;
    try {
      const proc = await this.#container.exec(settlementClaim
        ? ["node", "-e", EXECUTION_JOURNAL_SOURCE, "--", "settle", options!.requiredJournalJobId!, "0", settlementClaim.digest!, String(settlementClaim.deadline)]
        : ["sh", "-c", command], {
        cwd: settlementClaim ? "/workspace" : cwd,
        env: settlementClaim ? TRUST_ENV : env,
        ...(settlementClaim ? { stdin: new Blob([JSON.stringify({ command, cwd, env })]).stream() } : {}),
        signal: abort.signal,
      });
      let stdout = "";
      let stderr = "";
      const readStream = async (
        stream: ReadableStream<Uint8Array> | undefined,
        onChunk: (t: string) => void | Promise<void>,
      ) => {
        const decoder = new TextDecoder();
        const reader = (stream ?? new ReadableStream({ start(controller) { controller.close(); } })).getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await onChunk(decoder.decode(value, { stream: true }));
          }
          const tail = decoder.decode();
          if (tail) await onChunk(tail);
        } finally {
          reader.releaseLock();
        }
      };
      await Promise.all([
        readStream(proc.stdout ?? undefined, async (chunk) => {
          stdout = appendExecOutput(stdout, chunk);
          await options?.onOutput?.("stdout", chunk);
        }),
        readStream(proc.stderr ?? undefined, async (chunk) => {
          stderr = appendExecOutput(stderr, chunk);
          await options?.onOutput?.("stderr", chunk);
        }),
      ]);
      const out = await proc.output();
      return {
        stdout,
        stderr,
        exitCode: out.exitCode,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Claims one prepared CLI execution before its first launch. */
  async startExecution(input: JournalExecutionInput): Promise<{ jobId: string; state: JournalState }> {
    const digest = await executionInputDigest(input);
    const key = `execution-journal:${input.jobId}`;
    const retained = this.ctx.storage.kv.get<JournalClaim>(key);
    if (retained) {
      if (retained.digest !== null && retained.digest !== digest) throw new Error("Execution identity was already claimed with different inputs.");
      return { jobId: input.jobId, state: retained.state };
    }
    let claim: JournalClaim = { digest, deadline: input.deadline, createdAt: Date.now(), epoch: null, state: "starting" };
    this.ctx.storage.kv.put(key, claim);
    const state = (next: JournalState) => {
      const current = this.ctx.storage.kv.get<JournalClaim>(key);
      if (!current) return { jobId: input.jobId, state: "lost" as const };
      claim = { ...current, state: current.state === "cancelled" ? "cancelled" : next };
      this.ctx.storage.kv.put(key, claim);
      return { jobId: input.jobId, state: claim.state };
    };
    if (input.deadline <= Date.now()) return state("timed_out");
    const epoch = await this.#journalEpoch();
    if (!this.ctx.storage.kv.get<JournalClaim>(key)) return { jobId: input.jobId, state: "lost" };
    if (this.ctx.storage.kv.get<JournalClaim>(key)?.state === "cancelled") return state("cancelled");
    if (!epoch) return state("lost");
    claim = { ...claim, epoch };
    this.ctx.storage.kv.put(key, claim);
    const deadlines = this.ctx.storage.kv.get<Record<string, { deadline: number; epoch: string }>>(JOURNAL_DEADLINES_KEY) ?? {};
    deadlines[input.jobId] = { deadline: input.deadline, epoch };
    this.ctx.storage.kv.put(JOURNAL_DEADLINES_KEY, deadlines);
    await this.#armKeepalive();
    // The helper sees only trusted startup variables. Approved application
    // variables are carried on stdin and supplied to the CLI child only.
    const spec = JSON.stringify({ command: input.command, cwd: input.cwd, env: { ...TRUST_ENV, ...input.env }, deadline: input.deadline, digest });
    if (!this.ctx.storage.kv.get<JournalClaim>(key)) return { jobId: input.jobId, state: "lost" };
    if (this.ctx.storage.kv.get<JournalClaim>(key)?.state === "cancelled") return state("cancelled");
    await this.#container.exec(["node", "-e", EXECUTION_JOURNAL_SOURCE, "--", "start", input.jobId], {
      env: TRUST_ENV,
      stdin: new Blob([spec]).stream(),
      stdout: "ignore", stderr: "ignore",
    });
    if (!this.ctx.storage.kv.get<JournalClaim>(key)) return { jobId: input.jobId, state: "lost" };
    if (this.ctx.storage.kv.get<JournalClaim>(key)?.state === "cancelled") {
      await this.#journalControl("cancel", input.jobId).catch(() => undefined);
      return state("cancelled");
    }
    return { jobId: input.jobId, state: "starting" };
  }

  /** Reading a journal never starts or restores a container. */
  async readExecution(jobId: string, after: number): Promise<JournalPage> {
    assertJournalJobId(jobId);
    if (!Number.isSafeInteger(after) || after < 0 || after > 4096) throw new Error("Invalid execution journal cursor.");
    const key = `execution-journal:${jobId}`;
    const claim = this.ctx.storage.kv.get<JournalClaim>(key);
    if (!claim) return emptyJournalPage(jobId, "lost", after, "No retained execution claim exists.");
    if (claim.state === "cancelled") return emptyJournalPage(jobId, "cancelled", after);
    if (!claim.epoch || await this.#journalEpoch() !== claim.epoch) {
      return emptyJournalPage(jobId, "lost", after, "Execution container was stopped or replaced.");
    }
    if (!this.ctx.storage.kv.get<JournalClaim>(key)) return emptyJournalPage(jobId, "lost", after, "Execution claim was removed.");
    if (this.ctx.storage.kv.get<JournalClaim>(key)?.state === "cancelled") return emptyJournalPage(jobId, "cancelled", after);
    let page: JournalPage;
    try {
      page = await this.#journalControl("read", jobId, after, claim);
      if (page.state === "starting" && Date.now() - claim.createdAt > JOURNAL_START_GRACE_MS) {
        page = emptyJournalPage(jobId, "lost", after, "Execution launch could not be confirmed.");
      }
    } catch (error) {
      if (!(error instanceof JournalIntegrityError)) throw new Error("Execution journal transport is unavailable.");
      page = emptyJournalPage(jobId, "lost", after, "Execution journal could not be read safely.");
    }
    if (!this.ctx.storage.kv.get<JournalClaim>(key)) return emptyJournalPage(jobId, "lost", after, "Execution claim was removed.");
    if (this.ctx.storage.kv.get<JournalClaim>(key)?.state === "cancelled") return emptyJournalPage(jobId, "cancelled", after);
    this.ctx.storage.kv.put(key, { ...claim, state: page.state });
    if (page.state === "exited") {
      const deadlines = this.ctx.storage.kv.get<Record<string, { deadline: number; epoch: string }>>(JOURNAL_DEADLINES_KEY) ?? {};
      delete deadlines[jobId];
      this.ctx.storage.kv.put(JOURNAL_DEADLINES_KEY, deadlines);
    }
    return page;
  }

  /** A sticky cancellation also fences a launch whose response was lost. */
  async cancelExecution(jobId: string): Promise<{ jobId: string; state: JournalState }> {
    assertJournalJobId(jobId);
    const key = `execution-journal:${jobId}`;
    const previous = this.ctx.storage.kv.get<JournalClaim>(key);
    if (previous && !["starting", "running", "cancelled"].includes(previous.state)) return { jobId, state: previous.state };
    const claim: JournalClaim = previous ?? { digest: null, deadline: Date.now(), createdAt: Date.now(), epoch: null, state: "cancelled" };
    this.ctx.storage.kv.put(key, { ...claim, state: "cancelled" });
    const epoch = await this.#journalEpoch();
    if (!this.ctx.storage.kv.get<JournalClaim>(key)) return { jobId, state: "lost" };
    if (epoch && (!claim.epoch || epoch === claim.epoch)) {
      await this.#journalControl("cancel", jobId).catch(() => undefined);
    }
    return { jobId, state: "cancelled" };
  }

  async #journalEpoch(): Promise<string | null> {
    if (!this.#container.running) return null;
    const info = await this.#container.inspect();
    const epoch = info?.labels?.[EXECUTION_EPOCH_LABEL];
    return typeof epoch === "string" && /^[a-f0-9-]{36}$/.test(epoch) ? epoch : null;
  }

  async #journalControl(action: "read" | "cancel", jobId: string, after = 0, claim?: JournalClaim): Promise<JournalPage> {
    const process = await this.#container.exec(["node", "-e", EXECUTION_JOURNAL_SOURCE, "--", action, jobId, String(after),
      ...(claim?.digest ? [claim.digest, String(claim.deadline)] : []),
    ], { env: TRUST_ENV });
    const output = await process.output();
    if (output.exitCode !== 0 || output.stdout.byteLength > JOURNAL_MAX_REPLY_BYTES) throw new JournalIntegrityError("Journal response is invalid or exceeds its limit.");
    let data: JournalPage;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output.stdout)) as JournalPage; }
    catch { throw new JournalIntegrityError("Journal response is invalid."); }
    if (action === "cancel") return data;
    if (!data || typeof data !== "object" || data.jobId !== jobId || !["starting", "running", "exited", "cancelled", "timed_out", "limited", "lost"].includes(data.state) ||
        !Array.isArray(data.frames) || data.frames.length > 64 || !Number.isSafeInteger(data.cursor) || data.cursor < after || data.cursor > 4096 ||
        typeof data.done !== "boolean" || (data.exitCode !== undefined && !Number.isSafeInteger(data.exitCode)) ||
        (data.state === "exited" && data.exitCode === undefined) ||
        ((data.state === "starting" || data.state === "running") && data.done) ||
        (data.error !== undefined && (typeof data.error !== "string" || data.error.length > 512))) throw new JournalIntegrityError("Invalid execution journal response.");
    if (data.frames.some((frame, index) => !frame || frame.sequence !== after + index + 1 || !["stdout", "stderr"].includes(frame.stream) ||
        typeof frame.dataBase64 !== "string" || frame.dataBase64.length > 5464) || data.cursor !== after + data.frames.length) {
      throw new JournalIntegrityError("Execution journal sequence changed.");
    }
    return data;
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
      const deadlines = this.ctx.storage.kv.get<Record<string, { deadline: number; epoch: string }>>(JOURNAL_DEADLINES_KEY) ?? {};
      const overdue = Object.entries(deadlines).filter(([, job]) => job.deadline + JOURNAL_DRAIN_GRACE_MS <= Date.now());
      if (overdue.length > 0) {
        const epoch = await this.#journalEpoch();
        if (overdue.some(([, job]) => job.epoch === epoch)) {
          // A vanished reader may never have copied the final receipt into KV.
          // Reconcile the surviving instance before treating its deadline as unfinished.
          for (const [jobId, job] of overdue) {
            if (job.epoch === epoch && this.ctx.storage.kv.get<JournalClaim>(`execution-journal:${jobId}`)?.state !== "exited") {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([this.readExecution(jobId, 0), new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error("Execution receipt reconciliation timed out.")), 2_000);
                })]);
              } finally {
                if (timer) clearTimeout(timer);
              }
            }
          }
          if (await this.#journalEpoch() !== epoch) {
            const retained = this.ctx.storage.kv.get<Record<string, { deadline: number; epoch: string }>>(JOURNAL_DEADLINES_KEY) ?? {};
            for (const [jobId, job] of overdue) if (job.epoch === epoch) delete retained[jobId];
            this.ctx.storage.kv.put(JOURNAL_DEADLINES_KEY, retained);
            await this.#armKeepalive();
            return;
          }
          const stillActive = overdue.some(([jobId, job]) => job.epoch === epoch && this.ctx.storage.kv.get<JournalClaim>(`execution-journal:${jobId}`)?.state !== "exited");
          if (!stillActive) {
            const retained = this.ctx.storage.kv.get<Record<string, { deadline: number; epoch: string }>>(JOURNAL_DEADLINES_KEY) ?? {};
            for (const [jobId] of overdue) delete retained[jobId];
            this.ctx.storage.kv.put(JOURNAL_DEADLINES_KEY, retained);
            await this.#armKeepalive();
            return;
          }
          await this.#container.destroy();
          for (const [jobId, job] of overdue) {
            if (job.epoch !== epoch) continue;
            const key = `execution-journal:${jobId}`;
            const claim = this.ctx.storage.kv.get<JournalClaim>(key);
            if (claim && claim.state !== "exited") this.ctx.storage.kv.put(key, { ...claim, state: claim.state === "cancelled" ? "cancelled" : "timed_out" });
          }
          return;
        }
        const retained = this.ctx.storage.kv.get<Record<string, { deadline: number; epoch: string }>>(JOURNAL_DEADLINES_KEY) ?? {};
        for (const [jobId] of overdue) delete retained[jobId];
        this.ctx.storage.kv.put(JOURNAL_DEADLINES_KEY, retained);
      }
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
    this.ctx.storage.kv.put(JOURNAL_DEADLINES_KEY, {});
    if (snapshotId) {
      this.#container.start({
        containerSnapshot: { id: snapshotId },
        enableInternet: false,
        instance: instanceType,
        labels: { [EXECUTION_EPOCH_LABEL]: crypto.randomUUID() },
      });
    } else {
      this.#container.start({
        image: this.#container.images.sandbox,
        enableInternet: false,
        instance: instanceType,
        labels: { [EXECUTION_EPOCH_LABEL]: crypto.randomUUID() },
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
    const deadlines = this.ctx.storage.kv?.get<Record<string, { deadline: number }>>(JOURNAL_DEADLINES_KEY) ?? {};
    const nextDeadline = Math.min(...Object.values(deadlines).map((job) => job.deadline + JOURNAL_DRAIN_GRACE_MS));
    const now = Date.now();
    const next = nextDeadline <= now ? now + 5_000 : Math.min(now + KEEPALIVE_ALARM_MS, nextDeadline);
    await this.ctx.storage.setAlarm(next);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
