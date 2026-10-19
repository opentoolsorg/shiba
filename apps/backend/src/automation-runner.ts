/**
 * Production fire path for automations (PLAN T18–T20).
 *
 * Match → optional TypeSafe/Workers AI `run_when` → T20 safety → queue a
 * pending approval (or auto-approve when unattended is granted). Skips are
 * recorded; nothing fires silently.
 */
import {
  authorizeAutomationRun,
  automationsEnabled,
  evaluateRunWhen,
  matchAutomationEvent,
  recordSkip,
  recordTrigger,
  type Automation,
  type AutomationMatchEvent,
  type GitHubAutomationEvent,
  type MatchedTrigger,
  type RunWhenAi,
  type SlackAutomationEvent,
  type TypeSafeNoulFetch,
} from "./automations.js";
import { automationCommandId } from "./pending-approvals.js";
import { clampBurstWindowSeconds, DEFAULT_BURST_WINDOW_SECONDS } from "./slack-context.js";

export const AUTOMATIONS_DO_NAME = "default";

export interface QueueAutomationRunInput {
  repoUrl: string;
  task: string;
  publishPullRequest: boolean;
  threadKey: string;
  /** T41: deterministic per-(automation, event) id — a retried queue dedupes on it. */
  commandId?: string;
  customAgentId?: string;
}

export interface FireAutomationDeps {
  ai: RunWhenAi;
  model: string;
  typeSafeApiKey?: string;
  fetchImpl?: TypeSafeNoulFetch;
  nowMs?: number;
  globalEnabled: boolean;
  /** False when GITHUB_TOKEN is unset: runs still queue, without a pull request. */
  canPublishPullRequest?: boolean;
  queueRun: (input: QueueAutomationRunInput) => Promise<{ approvalId: string }>;
  resolveApproval?: (input: {
    threadKey: string;
    approvalId: string;
    approved: boolean;
    decidedBy: string;
  }) => Promise<void>;
}

export interface FireAutomationResult {
  fired: boolean;
  automation: Automation;
  reason: string;
  approvalId?: string;
}

export function summarizeAutomationEvent(event: AutomationMatchEvent): string {
  if (event.kind === "github") {
    return [
      `github ${event.event}${event.action ? `:${event.action}` : ""}`,
      event.repo,
      event.branch,
      event.author,
      (event.labels ?? []).join(","),
    ]
      .filter((part) => part && String(part).length > 0)
      .join(" ");
  }
  if (event.kind === "slack") {
    return `slack ${event.channel ?? ""} ${event.author ?? ""} ${event.text ?? ""}`.trim();
  }
  if (event.kind === "webhook") {
    const n = event.batchedBodies?.length;
    return n && n > 1 ? `incoming webhook (${n} batched)` : "incoming webhook";
  }
  if (event.kind === "linear") {
    return `linear ${event.action} ${event.teamKey ?? ""} ${event.sessionId ?? ""}`.trim();
  }
  if (event.kind === "schedule") {
    return `schedule tick ${event.nowMs}`;
  }
  return "manual";
}

export function githubWebhookToEvent(
  githubEvent: string,
  body: unknown,
): GitHubAutomationEvent {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const repoObj = typeof record.repository === "object" && record.repository !== null
    ? (record.repository as Record<string, unknown>)
    : {};
  const pr = typeof record.pull_request === "object" && record.pull_request !== null
    ? (record.pull_request as Record<string, unknown>)
    : null;
  const issue = typeof record.issue === "object" && record.issue !== null
    ? (record.issue as Record<string, unknown>)
    : null;
  const sender = typeof record.sender === "object" && record.sender !== null
    ? (record.sender as Record<string, unknown>)
    : {};
  const user = (pr ?? issue)?.user;
  const userLogin =
    typeof user === "object" && user !== null && typeof (user as { login?: unknown }).login === "string"
      ? (user as { login: string }).login
      : typeof sender.login === "string"
        ? sender.login
        : undefined;
  const labelsRaw = (pr ?? issue)?.labels;
  const labels = Array.isArray(labelsRaw)
    ? labelsRaw.flatMap((entry) => {
        if (typeof entry === "string") return [entry];
        if (typeof entry === "object" && entry !== null && typeof (entry as { name?: unknown }).name === "string") {
          return [(entry as { name: string }).name];
        }
        return [];
      })
    : undefined;
  const ref = typeof record.ref === "string" ? record.ref : undefined;
  const prHead = pr && typeof pr.head === "object" && pr.head !== null
    ? (pr.head as { ref?: unknown }).ref
    : undefined;
  const branch =
    typeof prHead === "string"
      ? prHead
      : ref?.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : undefined;
  const headSha = pr && typeof pr.head === "object" && pr.head !== null
    ? ((pr.head as { sha?: unknown }).sha as string | undefined)
    : undefined;
  const diffRef = pr && typeof pr.diff_url === "string"
    ? pr.diff_url
    : pr && typeof pr.html_url === "string" && typeof pr.number === "number"
      ? `${pr.html_url}.diff`
      : undefined;
  return {
    event: githubEvent,
    action: typeof record.action === "string" ? record.action : undefined,
    repo: typeof repoObj.full_name === "string" ? repoObj.full_name : undefined,
    branch,
    author: userLogin,
    labels,
    ...(typeof headSha === "string" && headSha !== "" ? { headSha } : {}),
    ...(typeof diffRef === "string" && diffRef !== "" ? { diffRef } : {}),
    ...(pr && typeof pr.number === "number" ? { pullNumber: pr.number } : {}),
  };
}

