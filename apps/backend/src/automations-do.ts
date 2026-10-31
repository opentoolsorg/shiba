/**
 * Durable Object that owns automation records and the fire path.
 * One instance (`default`) holds the full set so scheduled ticks and
 * webhooks share lastTriggeredAt / daily budget / lastSkip.
 */
import { getAgentByName } from "agents/routing";
import {
  prHeadReviewDedupeKey,
  prOwnerStorageKey,
  type PrOwnerRecord,
} from "@shiba/shared";
import { reviewerTask } from "./review/prompt.js";
import {
  fireMatchingAutomations,
  githubWebhookToEvent,
  linearEventToAutomation,
  slackEventToAutomation,
  type FireAutomationDeps,
  type QueueAutomationRunInput,
} from "./automation-runner.js";
import { isGitHubPublishConfigured } from "./github-auth.js";
import {
  AutomationStore,
  AUTOMATION_OCCURRENCE_HISTORY_LIMIT,
  automationsEnabled,
  collectDueSchedules,
  createAutomation,
  recordTrigger,
  parseAutomationWebhookPath,
  verifyWebhookSecret,
  type Automation,
  type AutomationMatchEvent,
  type CreateAutomationInput,
  type ScheduleOccurrence,
  reviewedSkillPinSha256,
} from "./automations.js";
import type { Env } from "./env.js";
import { InputError } from "./security.js";
import { ORCHESTRATOR_NAME } from "./slack-routes.js";
import { sha256Hex } from "./agent-tokens.js";
import { getCustomAgentById } from "./custom-agents-store.js";
import { DASHBOARD_ORG_ID } from "./org-request-auth.js";

export interface AutomationsState {
  items: Automation[];
}

export interface OrchestratorStub {
  fetch: (request: Request) => Promise<Response>;
}

const WEBHOOK_BATCH_PREFIX = "webhook-batch:";
const WEBHOOK_QUEUE_INTENT_PREFIX = "webhook-queue-intent:";
const WEBHOOK_MAX_BODY_BYTES = 32_000;
const WEBHOOK_MAX_BATCH_BODIES = 32;
// Leave room below Durable Object's 128 KiB value limit for record metadata.
const WEBHOOK_MAX_BATCH_BYTES = 96_000;
const WEBHOOK_RETRY_BASE_MS = 30_000;
const WEBHOOK_RETRY_MAX_MS = 300_000;

interface WebhookBatch {
  bodies: string[];
  firstAt: number;
  windowSeconds: number;
  /** Persisted before queue I/O; a frozen batch cannot accept new payloads. */
  commandId?: string;
  attempts?: number;
  retryAt?: number;
  approvalId?: string;
  chargedAt?: number;
}

interface WebhookQueueIntent extends Omit<QueueAutomationRunInput, "task"> {
  prompt: string;
}

class QueueFailure extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

/** Read the authenticated webhook without allocating an unbounded request body. */
async function webhookBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > WEBHOOK_MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}
const DEDUPE_PREFIX = "dedupe:";
const DEDUPE_TTL_MS = 3_600_000;
const DEDUPE_GC_INTERVAL_MS = 60_000;
const DEDUPE_GC_STATE_KEY = "automation-dedupe-gc:last-success";
const DEDUPE_GC_DELETE_LIMIT = 128;

async function queueOnOrchestrator(
  stub: OrchestratorStub,
  input: {
    repoUrl: string;
    executionTarget?: QueueAutomationRunInput["executionTarget"];
    task: string;
    publishPullRequest: boolean;
    threadKey: string;
    role?: string;
    codingModel?: string;
    commandId?: string;
    customAgentId?: string;
    expectedCustomAgentVersion?: number;
    orgId?: string;
  },
): Promise<{ approvalId: string }> {
  const queued = await stub.fetch(
    new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30_000),
    }),
  );
  if (!queued.ok) throw new QueueFailure(
    `Queue failed (${queued.status}).`,
    queued.status === 408 || queued.status === 429 || queued.status >= 500,
  );
  const body = (await queued.json().catch(() => ({}))) as { approvalId?: string };
  if (typeof body.approvalId !== "string" || !body.approvalId) {
    throw new QueueFailure("Orchestrator did not return an approval id.", true);
  }
  return { approvalId: body.approvalId };
}

async function resolveOnOrchestrator(
  stub: OrchestratorStub,
  input: { threadKey: string; approvalId: string; approved: boolean; decidedBy: string },
): Promise<void> {
  const resolved = await stub.fetch(
    new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30_000),
    }),
  );
  if (!resolved.ok) throw new QueueFailure(
    `Auto-approve failed (${resolved.status}).`,
    // A pending approval returns 409 when all coding slots are busy.
    resolved.status === 408 || resolved.status === 409 || resolved.status === 429 || resolved.status >= 500,
  );
}

export class Automations {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  private storeFrom(items: Automation[]): AutomationStore {
    const store = new AutomationStore();
    for (const item of items) store.upsert(item);
    return store;
  }

  private async load(): Promise<AutomationStore> {
    const state = (await this.ctx.storage.get<AutomationsState>("state")) ?? { items: [] };
    return this.storeFrom(state.items);
  }

  private async save(store: AutomationStore): Promise<void> {
    await this.ctx.storage.put("state", { items: store.list() } satisfies AutomationsState);
  }

