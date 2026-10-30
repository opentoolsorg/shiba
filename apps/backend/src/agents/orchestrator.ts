Warning: truncated output (original token count: 54681)
Total output lines: 5022

/**
 * Planning and delegation agent. It never edits repositories itself:
 * the only repository-touching capability is delegate_coding_task, which
 * requires explicit human approval and runs inside an isolated Sandbox
 * container driven by OpenCodeAgent.
 */
import { Think } from "@cloudflare/think";
import {
  AGENT_ROLES,
  approvalEventInput,
  foldOutboxEvent,
  HARNESS_IDS,
  isAgentRole,
  isReasoningEffort,
  withoutSealedEnv,
  type JsonValue,
  executionTargetSchema,
  LOCAL_INTAKE_DASHBOARD,
  LOCAL_INTAKE_HEADER,
  LOCAL_RUNTIME_FLAG,
  MAX_PENDING_APPROVALS,
  MAX_SPINE_EVENTS,
  type OutboxEntry,
  pruneApprovals,
  REASONING_EFFORTS,
  type RunCommand,
  type RunDecision,
  runtimeSelectionSchema,
  type RunSignal,
  type SideEffectKind,
  type SpineEvent,
  type SpineEventInput,
  sideEffectRequestInput,
  sideEffectResultInput,
  spineInputsFromDecider,
  testCommandSchema,
  expectedDeliverablesSchema,
  isFindingTriage,
  latestRoundForCodingRun,
  parseInlineSeverityThreshold,
  parseReviewEnvelope,
  patchFindingTriage,
  reviewRoundWriteRejected,
  runInputHash,
  type FindingSeverity,
  type ReviewLoopSettings,
  type ReviewRound,
  canStartRunWithBudget,
  denIdWireFields,
  parseDenAgentName,
  resolveDenId,
  parseDailyBudgetUsd,
  parseElevatedConcurrencyFlag,
  type ContainerBudgetConfig,
  type ExecutionTarget,
  resolveMaxConcurrentRuns,
} from "@shiba/shared";
import { buildDenDigest, buildPackFromRuns } from "../den/digest.js";
import { sandboxSelectionForRun } from "../sandbox/run-selection.js";
import { mintSubagentRun, type SpawnSubagentInput } from "../den/spawn.js";
import { shouldDestroySandboxAfterRun } from "../sandbox/release-policy.js";
import type { Connection, ConnectionContext } from "agents";
import { agentTool } from "agents/agent-tools";
import { type ToolSet, tool } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import { postToChatThread } from "../chat-lane.js";
import { createRunCodeTool } from "../codemode.js";
import { runWorkerEffect, toRunFailure, tryRunPromise } from "../effect/runtime.js";
import {
  emailApprovalDraftRef,
  executeEmailApproval,
  PostTransmitError,
  releaseRestartedDraftClaim,
  unqueueEmailApprovalDraft,
} from "../email-approvals.js";
import { carriesVouchedHeaders, verifyInternalRequest } from "../edge-identity.js";
import type { Env } from "../env.js";
import { isGitHubPublishConfigured, resolveGitHubCredential } from "../github-auth.js";
import {
  allowedHostsFor,
  HARNESS_DEFAULT_MODELS,
  HARNESS_MODEL_ENV,
  harnessRunsOn,
  resolveHarness,
} from "../harness/index.js";
import { mailboxDirectoryStub, mailboxStub, registeredMailbox } from "../mailbox-do.js";
import { ADDRESS_RE, type MailboxRecord } from "../mailbox-store.js";
import { type ApprovedRoute, describeRoute, isApprovedRoute } from "../model-connections.js";
import { orgIdFromIntake } from "../org-request-auth.js";
import { openRunEnv } from "../run-env-seal.js";
import { resolveRuntimeName } from "../runtime.js";
import { assertRunPreflight } from "../run-preflight.js";
import { readModelConfig, resolveCodingRoute, revalidateCodingRoute } from "../model-policy.js";
import { initiatorUserIdFromOrchestratorName } from "../subscription-routing.js";
import { type CodingTaskInput, formatAgentToolInput, parseAgentResult } from "../opencode-input.js";
import { appendBatch } from "../orchestration/event-log.js";
import { drainOutbox, dueEntries } from "../orchestration/outbox.js";
import {
  approvalEvidenceFor,
  type CommandReceipt,
  createPendingApproval,
  decidedApprovals,
  isApprovalExpired,
  isJsonObject,
  type PendingApproval,
  putCommandReceipt,
  type ResolveResult,
  recordApprovalExecution,
  resolvePendingApproval,
} from "../pending-approvals.js";
import { makeReceipt } from "../receipts.js";
import { logStructured } from "../log.js";
import { runTimedOut } from "../public-error.js";
import { restartDisposition } from "../run-resume.js";
import { fetchAgentsMd } from "../review/agents-md.js";
import { decideChain } from "../review/chain.js";
import { mergePullRequest, type MergeMethod } from "../review/merge.js";
import { reviewerTask } from "../review/prompt.js";
import { reviewRetryPlan, shouldQueueAutoMerge } from "../review/retry-plan.js";
import { postReview } from "../review/publish.js";
import { registerPrOwner } from "../pr-owner-index.js";
import { decidePrWake, pullNumberFromCheckPayload, wakeFollowUpTask } from "../review/wake.js";
import { ORCHESTRATOR_NAME } from "../slack-routes.js";
import { evaluateResultQuality } from "../result-quality.js";
import {
  classifyExecutorError,
  classifyRunError,
  type RunErrorCode,
  type RunErrorWire,
  runErrorWire,
  toTaggedError,
} from "../run-errors.js";
import {
  AGENT_PRINCIPAL_HEADER,
  createRun,
  type DecisionTap,
  type DelegatedRun,
  isActiveStatus,
  RUN_DEADLINE_MS,
  type RunPatch,
  type RunStatus,
  RunStore,
  reclaimStaleRuns,
  recordReceipt,
} from "../runs.js";
import { handleSteeringRequest } from "../steering.js";
import { localDispatchStub } from "../local-dispatch.js";
import {
  acquireSandboxOps,
  destroyManagedContainer,
  forgetLeaked,
  type LeakedContainer,
  type LeakHooks,
  leakedContainers,
} from "../sandbox/lifecycle.js";
import type { SandboxSelectionContext } from "../sandbox/selection.js";
import {
  type ScreenAction,
  ScreenActionError,
  screenActionArgv,
  runScreenAction,
  ScopedExecRefusal,
} from "../screen-control.js";
import { makeSandboxId, parseGitHubRepoUrl, redactSecrets } from "../security.js";
import { DEFAULT_ORCHESTRATOR_MODEL, distillSession } from "../session-distill.js";
import { evaluateSessionTriage } from "../session-triage.js";
import { postSlackMessage } from "../slack.js";
import {
  type ApprovalCardInput,
  approvalCardText,
  buildApprovalBlocks,
} from "../slack-approval.js";
import {
  slackRunCancelled,
  slackRunCompleted,
  slackRunFailed,
  slackRunStarted,
} from "../slack-persona.js";
import { parseSlackThreadName } from "../slack-thread.js";
import { extractPullRequestUrl } from "../transcript.js";
import {
  isDashboardAgentName,
  MAX_SESSIONS_PER_USER,
  pruneExpiredWebSessions,
  sanitizeSessionMetadata,
  sanitizeSessionName,
  validateSessionRecordIntegrity,
  type WebSessionRecord,
} from "../web-sessions.js";
import { OpenCodeAgent } from "./opencode-agent.js";
import { resolveRoleModel } from "./roles.js";

