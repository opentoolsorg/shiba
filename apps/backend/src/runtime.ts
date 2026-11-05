import { onboardingSourceInstructions } from "@shiba/shared";
import type { JournalExecutionOptions, JournalFrame } from "@shiba/sandbox";
import { approvedRuntimeIdentity, assertPreparedRuntimeExecution, runtimeIdentity, type PreparedRuntimeExecution } from "./runtime-recovery.js";
/**
 * Runtime adapter seam. The default adapter wraps the Sandbox SDK.
 * An experimental adapter for @cloudflare/computer exists only as a
 * guarded refusal: Computer is preview-only, so it must never silently
 * replace the default Sandbox path.
 *
 * What agent runs inside the sandbox is a second, narrower seam:
 * AgentHarness (src/harness/types.ts). SandboxRuntimeAdapter keeps
 * clone → configure → run → collect; only config, argv, and event parsing
 * are harness-dispatched (default: OpenCode).
 */

import type { RunSignal, RunSignalKind, RunUsage } from "@shiba/shared";
import {
  buildLocalRunEnvelope,
  expectedDeliverablesSchema,
  MAX_DELIVERABLE_BYTES,
  type LocalRunResult,
  mergeRunUsage,
  RUN_SIGNAL_KINDS,
  isEphemeralWorkspace,
  personalExecutionClaimSchema,
} from "@shiba/shared";
import {
  verifyExpectedDeliverables,
  isWorkspaceArtifactPath,
  MAX_WORKSPACE_ARTIFACT_FILES,
  MAX_WORKSPACE_ARTIFACT_BYTES,
  MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES,
} from "./run-deliverables.js";
import { ScopedExecRefusal, scopedExec } from "./exec-allowlist.js";
import { captureLiveDiff } from "./live-diff.js";
import {
  captureCheckpoint,
  checkpointRef,
  pruneCheckpoints,
} from "./git-checkpoint.js";
import { AcpErrorEvent, AcpEventError } from "./harness/acp.js";
import { AGENT_HARNESS_SOURCE } from "./harness/agent-harness-source.js";
import { AntigravityErrorEvent } from "./harness/antigravity.js";
import { AntigravityUsageLimitError } from "./harness/antigravity-subscription.js";
import { ClaudeCodeErrorEvent } from "./harness/claude-code.js";
import { ClaudeUsageLimitError } from "./harness/claude-subscription.js";
import { CodexErrorEvent } from "./harness/codex.js";
import { CodexUsageLimitError } from "./harness/codex-subscription.js";
import { CursorErrorEvent } from "./harness/cursor.js";
import { GrokErrorEvent } from "./harness/grok.js";
import {
  OpenCodeErrorEvent as OpenCodeErrorEventImpl,
  opencodeHarness,
} from "./harness/opencode.js";
import { PiErrorEvent, PiEventError } from "./harness/pi.js";
import { HARNESS_RETRY, withRetry } from "./harness/retry.js";
import type { AgentHarness } from "./harness/types.js";
import type { CodingTaskInput, CodingTaskResult } from "./opencode-input.js";
import { DUMMY_PROVIDER_KEY } from "./provider-gateway.js";
import { runRepoSetup, setupOverlap } from "./repo-setup.js";
import { boundTail, redactSecrets, shellJoin } from "./security.js";

function sessionProvider(name: string): "codex" | "claude" | null {
  if (name === "codex") return "codex";
  if (name === "claude-code" || name === "claude-subscription" || name === "claude-login")
    return "claude";
  return null;
}