  /**
   * Merge the in-flight fire's accounting into the latest persisted state.
   * Queue calls yield to PATCH/DELETE requests, so replacing the old snapshot
   * after an await could undo a pause or resurrect a deleted automation.
   */
  private async mergeFireState(before: Automation[], after: Automation[]): Promise<void> {
    const beforeById = new Map(before.map((item) => [item.id, item]));
    const afterById = new Map(after.map((item) => [item.id, item]));
    await this.ctx.storage.transaction(async (transaction) => {
      const state = await transaction.get<AutomationsState>("state") ?? { items: [] };
      const items = state.items.map((latest) => {
        const base = beforeById.get(latest.id);
        const fired = afterById.get(latest.id);
        return base && fired ? mergeAutomationFireState(base, fired, latest) : latest;
      });
      await transaction.put("state", { items } satisfies AutomationsState);
    });
  }

  /**
   * Refresh persisted occurrence links from the orchestrator's retained approvals and runs.
   * These source listings are bounded (25 decided approvals, 500 recent runs); older
   * entries retain their last known state instead of claiming indefinite recovery.
   */
  private async reconcileScheduleOccurrences(orchestrator: OrchestratorStub, nowMs: number): Promise<void> {
    const state = await this.ctx.storage.get<AutomationsState>("state") ?? { items: [] };
    if (!state.items.some((item) => item.occurrences?.some((occurrence) => occurrence.approvalId))) return;
    try {
      const [approvalResponse, runResponse] = await Promise.all([
        orchestrator.fetch(new Request("https://internal/api/approvals", { method: "GET", signal: AbortSignal.timeout(10_000) })),
        orchestrator.fetch(new Request("https://internal/api/runs?limit=500&view=summary", { method: "GET", signal: AbortSignal.timeout(10_000) })),
      ]);
      if (!approvalResponse.ok || !runResponse.ok) return;
      const approvals = await approvalResponse.json() as { approvals?: { approvalId?: string; status?: string }[]; decided?: { approvalId?: string; status?: string }[] };
      const runs = await runResponse.json() as { runs?: { runId?: string; status?: string }[] };
      const pendingIds = new Set((approvals.approvals ?? []).map((item) => item.approvalId).filter((id): id is string => Boolean(id)));
      const decided = new Map((approvals.decided ?? []).flatMap((item) => item.approvalId ? [[item.approvalId, item.status ?? "unknown"] as const] : []));
      const runStatuses = new Map((runs.runs ?? []).flatMap((item) => item.runId && item.status ? [[item.runId, item.status] as const] : []));
      await this.ctx.storage.transaction(async (transaction) => {
        const latest = await transaction.get<AutomationsState>("state") ?? { items: [] };
        const items = latest.items.map((automation) => {
          if (!automation.occurrences?.length) return automation;
          let changed = false;
          const occurrences = automation.occurrences.map((occurrence) => {
            if (!occurrence.approvalId) return occurrence;
            let outcome: "approval-pending" | "approved" | "rejected" | "running" | "completed" | "error" | "aborted" | "cancelled" | undefined;
            if (pendingIds.has(occurrence.approvalId)) outcome = "approval-pending";
            else {
              const runStatus = occurrence.runId ? runStatuses.get(occurrence.runId) : undefined;
              const approvalStatus = decided.get(occurrence.approvalId);
              if (runStatus && ["pending", "running", "completed", "error", "aborted", "cancelled"].includes(runStatus)) {
                outcome = runStatus === "pending" ? "approved" : runStatus as "running" | "completed" | "error" | "aborted" | "cancelled";
              } else if (approvalStatus === "rejected") outcome = "rejected";
              else if (approvalStatus === "approved") outcome = "approved";
            }
            if (!outcome || occurrence.outcome === outcome) return occurrence;
            changed = true;
            const status: ScheduleOccurrence["status"] = outcome === "approval-pending" ? "queued" : outcome;
            return { ...occurrence, status, outcome, updatedAt: nowMs };
          });
          return changed ? { ...automation, occurrences } : automation;
        });
        if (items.some((item, index) => item !== latest.items[index])) {
          await transaction.put("state", { items } satisfies AutomationsState);
        }
      });
    } catch {
      // A read-side reconciliation failure must not stall schedule dispatch;
      // the last known outcome and stable command receipt remain available.
    }
  }

  private fireDeps(orchestrator: OrchestratorStub, nowMs: number): FireAutomationDeps {
    return {
      ai: this.env.AI,
      model: this.env.ORCHESTRATOR_MODEL,
      typeSafeApiKey: this.env.TYPESAFE_API_KEY,
      nowMs,
      globalEnabled: automationsEnabled(this.env.AUTOMATIONS_ENABLED),
      canPublishPullRequest: isGitHubPublishConfigured(this.env),
      queueRun: (input) => queueOnOrchestrator(orchestrator, input),
      resolveCustomAgentPin: async (pin) => {
        if (!this.env.AGENT_AUDIT) return null;
        const current = await getCustomAgentById(this.env, pin.orgId, pin.id);
        return current ? { version: current.version, configSha256: await sha256Hex(JSON.stringify(current.config)) } : null;
      },
      resolveApproval: (input) => resolveOnOrchestrator(orchestrator, input),
    };
  }

  async fireEvent(
    event: AutomationMatchEvent,
    orchestrator: OrchestratorStub,
    nowMs = Date.now(),
    onlyId?: string,
  ): Promise<{ fired: number; skipped: number }> {
    const store = await this.load();
    const all = store.list();
    const target = onlyId ? all.filter((a) => a.id === onlyId) : all;
    const { results, automations } = await fireMatchingAutomations(
      target,
      event,
      this.fireDeps(orchestrator, nowMs),
    );
    await this.mergeFireState(target, automations);
    return {
      fired: results.filter((r) => r.fired).length,
      skipped: results.filter((r) => !r.fired).length,
    };
  }