/** App-range WebSocket close code sent to sockets of a deleted web session. */
export const SESSION_DELETED_CLOSE_CODE = 4410;

export interface OrchestratorState {
  runs: DelegatedRun[];
  pendingApprovals?: PendingApproval[];
  /** Leaks recorded before a hibernation still get their destroy retried. */
  leakedContainers?: Record<string, LeakedContainer>;
  webSessions?: WebSessionRecord[];
  /**
   * Set by session teardown on a `web:` session DO. The registry tombstone
   * lives on the base DO and only gates the Worker; this flag is what stops
   * a request already past that check, or a socket opened before it.
   */
  sessionDeletedAt?: number;
  /**
   * Durable command receipts (T41): one per processed command, keyed by
   * commandId and committed in the same setState write as the decision
   * or run it records. A retried resolve or queue reads the receipt and
   * answers from it instead of re-running the effect.
   */
  commandReceipts?: Record<string, CommandReceipt>;
  /** Review rounds for this thread. GitHub is the system of record for the posted review. */
  reviewRounds?: ReviewRound[];
  /** v1 review-loop settings keyed by coding run id. */
  reviewLoops?: Record<string, ReviewLoopSettings>;
  /** `owner/repo#n` → coding run that opened the PR (webhook wake target). */
  prBindings?: Record<string, string>;
  /**
   * P9 spine: the append-only event log. Every mutation routes through
   * `decide → appendEvents → apply` — the events below are the durable
   * record of what was decided; `runs`/`pendingApprovals` are their
   * materialized projection, and `outbox` tracks the side effects the
   * log requested. `seq` is per-orchestrator and never reused; the tail
   * is retained to MAX_SPINE_EVENTS (receipts carry the durable outcome
   * for anything older).
   */
  events?: SpineEvent[];
  outbox?: OutboxEntry[];
}

/** A classified error lands as its matching terminal status. */
function terminalStatusFor(code: RunErrorCode): RunStatus {
  // Indeterminate family: the run ended but its side effects are unverified —
  // the record is "unknown" so the wire projection and the dashboard agree.
  return code === "cancelled"
    ? "cancelled"
    : code === "outcome_unknown" || code === "container_lost"
      ? "unknown"
      : "error";
}