/** `provider/model` → the bare id the CLI accepts. */
function bareModelId(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

export const MAX_DIFF_CHARS = 120_000;
export const MAX_STDERR_TAIL_CHARS = 8_000;
export const MAX_STDOUT_TAIL_CHARS = 30_000;
export const MAX_CAPTURED_FILES = 50;
export const MAX_FILE_CHARS = 100_000;
export const MAX_TOTAL_FILE_CHARS = 500_000;
export const OPENCODE_TIMEOUT_MS = 15 * 60 * 1000;
export const GIT_TIMEOUT_MS = 5 * 60 * 1000;
export const TEST_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
// T46: the test tail quoted into the PR body is bounded — enough for a
// reviewer to see the verdict lines, never a whole log.
export const TEST_EVIDENCE_TAIL_CHARS = 4000;
export const MAX_PROGRESS_EVENTS = 256;

/** Largest pending (no-newline-yet) stdout line the stream parser buffers
 * before dropping it. Structured records bigger than this are reported
 * honestly instead of buffered unboundedly or chopped into fake events. */
export const MAX_STREAM_LINE_CHARS = 1_048_576;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxOps {
  /** True only for a provider with native attach-only execution journals. */
  journaledExec?: boolean;
  supportsJournal?: () => Promise<boolean>;
  /** Pin only the selected model/provider hosts, with no GitHub repository scope. */
  pinEgress?(): Promise<void>;
  gitCheckout(repoUrl: string, opts: { branch: string; targetDir: string }): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  exec(
    command: string,
    opts?: {
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      signal?: AbortSignal;
      onOutput?: (stream: "stdout" | "stderr", data: string) => void;
      /**
       * Per-stream output cap override — T45 enforced either way; raise it
       * for commands whose full output is the payload (e.g. diff export).
       */
      maxOutputChars?: number;
      journal?: JournalExecutionOptions;
      onJournalFrame?: (frame: JournalFrame) => Promise<void>;
      requiredJournalJobId?: string;
    },
  ): Promise<ExecResult>;
  readFile(
    path: string,
    opts?: { maxBytes?: number; signal?: AbortSignal },
  ): Promise<{ kind: "utf8"; content: string } | { kind: "base64"; content: string }>;
}

export interface ProgressEvent {
  phase: "clone" | "configure" | "code" | "collect";
  message: string;
  fraction: number;
}

export type ProgressEmitter = (event: ProgressEvent) => void | Promise<void>;

export interface RuntimeAdapter {
  readonly name: "sandbox" | "computer" | "local";
  runCodingTask(
    ops: SandboxOps,
    input: CodingTaskInput,
    emit: ProgressEmitter,
    opts?: {
      signal?: AbortSignal;
      /** T68: approved per-run env, already opened. Harness env wins on any shared key. */
      env?: Record<string, string>;
      /** T68: applied to sandbox output before truncation, so a cut can't leave part of a value behind. */
      scrub?: (text: string) => string;
      /**
       * T42 run-signal collector: the adapter appends each milestone it
       * crosses, in order, and the result envelope carries the same list
       * back to the orchestrator. Callers that pass no collector still get
       * `result.signals`.
       */
      signals?: RunSignal[];
      /**
       * T44: durable export for an oversize diff (Worker-side R2 hook).
       * Called with the full diff before boundTail caps it; the returned
       * storage key is receipted as `diff.exported`.
       */
      exportDiff?: (diff: string) => Promise<string>;
      onTerminal?: (stream: "stdout" | "stderr", data: string) => void;
      onDiff?: (diff: string) => void;
      onDiffPreviewStatus?: (status: "limited" | "unavailable", reason?: string) => void;
      onStreamGap?: () => void;
      approvedInput?: CodingTaskInput;
      recovery?: PreparedRuntimeExecution;
      onPrepared?: (record: PreparedRuntimeExecution) => Promise<void>;
      onSettlementStarted?: () => Promise<void>;
      onJournalFrame?: (frame: JournalFrame) => Promise<void>;
      onJournalEnd?: (exitCode?: number) => Promise<void>;
    },
  ): Promise<CodingTaskResult>;
}

/**
 * T49: setupCommands run through their own argv-prefix allowlist — home
 * layout materialization needs mkdir/symlink and nothing else. Disjoint
 * from the harness/test-command allowlist on purpose.
 */
// Harness-declared setup ops only — never model-controlled. `chmod` is
// for credential-dir modes (T50 profile dirs must be 0700).
const SETUP_COMMAND_ALLOWLIST: readonly (readonly string[])[] = [["mkdir"], ["ln"], ["chmod"]];

/**
 * Interpreter argv0s that cannot identify a harness by themselves —
 * `["node"]` on the allowlist would admit every node invocation in the
 * sandbox. When a harness argv leads with one of these (the ACP lanes run
 * `node <driver>.cjs`), the allowlist entry is argv[0..1] — interpreter +
 * script path — not bare argv0. Single-binary harnesses (opencode, claude,
 * codex, devin…) keep argv0 alone: that IS the harness binary.
 */
const EXEC_INTERPRETERS: ReadonlySet<string> = new Set([
  "node",
  "nodejs",
  "deno",
  "bun",
  "python",
  "python3",
]);

export const COMPUTER_PREVIEW_MESSAGE =
  "@cloudflare/computer is preview-only and not production-ready, so it is disabled. " +
  "Set RUNTIME=sandbox (the default) or wait for Computer to graduate from preview. " +
  "Sandbox remains the default isolated repository runtime.";

// A fixed adapter-owned reader transports Git object bytes as ASCII. The
// scoped allowlist permits only this exact script, never arbitrary node -e.
export const DELIVERABLE_BLOB_READER = `const {spawnSync}=require("node:child_process");const id=process.argv[1];if(!/^[a-f0-9]{40,64}$/.test(id||""))process.exit(2);const out=spawnSync("git",["--no-replace-objects","cat-file","blob",id],{maxBuffer:16385,timeout:60000});if(out.error||out.status!==0||out.stdout.length>16384)process.exit(1);process.stdout.write(out.stdout.toString("base64"));`;

export const WORKSPACE_MANIFEST_READER = `const {spawnSync}=require("node:child_process");const ref=process.argv[1];if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64}|refs\\/shiba\\/checkpoints\\/[A-Za-z0-9_-]+\\/[0-9]+)$/.test(ref||""))process.exit(2);const out=spawnSync("git",["--no-replace-objects","ls-tree","-r","-z",ref,"--","out"],{maxBuffer:65537,timeout:60000});if(out.error||out.status!==0||out.stdout.length>65536)process.exit(1);process.stdout.write(JSON.stringify({tree:out.stdout.toString("base64")}));`;
const WORKSPACE_BLOB_CHUNK_BYTES = 196_608;
export const WORKSPACE_BLOB_READER = `const {spawnSync}=require("node:child_process");const id=process.argv[1],offset=Number(process.argv[2]);if(!/^[a-f0-9]{40,64}$/.test(id||"")||!Number.isSafeInteger(offset)||offset<0||offset>1048576)process.exit(2);const out=spawnSync("git",["--no-replace-objects","cat-file","blob",id],{maxBuffer:1048577,timeout:60000});if(out.error||out.status!==0||out.stdout.length>1048576)process.exit(1);process.stdout.write(out.stdout.subarray(offset,offset+196608).toString("base64"));`;

// Raw, NUL-delimited records preserve spaces, Unicode, and rename/delete paths.
// Both endpoints are immutable OIDs returned before/after the harness turn;
// neither the working tree, HEAD, nor mutable checkpoint refs are consulted.
export const REPOSITORY_MANIFEST_READER = `const {spawnSync}=require("node:child_process");const refs=process.argv.slice(1);if(refs.length!==2||refs.some(ref=>!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref)))process.exit(2);const out=spawnSync("git",["--no-replace-objects","-c","core.fsmonitor=false","diff-tree","--raw","--no-commit-id","--no-renames","-r","-z",...refs,"--"],{maxBuffer:65537,timeout:60000});if(out.error||out.status!==0||out.stdout.length>65536)process.exit(1);process.stdout.write(JSON.stringify({changes:out.stdout.toString("base64")}));`;
export const REPOSITORY_BLOB_READER = `const {spawnSync}=require("node:child_process");const id=process.argv[1];if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id||""))process.exit(2);const out=spawnSync("git",["--no-replace-objects","cat-file","blob",id],{maxBuffer:100001,timeout:60000});if(out.error||out.status!==0||out.stdout.length>100000)process.exit(1);process.stdout.write(out.stdout.toString("base64"));`;

export class SandboxRuntimeAdapter implements RuntimeAdapter {
  readonly name = "sandbox" as const;
  private readonly harness: AgentHarness;

  constructor(harness: AgentHarness = opencodeHarness) {
    this.harness = harness;
  }

  async runCodingTask(
    ops: SandboxOps,
    input: CodingTaskInput,
    emit: ProgressEmitter,
    opts?: {
      signal?: AbortSignal;
      env?: Record<string, string>;
      scrub?: (text: string) => string;
      signals?: RunSignal[];
      exportDiff?: (diff: string) => Promise<string>;
      onTerminal?: (stream: "stdout" | "stderr", data: string) => void;
      onDiff?: (diff: string) => void;
      onDiffPreviewStatus?: (status: "limited" | "unavailable", reason?: string) => void;
      onStreamGap?: () => void;
      approvedInput?: CodingTaskInput;
      recovery?: PreparedRuntimeExecution;
      onPrepared?: (record: PreparedRuntimeExecution) => Promise<void>;
      onSettlementStarted?: () => Promise<void>;
      onJournalFrame?: (frame: JournalFrame) => Promise<void>;
      onJournalEnd?: (exitCode?: number) => Promise<void>;
    },
  ): Promise<CodingTaskResult> {
    throwIfAborted(opts?.signal);
    const approvedInput = opts?.approvedInput ?? input;
    input = withDeliverableInstructions(input);
    const ephemeral = isEphemeralWorkspace(input.executionTarget);
    const workdir = ephemeral ? "/workspace" : `/workspace/${input.sandboxId}`;
    const configValue = this.harness.configFile(input, input.sandboxId);
    const configFiles =
      configValue === null ? [] : Array.isArray(configValue) ? configValue : [configValue];
    const config = configFiles[0] ?? null;
    const signals = opts?.signals ?? [];
    const milestone = (kind: RunSignalKind, detail?: string) => {
      signals.push(
        detail !== undefined ? { kind, at: Date.now(), detail } : { kind, at: Date.now() },
      );
    };
    const scrub = opts?.scrub ?? ((text: string) => text);

    // T45: every exec this run sends to the sandbox goes through the scoped
    // executor — argv-prefix allowlist (adapter-internal git + the harness's
    // own argv prefix + its declared execAllowlist), timeout, output cap, receipts.
    const capabilities = this.harness.capabilities(input.codingModel);
    const harnessArgv = this.harness.buildArgv(input, workdir);
    const sessionKind = sessionProvider(this.harness.name);
    const sessionScript =
      sessionKind === null ? null : `/workspace/${input.sandboxId}.agent-harness.mjs`;
    // The harness's own argv prefix leads the allowlist (see
    // EXEC_INTERPRETERS): interpreter-prefixed argv like `node driver.cjs`
    // contributes interpreter + script, a bare binary just itself.
    const argv0 = harnessArgv[0] as string;
    const harnessExecPrefix =
      harnessArgv.length > 1 && EXEC_INTERPRETERS.has(argv0.split("/").pop() ?? "")
        ? harnessArgv.slice(0, 2)
        : [argv0];
    const allowlist: readonly (readonly string[])[] = [
      ["git"],
      ["node", "-e", REPOSITORY_MANIFEST_READER],
      ["node", "-e", REPOSITORY_BLOB_READER],
      ...(input.expectedDeliverables?.length ? [["node", "-e", DELIVERABLE_BLOB_READER] as const] : []),
      ...(ephemeral ? [
        ["node", "-e", WORKSPACE_MANIFEST_READER] as const,
        ["node", "-e", WORKSPACE_BLOB_READER] as const,
      ] : []),
      harnessExecPrefix,
      ...(sessionScript !== null ? [["node", sessionScript] as const] : []),
      ...capabilities.execAllowlist,
    ];
    let settlementJournalJobId = opts?.recovery?.jobId;
    const scoped: SandboxOps = {
      ...ops,
      exec: (command, execOpts) =>
        scopedExec(ops, command, {
          cwd: execOpts?.cwd,
          env: execOpts?.env,
          signal: execOpts?.signal,
          onOutput: execOpts?.onOutput,
          timeoutMs: execOpts?.timeoutMs,
          maxOutputChars: execOpts?.maxOutputChars,
          journal: execOpts?.journal,
          onJournalFrame: execOpts?.onJournalFrame,
          requiredJournalJobId: settlementJournalJobId ?? execOpts?.requiredJournalJobId,
          allowlist,
          signals,
        }),
    };

    const sessionFiles: Array<{ path: string; contents: string }> = [];
    let argv = harnessArgv;
    if (sessionScript !== null && sessionKind !== null) {
      const jobPath = `/workspace/${input.sandboxId}.job.json`;
      // The job file is the prompt and the mode. Provider keys stay in the
      // process env the sandbox already injects; they are not written here.
      const job = {
        provider: sessionKind,
        cwd: workdir,
        model: bareModelId(input.codingModel),
        ...(input.route?.reasoningEffort ? { reasoningEffort: input.route.reasoningEffort } : {}),
        prompt: input.task,
        permissionMode: "accept-edits",
        checkpoints: true,
        logDir: "/tmp/shiba-sessions",
      };
      sessionFiles.push({ path: sessionScript, contents: AGENT_HARNESS_SOURCE }, { path: jobPath, contents: `${JSON.stringify(job)}\n` });
      argv = ["node", sessionScript, jobPath];
    }
    let executionEnv: Record<string, string>;
    let setupCommands: readonly (readonly string[])[];
    let commandIdentity: string;
    let jobId: string;
    try {
      executionEnv = { ...opts?.env, ...this.harness.env(input, config?.path ?? null) };
      setupCommands = this.harness.setupCommands?.(input, workdir) ?? [];
      commandIdentity = await runtimeIdentity({ command: shellJoin(argv), workdir, configFiles, sessionFiles,
        setupCommands, env: executionEnv });
      jobId = await runtimeIdentity([
        "shiba:execution-journal:v1", input.sandboxId, input.dispatchApprovalId ?? "", input.dispatchInputHash ?? "", this.harness.name,
      ]);
    } catch (error) {
      throwIfAborted(opts?.signal);
      if (opts?.recovery) throw error;
      return failureResult(`${this.harness.name} configuration failed: ${shortError(error, scrub)}`, 0, "", signals);
    }
    let baseRevision: string | undefined;
    let setupCommit: string | null = null;
    let baselineCommit: string;
    let deadline: number;
    const baselineRef = checkpointRef(input.sandboxId, 0);
    const settleRef = checkpointRef(input.sandboxId, 1);
    const journalSupported = ops.supportsJournal ? await ops.supportsJournal() : ops.journaledExec === true;
    if (opts?.recovery) {
      if (!journalSupported || (input.sandboxProvider !== undefined && input.sandboxProvider !== "cloudflare")) {
        throw new Error("Prepared execution recovery requires a Cloudflare native journal. No command was launched.");
      }
      const record = await assertPreparedRuntimeExecution(opts.recovery, approvedInput,
        { harness: this.harness.name, workdir, commandIdentity, jobId });
      baseRevision = record.baseRevision ?? undefined;
      baselineCommit = record.baselineCommit;
      setupCommit = record.setupCommit;
      deadline = record.deadline;
      await emit({ phase: "code", message: `Reattaching to the existing ${this.harness.name} execution.`, fraction: 0.25 });
    } else {
      throwIfAborted(opts?.signal);
      if (input.executionTarget?.kind === "artifact-workspace") {
        await emit({ phase: "clone", message: "Preparing an isolated artifact workspace.", fraction: 0.05 });
        milestone("sandbox.ready", input.sandboxId);
        try {
          if (!ops.pinEgress) throw new Error("Sandbox provider cannot pin artifact-workspace egress.");
          await ops.pinEgress();
          const init = await scoped.exec(shellJoin(["git", "init", "--initial-branch=main", workdir]), { cwd: "/workspace", signal: opts?.signal });
          if (init.exitCode !== 0) throw new Error(boundTail(scrub(init.stderr), 1000) || "git init failed.");
          if (ephemeral) {
            const directories = await scopedExec(ops, shellJoin(["mkdir", "-p", `${workdir}/.shiba`, `${workdir}/out`]), {
              cwd: workdir, signal: opts?.signal, allowlist: [["mkdir", "-p"]], signals,
            });
            if (directories.exitCode !== 0) throw new Error("Could not initialize workspace directories.");
            await ops.writeFile(`${workdir}/.shiba/context.json`, `${JSON.stringify({
              workspaceId: input.executionTarget.kind === "artifact-workspace" ? input.executionTarget.workspaceId : undefined,
              template: input.executionTarget.kind === "artifact-workspace" ? input.executionTarget.template : undefined,
              outputDirectory: "/workspace/out",
            })}\n`);
          }
          const baseline = await scoped.exec(shellJoin(["git", "-C", workdir, "-c", "user.name=shiba", "-c", "user.email=shiba@shiba.local", "commit", "--allow-empty", "-m", "shiba artifact workspace baseline"]), { cwd: "/workspace", signal: opts?.signal });
          if (baseline.exitCode !== 0) throw new Error(boundTail(scrub(baseline.stderr), 1000) || "Could not initialize artifact workspace baseline.");
          milestone("clone.complete", "artifact-workspace");
        } catch (error) {
          return failureResult(`Artifact workspace initialization failed: ${shortError(error, scrub)}`, 0, "", signals);
        }
      } else {
        await emit({
          phase: "clone",
          message: `Cloning ${input.repoUrl} (branch ${input.baseBranch}).`,
          fraction: 0.05,
        });
        // The ops handle being bound is the readiness claim; egress pinning
        // runs inside this first call as one retried unit with the clone.
        milestone("sandbox.ready", input.sandboxId);
        try {
          await ops.gitCheckout(input.repoUrl, { branch: input.baseBranch, targetDir: workdir });
          milestone("clone.complete", input.baseBranch);
        } catch (error) {
          return failureResult(`Clone failed: ${shortError(error, scrub)}`, 0, "", signals);
        }
      }

      // Freeze the cloned GitHub parent before setup or the harness can move HEAD.
      // Publication must never re-resolve a mutable branch after execution.
      if (input.executionTarget?.kind !== "artifact-workspace") {
        try {
          const head = await scoped.exec(shellJoin(["git", "--no-replace-objects", "rev-parse", "--verify", "HEAD^{commit}"]), {
            cwd: workdir, timeoutMs: GIT_TIMEOUT_MS, signal: opts?.signal,
          });
          if (head.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout.trim())) {
            throw new Error("Cloned repository has no immutable GitHub base revision.");
          }
          baseRevision = head.stdout.trim();
        } catch (error) {
          return failureResult(`Repository base revision capture failed: ${shortError(error, scrub)}`, 0, "", signals);
        }
      }

      // T72: only when the human opted in; before the baseline so installs and generated files aren't part of the change.
      if (input.runSetup === true) {
        const setup = await runRepoSetup(ops, workdir, {
          ...(opts?.env !== undefined ? { env: opts.env } : {}),
          scrub,
          signals,
          signal: opts?.signal,
          emit,
        });
        if (setup.failure !== null) return failureResult(setup.failure, 0, "", signals);
        setupCommit = setup.commit;
      }

      // T44: baseline checkpoint — the whole worktree at post-clone, before
      // any harness mutation, under a hidden ref that dies with the sandbox.
      try {
        baselineCommit = await captureCheckpoint(scoped, workdir, input.sandboxId, 0, opts?.signal);
        if (!isGitObjectId(baselineCommit)) throw new Error("Baseline checkpoint has no immutable commit identity.");
        milestone("checkpoint.captured", baselineRef);
      } catch (error) {
        return failureResult(`Baseline checkpoint failed: ${shortError(error, scrub)}`, 0, "", signals);
      }

      await emit({
        phase: "configure",
        message: `Writing isolated ${this.harness.name} config.`,
        fraction: 0.15,
      });
      throwIfAborted(opts?.signal);
      try {
        // T49: directory-shaped harnesses materialize their home layout first
        // (mkdir/symlink ops only — a dedicated allowlist disjoint from the
        // harness's test-command one; these commands are harness-declared,
        // never model-controlled).
        for (const argv of setupCommands) {
          const result = await scopedExec(ops, shellJoin(argv), {
            allowlist: SETUP_COMMAND_ALLOWLIST,
            signals,
            signal: opts?.signal,
          });
          if (result.exitCode !== 0) {
            return failureResult(
              `Home layout setup failed (${argv.join(" ")}): ${boundTail(scrub(result.stderr), 500)}`,
              0,
              "",
              signals,
            );
          }
        }
        for (const file of configFiles) {
          await ops.writeFile(file.path, file.contents);
        }
        milestone("config.written", config?.path ?? "none");
      } catch (error) {
        return failureResult(`Config write failed: ${shortError(error, scrub)}`, 0, "", signals);
      }

      await emit({
        phase: "code",
        message: `Running ${this.harness.name} headlessly.`,
        fraction: 0.25,
      });
      throwIfAborted(opts?.signal);
      for (const file of sessionFiles) await ops.writeFile(file.path, file.contents);
      const preparedAt = Date.now();
      deadline = Math.min(preparedAt + OPENCODE_TIMEOUT_MS, input.dispatchExpiresAt ?? Number.POSITIVE_INFINITY);
      if (opts?.onPrepared && journalSupported && (input.sandboxProvider === undefined || input.sandboxProvider === "cloudflare")) {
        const approved = await approvedRuntimeIdentity(approvedInput);
        await opts.onPrepared({ version: 1, phase: "harness", provider: "cloudflare", sandboxId: input.sandboxId,
          harness: this.harness.name, workdir, ...approved, commandIdentity, jobId, preparedAt, deadline,
          baseRevision: baseRevision ?? null, baselineCommit, setupCommit });
      }
    }
    let run: ExecResult;
    let harnessDispatched = false;
    let harnessSettled = false;
    let uncertainTransport = false;
    let settledCommit: string;
    const output = streamProgress(this.harness, emit, opts?.signal, scrub);
    const stopLiveDiff = opts?.onDiff && !ephemeral && !opts.recovery
      ? startLiveDiff(ops, workdir, baselineCommit, opts.onDiff, scrub, signals, opts.signal, opts.onDiffPreviewStatus)
      : async () => {};
    try {
      throwIfAborted(opts?.signal);
      milestone("harness.started", this.harness.name);
      // A silent CLI may already have performed work. A lost execution
      // response never authorizes another launch of the approved task.
      harnessDispatched = true;
      run = await scoped.exec(shellJoin(argv), {
        cwd: workdir,
        timeoutMs: OPENCODE_TIMEOUT_MS,
        journal: { jobId, deadline, ...(opts?.recovery ? { mode: "attach" as const, observationDeadline: opts.recovery.recoveryDeadline } : {}) },
        onJournalFrame: opts?.onJournalFrame,
        signal: opts?.signal,
        onOutput: (stream, data) => {
          output.onData(stream, data);
          opts?.onTerminal?.(stream, scrub(data));
        },
        env: executionEnv,
      });
      harnessSettled = true;
      if (journalSupported) settlementJournalJobId = jobId;
      // The harness process resolved — idle covers clean exits and
      // nonzero verdicts alike; a thrown error means it never went idle.
      milestone("harness.idle", `exitCode:${run.exitCode}`);
      await output.finish();
      await opts?.onJournalEnd?.(run.exitCode);
      throwIfAborted(opts?.signal);
      // Persist this fence before any checkpoint, collection or test mutation.
      await opts?.onSettlementStarted?.();
      throwIfAborted(opts?.signal);
      // T44: settle checkpoint — captures the harness's mutations (incl.
      // untracked files) so the turn diff is baseline→settle commit-diff.
      settledCommit = await captureCheckpoint(scoped, workdir, input.sandboxId, 1, opts?.signal);
      if (!isGitObjectId(settledCommit)) {
        throw new Error("Settled workspace checkpoint has no immutable commit identity.");
      }
      milestone("checkpoint.captured", settleRef);
      await pruneCheckpoints(scoped, workdir, input.sandboxId, 4, opts?.signal);
    } catch (error) {
      await output.finish();
      throwIfAborted(opts?.signal);
      if (
        error instanceof OpenCodeErrorEventImpl ||
        error instanceof ClaudeCodeErrorEvent ||
        error instanceof CodexErrorEvent ||
        error instanceof GrokErrorEvent ||
        error instanceof PiErrorEvent ||
        error instanceof PiEventError ||
        error instanceof CursorErrorEvent ||
        error instanceof AcpErrorEvent ||
        error instanceof AcpEventError ||
        error instanceof ClaudeUsageLimitError ||
        error instanceof CodexUsageLimitError ||
        error instanceof AntigravityUsageLimitError ||
        error instanceof AntigravityErrorEvent
      ) {
        return failureResult(error.message, 0, "", signals, output.usage);
      }
      uncertainTransport = harnessDispatched && !harnessSettled && !(error instanceof ScopedExecRefusal);
      return failureResult(
        `${uncertainTransport ? "Harness transport failed before its outcome was confirmed. Execution outcome is uncertain. " : ""}${this.harness.name} execution failed: ${shortError(error, scrub)}`,
        0,
        "",
        signals,
        output.usage,
        uncertainTransport || (journalSupported && harnessSettled) ? "outcome_unknown" : undefined,
      );
    } finally {
      if (uncertainTransport) opts?.onStreamGap?.();
      await stopLiveDiff();
    }
    const stderrTail = redactSecrets(boundTail(scrub(run.stderr), MAX_STDERR_TAIL_CHARS));
    if (run.exitCode !== 0) {
      // stderr is the only diagnostic a harness failure carries; fold the tail
      // into the summary so the run record shows why the CLI died.
      const detail = stderrTail.trim();
      return failureResult(
        `${this.harness.name} exited with code ${run.exitCode}.${detail ? ` stderr: ${boundTail(detail, 1500)}` : ""}`,
        run.exitCode,
        stderrTail,
        signals,
        output.usage,
      );
    }

    await emit({ phase: "collect", message: "Collecting changed files and diff.", fraction: 0.85 });
    // Abort stays allowed here: collection is read-side only — no external
    // write exists between the harness exec and the returned result.
    throwIfAborted(opts?.signal);
    try {
      const collection = await withRetry(
        HARNESS_RETRY,
        () => ephemeral
          ? collectWorkspaceChanges(scoped, workdir, settledCommit, opts?.signal)
          : collectRepositoryChanges(scoped, workdir, baselineCommit, settledCommit, {
            signal: opts?.signal,
            expectedDeliverables: input.expectedDeliverables,
            exportDiff: opts?.exportDiff,
            onDiffExported: (key) => milestone("diff.exported", key),
          }),
        opts?.signal,
      );
      milestone("collect.complete", `${collection.changedFiles.length} files`);
      opts?.onDiff?.(scrub(collection.diff));
      // A path both setup and the agent changed would publish setup's edits (and anything it wrote) as the agent's.
      let overlap: string[] = [];
      if (setupCommit !== null) {
        try {
          const overlapPaths = [
            ...new Set([
              ...collection.changedFiles,
              ...(input.expectedDeliverables ?? []),
            ]),
          ];
          overlap = await setupOverlap(scoped, workdir, setupCommit, overlapPaths, {
            signals,
            signal: opts?.signal,
          });
        } catch (error) {
          return failureResult(`Repo setup check failed: ${shortError(error, scrub)}`, 0, stderrTail, signals, output.usage, journalSupported ? "outcome_unknown" : undefined);
        }
      }
      if (overlap.length > 0) {
        return failureResult(
          `The agent changed files the repo setup also changed (${overlap.slice(0, 5).join(", ")}); keep .shiba/setup.json from editing tracked files.`,
          0,
          stderrTail,
          signals,
          output.usage,
        );
      }
      await emit({
        phase: "collect",
        message: `Done: ${collection.changedFiles.length} changed files.`,
        fraction: 1,
      });
      const completed: CodingTaskResult = {
        status: "completed",
        ...(baseRevision !== undefined ? { baseRevision } : {}),
        exitCode: 0,
        stderrTail,
        changedFiles: collection.changedFiles,
        diff: collection.diff,
        files: collection.files,
        signals,
        summary: summarizeRun(
          this.harness.name,
          input,
          collection.changedFiles,
          boundTail(scrub(run.stdout), MAX_STDOUT_TAIL_CHARS),
        ),
        // Only what the harness stream actually reported — never estimated.
        ...(output.usage !== undefined ? { usage: output.usage } : {}),
      };
      // T45: a declared test command runs scoped after collection — the
      // exec.settled receipt is what T43's verify reads. A refusal is caught
      // here and left for verify to reject; a thrown container error is real.
      if (input.testCommand !== undefined && input.testCommand.length > 0) {
        try {
          throwIfAborted(opts?.signal);
          await emit({
            phase: "collect",
            message: `Running test command: ${input.testCommand.join(" ")}`,
            fraction: 0.9,
          });
          const testRun = await scoped.exec(shellJoin(input.testCommand), {
            cwd: workdir,
            ...(opts?.env !== undefined ? { env: opts.env } : {}),
            timeoutMs: TEST_COMMAND_TIMEOUT_MS,
            signal: opts?.signal,
          });
          // T46: the PR body quotes this tail — the reviewer sees the real
          // test output, not the model's claim about it.
          completed.testEvidence = {
            command: shellJoin(input.testCommand),
            exitCode: testRun.exitCode,
            outputTail: boundTail(
              scrub(`${testRun.stdout}\n${testRun.stderr}`.trim()),
              TEST_EVIDENCE_TAIL_CHARS,
            ),
          };
          if (testRun.exitCode !== 0) {
            await emit({
              phase: "collect",
              message: `Test command exited ${testRun.exitCode}.`,
              fraction: 0.92,
            });
          }
        } catch (error) {
          if (!(error instanceof ScopedExecRefusal)) {
            return failureResult(
              `Test command failed to execute: ${shortError(error, scrub)}`,
              run.exitCode,
              stderrTail,
              signals,
              output.usage,
              journalSupported ? "outcome_unknown" : undefined,
            );
          }
          // Refused: receipt recorded; verify below reports the real reason.
          await emit({
            phase: "collect",
            message: "Test command refused by the exec allowlist.",
            fraction: 0.92,
          });
        }
      }
      // T43 verify gate — load-bearing: an exit-0 run with an empty diff is NOT
      // completed, and a declared test command needs a clean exec.settled
      // receipt. Deterministic evidence only; this feeds T46's proof gate.
      await verifyExpectedDeliverables(input.expectedDeliverables, completed.files);
      const verification = await this.harness.verify(input, completed);
      if (!verification.ok) {
        return failureResult(
          `Verification failed: ${verification.reason}`,
          run.exitCode,
          stderrTail,
          signals,
          output.usage,
        );
      }
      return completed;
    } catch (error) {
      return failureResult(
        `Change collection failed: ${shortError(error, scrub)}`,
        run.exitCode,
        stderrTail,
        signals,
        output.usage,
        journalSupported ? "outcome_unknown" : undefined,
      );
    }
  }
}