  async tick(orchestrator: OrchestratorStub, nowMs = Date.now()): Promise<{ fired: number }> {
    await this.reconcileScheduleOccurrences(orchestrator, nowMs);
    const batchStore = await this.load();
    let fired = 0;
    fired += await this.flushWebhookBatches(orchestrator, batchStore, nowMs);
    // Each flushed batch persists its firing and daily budget through
    // fireEvent. Schedules must use that updated state: saving the snapshot
    // from before the flush would erase webhook counts and could authorize
    // another run after the automation had already spent its daily budget.
    const store = await this.load();
    const due = collectDueSchedules(store.list(), nowMs);
    if (due.length === 0) return { fired };
    const event: AutomationMatchEvent = { kind: "schedule", nowMs };
    const { results, automations } = await fireMatchingAutomations(
      store.list(),
      event,
      this.fireDeps(orchestrator, nowMs),
    );
    await this.mergeFireState(store.list(), automations);
    return { fired: fired + results.filter((r) => r.fired).length };
  }

  private async flushWebhookBatches(
    orchestrator: OrchestratorStub,
    store: AutomationStore,
    nowMs: number,
  ): Promise<number> {
    const batches = await this.ctx.storage.list<WebhookBatch>({
      prefix: WEBHOOK_BATCH_PREFIX,
    });
    let fired = 0;
    for (const [key] of batches) {
      const automationId = key.slice(WEBHOOK_BATCH_PREFIX.length);
      const intentKey = WEBHOOK_QUEUE_INTENT_PREFIX + automationId;
      const automation = store.get(automationId);
      // Claim/freeze atomically with ingress appends. Never drop a payload
      // accepted between the initial list and the external queue request.
      const batch = await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<WebhookBatch>(key);
        if (!current || !Array.isArray(current.bodies) || current.bodies.length === 0) return null;
        if (nowMs < Math.max(current.firstAt + current.windowSeconds * 1000, current.retryAt ?? 0)) return null;
        if (!automation?.webhookSecret) {
          await transaction.delete(key);
          await transaction.delete(intentKey);
          return null;
        }
        const frozen: WebhookBatch = {
          ...current,
          commandId: current.commandId ?? `webhook-batch:${automationId}:${crypto.randomUUID()}`,
          // Concurrent cron calls share this durable attempt lease. If the
          // isolate dies before acknowledgement, a later tick can recover.
          retryAt: nowMs + WEBHOOK_RETRY_MAX_MS,
        };
        await transaction.put(key, frozen);
        return frozen;
      });
      if (!batch || !automation?.webhookSecret) continue;
      let retryableFailure = false;
      const deps = this.fireDeps(orchestrator, nowMs);
      const priorIntent = await this.ctx.storage.get<WebhookQueueIntent>(intentKey);
      const frozenIntent = priorIntent?.commandId === batch.commandId ? priorIntent : undefined;
      // A saved approval has already charged this batch. Exclude only its
      // own same-day charge while rechecking current policy for resolution.
      const ownCharge = batch.approvalId && batch.chargedAt !== undefined
        && automation.runDayStartedAt === Math.floor(batch.chargedAt / 86_400_000) * 86_400_000
        && Math.floor(batch.chargedAt / 86_400_000) === Math.floor(nowMs / 86_400_000);
      const evaluation = {
        ...automation,
        // Evaluate today's permissions against the repository and PR intent
        // that was actually queued, rather than a subsequently edited task.
        ...(frozenIntent ? {
          repoUrl: frozenIntent.repoUrl,
          prompt: frozenIntent.prompt,
          // A previously attempted queue has a durable input intent. Do not
          // let later employee edits turn that same command into a different
          // (or unpinned) profile dispatch; queueRun below reuses the frozen
          // command receipt and exact input fields.
          customAgentId: frozenIntent.customAgentId,
          customAgentPin: undefined,
          skillPins: undefined,
          executionTarget: frozenIntent.executionTarget,
        } : {}),
        ...(ownCharge ? { runsToday: Math.max(0, (automation.runsToday ?? 0) - 1) } : {}),
      };
      const result = await fireMatchingAutomations(
        [evaluation],
        { kind: "webhook", secret: automation.webhookSecret, batchedBodies: batch.bodies },
        {
          ...deps,
          ...(frozenIntent ? { canPublishPullRequest: frozenIntent.publishPullRequest } : {}),
          queueRun: async (input) => {
            try {
              if (batch.approvalId) return { approvalId: batch.approvalId };
              const intent = await this.ctx.storage.transaction(async (transaction) => {
                const existing = await transaction.get<WebhookQueueIntent>(intentKey);
                if (existing && existing.commandId === batch.commandId) return existing;
                // Bodies live in one record only: duplicating the full task
                // here could exceed the per-value Durable Object size limit.
                const { task: _task, ...fields } = input;
                const frozen = { ...fields, prompt: automation.prompt, commandId: batch.commandId! };
                await transaction.put(intentKey, frozen);
                return frozen;
              });
              const { prompt, ...fields } = intent;
              const queued = await deps.queueRun({
                ...fields,
                task: `${prompt}\n\n---\nWebhook payloads (${batch.bodies.length}):\n${batch.bodies.join("\n---\n")}`,
              });
              const committedBatch = await this.ctx.storage.transaction(async (transaction) => {
                const current = await transaction.get<WebhookBatch>(key);
                if (!current || current.commandId !== batch.commandId) throw new Error("Webhook batch changed during queueing.");
                if (current.approvalId) return current;
                const state = await transaction.get<AutomationsState>("state") ?? { items: [] };
                const items = state.items.map((item) => item.id === automationId ? recordTrigger(item, nowMs) : item);
                const next = { ...current, approvalId: queued.approvalId, chargedAt: nowMs };
                await transaction.put("state", { items } satisfies AutomationsState);
                await transaction.put(key, next);
                return next;
              });
              Object.assign(batch, committedBatch);
              return queued;
            }
            catch (error) {
              retryableFailure = !(error instanceof QueueFailure) || error.retryable;
              throw error;
            }
          },
          resolveApproval: async (input) => {
            try { await deps.resolveApproval!(input); }
            catch (error) {
              retryableFailure = !(error instanceof QueueFailure) || error.retryable;
              throw error;
            }
          },
        },
      );
      const outcome = result.results[0]!;
      // If the outcome of an attempted queue is still unknown, a changed
      // policy must pause recovery rather than discard its accepted payload.
      // Never-attempted policy skips remain terminal and visible.
      if (!outcome.fired && !batch.approvalId && !retryableFailure) {
        const priorIntent = await this.ctx.storage.get<WebhookQueueIntent>(intentKey);
        if (priorIntent?.commandId === batch.commandId && !outcome.reason.startsWith("Queue failed:")) {
          retryableFailure = true;
        }
      }
      // A successful queue's charge is already durable with its saved
      // approval ID. Deleting the batch can never charge it a second time.
      const committed = await this.ctx.storage.transaction(async (transaction) => {
        const state = await transaction.get<AutomationsState>("state") ?? { items: [] };
        const currentBatch = await transaction.get<WebhookBatch>(key);
        if (currentBatch?.commandId !== batch.commandId) return false;
        const items = state.items.map((item) => item.id !== automationId || outcome.fired ? item
          : { ...item, lastSkip: { at: nowMs, reason: automation.enabled ? outcome.reason : "Automation is disabled." } });
        await transaction.put("state", { items } satisfies AutomationsState);
        if (retryableFailure) {
          const attempts = (batch.attempts ?? 0) + 1;
          await transaction.put(key, {
            ...batch, attempts,
            retryAt: nowMs + Math.min(WEBHOOK_RETRY_MAX_MS, WEBHOOK_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 4)),
          } satisfies WebhookBatch);
        } else {
          // Success, permanent invalid input, and deliberate policy skips
          // are terminal. The latter two retain their visible lastSkip.
          await transaction.delete(key);
          await transaction.delete(intentKey);
        }
        return true;
      });
      if (committed && outcome.fired) fired += 1;
    }
    return fired;
  }

  private async orchestrator(): Promise<OrchestratorStub> {
    return getAgentByName(this.env.CodingOrchestrator, ORCHESTRATOR_NAME);
  }

  private async orchestratorForAgent(agentName: string): Promise<OrchestratorStub> {
    return getAgentByName(this.env.CodingOrchestrator, agentName);
  }

  private async lookupPrOwner(repoFullName: string, pullNumber: number): Promise<PrOwnerRecord | null> {
    if (!repoFullName || !Number.isInteger(pullNumber) || pullNumber < 1) return null;
    const record = await this.ctx.storage.get<PrOwnerRecord>(prOwnerStorageKey(repoFullName, pullNumber));
    if (!record || typeof record.agentName !== "string" || record.agentName === "") return null;
    return record;
  }

  /** False when this head already claimed a review intent cluster-wide. */
  private async claimHeadReviewIntent(
    repoFullName: string,
    pullNumber: number,
    headSha: string,
  ): Promise<boolean> {
    const key = prHeadReviewDedupeKey(repoFullName, pullNumber, headSha);
    const storageKey = DEDUPE_PREFIX + key.slice(0, 200);
    if (await this.ctx.storage.get<number>(storageKey)) return false;
    await this.ctx.storage.put(storageKey, Date.now());
    return true;
  }

  private async releaseHeadReviewIntent(
    repoFullName: string,
    pullNumber: number,
    headSha: string,
  ): Promise<void> {
    const key = prHeadReviewDedupeKey(repoFullName, pullNumber, headSha);
    const storageKey = DEDUPE_PREFIX + key.slice(0, 200);
    await this.ctx.storage.delete(storageKey);
  }

  private async invokePrLifecycle(
    orchestrator: OrchestratorStub,
    githubEvent: string,
    mapped: object,
    payload: unknown,
  ): Promise<{ queuedReview: boolean }> {
    const response = await orchestrator.fetch(
      new Request("https://internal/internal/pr-lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubEvent, mapped, payload }),
      }),
    );
    const body = (await response.json().catch(() => ({}))) as { queued?: string };
    return { queuedReview: body.queued === "review" };
  }

  /**
   * Bounded cleanup for durable delivery keys. Sweep state lives outside the
   * dedupe namespace so it can never be mistaken for a delivery record.
   * The timestamp advances only after a successful list+delete pass; callers
   * catch failures so cleanup trouble never turns an accepted delivery into a
   * failed request whose retry then looks like a duplicate.
   */
  private async sweepDedupe(nowMs: number): Promise<void> {
    const lastSweep = await this.ctx.storage.get<unknown>(DEDUPE_GC_STATE_KEY);
    if (
      typeof lastSweep === "number" &&
      Number.isFinite(lastSweep) &&
      nowMs - lastSweep < DEDUPE_GC_INTERVAL_MS
    ) {
      return;
    }
    const all = await this.ctx.storage.list<unknown>({ prefix: DEDUPE_PREFIX });
    const stale = [...all.entries()]
      .filter(([, seenAt]) => typeof seenAt !== "number" || seenAt < nowMs - DEDUPE_TTL_MS)
      .map(([key]) => key)
      .sort()
      .slice(0, DEDUPE_GC_DELETE_LIMIT);
    if (stale.length > 0) {
      await this.ctx.storage.delete(stale);
    }
    await this.ctx.storage.put(DEDUPE_GC_STATE_KEY, nowMs);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/tick") {
      const result = await this.tick(await this.orchestrator());
      return Response.json(result);
    }
    if (request.method === "POST" && url.pathname === "/internal/github") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
      }
      const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const githubEvent = typeof record.event === "string" ? record.event : "unknown";
      const mapped = githubWebhookToEvent(githubEvent, record.payload);
      const orchestratorDefault = await this.orchestrator();
      const result = await this.fireEvent(
        {
          kind: "github",
          ...mapped,
          ...(typeof record.deliveryId === "string" && record.deliveryId !== ""
            ? { deliveryId: record.deliveryId }
            : {}),
        },
        orchestratorDefault,
      );
      const repoFullName = typeof mapped.repo === "string" ? mapped.repo : "";
      const pullNumber = typeof mapped.pullNumber === "number" ? mapped.pullNumber : 0;
      const headSha = typeof mapped.headSha === "string" ? mapped.headSha : "";
      const owner =
        repoFullName && pullNumber > 0 ? await this.lookupPrOwner(repoFullName, pullNumber) : null;
      const targetOrchestrator = owner
        ? await this.orchestratorForAgent(owner.agentName)
        : orchestratorDefault;

      const isPullReview =
        automationsEnabled(this.env.AUTOMATIONS_ENABLED) &&
        mapped.event === "pull_request" &&
        (mapped.action === "opened" || mapped.action === "synchronize") &&
        repoFullName !== "" &&
        headSha !== "" &&
        pullNumber > 0;

      let reviewQueued = false;
      let headClaimed = true;
      if (isPullReview) {
        headClaimed = await this.claimHeadReviewIntent(repoFullName, pullNumber, headSha);
      }

      let lifecycleCompleted = false;
      if (headClaimed) {
        try {
          const lifecycle = await this.invokePrLifecycle(
            targetOrchestrator,
            githubEvent,
            { ...mapped },
            record.payload,
          );
          lifecycleCompleted = true;
          if (lifecycle.queuedReview) reviewQueued = true;
        } catch (error) {
          console.error(
            `pr lifecycle wake failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Built-in lane: only for PRs with no dashboard owner index (automation-only reviews).
      if (isPullReview && headClaimed && owner === null) {
        try {
          const diffRef = mapped.diffRef ?? `https://github.com/${repoFullName}/pull/${pullNumber}.diff`;
          const task = reviewerTask({
            repoUrl: `https://github.com/${repoFullName}`,
            pullNumber,
            headSha,
            diffUrl: diffRef,
            ...(typeof mapped.branch === "string" ? { headBranch: mapped.branch } : {}),
          });
          await queueOnOrchestrator(orchestratorDefault, {
            repoUrl: `https://github.com/${repoFullName}`,
            task,
            publishPullRequest: false,
            role: "reviewer",
            codingModel: this.env.REVIEW_RUN_MODEL?.trim() || "opencode-go/gpt-6.1-sol",
            threadKey: `review:${repoFullName}#${pullNumber}`,
            commandId:
              typeof record.deliveryId === "string" && record.deliveryId !== ""
                ? `review:${record.deliveryId}`
                : `review:${repoFullName}:${headSha}`,
          });
          reviewQueued = true;
        } catch (error) {
          console.error(
            `pr review lane queue failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (isPullReview && headClaimed && !reviewQueued) {
        const shouldRelease = owner === null || !lifecycleCompleted;
        if (shouldRelease) {
          await this.releaseHeadReviewIntent(repoFullName, pullNumber, headSha);
        }
      }

      return Response.json({ ...result, reviewQueued });
    }
    if (request.method === "POST" && url.pathname === "/internal/sentry") {
      // Sentry issue-alert lane: the verified webhook hands the run fields
      // over; this lane puts it on the SAME approval-gated queue path every
      // automation uses. No auto-approve — the card waits for an operator.
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
      }
      const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const repoUrl = typeof record.repoUrl === "string" ? record.repoUrl : "";
      const task = typeof record.task === "string" ? record.task : "";
      const eventId = typeof record.eventId === "string" ? record.eventId : "";
      if (repoUrl === "" || task === "" || eventId === "") {
        return Response.json({ error: "repoUrl, task, and eventId are required." }, { status: 400 });
      }
      const queued = await queueOnOrchestrator(await this.orchestrator(), {
        repoUrl,
        task,
        publishPullRequest: Boolean(this.env.GITHUB_TOKEN),
        threadKey: `sentry:${eventId}`,
        commandId: `sentry:${eventId}`,
      });
      return Response.json({ ok: true, approvalId: queued.approvalId });
    }
    if (url.pathname === "/internal/pr-owner") {
      if (request.method === "PUT") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
        }
        const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
        const repoFullName = typeof record.repoFullName === "string" ? record.repoFullName.trim() : "";
        const pullNumber = typeof record.pullNumber === "number" ? record.pullNumber : 0;
        const agentName = typeof record.agentName === "string" ? record.agentName.trim() : "";
        const codingRunId = typeof record.codingRunId === "string" ? record.codingRunId.trim() : "";
        const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : Date.now();
        if (!repoFullName || !Number.isInteger(pullNumber) || pullNumber < 1 || !agentName || !codingRunId) {
          return Response.json({ error: "repoFullName, pullNumber, agentName, codingRunId required." }, { status: 400 });
        }
        const owner: PrOwnerRecord = { agentName, codingRunId, updatedAt };
        await this.ctx.storage.put(prOwnerStorageKey(repoFullName, pullNumber), owner);
        return Response.json({ ok: true, owner });
      }
      if (request.method === "GET") {
        const repoFullName = url.searchParams.get("repo")?.trim() ?? "";
        const pullNumber = Number(url.searchParams.get("pull"));
        if (!repoFullName || !Number.isInteger(pullNumber) || pullNumber < 1) {
          return Response.json({ error: "repo and pull query params required." }, { status: 400 });
        }
        const owner = await this.lookupPrOwner(repoFullName, pullNumber);
        if (!owner) return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({ ok: true, owner });
      }
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    if (request.method === "POST" && url.pathname === "/internal/dedupe") {
      // Cross-isolate idempotency for retried Slack event deliveries:
      // {key} → {seen}. Keys expire after one hour — Slack retries stop
      // long before that, so the set stays tiny.
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
      }
      const key = (body as { key?: unknown })?.key;
      if (typeof key !== "string" || !key) {
        return Response.json({ error: "Missing dedupe key." }, { status: 400 });
      }
      const storageKey = DEDUPE_PREFIX + key.slice(0, 200);
      if (await this.ctx.storage.get<number>(storageKey)) {
        return Response.json({ seen: true });
      }
      const now = Date.now();
      await this.ctx.storage.put(storageKey, now);
      try {
        await this.sweepDedupe(now);
      } catch (error) {
        console.warn(
          "automation dedupe sweep failed: " +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      return Response.json({ seen: false });
    }
    if (request.method === "POST" && url.pathname === "/internal/linear") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
      }
      const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const action = typeof record.event === "object" && record.event !== null
        ? String((record.event as { action?: unknown }).action ?? "created")
        : "created";
      const teamKey =
        typeof record.teamKey === "string"
          ? record.teamKey
          : typeof record.event === "object" &&
              record.event !== null &&
              typeof (record.event as { agentSession?: { issue?: { team?: { key?: string } } } }).agentSession?.issue
                ?.team?.key === "string"
            ? (record.event as { agentSession: { issue: { team: { key: string } } } }).agentSession.issue.team.key
            : undefined;
      const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
      const mapped = linearEventToAutomation({ action, ...(teamKey ? { teamKey } : {}), ...(sessionId ? { sessionId } : {}) });
      const result = await this.fireEvent({ kind: "linear", ...mapped }, await this.orchestrator());
      const task = typeof record.task === "string" ? record.task : "";
      const repoUrl =
        (typeof record.repoUrl === "string" ? record.repoUrl : "") ||
        this.env.LINEAR_DEFAULT_REPO_URL?.trim() ||
        "";
      let linearQueued = false;
      if (task && repoUrl && sessionId) {
        try {
          await queueOnOrchestrator(await this.orchestrator(), {
            repoUrl,
            task,
            publishPullRequest: isGitHubPublishConfigured(this.env),
            threadKey: `linear:session:${sessionId}`,
            commandId: `linear:${sessionId}:${action}`,
          });
          linearQueued = true;
        } catch (error) {
          console.error(
            `linear session lane queue failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return Response.json({ ...result, linearQueued });
    }
    if (request.method === "POST" && url.pathname === "/internal/slack") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
      }
      const mapped = slackEventToAutomation(body);
      const result = await this.fireEvent({ kind: "slack", ...mapped }, await this.orchestrator());
      return Response.json(result);
    }
    if (request.method === "GET" && url.pathname === "/api/automations") {
      const store = await this.load();
      return Response.json({ automations: store.list().map(publicAutomation) });
    }
    if (request.method === "POST" && url.pathname === "/api/automations") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
      }
      try {
        const input = body as CreateAutomationInput;
        if (input.customAgentId?.trim()) {
          if (!this.env.AGENT_AUDIT) return Response.json({ error: "Bot storage is not configured." }, { status: 503 });
          const agent = await getCustomAgentById(this.env, DASHBOARD_ORG_ID, input.customAgentId.trim());
          if (!agent) return Response.json({ error: "Bot not found or unavailable." }, { status: 404 });
          if (agent.config.toolScopes?.length) return Response.json({ error: "Bot toolScopes are not supported." }, { status: 400 });
          input.customAgentId = agent.id;
          input.customAgentPin = {
            id: agent.id,
            orgId: agent.orgId,
            version: agent.version,
            configSha256: await sha256Hex(JSON.stringify(agent.config)),
          };
        }
        for (const pin of input.skillPins ?? []) {
          if (await reviewedSkillPinSha256(pin) !== pin.sha256) {
            return Response.json({ error: `Reviewed skill pin ${pin.id} does not match its content hash.` }, { status: 400 });
          }
        }
        const created = createAutomation(input);
        const inserted = await this.ctx.storage.transaction(async (transaction) => {
          const state = await transaction.get<AutomationsState>("state") ?? { items: [] };
          if (state.items.some((item) => item.id === created.automation.id)) return false;
          await transaction.put("state", { items: [...state.items, created.automation] } satisfies AutomationsState);
          return true;
        });
        if (!inserted) {
          return Response.json({ error: "Automation id already exists." }, { status: 409 });
        }
        return Response.json(
          { automation: publicAutomation(created.automation), webhookSecret: created.webhookSecret },
          { status: 201 },
        );
      } catch (error) {
        const message = error instanceof InputError ? error.message : "Invalid automation.";
        return Response.json({ error: message }, { status: 400 });
      }
    }
    // Update (enabled/prompt only) and delete, used by the /api/v1 automations facade.
    const itemId = /^\/api\/automations\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    if (itemId && (request.method === "PATCH" || request.method === "DELETE")) {
      let id: string;
      try {
        id = decodeURIComponent(itemId);
      } catch {
        return Response.json({ error: "Automation not found." }, { status: 404 });
      }
      const store = await this.load();
      const automation = store.get(id);
      if (!automation) {
        return Response.json({ error: "Automation not found." }, { status: 404 });
      }
      if (request.method === "DELETE") {
        store.remove(id);
        await this.save(store);
        return Response.json({ ok: true, id });
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
      }
      const patch = (typeof body === "object" && body !== null ? body : {}) as {
        enabled?: unknown;
        prompt?: unknown;
        customAgentId?: unknown;
        reviewCustomAgent?: unknown;
        skillPins?: unknown;
        reviewSkillPins?: unknown;
        executionTarget?: unknown;
        triggers?: unknown;
      };
      if (patch.executionTarget !== undefined || patch.triggers !== undefined) {
        return Response.json({ error: "Execution target, deliverables, and triggers are immutable after creation." }, { status: 400 });
      }
      if (
        (patch.enabled !== undefined && typeof patch.enabled !== "boolean") ||
        (patch.prompt !== undefined && (typeof patch.prompt !== "string" || !patch.prompt.trim())) ||
        (patch.customAgentId !== undefined &&
          patch.customAgentId !== null &&
          typeof patch.customAgentId !== "string") ||
        (patch.reviewCustomAgent !== undefined && typeof patch.reviewCustomAgent !== "boolean") ||
        (patch.reviewSkillPins !== undefined && typeof patch.reviewSkillPins !== "boolean")
      ) {
        return Response.json(
          { error: "Invalid automation update fields." },
          { status: 400 },
        );
      }
      const customAgentId =
        patch.customAgentId === null
          ? undefined
          : typeof patch.customAgentId === "string" && patch.customAgentId.trim()
            ? patch.customAgentId.trim()
            : automation.customAgentId;
      if (patch.customAgentId !== undefined && patch.customAgentId !== null && customAgentId !== automation.customAgentId && patch.reviewCustomAgent !== true) {
        return Response.json({ error: "Changing an employee profile requires reviewCustomAgent: true." }, { status: 400 });
      }
      let customAgentPin = patch.customAgentId === null ? undefined : automation.customAgentPin;
      if (customAgentId && patch.reviewCustomAgent === true) {
        if (!this.env.AGENT_AUDIT) return Response.json({ error: "Bot storage is not configured." }, { status: 503 });
        const agent = await getCustomAgentById(this.env, DASHBOARD_ORG_ID, customAgentId);
        if (!agent) return Response.json({ error: "Bot not found or unavailable." }, { status: 404 });
        if (agent.config.toolScopes?.length) return Response.json({ error: "Bot toolScopes are not supported." }, { status: 400 });
        customAgentPin = { id: agent.id, orgId: agent.orgId, version: agent.version, configSha256: await sha256Hex(JSON.stringify(agent.config)) };
      }
      let skillPins = automation.skillPins;
      if (patch.skillPins !== undefined) {
        if (patch.reviewSkillPins !== true || !Array.isArray(patch.skillPins) || patch.skillPins.length > 16) {
          return Response.json({ error: "Changing skill pins requires reviewSkillPins: true and a skill pin list." }, { status: 400 });
        }
        try {
          for (const pin of patch.skillPins) {
            const item = pin as { id?: unknown; version?: unknown; source?: unknown; instructions?: unknown; sha256?: unknown; enabled?: unknown };
            if (typeof item.id !== "string" || typeof item.version !== "string" || typeof item.source !== "string" || typeof item.instructions !== "string" || typeof item.sha256 !== "string" || await reviewedSkillPinSha256(item as Pick<import("./automations.js").ReviewedSkillPin, "id" | "version" | "source" | "instructions">) !== item.sha256) {
              return Response.json({ error: "Reviewed skill pin content does not match its hash." }, { status: 400 });
            }
          }
          const validated = createAutomation({
            id: automation.id,
            prompt: automation.prompt,
            repoUrl: automation.repoUrl,
            ...(automation.executionTarget ? { executionTarget: automation.executionTarget } : {}),
            triggers: automation.triggers,
            customAgentId,
            ...(customAgentPin ? { customAgentPin } : {}),
            skillPins: patch.skillPins as CreateAutomationInput["skillPins"],
          });
          skillPins = validated.automation.skillPins;
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Invalid reviewed skill pins." }, { status: 400 });
        }
      }
      const updated: Automation = {
        ...automation,
        ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
        ...(typeof patch.prompt === "string" ? { prompt: patch.prompt.trim() } : {}),
        ...(patch.customAgentId !== undefined ? { customAgentId } : {}),
        ...(patch.customAgentId !== undefined || patch.reviewCustomAgent === true ? { customAgentPin } : {}),
        ...(patch.skillPins !== undefined ? { skillPins } : {}),
      };
      store.upsert(updated);
      await this.save(store);
      return Response.json({ automation: publicAutomation(updated) });
    }
    const manualId = /^\/api\/automations\/([^/]+)\/run\/?$/.exec(url.pathname)?.[1];
    if (manualId && request.method === "POST") {
      const store = await this.load();
      const automation = store.get(decodeURIComponent(manualId));
      if (!automation) {
        return Response.json({ error: "Automation not found." }, { status: 404 });
      }
      if (!automation.triggers.some((t) => t.kind === "manual")) {
        return Response.json({ error: "Automation has no manual trigger." }, { status: 400 });
      }
      const result = await this.fireEvent({ kind: "manual" }, await this.orchestrator(), Date.now(), automation.id);
      return Response.json({ ok: true, id: automation.id, ...result });
    }
    const webhookId = parseAutomationWebhookPath(url.pathname);
    if (webhookId && request.method === "POST") {
      const store = await this.load();
      let decodedId = webhookId;
      try {
        decodedId = decodeURIComponent(webhookId);
      } catch {
        // Malformed % escapes keep the raw id — lookup below 404s anyway.
      }
      const automation = store.get(decodedId);
      if (!automation) {
        return Response.json({ error: "Automation not found." }, { status: 404 });
      }
      // Header only: a ?secret= query param lands in proxy and access logs,
      // which is exactly where a credential must not appear.
      const secret = request.headers.get("x-automation-secret") ?? "";
      if (!verifyWebhookSecret(automation, secret)) {
        return Response.json({ error: "Invalid automation secret." }, { status: 401 });
      }
      const webhookTrigger = automation.triggers.find((t) => t.kind === "webhook");
      const batchWindow =
        webhookTrigger?.kind === "webhook" ? webhookTrigger.batchWindowSeconds ?? 0 : 0;
      const rawPayload = await webhookBody(request);
      if (rawPayload === null) {
        return Response.json({ error: "Webhook payload exceeds 32000 bytes." }, { status: 413 });
      }
      const now = Date.now();
      if (batchWindow > 0) {
        const storageKey = WEBHOOK_BATCH_PREFIX + automation.id;
        return this.ctx.storage.transaction(async (transaction) => {
          const existing = await transaction.get<WebhookBatch>(storageKey);
          if (existing?.commandId) {
            return Response.json({ error: "Webhook batch is processing. Retry this delivery later." }, {
              status: 503, headers: { "Retry-After": "30" },
            });
          }
          const bodies = [...(existing?.bodies ?? []), rawPayload];
          if (bodies.length > WEBHOOK_MAX_BATCH_BODIES || new TextEncoder().encode(JSON.stringify(bodies)).byteLength > WEBHOOK_MAX_BATCH_BYTES) {
            return Response.json({ error: "Webhook batch is full. Retry this delivery later." }, {
              status: 429, headers: { "Retry-After": String(Math.min(300, Math.max(1, batchWindow))) },
            });
          }
          await transaction.put(storageKey, {
            bodies, firstAt: existing?.firstAt ?? now,
            windowSeconds: Math.min(300, Math.max(1, batchWindow)),
          } satisfies WebhookBatch);
          return Response.json({ ok: true, id: automation.id, batched: true, pending: bodies.length });
        });
      }
      const result = await this.fireEvent(
        { kind: "webhook", secret, batchedBodies: rawPayload ? [rawPayload] : [] },
        await this.orchestrator(),
        now,
        automation.id,
      );
      return Response.json({ ok: true, id: automation.id, ...result });
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  }
}