/** Exported for tests — the tool-call surface stays the single caller. */
export const delegateInputSchema = z.object({
  repoUrl: z.string().describe("HTTPS GitHub repository URL, e.g. https://github.com/owner/repo."),
  task: z.string().describe("The coding task to perform in the repository."),
  baseBranch: z
    .string()
    .optional()
    .default("main")
    .describe("Base branch to clone. Defaults to main."),
  publishPullRequest: z
    .boolean()
    .optional()
    .default(false)
    .describe("Open a pull request with the result. Requires GITHUB_TOKEN."),
  reviewAfterPublish: z
    .boolean()
    .optional()
    .describe("After the PR opens, run a read-only review and post findings. Covered by this approval."),
  harness: z
    .enum(HARNESS_IDS)
    .optional()
    .describe(
      "Coding agent harness. Defaults to the deployment's AGENT_HARNESS, else opencode. " +
        "API-key harnesses: claude-code needs an anthropic/* model; codex an openai/* model; " +
        "grok an xai/* model. Subscription harnesses use their " +
        "<provider>-subscription/* model namespace and are only registered when the matching " +
        "SHIBA_*_SUBSCRIPTION=1 flag is set (anthropic-subscription, openai-subscription, " +
        "google-subscription, cursor-subscription). ACP lanes " +
        "(claude-acp, codex-acp, gemini-acp, opencode-acp) drive the pinned " +
        "CLIs through the Agent Client Protocol in-container.",
    ),
  role: z
    .enum(AGENT_ROLES)
    .optional()
    .describe(
      "Delegation role (orchestrator | explorer | fixer | reviewer | designer). " +
        "When set, the deployment's ROLE_MODEL_MAP / ROLE_MODEL__<ROLE> pin " +
        "resolves the harness and model before any per-call or deployment default.",
    ),
  authAccount: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
    .optional()
    .describe(
      "Subscription account name for subscription-authed harnesses (e.g. claude-subscription). " +
        "Maps to a named Worker secret; 'default' when absent. Never a credential.",
    ),
  codingModel: z
    .string()
    .optional()
    .describe(
      "Coding model as provider/model, e.g. google/gemini-3.5-flash-lite. " +
        "Defaults to the deployment's per-harness model.",
    ),
  connectionId: z
    .string()
    .optional()
    .describe(
      "Model connection id (conn_*) from the deployment's connection catalog. " +
        "Defaults to the deployment's implicit gateway/secret default.",
    ),
  reasoningEffort: z
    .enum(REASONING_EFFORTS)
    .optional()
    .describe(
      "Reasoning effort for the coding model. Only levels the harness supports are accepted " +
        "(claude-code: low..max, codex: minimal..xhigh, opencode: low/medium/high). Defaults to the model's own.",
    ),
  expectedDeliverables: expectedDeliverablesSchema.optional(),
  testCommand: testCommandSchema
    .optional()
    .describe(
      'The project\'s test command as argv, e.g. ["pnpm","test"]. Runs in the ' +
        "sandbox through the scoped exec allowlist; the run only reports " +
        "completed when the command is allowlisted and exits 0.",
    ),
  runtime: runtimeSelectionSchema
    .optional()
    .describe(
      'Execution runtime: "sandbox" (default) runs in an isolated container; ' +
        '"local" runs on the operator\'s machine through the local daemon. "local" ' +
        "is admissible only from the dashboard on a deployment with SHIBA_LOCAL_RUNTIME=1.",
    ),
  customAgentId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Org custom agent id from /api/custom-agents — applies harness, model, and sandbox defaults."),
  orgId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Org scope for custom-agent and sandbox selection (v1 principal org; dashboard defaults to self-hosted)."),
});

type DelegateInput = z.infer<typeof delegateInputSchema> & { executionTarget?: ExecutionTarget };

type FrozenRunEnv = { envNames: string[]; envDigest: string; envSealed: string };

// Composer fields a chat message may pin via metadata.shibaTask. Declared without
// .default() (zod 4 re-injects defaults under .partial()); runtime/role/authAccount/testCommand are never read.
// Per-field .catch: one bad field drops only itself, not the whole pin.
const composerPinSchema = z.object({
  repoUrl: z.string().min(1).optional().catch(undefined),
  task: z.string().min(1).optional().catch(undefined),
  baseBranch: z.string().min(1).optional().catch(undefined),
  publishPullRequest: z.boolean().optional().catch(undefined),
  reviewAfterPublish: z.boolean().optional().catch(undefined),
  harness: z.enum(HARNESS_IDS).optional().catch(undefined),
  codingModel: z.string().min(1).optional().catch(undefined),
  connectionId: z.string().min(1).optional().catch(undefined),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional().catch(undefined),
  customAgentId: z.string().min(1).max(128).optional().catch(undefined),
  orgId: z.string().min(1).max(128).optional().catch(undefined),
});

/**
 * Floor between full-mailbox stale-draft sweeps. The sweep is a
 * backstop, not a per-poll job — the dashboard polls approvals every
 * 10s and each run wakes every registered mailbox DO, so it fires at
 * most this often per orchestrator lifetime. A touch that just
 * dropped expired email sends passes `force` — their drafts need
 * freeing now, not at the next tick.
 */
const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Floor between full reclaim sweeps (stale-run scan + leaked-container
 * retries) on the read path. Owed post-backs still drain on every call —
 * this gates only the expensive sweep, at most once per interval per DO
 * lifetime. The alarm path calls reclaimRuns directly, unfloored.
 */
const RECLAIM_SWEEP_INTERVAL_MS = 30 * 1000;
/** Per-step bound on sequential cleanup loops so one hung destroy cannot starve the rest. */
const CLEANUP_TIMEOUT_MS = 30_000;

/**
 * The payload an email approval freezes is the executor's verbatim
 * contract — executeEmailApproval reads exactly these keys per kind, so
 * no other caller-supplied key may ride into durable DO state.
 */
const EMAIL_SEND_PAYLOAD_KEYS = [
  "to_addr",
  "subject",
  "body_text",
  "thread_id",
  "in_reply_to_email_id",
  "draft_id",
] as const;
const EMAIL_DELETE_PAYLOAD_KEYS = ["email_id", "subject", "from_addr"] as const;

/** Per-key character bounds on the frozen payload — durable state, not a data pipe. */
const EMAIL_PAYLOAD_LIMITS: Record<string, number> = {
  to_addr: 320,
  subject: 2_000,
  body_text: 100_000,
  thread_id: 400,
  in_reply_to_email_id: 400,
  draft_id: 400,
  email_id: 400,
  from_addr: 320,
};