/** Bounded read-only snapshots cannot overlap or outlive the active turn. */
function startLiveDiff(
  ops: SandboxOps,
  workdir: string,
  baselineCommit: string,
  publish: (diff: string) => void,
  scrub: (text: string) => string,
  signals: RunSignal[],
  signal?: AbortSignal,
  publishStatus?: (status: "limited" | "unavailable", reason?: string) => void,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  let previous: string | undefined;
  let previousStatus: string | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped || pending || signal?.aborted) return;
    pending = (async () => {
      try {
        const preview = await captureLiveDiff(ops, workdir, baselineCommit, signals, signal);
        if (stopped || signal?.aborted) return;
        if (preview.status !== "ready") {
          const statusKey = `${preview.status}:${preview.reason}`;
          if (statusKey !== previousStatus) publishStatus?.(preview.status, preview.reason);
          previousStatus = statusKey;
          return;
        }
        const safe = scrub(preview.diff);
        if (safe !== previous || previousStatus !== undefined) {
          previous = safe;
          publish(safe);
        }
        previousStatus = undefined;
      } finally {
        pending = undefined;
      }
    })();
  };
  const timer = setInterval(tick, 5_000);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}

export class ComputerPreviewAdapter implements RuntimeAdapter {
  readonly name = "computer" as const;
  async runCodingTask(): Promise<CodingTaskResult> {
    throw new Error(COMPUTER_PREVIEW_MESSAGE);
  }
}