export function linearEventToAutomation(input: {
  action: string;
  teamKey?: string;
  sessionId?: string;
}): import("./automations.js").LinearAutomationEvent {
  return {
    action: input.action,
    ...(input.teamKey ? { teamKey: input.teamKey } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

export function slackEventToAutomation(body: unknown): SlackAutomationEvent {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const event = typeof record.event === "object" && record.event !== null
    ? (record.event as Record<string, unknown>)
    : record;
  return {
    channel: typeof event.channel === "string" ? event.channel : undefined,
    author: typeof event.user === "string" ? event.user : undefined,
    text: typeof event.text === "string" ? event.text : undefined,
    // The envelope's `event_id`, not the inner event's — a Slack retry
    // carries the same envelope id so the queue command dedupes on it.
    eventId: typeof record.event_id === "string" ? record.event_id : undefined,
  };
}

export function automationThreadKey(automationId: string): string {
  return `automation:${automationId}`;
}

/**
 * Bound on concurrent run_when predicate calls during fan-out. Predicates
 * are pure reads (match, burst check, model/TypeSafe verdict); only the
 * ordered authorization/queue commits below may mutate, so they stay
 * sequential.
 */
export const RUN_WHEN_PREDICATE_CONCURRENCY = 4;

type FirePredicate =
  | { status: "skip"; result: FireAutomationResult }
  | { status: "proceed"; matched: MatchedTrigger };

/**
 * The burst-window suppression (PLAN T13): a matched Slack event inside the
 * trigger's burst window of the previous firing is suppressed. Pure read,
 * safe to run before any model call and again before side effects.
 */
function burstWindowReason(
  automation: Automation,
  trigger: MatchedTrigger["trigger"],
  nowMs: number,
): string | null {
  if (trigger.kind !== "slack" || automation.lastTriggeredAt === undefined) {
    return null;
  }
  const windowMs =
    clampBurstWindowSeconds(trigger.burstWindowSeconds ?? DEFAULT_BURST_WINDOW_SECONDS) * 1000;
  if (nowMs - automation.lastTriggeredAt < windowMs) {
    return "Burst window: a matching run already fired.";
  }
  return null;
}

/**
 * Phase 1, the pure predicate: match, cheap burst suppression, and the
 * run_when verdict. No queueing, no approvals, no state writes; the only
 * awaited work is the model/TypeSafe call, so it is safe to run with bounded
 * concurrency across automations.
 */
async function evaluateFirePredicate(
  automation: Automation,
  event: AutomationMatchEvent,
  deps: FireAutomationDeps,
  nowMs: number,
): Promise<FirePredicate> {
  const matched = matchAutomationEvent(automation, event);
  if (!matched) {
    return { status: "skip", result: { fired: false, automation, reason: "No matching trigger." } };
  }

  const burst = burstWindowReason(automation, matched.trigger, nowMs);
  if (burst !== null) {
    const skipped = recordSkip(automation, burst, nowMs);
    return {
      status: "skip",
      result: { fired: false, automation: skipped, reason: skipped.lastSkip?.reason ?? "burst" },
    };
  }

  const runWhen = matched.trigger.runWhen?.trim() ?? "";
  if (runWhen) {
    const verdict = await evaluateRunWhen(
      deps.ai,
      deps.model,
      runWhen,
      summarizeAutomationEvent(event),
      deps.typeSafeApiKey,
      deps.fetchImpl,
    );
    if (!verdict.run) {
      const skipped = recordSkip(automation, verdict.reason, nowMs);
      return { status: "skip", result: { fired: false, automation: skipped, reason: verdict.reason } };
    }
  }

  return { status: "proceed", matched };
}

/**
 * Phase 2, the ordered commit. Rechecks the match/burst ordering gates
 * against the freshest automation state, then the T20 authorization, before
 * any side effect (queue plus optional unattended resolve). Called
 * sequentially so mutating calls never overlap.
 */
async function commitAutomationFire(
  automation: Automation,
  event: AutomationMatchEvent,
  deps: FireAutomationDeps,
  nowMs: number,
): Promise<FireAutomationResult> {
  // Recheck the ordering gates: the predicate verdict ran concurrently and
  // the automation state may have moved before this commit slot.
  const recheck = matchAutomationEvent(automation, event);
  if (!recheck) {
    return { fired: false, automation, reason: "No matching trigger." };
  }
  const burst = burstWindowReason(automation, recheck.trigger, nowMs);
  if (burst !== null) {
    const skipped = recordSkip(automation, burst, nowMs);
    return { fired: false, automation: skipped, reason: skipped.lastSkip?.reason ?? "burst" };
  }

  // No GITHUB_TOKEN: degrade to a no-PR run (the orchestrator 400s a PR
  // request). Unattended needs PR-only, so this also forces approval.
  const publishPullRequest = deps.canPublishPullRequest !== false;
  const request = { publishPullRequest };
  const auth = authorizeAutomationRun(automation, request, nowMs, deps.globalEnabled);
  if (!auth.allowed) {
    const skipped = recordSkip(automation, auth.reason, nowMs);
    return { fired: false, automation: skipped, reason: auth.reason };
  }
  const reason = publishPullRequest
    ? auth.reason
    : `${auth.reason} GITHUB_TOKEN is not configured, so the run will not open a pull request.`;

  const threadKey = automationThreadKey(automation.id);
  try {
    const commandId = automationCommandId(automation.id, event);
    let task = automation.prompt;
    if (event.kind === "webhook" && event.batchedBodies && event.batchedBodies.length > 0) {
      task += `\n\n---\nWebhook payloads (${event.batchedBodies.length}):\n${event.batchedBodies.join("\n---\n")}`;
    }
    const queued = await deps.queueRun({
      repoUrl: automation.repoUrl,
      task,
      publishPullRequest,
      threadKey,
      ...(commandId !== undefined ? { commandId } : {}),
      ...(automation.customAgentId ? { customAgentId: automation.customAgentId } : {}),
    });
    const scheduleKey = recheck.trigger.kind === "schedule" ? `t${recheck.triggerIndex}` : undefined;
    const next = recordTrigger(automation, nowMs, scheduleKey);
    if (!auth.requiresApproval) {
      if (!deps.resolveApproval) {
        const skipped = recordSkip(
          automation,
          "Unattended run granted but no resolveApproval seam.",
          nowMs,
        );
        return { fired: false, automation: skipped, reason: skipped.lastSkip?.reason ?? "unattended missing seam" };
      }
      await deps.resolveApproval({
        threadKey,
        approvalId: queued.approvalId,
        approved: true,
        decidedBy: "automation:" + automation.id,
      });
    }
    return {
      fired: true,
      automation: next,
      reason,
      approvalId: queued.approvalId,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const skipped = recordSkip(automation, "Queue failed: " + detail, nowMs);
    return { fired: false, automation: skipped, reason: skipped.lastSkip?.reason ?? detail };
  }
}

/**
 * One automation, one event. Match, gate, authorize, then queue (and
 * auto-approve only when T20 unattended is granted).
 */
export async function fireAutomation(
  automation: Automation,
  event: AutomationMatchEvent,
  deps: FireAutomationDeps,
): Promise<FireAutomationResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const predicate = await evaluateFirePredicate(automation, event, deps, nowMs);
  if (predicate.status === "skip") {
    return predicate.result;
  }
  return commitAutomationFire(automation, event, deps, nowMs);
}

/** Bounded mapper used for predicate evaluation only, never for mutating calls. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index] as T, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function fireMatchingAutomations(
  automations: Automation[],
  event: AutomationMatchEvent,
  deps: FireAutomationDeps,
): Promise<{ results: FireAutomationResult[]; automations: Automation[] }> {
  const nowMs = deps.nowMs ?? Date.now();
  // Phase 1: run the pure predicates (including run_when model calls) with
  // bounded concurrency. Predicate failures fail closed per item so one bad
  // verdict can neither reorder commits nor escape as an unhandled rejection.
  const predicates = await mapBounded(
    automations,
    RUN_WHEN_PREDICATE_CONCURRENCY,
    async (automation) => {
      try {
        return await evaluateFirePredicate(automation, event, deps, nowMs);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const skipped = recordSkip(automation, "run_when gate failed closed: " + detail, nowMs);
        return {
          status: "skip" as const,
          result: {
            fired: false,
            automation: skipped,
            reason: skipped.lastSkip?.reason ?? detail,
          },
        };
      }
    },
  );
  // Phase 2: commit in input order, ordering recheck then authorization,
  // queue, optional unattended resolve, so mutating calls stay sequential.
  const next = new Map(automations.map((item) => [item.id, item]));
  const results: FireAutomationResult[] = [];
  for (let index = 0; index < automations.length; index++) {
    const predicate = predicates[index];
    const current = next.get((automations[index] as Automation).id) ?? (automations[index] as Automation);
    let result: FireAutomationResult;
    if (predicate === undefined) {
      result = { fired: false, automation: current, reason: "No matching trigger." };
    } else if (predicate.status === "skip") {
      result = predicate.result;
    } else {
      result = await commitAutomationFire(current, event, deps, nowMs);
    }
    results.push(result);
    next.set(result.automation.id, result.automation);
  }
  return { results, automations: [...next.values()] };
}