function mergeAutomationFireState(base: Automation, fired: Automation, latest: Automation): Automation {
  const updated: Automation = { ...latest };
  const runCountDelta = Math.max(0, fired.runCount - base.runCount);
  if (runCountDelta > 0) updated.runCount = latest.runCount + runCountDelta;

  const firedDay = fired.runDayStartedAt;
  const baseDay = base.runDayStartedAt;
  const firedTodayDelta = firedDay === baseDay
    ? Math.max(0, (fired.runsToday ?? 0) - (base.runsToday ?? 0))
    : fired.runsToday ?? 0;
  if (firedTodayDelta > 0 && firedDay !== undefined) {
    if (latest.runDayStartedAt === firedDay) {
      updated.runsToday = (latest.runsToday ?? 0) + firedTodayDelta;
    } else if (latest.runDayStartedAt === undefined || latest.runDayStartedAt < firedDay) {
      updated.runDayStartedAt = firedDay;
      updated.runsToday = fired.runsToday ?? firedTodayDelta;
    }
  }

  if (fired.lastTriggeredAt !== base.lastTriggeredAt && fired.lastTriggeredAt !== undefined) {
    updated.lastTriggeredAt = Math.max(latest.lastTriggeredAt ?? Number.NEGATIVE_INFINITY, fired.lastTriggeredAt);
  }
  const scheduleFiredAt = { ...(latest.scheduleFiredAt ?? {}) };
  for (const [key, value] of Object.entries(fired.scheduleFiredAt ?? {})) {
    if (value !== base.scheduleFiredAt?.[key]) {
      scheduleFiredAt[key] = Math.max(scheduleFiredAt[key] ?? Number.NEGATIVE_INFINITY, value);
    }
  }
  if (Object.keys(scheduleFiredAt).length > 0) updated.scheduleFiredAt = scheduleFiredAt;

  const firedSkip = fired.lastSkip;
  const baseSkip = base.lastSkip;
  if (firedSkip && (firedSkip.at !== baseSkip?.at || firedSkip.reason !== baseSkip.reason)
      && (!latest.lastSkip || latest.lastSkip.at <= firedSkip.at)) {
    updated.lastSkip = firedSkip;
  }
  const occurrenceMap = new Map((latest.occurrences ?? []).map((item) => [item.id, item]));
  for (const occurrence of fired.occurrences ?? []) {
    const previous = base.occurrences?.find((item) => item.id === occurrence.id);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(occurrence)) {
      const current = occurrenceMap.get(occurrence.id);
      if (!current || current.updatedAt <= occurrence.updatedAt) occurrenceMap.set(occurrence.id, occurrence);
    }
  }
  const occurrences = [...occurrenceMap.values()].sort((a, b) => a.scheduledAt - b.scheduledAt).slice(-AUTOMATION_OCCURRENCE_HISTORY_LIMIT);
  if (occurrences.length > 0) updated.occurrences = occurrences;
  return updated;
}

function publicAutomation(automation: Automation): Omit<Automation, "webhookSecret"> & { hasWebhookSecret: boolean } {
  const { webhookSecret, ...rest } = automation;
  return { ...rest, hasWebhookSecret: Boolean(webhookSecret) };
}