/**
 * T51: the LocalDispatch mailbox as the adapter sees it. The production
 * client wraps the DO stub; tests inject an in-memory one.
 */
export interface LocalDispatchClient {
  dispatch(
    envelope: import("@shiba/shared").LocalRunEnvelope,
    targetMachineId?: string,
    dashboardOwnerId?: string,
  ): Promise<void>;
  status(sandboxId: string): Promise<{
    status: "pending" | "claimed" | "settled" | "cancelled";
    claimedAt?: number;
    claimedBy?: string;
    result?: LocalRunResult;
    sessionEvents?: { seq: number; at: number; type: string; text: string }[];
    liveDiff?: string;
  }>;
  cancel(sandboxId: string): Promise<void>;
}

export const LOCAL_DISPATCH_MESSAGE =
  'runtime "local" requires SHIBA_LOCAL_RUNTIME=1 on the deployment and ' +
  "an operator daemon polling /api/local — see configuration.md.";

/** The adapter's own poll cadence and the total mailbox budget. */
export const LOCAL_POLL_INTERVAL_MS = 2_500;
export const LOCAL_MAILBOX_TIMEOUT_MS = OPENCODE_TIMEOUT_MS + 2 * GIT_TIMEOUT_MS;

/**
 * T51 local runtime: the Worker never touches the operator's machine — it
 * publishes a fully-computed run envelope (argv, config files, env minus
 * dummy keys) to LocalDispatch and waits. The operator's daemon executes
 * it and posts back the same result shape a sandbox run produces, which
 * then passes the same T43 verify gate before it can claim completed.
 */