/**
 * Accept a scraped "Pull request:" URL only when it points at a PR in the
 * run's own repository — transcript text is agent-influenced, so a link to
 * any other repo is rejected instead of posted to Slack.
 */
function repoPullUrl(output: string, repoUrl: string): string | undefined {
  const url = extractPullRequestUrl(output);
  if (!url) return undefined;
  // Structural match, not a prefix check: ../ or %2e%2e segments could
  // otherwise smuggle a different repo past startsWith.
  const match = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(url);
  if (!match) return undefined;
  const { owner, repo } = parseGitHubRepoUrl(repoUrl);
  return match[1]!.toLowerCase() === owner.toLowerCase() &&
    match[2]!.toLowerCase() === repo.toLowerCase()
    ? url
    : undefined;
}

export class CodingOrchestrator extends Think<Env, OrchestratorState> {
  /** The orchestrator plans and delegates; it never runs shell commands. */
  override workspaceBash = false;

  // Abort signal per active run so cancel/reclaim reaches the child container,
  // not just the registry row. Lazy: DO subclasses may be constructed without
  // the base constructor in tests.
  private runControllersMap: Map<string, AbortController> | undefined;
  private get runControllers(): Map<string, AbortController> {
    return (this.runControllersMap ??= new Map());
  }

  /**
   * Side-effect ids a synchronous send is already driving this
   * lifetime — the outbox drainer skips these rows so an open
   * postToThread send can't be re-driven mid-flight (a double post and
   * a double-counted attempt). Volatile by design: rows a dead
   * lifetime left pending still replay on the next wake.
   */
  private inFlightEffectsSet: Set<string> | undefined;
  private get inFlightEffects(): Set<string> {
    return (this.inFlightEffectsSet ??= new Set());
  }

  /** Stamp of the last full reclaim sweep — see RECLAIM_SWEEP_INTERVAL_MS. */
  private lastReclaimSweepAt: number | undefined;
  private leakCleanupPromise: Promise<void> | undefined;

  /**
   * P9: spine inputs awaiting commit on the next durable write. The
   * store's decision tap, approval writes, and side-effect request/
   * result sites push here; `setState` flushes the buffer so an event
   * and the mutation it decided land in the same atomic write.
   */
  private spineBuf: SpineEventInput[] | undefined;

  private emitSpine(...inputs: SpineEventInput[]): void {
    // Lazy like runControllersMap: test subclasses constructed without
    // the base constructor still get a buffer.
    (this.spineBuf ??= []).push(...inputs);
  }

  /**
   * The decision tap every run-transition path shares — store writes,
   * mint, and reclaim all report their decided events through it so the
   * log sees the same batch the read model applied.
   */
  private spineTap(command: RunCommand, decision: RunDecision): void {
    if ("error" in decision) return;
    this.emitSpine(
      ...spineInputsFromDecider(command.runId, command.commandId, decision.events, command.at),
    );
  }

  /**
   * Fold pending spine inputs into the state about to commit: assign
   * seq from the retained tail, synthesize approval.requested/answered
   * events from the pendingApprovals diff (covering every mutation
   * site, not only the ones that emit explicitly), and fold the
   * side_effect.* events into the outbox projection.
   */
  private applySpine(next: OrchestratorState): void {
    const before = this.state?.pendingApprovals ?? [];
    const after = next.pendingApprovals ?? [];
    // Snapshot the buffer; it is drained by setState only after the
    // write commits, so a rejected write loses nothing.
    const inputs = [...(this.spineBuf ?? [])];
    const logged = new Set(
      inputs
        .filter((input) => input.kind === "approval.requested" || input.kind === "approval.answered")
        .map((input) => `${input.kind}:${input.approvalId}`),
    );
    const priorApprovals = new Map<string, Map<string, PendingApproval>>();
    for (const approval of before) {
      let thread = priorApprovals.get(approval.threadKey);
      if (!thread) {
        thread = new Map();
        priorApprovals.set(approval.threadKey, thread);
      }
      // Preserve Array.find's first-match behavior for legacy duplicates.
      if (!thread.has(approval.approvalId)) thread.set(approval.approvalId, approval);
    }
    for (const approval of after) {
      const prior = priorApprovals.get(approval.threadKey)?.get(approval.approvalId);
      if (prior === undefined) {
        if (!logged.has(`approval.requested:${approval.approvalId}`)) {
          inputs.push(
            approvalEventInput({
              approval,
              commandId: `approval.request:${approval.approvalId}`,
              at: approval.createdAt,
            }),
          );
        }
      } else if (prior.status === "pending" && approval.status !== "pending") {
        if (!logged.has(`approval.answered:${approval.approvalId}`)) {
          inputs.push(
            approvalEventInput({
              approval,
              result: approval.status === "approved" ? "approved" : "rejected",
              commandId: `approval.answer:${approval.approvalId}`,
              at: approval.decidedAt ?? Date.now(),
            }),
          );
        }
      }
    }
    if (inputs.length === 0) return;
    const priorLog = this.state?.events ?? next.events ?? [];
    const appended = appendBatch(priorLog, inputs);
    next.events = [...priorLog, ...appended].slice(-MAX_SPINE_EVENTS);
    let outbox = next.outbox;
    for (const event of appended) {
      outbox = foldOutboxEvent(outbox, event);
    }
    next.outbox = outbox;
  }

  /**
   * Every state write funnels through here — store transitions,
   * approval resolves, receipts — so the spine flush rides the same
   * atomic commit as the mutation it records.
   */
  override setState(next: OrchestratorState): void {
    this.applySpine(next);
    super.setState(next);
    this.spineBuf = [];
  }

