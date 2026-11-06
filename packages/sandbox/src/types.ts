/**
 * Capability flags document what a backend may assume. Missing features must not
 * be faked — callers check flags and refuse or degrade explicitly.
 */
export interface SandboxCapabilities {
  /** Outbound HTTP(S) from the container is filtered at the Worker/edge (credentials never inside). */
  edgeEgressEnforcement: boolean;
  /** Token-gated preview URLs for exposed ports (browser E2E, screenshots). */
  previewUrls: boolean;
  /** Resume a container from a provider snapshot (optional on instances). */
  snapshots: boolean;
  /** `exec` may stream stdout/stderr incrementally. */
  streamingExec: boolean;
  /** `startProcess` + `waitForPort` for dev servers inside the sandbox. */
  backgroundProcesses: boolean;
  /** `raw()` exposes the provider-native handle (e.g. ComputeSDK `Instance`). */
  rawProviderHandle: boolean;
  /** Durable attachable storage beyond the container filesystem (optional). */
  persistentVolumes?: boolean;
  /** A surviving container can retain and reread one supervised execution. */
  journaledExec?: boolean;
}

export type BuiltinSandboxProviderId = "cloudflare" | "docker-local" | "e2b" | "computesdk";
/** Built-in ids or any name passed to `registerSandboxProvider`. */
export type SandboxProviderId = BuiltinSandboxProviderId | (string & {});

export interface SandboxEgressPin {
  allowedHosts: string[];
  /** Host → named outbound handler (Cloudflare SandboxOutbound only today). */
  outboundByHost?: Record<
    string,
    { handler: string; params?: Record<string, string> }
  >;
  /** GitHub REST scope: allowed repo path prefix, e.g. `/owner/repo`. */
  githubRepoPath?: string;
  /** Org context for per-org model key and egress handling. */
  orgId?: string;
  /** Authenticated user whose credentials may be attached at egress. */
  initiatorUserId?: string;
  /** Frozen AI Gateway BYOK alias from the approved model connection. */
  gatewayByokAlias?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type JournalState = "starting" | "running" | "exited" | "cancelled" | "timed_out" | "limited" | "lost";

export interface JournalExecutionInput {
  jobId: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  deadline: number;
}

export interface JournalFrame {
  sequence: number;
  stream: "stdout" | "stderr";
  dataBase64: string;
}

export interface JournalPage {
  jobId: string;
  state: JournalState;
  frames: JournalFrame[];
  cursor: number;
  done: boolean;
  exitCode?: number;
  error?: string;
}

export interface JournalExecutionOptions {
  jobId: string;
  deadline: number;
  /** Attach only reads an existing claim and never launches, even if the claim is absent. */
  mode?: "start" | "attach";
  /** Original approved run expiry. Attach may observe an already completed CLI after its deadline. */
  observationDeadline?: number;
}

export type ReadFileResult =
  | { kind: "utf8"; content: string }
  | { kind: "base64"; content: string };

export interface ExposePortOptions {
  /** Public hostname used to mint preview URLs (no scheme). */
  hostname: string;
}

export interface BackgroundProcess {
  waitForPort(port: number, options?: { timeoutMs?: number }): Promise<void>;
  kill(): Promise<void>;
}

/**
 * One live sandbox instance (per run id). Providers resolve by id — shiba mints
 * the id before approval; `get` materializes the backing container/DO on first use.
 */
export interface SandboxInstance {
  readonly id: string;
  readonly capabilities: SandboxCapabilities;

  pinEgress?(pin: SandboxEgressPin): Promise<void>;

  gitCheckout(repoUrl: string, opts: { branch: string; targetDir: string }): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  writeFileStream?(path: string, body: ReadableStream<Uint8Array>): Promise<void>;
  readFile(path: string, opts?: { maxBytes?: number; signal?: AbortSignal }): Promise<ReadFileResult>;
  readFileStream?(path: string): Promise<ReadableStream<Uint8Array>>;

  exec(
    command: string,
    opts?: {
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      signal?: AbortSignal;
      onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
      onJournalFrame?: (frame: JournalFrame) => Promise<void>;
      /** Refuse generic execution unless this completed journal still owns the same native container. */
      requiredJournalJobId?: string;
      /** Other providers retain their ordinary single-attempt execution behavior. */
      journal?: JournalExecutionOptions;
    },
  ): Promise<ExecResult>;

  exposePort?(port: number, options: ExposePortOptions): Promise<{ url: string }>;
  unexposePort?(port: number): Promise<void>;
  startProcess?(command: string, options?: { cwd?: string }): Promise<BackgroundProcess>;
  snapshot?(name?: string): Promise<{ id: string; size: number } | null>;

  destroy(): Promise<void>;

  /**
   * Provider-native escape hatch. Only available when `capabilities.rawProviderHandle`
   * is true; otherwise throws `SandboxError` `capability_unsupported`.
   */
  raw?<T = unknown>(): T;
}

/** Minimal port surface for browser-E2E / screenshot flows (PreviewPortGateway seam). */
export interface PreviewPortGateway {
  exposePort(port: number, options: ExposePortOptions): Promise<{ url: string }>;
  unexposePort(port: number): Promise<void>;
}

export interface SandboxProvider {
  readonly id: SandboxProviderId;
  readonly capabilities: SandboxCapabilities;

  /** Resolve (and lazily start) an instance by run sandbox id. */
  get(instanceId: string): Promise<SandboxInstance>;
  /** Tear down backing resources; idempotent. */
  destroy(instanceId: string): Promise<void>;
}

export interface ResolveSandboxProviderOptions {
  providerId?: string | undefined;
  /** When false and the adapter lacks edge egress, resolution throws. */
  allowUnenforcedEgress?: boolean;
}

export type SandboxProviderFactory = (
  options: ResolveSandboxProviderOptions,
) => SandboxProvider | Promise<SandboxProvider>;