export class LocalRuntimeAdapter implements RuntimeAdapter {
  readonly name = "local" as const;
  private readonly harness: AgentHarness;
  private readonly client: LocalDispatchClient;
  private readonly pollIntervalMs: number;

  constructor(
    harness: AgentHarness,
    deps: { client: LocalDispatchClient; pollIntervalMs?: number },
  ) {
    this.harness = harness;
    this.client = deps.client;
    this.pollIntervalMs = deps.pollIntervalMs ?? LOCAL_POLL_INTERVAL_MS;
  }

  async runCodingTask(
    _ops: SandboxOps,
    input: CodingTaskInput,
    emit: ProgressEmitter,
    opts?: { signal?: AbortSignal; signals?: RunSignal[]; env?: Record<string, string> },
  ): Promise<CodingTaskResult> {
    const signals = opts?.signals ?? [];
    const artifact = input.executionTarget?.kind === "artifact-workspace" ? input.executionTarget : undefined;
    if (input.executionTarget?.kind === "connected-app" || (artifact && (
      input.personalExecution || input.repoUrl || input.publishPullRequest || !artifact.expectedDeliverables.length ||
      JSON.stringify(input.expectedDeliverables) !== JSON.stringify(artifact.expectedDeliverables)))) {
      return failureResult("Local artifact work requires a no-repository target, matching nonempty approved deliverables and no personal repository grant or publication.", 0, "", signals);
    }
    if (artifact && (!input.targetMachineId?.trim() || !input.initiatorUserId?.trim() ||
      !expectedDeliverablesSchema.safeParse(artifact.expectedDeliverables).success)) {
      return failureResult("Local artifacts require an explicit paired computer, owner and safe approved deliverable paths.", 0, "", signals);
    }
    input = input.personalExecution ? input : artifact ? {
      ...input,
      task: `${input.task}${onboardingSourceInstructions(input.onboardingSourceSnapshot)}\n\nWrite only these approved complete UTF-8 deliverables relative to your current working directory: ${artifact.expectedDeliverables.join(", ")}. Each file is limited to 16384 bytes, 65536 bytes total. Only these files will be privately exported; other files are not recoverable artifacts.`,
    } : withDeliverableInstructions(input);
    const milestone = (kind: RunSignalKind, detail?: string) => {
      signals.push(
        detail !== undefined ? { kind, at: Date.now(), detail } : { kind, at: Date.now() },
      );
    };
    // ponytail: intake refuses env for local runs; this guards a forged envelope. Lift when the daemon can take sealed env.
    if (opts?.env !== undefined) {
      return failureResult("Per-run environment variables are not supported on the local runtime.", 0, "", signals);
    }
    if (input.runSetup === true) {
      return failureResult("Repo setup is not supported on the local runtime.", 0, "", signals);
    }
    if (!this.harness.capabilities(input.codingModel).supportedRuntimes.includes("local")) {
      return failureResult(
        `Harness ${this.harness.name} does not run on the local runtime.`,
        0,
        "",
        signals,
      );
    }
    const personal = input.personalExecution ? personalExecutionClaimSchema.safeParse(input.personalExecutionClaim) : null;
    if (input.personalExecution && (!personal?.success ||
      JSON.stringify(personal.data.snapshot) !== JSON.stringify(input.personalExecution) ||
      input.targetMachineId !== input.personalExecution.machineId || input.initiatorUserId !== input.personalExecution.actorId ||
      this.harness.name !== input.personalExecution.harness || input.codingModel !== input.personalExecution.codingModel ||
      input.repoUrl !== input.personalExecution.repoUrl || input.runtime !== "local" || input.publishPullRequest || input.testCommand ||
      input.authAccount || input.forkCheckpointRef || personal.data.approvedUntil <= Date.now())) {
      return failureResult("Personal local work no longer matches its approved account, machine and task authority.", 0, "", signals);
    }
    const workdir = `/workspace/${input.sandboxId}`;
    // A personal native account must never receive deployment credentials,
    // harness config, setup commands or a silent provider fallback.
    const configValue = personal?.success ? null : this.harness.configFile(input, input.sandboxId);
    const configFiles =
      configValue === null ? [] : Array.isArray(configValue) ? configValue : [configValue];
    const env = personal?.success ? {} : this.harness.env(input, configFiles[0]?.path ?? null);
    const dummyKeys = Object.entries(env)
      .filter(([, value]) => value === DUMMY_PROVIDER_KEY)
      .map(([key]) => key);
    const sessionKindLocal = sessionProvider(this.harness.name);
    const deadlineAt = Math.min(Date.now() + LOCAL_MAILBOX_TIMEOUT_MS, personal?.success ? personal.data.approvedUntil : Infinity);
    const envelope = buildLocalRunEnvelope({
      input: {
        sandboxId: input.sandboxId,
        repoUrl: input.repoUrl,
        ...(artifact ? { executionTarget: artifact } : {}),
        baseBranch: input.baseBranch,
        task: input.task,
        ...(input.customAgentId !== undefined ? { customAgentId: input.customAgentId } : {}),
        ...(input.customAgentVersion !== undefined ? { customAgentVersion: input.customAgentVersion } : {}),
        ...(input.skillPins !== undefined ? { skillPins: input.skillPins.map((pin) => ({ ...pin })) } : {}),
        ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
        ...(input.testCommand !== undefined ? { testCommand: input.testCommand } : {}),
        ...(input.expectedDeliverables !== undefined ? { expectedDeliverables: input.expectedDeliverables } : {}),
        ...(personal?.success ? { personalExecution: personal.data } : {}),
      },
      harnessName: this.harness.name,
      workdir,
      configFiles,
      setupCommands: personal?.success ? [] : (this.harness.setupCommands?.(input, workdir) ?? []).map((cmd) => [...cmd]),
      argv: personal?.success ? [] : this.harness.buildArgv(input, workdir),
      env,
      dummyKey: DUMMY_PROVIDER_KEY,
      providerKeyEnv: dummyKeys[0],
      execAllowlist: this.harness
        .capabilities(input.codingModel)
        .execAllowlist.map((prefix) => [...prefix]),
      setupAllowlist: personal?.success ? [] : SETUP_COMMAND_ALLOWLIST.map((prefix) => [...prefix]),
      deadlineAt,
      ...(sessionKindLocal !== null
        ? {
            session: {
              provider: sessionKindLocal,
              model: bareModelId(input.codingModel),
              ...(input.route?.reasoningEffort ? { reasoningEffort: input.route.reasoningEffort } : {}),
              permissionMode: "approval-required" as const,
            },
          }
        : {}),
    });

    throwIfAborted(opts?.signal);
    await emit({
      phase: "clone",
      message: `Dispatching ${this.harness.name} to the local runtime.`,
      fraction: 0.05,
    });
    try {
      await this.client.dispatch(envelope, input.targetMachineId, input.initiatorUserId);
    } catch (error) {
      return failureResult(`Local dispatch failed: ${shortError(error)}${artifact ? " Outcome unknown; do not retry automatically." : ""}`, 0, "", signals, undefined, artifact ? "outcome_unknown" : undefined);
    }
    milestone("local.dispatched", input.sandboxId);

    // The wait IS the runtime semantics — a daemon claims, executes, and
    // settles on its own clock; the abort path cancels the record so a
    // late claim can never start a cancelled run.
    let seenClaimed = false;
    let seenEventSeq = 0;
    for (;;) {
      if (opts?.signal?.aborted) {
        await this.client.cancel(input.sandboxId).catch(() => undefined);
        throw new Error("Run cancelled.");
      }
      if (Date.now() > deadlineAt) {
        await this.client.cancel(input.sandboxId).catch(() => undefined);
        return failureResult(
          "Local run timed out waiting for the daemon — is `shiba local` running?",
          0,
          "",
          signals,
          undefined,
          artifact ? "outcome_unknown" : undefined,
        );
      }
      let status: Awaited<ReturnType<LocalDispatchClient["status"]>>;
      try {
        status = await this.client.status(input.sandboxId);
      } catch (error) {
        return failureResult(`Local dispatch status failed: ${shortError(error)}${artifact ? " Outcome unknown; do not retry automatically." : ""}`, 0, "", signals, undefined, artifact ? "outcome_unknown" : undefined);
      }
      if (!seenClaimed && (status.status === "claimed" || status.claimedAt !== undefined)) {
        seenClaimed = true;
        milestone("local.claimed", status.claimedBy ?? "operator");
        await emit({
          phase: "code",
          message: `Daemon${status.claimedBy ? ` ${status.claimedBy}` : ""} claimed the run.`,
          fraction: 0.25,
        });
      }
      for (const event of status.sessionEvents ?? []) {
        if (event.seq <= seenEventSeq || event.text.trim() === "") continue;
        seenEventSeq = event.seq;
        await emit({ phase: "code", message: event.text, fraction: 0.5 });
      }
      if (status.status === "cancelled") {
        return failureResult("Local run was cancelled before a daemon settled it.", 0, "", signals);
      }
      if (status.status === "settled" && status.result !== undefined) {
        milestone("local.settled", `exitCode:${status.result.exitCode}`);
        // Daemon-emitted exec receipts merge ahead of the mailbox
        // milestones — verify() reads exec.settled from the same list.
        for (const signal of status.result.signals ?? []) {
          if ((RUN_SIGNAL_KINDS as readonly string[]).includes(signal.kind)) {
            signals.push({
              kind: signal.kind as RunSignalKind,
              at: signal.at,
              ...(signal.detail !== undefined ? { detail: signal.detail } : {}),
            });
          }
        }
        const result = status.result;
        const stderrTail = redactSecrets(boundTail(result.stderrTail, MAX_STDERR_TAIL_CHARS));
        if (result.status === "error" || result.exitCode !== 0) {
          const detail = stderrTail.trim();
          return failureResult(
            `${this.harness.name} (local) ${result.exitCode !== 0 ? `exited with code ${result.exitCode}` : "failed"}.${detail ? ` stderr: ${boundTail(detail, 1500)}` : ""} ${boundTail(result.summary, 1500)}`.trim(),
            result.exitCode,
            stderrTail,
            signals,
          );
        }
        try {
          if (artifact && (result.diff !== "" || result.baseRevision !== undefined ||
            result.changedFiles.length !== artifact.expectedDeliverables.length ||
            new Set(result.changedFiles).size !== result.changedFiles.length ||
            result.changedFiles.some((file) => !artifact.expectedDeliverables.includes(file)) ||
            result.files.length !== artifact.expectedDeliverables.length ||
            result.files.some((file) => !artifact.expectedDeliverables.includes(file.path)))) {
            throw new Error("Local artifact response contains unapproved files or repository state.");
          }
          await verifyExpectedDeliverables(input.expectedDeliverables, result.files);
        } catch (error) {
          return failureResult(`Deliverable verification failed: ${shortError(error)}`, result.exitCode, stderrTail, signals);
        }
        const completed: CodingTaskResult = {
          status: "completed",
          ...(result.baseRevision !== undefined ? { baseRevision: result.baseRevision } : {}),
          exitCode: 0,
          stderrTail,
          changedFiles: result.changedFiles,
          diff: boundTail(result.diff, MAX_DIFF_CHARS),
          files: result.files.slice(0, MAX_CAPTURED_FILES).map((file) => ({
            path: file.path,
            content: file.content === null ? null : boundTail(file.content, MAX_FILE_CHARS),
            encoding: file.encoding,
          })),
          signals,
          summary: boundTail(result.summary, 8000),
          ...(result.testEvidence !== undefined ? { testEvidence: result.testEvidence } : {}),
        };
        await emit({
          phase: "collect",
          message: `Done: ${result.changedFiles.length} changed files.`,
          fraction: 1,
        });
        // T43 verify gate — identical to the sandbox path: the daemon's
        // report is evidence, not truth.
        const verification = await this.harness.verify(input, completed);
        if (!verification.ok) {
          return failureResult(
            `Verification failed: ${verification.reason}`,
            result.exitCode,
            stderrTail,
            signals,
          );
        }
        return completed;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }
}

export function resolveRuntimeName(raw: string | undefined): "sandbox" | "computer" | "local" {
  if (raw === undefined || raw === "") return "sandbox";
  if (raw === "sandbox" || raw === "computer" || raw === "local") return raw;
  throw new Error(
    `Unknown RUNTIME ${JSON.stringify(raw)}: expected "sandbox", "computer", or "local".`,
  );
}

/**
 * The harness must reach the adapter that actually runs it: egress is
 * narrowed to the selected harness's host, so running a different one would
 * block its own provider. `"local"` requires its dispatch client — the
 * caller that lacks one (flag off) throws instead of silently sandboxing.
 */
export function createRuntimeAdapter(
  name: "sandbox" | "computer" | "local",
  harness: AgentHarness = opencodeHarness,
  local?: { client: LocalDispatchClient; pollIntervalMs?: number },
): RuntimeAdapter {
  if (name === "local") {
    if (local === undefined) {
      throw new Error(LOCAL_DISPATCH_MESSAGE);
    }
    return new LocalRuntimeAdapter(harness, local);
  }
  return name === "computer" ? new ComputerPreviewAdapter() : new SandboxRuntimeAdapter(harness);
}

function failureResult(
  summary: string,
  exitCode: number,
  stderrTail: string,
  signals?: RunSignal[],
  usage?: RunUsage,
  errorCode?: CodingTaskResult["errorCode"],
): CodingTaskResult {
  return {
    status: "error",
    ...(errorCode ? { errorCode } : {}),
    exitCode,
    stderrTail,
    changedFiles: [],
    diff: "",
    files: [],
    // Partial signals survive a failure — the missing ones name the
    // phase the run never reached.
    ...(signals && signals.length > 0 ? { signals } : {}),
    // Tokens the harness reported before the failure are real spend.
    ...(usage !== undefined ? { usage } : {}),
    summary: redactSecrets(summary),
  };
}

function shortError(error: unknown, scrub: (text: string) => string = (text) => text): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundTail(redactSecrets(scrub(message)), 2000);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Run cancelled.");
  }
}