  private get store(): RunStore {
    return new RunStore(
      () => this.state?.runs ?? [],
      (runs) => this.setState({ ...this.state, runs }),
      (command, decision) => this.spineTap(command, decision),
    );
  }

  private get approvals(): PendingApproval[] {
    return this.state?.pendingApprovals ?? [];
  }

  /**
   * Wall-clock time of this lifetime's last stale-draft sweep —
   * volatile on purpose: an evicted DO re-sweeps once on its next
   * approval touch, which is the correct post-restart behavior anyway.
   */
  private lastStaleSweepAt: number | undefined;

  private writeApprovals(next: PendingApproval[]): void {
    this.setState({ ...this.state, pendingApprovals: next });
  }

  private commandReceipt(commandId: string): CommandReceipt | undefined {
    return this.state?.commandReceipts?.[commandId];
  }

  private withCommandReceipt(receipt: CommandReceipt): Record<string, CommandReceipt> {
    return putCommandReceipt(this.state?.commandReceipts ?? {}, receipt);
  }

  private recordCommandReceipt(receipt: CommandReceipt): void {
    this.setState({ ...this.state, commandReceipts: this.withCommandReceipt(receipt) });
  }

  get storedWebSessions(): WebSessionRecord[] {
    return this.state?.webSessions ?? [];
  }

  private writeWebSessions(webSessions: WebSessionRecord[]): void {
    const current = this.state ?? { runs: [] };
    this.setState({
      ...current,
      webSessions,
    });
  }

  /**
   * F17: evict registry records idle longer than WEB_SESSION_TTL_MS. The
   * hard cap bounds count but not retention — without expiry an abandoned
   * session occupies its slot forever. Pruning runs on the read surfaces
   * so stale rows leave durable state, not just the response.
   */
  private evictExpiredWebSessions(now: number): void {
    const pruned = pruneExpiredWebSessions(this.storedWebSessions, now);
    if (pruned.length !== this.storedWebSessions.length) {
      this.writeWebSessions(pruned);
    }
  }

  private get sessionDeleted(): boolean {
    return this.state?.sessionDeletedAt !== undefined;
  }

  // `cf_agent_state` frames carry a connection source; server mutations use "server".
  override validateStateChange(_nextState: OrchestratorState, source: Connection | "server"): void {
    if (source !== "server") {
      throw new Error("Client state writes are not accepted.");
    }
  }