/** Thrown when a streamed OpenCode event line is malformed. */
export { buildOpencodeArgv, buildOpencodeConfig } from "./harness/opencode.js";

interface OutputStream {
  onData: (stream: "stdout" | "stderr", data: string) => void;
  finish: () => Promise<void>;
  /** Harness-reported token/cost totals accumulated so far; absent when the
   * stream never emitted a usage event. */
  usage: RunUsage | undefined;
}

/**
 * Bridge exec output into progress events. Bounded: at most 256 events are
 * emitted per run, stdout lines drive progress and stderr is only counted.
 * Event parsing is harness-dispatched; error events propagate so the run
 * fails honestly.
 */
function streamProgress(
  harness: AgentHarness,
  emit: ProgressEmitter,
  _signal?: AbortSignal,
  scrub: (text: string) => string = (text) => text,
): OutputStream {
  let buffer = "";
  // Index into buffer that is already known newline-free; searching resumes
  // there instead of rescanning the pending line on every chunk (linear).
  let searchFrom = 0;
  // Set after an oversized line is dropped: everything up to the next
  // newline is the same unparseable record and gets discarded too.
  let dropping = false;
  let emitted = 0;
  let pending: Promise<void> = Promise.resolve();
  const emitText = (text: string) => {
    if (emitted >= MAX_PROGRESS_EVENTS) return;
    emitted += 1;
    pending = pending.then(() =>
      emit({
        phase: "code",
        message: scrub(text),
        fraction: Math.min(0.25 + emitted * 0.05, 0.8),
      }),
    );
  };
  const stream: OutputStream = {
    usage: undefined,
    onData(stream_, data) {
      if (stream_ !== "stdout") return;
      if (dropping) {
        const end = data.indexOf("\n");
        if (end < 0) return;
        dropping = false;
        buffer = "";
        searchFrom = 0;
        data = data.slice(end + 1);
      }
      buffer += data;
      for (;;) {
        const newline = buffer.indexOf("\n", searchFrom);
        if (newline < 0) {
          searchFrom = buffer.length;
          if (buffer.length > MAX_STREAM_LINE_CHARS) {
            // Bounded, honest overflow: report the drop and discard the
            // partial record until its delimiter rather than emitting
            // fabricated events or buffering without bound.
            emitText(
              `[${harness.name}] oversized output line dropped (exceeded ${MAX_STREAM_LINE_CHARS} chars).`,
            );
            buffer = "";
            searchFrom = 0;
            dropping = true;
          }
          break;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        searchFrom = 0;
        try {
          // Preserve protocol fields and usage. Parsers scrub complete display
          // and error content before applying their text bounds.
          const event = harness.parseEvent(line, scrub);
          if (event === null || event === undefined) continue;
          // Usage events carry real reported numbers: per-step deltas sum,
          // a cumulative report replaces (it already includes the deltas).
          if (event.kind === "usage") {
            stream.usage =
              event.cumulative === true
                ? { ...event.usage }
                : mergeRunUsage(stream.usage, event.usage);
          }
          if (event?.text.trim()) emitText(`[${harness.name}] ${event.text}`);
        } catch (error) {
          // Error events must propagate so the run fails honestly.
          if (
            error instanceof OpenCodeErrorEventImpl ||
            error instanceof ClaudeCodeErrorEvent ||
            error instanceof CodexErrorEvent ||
            error instanceof GrokErrorEvent ||
            error instanceof PiErrorEvent ||
            error instanceof PiEventError ||
            error instanceof CursorErrorEvent ||
            error instanceof AcpErrorEvent ||
            error instanceof AcpEventError ||
            error instanceof ClaudeUsageLimitError ||
            error instanceof CodexUsageLimitError ||
            error instanceof AntigravityUsageLimitError ||
            error instanceof AntigravityErrorEvent
          ) {
            throw error;
          }
          emitText(`[${harness.name}] malformed event line (redacted).`);
        }
      }
    },
    async finish() {
      buffer = "";
      searchFrom = 0;
      dropping = false;
      await pending;
    },
  };
  return stream;
}

function withDeliverableInstructions(input: CodingTaskInput): CodingTaskInput {
  const sourceContext = onboardingSourceInstructions(input.onboardingSourceSnapshot);
  if (sourceContext) input = { ...input, task: input.task + sourceContext };
  if (isEphemeralWorkspace(input.executionTarget)) {
    const template = input.executionTarget?.kind === "artifact-workspace" ? input.executionTarget.template : undefined;
    input = { ...input, task: `${input.task}\n\nThis is an ephemeral workspace at /workspace. Read workspace context from /workspace/.shiba/context.json. Place final output files in /workspace/out. Files there are archived as artifacts after execution. Keep each file at most 1048576 bytes, at most 64 files, and at most 8388608 bytes in total. Use ordinary relative filenames without hidden components or symlinks.${template ? ` Requested workspace template: ${JSON.stringify(template)}. Treat this as a format hint, not an executable command.` : ""}` };
  }
  const expected = expectedDeliverablesSchema.parse(input.expectedDeliverables ?? []);
  if (!expected.length) return input;
  const workspace = input.executionTarget?.kind === "artifact-workspace"
    ? `the approved artifact workspace${input.executionTarget.workspaceName ? ` (${input.executionTarget.workspaceName})` : ""}`
    : "the approved repository workspace";
  return { ...input, task: `${input.task}\n\nRequired deliverables (relative to ${workspace}):\n${expected.map((path) => `- ${path}`).join("\n")}\nWrite complete nonempty UTF-8 text files at these exact paths. JSON files must parse. Each file must be at most 16384 UTF-8 bytes, and all requested files together at most 65536 bytes. A completion claim without these files will fail verification.` };
}

/** Read regular files from the settled Git snapshot. Symlinks (including
 * symlink parents), missing files, binary/invalid UTF-8 and truncated exec
 * output cannot become requested artifacts. No filesystem path is followed. */
export async function collectExpectedSandboxDeliverables(
  ops: SandboxOps, workdir: string, checkpoint: string, expected: string[] | undefined, signal?: AbortSignal,
): Promise<CollectedChanges["files"]> {
  const paths = expectedDeliverablesSchema.parse(expected ?? []);
  const files: CollectedChanges["files"] = [];
  for (const path of paths) {
    const tree = await ops.exec(shellJoin(["git", "--no-replace-objects", "ls-tree", "-z", checkpoint, "--", path]), { cwd: workdir, timeoutMs: GIT_TIMEOUT_MS, signal });
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(tree.stdout);
    if (tree.exitCode !== 0 || !match || match[3] !== path) throw new Error(`Deliverable ${path} must be a regular file in the settled workspace.`);
    const objectId = match[2]!;
    const size = await ops.exec(shellJoin(["git", "--no-replace-objects", "cat-file", "-s", objectId]), { cwd: workdir, timeoutMs: GIT_TIMEOUT_MS, signal });
    const bytes = Number(size.stdout.trim());
    if (size.exitCode !== 0 || !/^\d+\s*$/.test(size.stdout) || !Number.isSafeInteger(bytes) || bytes > MAX_DELIVERABLE_BYTES) throw new Error(`Deliverable ${path} exceeds its byte limit or could not be read completely.`);
    const encodedLength = Math.ceil(bytes / 3) * 4;
    const blob = await ops.exec(shellJoin(["node", "-e", DELIVERABLE_BLOB_READER, objectId]), { cwd: workdir, timeoutMs: GIT_TIMEOUT_MS, signal, maxOutputChars: Math.ceil(MAX_DELIVERABLE_BYTES / 3) * 4 + 1 });
    const encoded = blob.stdout;
    if (blob.exitCode !== 0 || encoded.length !== encodedLength || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error(`Deliverable ${path} has malformed or truncated byte transport.`);
    let content: string;
    try {
      const raw = atob(encoded);
      const data = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      if (data.byteLength !== bytes || btoa(raw) !== encoded) throw new Error("Noncanonical byte transport");
      const header = new TextEncoder().encode(`blob ${bytes}\0`);
      const objectBytes = new Uint8Array(header.byteLength + data.byteLength);
      objectBytes.set(header); objectBytes.set(data, header.byteLength);
      const digest = new Uint8Array(await crypto.subtle.digest(objectId.length === 40 ? "SHA-1" : "SHA-256", objectBytes));
      const actualId = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (actualId !== objectId) throw new Error("Git object integrity mismatch");
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
      throw new Error(`Deliverable ${path} contains invalid UTF-8 or malformed byte transport.`);
    }
    files.push({ path, content, encoding: "utf8" });
  }
  await verifyExpectedDeliverables(paths, files);
  return files;
}

/** Capture only regular output blobs from the immutable settled snapshot. */
export async function collectWorkspaceChanges(
  ops: SandboxOps,
  workdir: string,
  checkpoint: string,
  signal?: AbortSignal,
): Promise<CollectedChanges> {
  const manifest = await ops.exec(shellJoin(["node", "-e", WORKSPACE_MANIFEST_READER, checkpoint]), {
    cwd: workdir, timeoutMs: GIT_TIMEOUT_MS, signal, maxOutputChars: 90_000,
  });
  let tree: string;
  try {
    const payload: unknown = JSON.parse(manifest.stdout);
    if (manifest.exitCode !== 0 || payload === null || typeof payload !== "object" || !("tree" in payload) || typeof payload.tree !== "string") throw new Error("Invalid manifest");
    const raw = atob(payload.tree);
    if (btoa(raw) !== payload.tree) throw new Error("Noncanonical manifest");
    tree = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(raw, (character) => character.charCodeAt(0)));
    if (tree !== "" && !tree.endsWith("\0")) throw new Error("Truncated manifest");
  } catch {
    throw new Error("Workspace output manifest is malformed, truncated, or exceeds its limit.");
  }
  const entries = tree === "" ? [] : tree.slice(0, -1).split("\0");
  if (entries.length > MAX_WORKSPACE_ARTIFACT_FILES) throw new Error("Workspace output exceeds the file count limit.");
  const files: CollectedChanges["files"] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    signal?.throwIfAborted();
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(entry);
    const path = match?.[3];
    const objectId = match?.[2];
    if (!path || !objectId || !isWorkspaceArtifactPath(path) || seen.has(path.toLowerCase())) {
      throw new Error("Workspace output contains a symlink, unsupported path, or duplicate filename.");
    }
    seen.add(path.toLowerCase());
    const size = await ops.exec(shellJoin(["git", "--no-replace-objects", "cat-file", "-s", objectId]), { cwd: workdir, timeoutMs: GIT_TIMEOUT_MS, signal });
    const bytes = Number(size.stdout.trim());
    if (size.exitCode !== 0 || !/^\d+\s*$/.test(size.stdout) || !Number.isSafeInteger(bytes) || bytes > MAX_WORKSPACE_ARTIFACT_BYTES) {
      throw new Error(`Workspace output ${path} exceeds its file size limit or could not be read.`);
    }
    total += bytes;
    if (total > MAX_WORKSPACE_ARTIFACT_TOTAL_BYTES) throw new Error("Workspace output exceeds the total byte limit.");
    let encoded = "";
    for (let offset = 0; offset < bytes; offset += WORKSPACE_BLOB_CHUNK_BYTES) {
      const blob = await ops.exec(shellJoin(["node", "-e", WORKSPACE_BLOB_READER, objectId, String(offset)]), {
        cwd: workdir, timeoutMs: GIT_TIMEOUT_MS, signal, maxOutputChars: Math.ceil(WORKSPACE_BLOB_CHUNK_BYTES / 3) * 4 + 1,
      });
      const chunkLength = Math.min(WORKSPACE_BLOB_CHUNK_BYTES, bytes - offset);
      if (blob.exitCode !== 0 || blob.stdout.length !== Math.ceil(chunkLength / 3) * 4) {
        throw new Error(`Workspace output ${path} has truncated byte transport.`);
      }
      encoded += blob.stdout;
    }
    let data: Uint8Array;
    try {
      if (encoded.length !== Math.ceil(bytes / 3) * 4) throw new Error("Truncated blob");
      const raw = atob(encoded);
      if (btoa(raw) !== encoded || raw.length !== bytes) throw new Error("Noncanonical blob");
      data = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      const header = new TextEncoder().encode(`blob ${bytes}\0`);
      const objectBytes = new Uint8Array(header.byteLength + bytes);
      objectBytes.set(header); objectBytes.set(data, header.byteLength);
      const digest = new Uint8Array(await crypto.subtle.digest(objectId.length === 40 ? "SHA-1" : "SHA-256", objectBytes));
      const actualId = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (actualId !== objectId) throw new Error("Integrity mismatch");
    } catch {
      throw new Error(`Workspace output ${path} has invalid, truncated, or corrupt byte transport.`);
    }
    try {
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
      if (data.some((byte) => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)) throw new Error("Binary data");
      files.push({ path, content, encoding: "utf8" });
    } catch {
      files.push({ path, content: encoded, encoding: "base64" });
    }
  }
  return { files, changedFiles: files.map((file) => file.path), diff: "" };
}

function summarizeRun(
  harnessName: string,
  input: CodingTaskInput,
  changedFiles: string[],
  stdoutTail: string,
): string {
  const destination = input.executionTarget?.kind === "artifact-workspace"
    ? `workspace ${input.executionTarget.workspaceName ?? input.executionTarget.workspaceId ?? input.sandboxId}`
    : `${input.repoUrl} (${input.baseBranch})`;
  const header = `${harnessName} completed for ${destination}: ${changedFiles.length} changed files.`;
  if (changedFiles.length === 0) {
    return `${header} No file changes detected.`;
  }
  const preview = stdoutTail.trim().slice(-2000);
  return preview ? `${header}\n${preview}` : header;
}

interface CollectedChanges {
  changedFiles: string[];
  diff: string;
  files: Array<{ path: string; content: string | null; encoding: "utf8" | "base64" }>;
}

/** Decode a quoted porcelain path (`\"`, `\\`, `\\n`, `\\t`, `\\ooo`). */
export function unescapePorcelainPath(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"') && path.length >= 2)) return path;
  const inner = path.slice(1, -1);
  let out = "";
  // Consecutive octal escapes are UTF-8 bytes; decode runs together or
  // multi-byte characters corrupt (café -> cafÃ©).
  const bytes: number[] = [];
  const flush = () => {
    if (bytes.length > 0) {
      out += new TextDecoder().decode(new Uint8Array(bytes));
      bytes.length = 0;
    }
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      flush();
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === "n") {
      flush();
      out += "\n";
      i += 1;
    } else if (next === "t") {
      flush();
      out += "\t";
      i += 1;
    } else if (next === '"' || next === "\\") {
      flush();
      out += next;
      i += 1;
    } else if (next !== undefined && next >= "0" && next <= "7") {
      let oct = "";
      let j = i + 1;
      while (j < inner.length && oct.length < 3 && inner[j]! >= "0" && inner[j]! <= "7") {
        oct += inner[j];
        j += 1;
      }
      bytes.push(parseInt(oct, 8));
      i = j - 1;
    } else if (next !== undefined) {
      flush();
      out += next;
      i += 1;
    }
  }
  flush();
  return out;
}