  private closeLiveConnections(): void {
    for (const conn…42681 tokens truncated…ogStructured("info", { event: "review.retry", runId: round.reviewRunId, threadId: parent.runId, detail: "rerun" });
      await this.queueReviewForCodingRun(parent, headSha, { force: true });
      const next =
        (this.state.reviewRounds ?? []).find((item) => item.codingRunId === parent.runId && item.pull.headSha === headSha) ??
        round;
      return Response.json({ ok: true, round: next, action: "rerun" });
    }
    const cred = await resolveGitHubCredential(
      this.env,
      round.pull ? `https://github.com/${round.pull.owner}/${round.pull.repo}` : undefined,
    );
    if (!cred) {
      return Response.json(
        { ok: false, error: "github_not_configured", userMessage: "GitHub is not configured, so the review cannot be posted." },
        { status: 503 },
      );
    }
    try {
      const posted = await postReview(round, cred.token, {
        apiBase: cred.apiBase,
        inlineThreshold: this.inlineReviewThreshold(),
      });
      const next: ReviewRound = { ...round, status: "posted", githubReviewId: posted.githubReviewId, postedAt: Date.now() };
      this.writeRound(next);
      logStructured("info", { event: "review.retry", runId: round.reviewRunId, threadId: round.codingRunId, detail: "repost" });
      await this.maybeAutoMerge(next);
      return Response.json({ ok: true, round: next, action: "repost" });
    } catch (error) {
      const failed: ReviewRound = {
        ...round,
        status: "failed",
        error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500),
      };
      this.writeRound(failed);
      return Response.json(
        { ok: false, round: failed, userMessage: "GitHub rejected the review post. You can retry again." },
        { status: 502 },
      );
    }
  }

  private async maybeAutoMerge(round: ReviewRound): Promise<void> {
    const loop = this.reviewLoopFor(round.codingRunId);
    if (!shouldQueueAutoMerge(loop, round)) return;
    if (!/^[a-fA-F0-9]{40,64}$/.test(round.pull.headSha)) {
      logStructured("warn", {
        event: "review.automerge_skipped",
        runId: round.reviewRunId,
        threadId: round.codingRunId,
        detail: "head_sha_unavailable",
      });
      return;
    }
    logStructured("info", {
      event: "review.automerge_queued",
      runId: round.reviewRunId,
      threadId: round.codingRunId,
    });
    await this.queuePrMergeApproval({
      threadKey: round.codingRunId,
      payload: {
        owner: round.pull.owner,
        repo: round.pull.repo,
        number: round.pull.number,
        expectedHeadSha: round.pull.headSha,
        mergeMethod: "squash",
      },
    });
  }

  private async handleReviewLoop(request: Request, threadId: string): Promise<Response> {
    const current = this.state.reviewLoops?.[threadId] ?? null;
    if (request.method === "GET") return Response.json({ ok: true, reviewLoop: current });
    if (request.method !== "PATCH") return Response.json({ error: "Method not allowed." }, { status: 405 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
    }
    const record = body as Record<string, unknown>;
    const allowed = new Set(["enabled", "autoMerge", "pullRequestId"]);
    if (Object.keys(record).some((key) => !allowed.has(key))) {
      return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
    }
    if (
      (record.enabled !== undefined && typeof record.enabled !== "boolean") ||
      (record.autoMerge !== undefined && typeof record.autoMerge !== "boolean") ||
      (record.pullRequestId !== undefined && (typeof record.pullRequestId !== "string" || !record.pullRequestId))
    ) {
      return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
    }
    const next: ReviewLoopSettings = {
      threadId,
      enabled: record.enabled !== undefined ? record.enabled : (current?.enabled ?? false),
      autoMerge: record.autoMerge !== undefined ? record.autoMerge : (current?.autoMerge ?? false),
      ...(record.pullRequestId !== undefined
        ? { pullRequestId: record.pullRequestId }
        : current?.pullRequestId
          ? { pullRequestId: current.pullRequestId }
          : {}),
      updatedAt: Date.now(),
    };
    this.setState({ ...this.state, reviewLoops: { ...this.state.reviewLoops, [threadId]: next } });
    logStructured("info", {
      event: "review.loop",
      runId: threadId,
      threadId,
      detail: next.enabled ? "enabled" : "disabled",
    });
    if (next.enabled) {
      const parent = this.store.get(threadId);
      if (parent?.pullUrl && parent.status === "completed") {
        const pull = this.parsePull(parent.pullUrl);
        const headSha = pull ? await this.pullHeadSha(pull.owner, pull.repo, pull.number) : "head";
        await this.queueReviewForCodingRun(parent, headSha);
      }
      const latest =
        latestRoundForCodingRun(this.state.reviewRounds ?? [], threadId) ?? null;
      if (latest) await this.maybeAutoMerge(latest);
    }
    return Response.json({ ok: true, reviewLoop: this.state.reviewLoops?.[threadId] ?? next });
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Edge identity: when INTERNAL_SIGNING_KEY is configured, any request
    // carrying vouched headers must present a valid Worker signature —
    // otherwise a forged X-Agent-Principal would scope/cancel as another
    // principal. Requests without vouched headers pass unverified (same
    // trust level as before). Unset key = header-trust fallback for dev.
    const verification = await verifyInternalRequest(request, this.env);
    if (!verification.ok) {
      return Response.json(
        { error: `Internal signature verification failed (${verification.reason}).` },
        { status: 401 },
      );
    }
    if (!verification.signed && carriesVouchedHeaders(request)) {
      this.warnSigningDisabledOnce();
    }
    // Worker-vouched agent identity: only mcp-run-tools sets this after
    // bearer auth, so it scopes reads/cancels to records that principal
    // queued. External callers never reach this DO without an Access or
    // signature-authenticated identity on the Worker first.
    const agentPrincipal = request.headers.get(AGENT_PRINCIPAL_HEADER)?.trim() || null;
    // Cron backstop for the poll-driven stale-draft sweep — in a quiet
    // system no approvals fetch or DO restart ever calls it, so a human
    // who stops polling would leave `sending`-locked drafts held forever.
    if (request.method === "POST" && url.pathname === "/internal/sweep-drafts") {
      this.sweepStaleDrafts(true);
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/internal/pr-lifecycle") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }
      const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      return this.handlePrLifecycleWake(record);
    }
    if (url.pathname.startsWith("/internal/web-sessions")) {
      return this.handleInternalWebSessions(request, url);
    }
    if (url.pathname === "/internal/session-teardown") {
      return this.handleInternalSessionTeardown(request, url);
    }
    if (
      (url.pathname === "/internal/den/snapshot" || url.pathname === "/internal/captain/snapshot") &&
      request.method === "GET"
    ) {
      return this.denSnapshot();
    }
    // Teardown stays reachable above so a delete can be retried; everything
    // else on a deleted session is gone, whatever the Worker checked first.
    if (this.sessionDeleted) {
      return Response.json({ error: "Session deleted." }, { status: 410 });
    }
    if (url.pathname === "/api/runs/subagents/spawn" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON." }, { status: 400 });
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return Response.json({ error: "Body must be a JSON object." }, { status: 400 });
      }
      return this.spawnSubagent(body as Record<string, unknown>, agentPrincipal);
    }
    if (url.pathname === "/api/approvals" && request.method === "GET") {
      return this.listApprovals(agentPrincipal);
    }
    if (request.method === "POST" && url.pathname === "/api/approvals") {
      // Approving is a human act — an agent principal can never decide.
      if (agentPrincipal !== null) {
        return Response.json(
          { error: "Agent principals cannot decide approvals." },
          { status: 403 },
        );
      }
      let approvalBody: unknown;
      try {
        approvalBody = await request.json();
      } catch {
        return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
      }
      if (
        typeof approvalBody !== "object" ||
        approvalBody === null ||
        Array.isArray(approvalBody)
      ) {
        return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
      }
      return this.resolveApproval(approvalBody as Record<string, unknown>);
    }
    if (url.pathname === "/api/approvals") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    // P9 spine surface (PLAN-V2-NEXT): the durable event log + outbox —
    // what the orchestrator decided and which side effects it still owes.
    if (url.pathname === "/api/spine") {
      if (request.method !== "GET") {
        return Response.json({ error: "Method not allowed." }, { status: 405 });
      }
      // Incremental reads pass ?since=<seq>: only newer events ship, plus
      // the log-window markers so the client detects a rotated log —
      // earliestSeq above its cursor means events were pruned under it.
      let since: number | null = null;
      const sinceParam = url.searchParams.get("since");
      if (sinceParam !== null) {
        const parsed = Number(sinceParam);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return Response.json(
            { error: "since must be a non-negative integer." },
            { status: 400 },
          );
        }
        since = parsed;
      }
      const events = this.state?.events ?? [];
      const outbox = this.state?.outbox ?? [];
      const tail = since === null ? events : events.filter((event) => event.seq > since);
      const earliestSeq = events.length > 0 ? events[0]!.seq : 0;
      const latestSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
      const totalEvents = events.length;
      if (agentPrincipal === null) {
        return Response.json({ events: tail, outbox, earliestSeq, latestSeq, totalEvents });
      }
      // Agent principals see only events on runs they queued; an event with
      // no runId is orchestrator-internal and stays hidden.
      const mine = new Set(
        this.store.list().filter((run) => run.queuedBy === agentPrincipal).map((run) => run.runId),
      );
      return Response.json({
        events: tail.filter((e) => e.runId !== undefined && mine.has(e.runId)),
        outbox: outbox.filter((e) => e.runId !== undefined && mine.has(e.runId)),
        earliestSeq,
        latestSeq,
        totalEvents,
      });
    }
    const screenMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/screen$/);
    if (screenMatch !== null) {
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed." }, { status: 405 });
      }
      let screenBody: unknown;
      try {
        screenBody = await request.json();
      } catch {
        return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
      }
      if (typeof screenBody !== "object" || screenBody === null || Array.isArray(screenBody)) {
        return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
      }
      let screenRunId: string;
      try {
        screenRunId = decodeURIComponent(screenMatch[1]!);
      } catch {
        return Response.json({ error: "Invalid run ID." }, { status: 400 });
      }
      return this.screenAction(screenRunId, screenBody as Record<string, unknown>, agentPrincipal);
    }
    const archiveMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/archive$/);
    if (archiveMatch) {
      if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
      let id: string;
      try { id = decodeURIComponent(archiveMatch[1]!); }
      catch { return Response.json({ error: "Invalid run ID." }, { status: 400 }); }
      const existing = this.store.get(id);
      if (!existing || (agentPrincipal !== null && existing.queuedBy !== agentPrincipal)) {
        return Response.json({ error: "Run not found." }, { status: 404 });
      }
      const run = await this.archiveRun(id);
      return run ? Response.json({ run: this.serializeRun(run) })
        : Response.json({ error: "Run not found." }, { status: 404 });
    }
    const triageMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/review\/findings\/([^/]+)\/triage$/);
    if (triageMatch && request.method === "PATCH") {
      let runId: string;
      let findingId: string;
      try {
        runId = decodeURIComponent(triageMatch[1] ?? "");
        findingId = decodeURIComponent(triageMatch[2] ?? "");
      } catch {
        return Response.json({ ok: false, error: "invalid_id" }, { status: 400 });
      }
      const rounds = this.state.reviewRounds ?? [];
      const round =
        latestRoundForCodingRun(rounds, runId) ??
        rounds.find((item) => item.codingRunId === runId || item.reviewRunId === runId);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
      }
      const triage =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as { triage?: unknown }).triage
          : undefined;
      if (!isFindingTriage(triage) || !round) {
        return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
      }
      const next = patchFindingTriage(round, findingId, triage);
      if (!next) return Response.json({ ok: false, error: "finding_not_found" }, { status: 404 });
      this.writeRound(next);
      return Response.json({ ok: true, round: next });
    }
    const mergeMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/merge$/);
    if (mergeMatch && request.method === "POST") {
      let mergeBody: unknown;
      try {
        mergeBody = await request.json();
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }
      const record =
        typeof mergeBody === "object" && mergeBody !== null ? (mergeBody as Record<string, unknown>) : {};
      let runId: string;
      try {
        runId = decodeURIComponent(mergeMatch[1] ?? "");
      } catch {
        return Response.json({ error: "invalid_thread" }, { status: 400 });
      }
      const run = this.store.get(runId);
      const pull = run?.pullUrl ? this.parsePull(run.pullUrl) : null;
      if (!pull) return Response.json({ error: "pull_request_not_found" }, { status: 404 });
      const expectedHeadSha =
        typeof record.expectedHeadSha === "string" ? record.expectedHeadSha : pull ? await this.pullHeadSha(pull.owner, pull.repo, pull.number) : "";
      return this.queuePrMergeApproval({
        threadKey: runId,
        payload: {
          owner: pull.owner,
          repo: pull.repo,
          number: pull.number,
          expectedHeadSha,
          ...(typeof record.mergeMethod === "string" ? { mergeMethod: record.mergeMethod } : {}),
          ...(typeof record.commitTitle === "string" ? { commitTitle: record.commitTitle } : {}),
          ...(typeof record.commitMessage === "string" ? { commitMessage: record.commitMessage } : {}),
        },
      });
    }
    const reviewLoopMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/review-loop$/);
    if (reviewLoopMatch) {
      let threadId: string;
      try {
        threadId = decodeURIComponent(reviewLoopMatch[1] ?? "");
      } catch {
        return Response.json({ ok: false, error: "invalid_thread" }, { status: 400 });
      }
      return this.handleReviewLoop(request, threadId);
    }
    const reviewMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/review(?:\/(retry))?$/);
    if (reviewMatch) return this.handleReviewRoute(request, reviewMatch);
    const steerMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/steer$/);
    if (steerMatch !== null) {
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed." }, { status: 405 });
      }
      let steerBody: unknown;
      try {
        steerBody = await request.json();
      } catch {
        return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
      }
      let steerRunId: string;
      try {
        steerRunId = decodeURIComponent(steerMatch[1]!);
      } catch {
        return Response.json({ error: "Invalid run ID." }, { status: 400 });
      }
      const existing = this.store.get(steerRunId);
      if (!existing || (agentPrincipal !== null && existing.queuedBy !== agentPrincipal)) {
        return Response.json({ error: "Run not found." }, { status: 404 });
      }
      return this.steerRun(steerRunId, steerBody, agentPrincipal);
    }
    const subagentMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/subagents$/);
    if (subagentMatch && request.method === "POST") {
      let parentRunId: string;
      try { parentRunId = decodeURIComponent(subagentMatch[1]!); }
      catch { return Response.json({ error: "Invalid run ID." }, { status: 400 }); }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON." }, { status: 400 });
      }
      const payload =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? { ...(body as Record<string, unknown>), parentRunId }
          : null;
      if (!payload) return Response.json({ error: "Body must be a JSON object." }, { status: 400 });
      return this.spawnSubagent(payload, agentPrincipal);
    }
    const forkMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/fork$/);
    if (forkMatch !== null) {
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed." }, { status: 405 });
      }
      let forkBody: unknown;
      try {
        forkBody = await request.json();
      } catch {
        return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
      }
      if (typeof forkBody !== "object" || forkBody === null || Array.isArray(forkBody)) {
        return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
      }
      let forkRunId: string;
      try {
        forkRunId = decodeURIComponent(forkMatch[1]!);
      } catch {
        return Response.json({ error: "Invalid run ID." }, { status: 400 });
      }
      return this.forkRun(forkRunId, forkBody as Record<string, unknown>, agentPrincipal);
    }
    const match = url.pathname.match(/^\/api\/runs(?:\/([^/]+))?$/);
    if (!match) {
      return super.onRequest(request);
    }
    if (request.method === "POST" && url.pathname === "/api/runs") {
      let queueBody: unknown;
      try {
        queueBody = await request.json();
      } catch {
        return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
      }
      if (typeof queueBody !== "object" || queueBody === null || Array.isArray(queueBody)) {
        return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
      }
      // queuedBy comes only from the vouched header — a body field would
      // let any caller attribute its run to another principal. Same for the
      // T51 intake voucher: only the Worker's /api/runs handler stamps
      // X-Shiba-Intake: dashboard (after deleting the caller's copy).
      return this.queueSlackRun({
        ...(queueBody as Record<string, unknown>),
        queuedBy: agentPrincipal ?? undefined,
        intake: request.headers.get(LOCAL_INTAKE_HEADER) ?? undefined,
      });
    }
    if (request.method !== "GET" && request.method !== "DELETE") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    let id: string | null;
    try {
      id = match[1] ? decodeURIComponent(match[1]) : null;
    } catch {
      return Response.json({ error: "Invalid run ID." }, { status: 400 });
    }
    // GET polls share a floored sweep; DELETE keeps the full reclaim —
    // a cancel needs the store fresh before it fences the run.
    await (request.method === "GET" ? this.reclaimRunsForRead() : this.reclaimRuns());
    if (request.method === "GET" && id === null) {
      const visible =
        agentPrincipal === null
          ? this.store.list()
          : this.store.list().filter((run) => run.queuedBy === agentPrincipal);
      const summary = url.searchParams.get("view") === "summary";
      const project = (run: DelegatedRun) => {
        const serialized = this.serializeRun(run);
        if (!summary) return serialized;
        // Lists are a projection only. Full detail and persisted approval/
        // receipt state remain untouched and available from GET /runs/:id.
        const item = { ...serialized, hasDiff: Boolean(serialized.diff) };
        delete item.diff;
        delete item.receipts;
        delete item.signals;
        delete item.steering;
        return item;
      };
      const limitParam = url.searchParams.get("limit");
      if (limitParam !== null) {
        const limit = Number(limitParam);
        if (!Number.isInteger(limit) || limit < 1) {
          return Response.json({ error: "limit must be a positive integer." }, { status: 400 });
        }
        // Store order is oldest-first; a bounded listing serves newest first.
        return Response.json({
          runs: visible
            .slice(-Math.min(limit, 500))
            .reverse()
            .map(project),
        });
      }
      return Response.json({ runs: visible.map(project) });
    }
    if (request.method === "DELETE" && id === null) {
      // Registry clear is an operator action — never agent-bulk-deletable.
      if (agentPrincipal !== null) {
        return Response.json(
          { error: "Agent principals cannot clear the run registry." },
          { status: 403 },
        );
      }
      await this.clearRuns();
      return Response.json({ ok: true });
    }
    if (id !== null && request.method === "GET") {
      const run = this.store.get(id);
      return run && (agentPrincipal === null || run.queuedBy === agentPrincipal)
        ? Response.json({ run: this.serializeRun(run) })
        : Response.json({ error: "Run not found." }, { status: 404 });
    }
    if (id !== null && request.method === "DELETE") {
      const existing = this.store.get(id);
      if (!existing || (agentPrincipal !== null && existing.queuedBy !== agentPrincipal)) {
        return Response.json({ error: "Run not found." }, { status: 404 });
      }
      const run = await this.cancelRun(id);
      return run
        ? Response.json({ run: this.serializeRun(run) })
        : Response.json({ error: "Run not found." }, { status: 404 });
    }
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
}