function porcelainPath(rest: string): string {
  const arrow = rest.indexOf(" -> ");
  const path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
  return unescapePorcelainPath(path);
}

function isSafeRepoPath(path: string): boolean {
  // Only ".." as a whole segment escapes the workdir; "notes..txt" is a legal name.
  return Boolean(path) && !path.split("/").includes("..") && !path.startsWith("/");
}

/** Parse `git status --porcelain` output into repo-relative paths. */
export function parsePorcelainStatus(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    const rest = line.slice(3).trim();
    if (!rest) continue;
    const path = porcelainPath(rest);
    if (isSafeRepoPath(path)) paths.push(path);
  }
  return [...new Set(paths)];
}

function isGitObjectId(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

/** Export the exact settled turn, including newly created binary files and
 * deletions. The manifest, diff, and blob bytes share immutable endpoints;
 * mutations of HEAD, checkpoint refs, the index, or the worktree after the
 * checkpoint cannot change the proposed publication. */
export async function collectRepositoryChanges(
  ops: SandboxOps,
  workdir: string,
  baseline: string,
  settled: string,
  opts: {
    signal?: AbortSignal;
    expectedDeliverables?: string[];
    exportDiff?: (diff: string) => Promise<string>;
    onDiffExported?: (key: string) => void;
  } = {},
): Promise<CollectedChanges> {
  if (!isGitObjectId(baseline) || !isGitObjectId(settled)) {
    throw new Error("Repository capture requires immutable checkpoint identities.");
  }
  const signal = opts.signal;
  const manifest = await ops.exec(shellJoin(["node", "-e", REPOSITORY_MANIFEST_READER, baseline, settled]), {
    cwd: workdir, timeoutMs: GIT_TIMEOUT_MS, signal, maxOutputChars: 90_000,
  });
  let records: string[];
  try {
    const payload: unknown = JSON.parse(manifest.stdout);
    if (manifest.exitCode !== 0 || payload === null || typeof payload !== "object" || !("changes" in payload) || typeof payload.changes !== "string") throw new Error("Invalid manifest");
    const raw = atob(payload.changes);
    if (btoa(raw) !== payload.changes) throw new Error("Noncanonical manifest");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(raw, (character) => character.charCodeAt(0)));
    if (text !== "" && !text.endsWith("\0")) throw new Error("Truncated manifest");
    records = text === "" ? [] : text.slice(0, -1).split("\0");
    if (records.length % 2 !== 0) throw new Error("Partial manifest record");
  } catch {
    throw new Error("Repository change manifest is malformed, truncated, or exceeds its limit.");
  }
  if (records.length / 2 > MAX_CAPTURED_FILES) {
    throw new Error(`Run changed ${records.length / 2} files; capture limit is ${MAX_CAPTURED_FILES}. Narrow the task or raise MAX_CAPTURED_FILES.`);
  }
  const changes: Array<{ path: string; objectId: string | null }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < records.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([AMD])$/.exec(records[index]!);
    const path = records[index + 1]!;
    if (!match || !isSafeRepoPath(path) || path.split("/").some((part) => !part || part === "." || part.toLowerCase() === ".git") || path.includes("\\") || seen.has(path)) {
      throw new Error("Repository snapshot contains an unsupported path, type, or duplicate file.");
    }
    const deleted = match[5] === "D";
    if (deleted ? match[2] !== "000000" || !/^0+$/.test(match[4]!) : !["100644", "100755"].includes(match[2]!) || /^0+$/.test(match[4]!)) {
      throw new Error("Repository snapshot contains a symlink or unsupported file type.");
    }
    seen.add(path);
    changes.push({ path, objectId: deleted ? null : match[4]! });
  }
  const diffResult = await ops.exec(shellJoin(["git", "--no-replace-objects", "diff", "--no-ext-diff", "--no-textconv", "--no-color", baseline, settled, "--"]), {
    cwd: workdir, timeoutMs: GIT_TIMEOUT_MS, signal, maxOutputChars: 20_000_000,
  });
  if (diffResult.exitCode !== 0) throw new Error(`git diff failed with exit code ${diffResult.exitCode}.`);
  const rawDiff = diffResult.stdout;
  if (rawDiff.length > MAX_DIFF_CHARS && opts.exportDiff) {
    const key = await opts.exportDiff(rawDiff);
    opts.onDiffExported?.(key);
  }
  const files = await collectExpectedSandboxDeliverables(ops, workdir, settled, opts.expectedDeliverables, signal);
  let totalBytes = files.reduce((sum, file) => sum + new TextEncoder().encode(file.content ?? "").byteLength, 0);
  for (const { path, objectId } of changes) {
    signal?.throwIfAborted();
    if (objectId === null || opts.expectedDeliverables?.includes(path)) continue;
    const size = await ops.exec(shellJoin(["git", "--no-replace-objects", "cat-file", "-s", objectId]), { cwd: workdir, timeoutMs: GIT_TIMEOUT_MS, signal });
    const bytes = Number(size.stdout.trim());
    if (size.exitCode !== 0 || !/^\d+\s*$/.test(size.stdout) || !Number.isSafeInteger(bytes) || bytes > MAX_FILE_CHARS) {
      throw new Error(`Repository file ${path} exceeds MAX_FILE_CHARS or could not be read completely.`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_FILE_CHARS) throw new Error("Captured file content exceeds MAX_TOTAL_FILE_CHARS; refusing to publish a partial tree.");
    const blob = await ops.exec(shellJoin(["node", "-e", REPOSITORY_BLOB_READER, objectId]), {
      cwd: workdir, timeoutMs: GIT_TIMEOUT_MS, signal, maxOutputChars: Math.ceil(MAX_FILE_CHARS / 3) * 4 + 1,
    });
    let data: Uint8Array;
    try {
      const encoded = blob.stdout;
      if (blob.exitCode !== 0 || encoded.length !== Math.ceil(bytes / 3) * 4) throw new Error("Truncated blob");
      const raw = atob(encoded);
      if (btoa(raw) !== encoded || raw.length !== bytes) throw new Error("Noncanonical blob");
      data = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      const header = new TextEncoder().encode(`blob ${bytes}\0`);
      const objectBytes = new Uint8Array(header.byteLength + bytes);
      objectBytes.set(header); objectBytes.set(data, header.byteLength);
      const digest = new Uint8Array(await crypto.subtle.digest(objectId.length === 40 ? "SHA-1" : "SHA-256", objectBytes));
      if (Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") !== objectId) throw new Error("Git object integrity mismatch");
    } catch {
      throw new Error(`Repository file ${path} has invalid, truncated, or corrupt byte transport.`);
    }
    try {
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
      if (data.some((byte) => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)) throw new Error("Binary data");
      files.push({ path, content, encoding: "utf8" });
    } catch {
      files.push({ path, content: blob.stdout, encoding: "base64" });
    }
  }
  for (const { path, objectId } of changes) {
    if (objectId === null) files.push({ path, content: null, encoding: "utf8" });
  }
  return { changedFiles: changes.map(({ path }) => path), diff: boundTail(rawDiff, MAX_DIFF_CHARS), files };
}
