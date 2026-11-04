/**
 * Mention dispatch (PLAN T13/T14/T16). Events already acked; this runs in waitUntil.
 * No bot token → no in-thread card and no run. No repo → ask, no run.
 */
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";
import { postSlackMessage, SLACK_POST_TIMEOUT_MS } from "./slack.js";
import { buildSlackCanvasUrl, signSlackCanvasIntake, slackCanvasOwner } from "./slack-canvas.js";
import { postSystemOne, readChoiceAnswer, type TypeSafeFetch } from "./typesafe.js";
import { buildApprovalBlocks, slackCanvasUrl } from "./slack-approval.js";
import {
  applyThreadControls,
  gatherSlackContext,
  MAX_CONTEXT_MESSAGES,
  parseChannelRepoMap,
  resolveSlackRepo,
  type SlackThreadMessage,
} from "./slack-context.js";
import type { SlackEventCallbackBody } from "./slack-events.js";
import {
  slackAck,
  slackAskForRepo,
  slackAskForTask,
  slackQueueFailed,
} from "./slack-persona.js";
import {
  buildSlackRunPayload,
  buildSlackThreadName,
  getSlackThreadStub,
  resolveSlackHarness,
  resolveThreadTs,
  slackWorkspaceTarget,
} from "./slack-thread.js";
import {
  chatEmployeeQueueExtras,
  resolveChatEmployeeFromText,
} from "./chat-employee.js";

import { isSlackMessageTimestamp, signSlackBufferRequest, type BufferedSlackMessage } from "./slack-turn-buffer.js";

const SLACK_REPLIES = "https://slack.com/api/conversations.replies";

export interface SlackMentionQueueResult {
  approvalId: string;
}

export interface SlackMentionDeps {
  bufferMessage?: (input: BufferedSlackMessage & { threadKey: string }) => Promise<{ buffered: boolean; status?: string }>;
  queueRun?: (input: {
    threadKey: string;
    repoUrl: string;
    task: string;
    channelId: string;
    userId: string;
    harness: string;
    workspaceTarget?: import("@shiba/shared").WorkspaceTarget;
    publishPullRequest?: boolean;
  }) => Promise<SlackMentionQueueResult>;
  postMessage?: (input: {
    channel: string;
    threadTs: string;
    text: string;
    blocks?: unknown[];
  }) => Promise<void>;
  fetchThread?: (channel: string, threadTs: string) => Promise<SlackThreadMessage[]>;
  /** Injected in tests to mock the TypeSafe API call for intent classification. */
  typeSafeFetch?: MentionFetchImpl;
}

interface AppMentionEvent {
  type: "app_mention" | "message";
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
}

function sameThreadMessage(left: SlackThreadMessage, right: SlackThreadMessage): boolean {
  if (left.eventId && left.eventId === right.eventId) return true;
  // The native history reader retains exact timestamps. Numeric-only records
  // remain compatible with existing context providers and tests.
  return left.messageTs && right.messageTs ? left.messageTs === right.messageTs : left.ts === right.ts;
}

function compareThreadMessages(left: SlackThreadMessage, right: SlackThreadMessage): number {
  if (isSlackMessageTimestamp(left.messageTs) && isSlackMessageTimestamp(right.messageTs)) {
    const [leftSeconds = "0", leftFraction = ""] = left.messageTs.split(".");
    const [rightSeconds = "0", rightFraction = ""] = right.messageTs.split(".");
    const first = BigInt(leftSeconds), second = BigInt(rightSeconds);
    if (first !== second) return first < second ? -1 : 1;
    const firstFraction = leftFraction.padEnd(20, "0"), secondFraction = rightFraction.padEnd(20, "0");
    return firstFraction === secondFraction ? 0 : firstFraction < secondFraction ? -1 : 1;
  }
  return left.ts - right.ts;
}

/** The verified trigger wins over fetched copies and always fits in context. */
function mergeIncomingMessage(history: SlackThreadMessage[], incoming: SlackThreadMessage): SlackThreadMessage[] {
  const messages: SlackThreadMessage[] = [];
  for (const message of history) {
    if (sameThreadMessage(message, incoming) || messages.some((saved) => sameThreadMessage(saved, message))) continue;
    messages.push(message);
  }
  messages.sort(compareThreadMessages);
  return [...messages.slice(-(MAX_CONTEXT_MESSAGES - 1)), incoming].sort(compareThreadMessages);
}

function asAppMention(event: unknown): AppMentionEvent | null {
  if (typeof event !== "object" || event === null) return null;
  const candidate = event as { type?: unknown };
  if (candidate.type !== "app_mention") return null;
  return event as AppMentionEvent;
}

/**
 * A top-level DM to the intern is a task request, same as a channel
 * @mention. Only `message` events in an IM channel with no bot_id and no
 * subtype qualify — bot echoes and edits/joins/leaves are not tasks.
 * Thread replies are ignored: "thanks" or "ok" under an old card must not
 * queue a new run.
 */
function asDirectMessage(event: unknown): AppMentionEvent | null {
  if (typeof event !== "object" || event === null) return null;
  const candidate = event as Record<string, unknown>;
  if (candidate.type !== "message" || candidate.channel_type !== "im") return null;
  if (typeof candidate.bot_id === "string" || typeof candidate.subtype === "string") return null;
  if (typeof candidate.thread_ts === "string") return null;
  return event as AppMentionEvent;
}

function asThreadReply(event: unknown): AppMentionEvent | null {
  if (typeof event !== "object" || event === null) return null;
  const candidate = event as Record<string, unknown>;
  if (candidate.type !== "message" || typeof candidate.thread_ts !== "string") return null;
  if (typeof candidate.bot_id === "string" || typeof candidate.subtype === "string") return null;
  return event as AppMentionEvent;
}

function stripMentionMarkers(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gi, " ").replace(/\s+/g, " ").trim();
}

function requireSlackOk(response: Response, json: Record<string, unknown>): void {
  // Slack answers HTTP 200 with {ok:false, error} — check both.
  if (!response.ok || json.ok !== true) {
    throw new Error(typeof json.error === "string" ? json.error : `Slack API ${response.status}`);
  }
}

// conversations.replies is a GET method — query params, not a JSON body.
async function slackApiGet(
  token: string,
  url: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams(params);
  const response = await fetch(`${url}?${query.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  requireSlackOk(response, json);
  return json;
}

async function defaultPostMessage(
  token: string,
  input: { channel: string; threadTs: string; text: string; blocks?: unknown[] },
): Promise<void> {
  await postSlackMessage(token, input);
}

async function defaultFetchThread(token: string, channel: string, threadTs: string): Promise<SlackThreadMessage[]> {
  const json = await slackApiGet(token, SLACK_REPLIES, { channel, ts: threadTs, limit: "50" });
  const messages = Array.isArray(json.messages) ? json.messages : [];
  const out: SlackThreadMessage[] = [];
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const msg = raw as { user?: unknown; text?: unknown; ts?: unknown };
    if (typeof msg.text !== "string" || !isSlackMessageTimestamp(msg.ts)) continue;
    const ts = Number(msg.ts);
    if (!Number.isFinite(ts)) continue;
    out.push({
      user: typeof msg.user === "string" ? msg.user : "unknown",
      text: msg.text,
      ts,
      messageTs: msg.ts,
    });
  }
  return out;
}


export const SLACK_INTENT_TYPES = ["fix", "implement", "explain", "other"] as const;
export type SlackMentionIntent = (typeof SLACK_INTENT_TYPES)[number];

/** Pluggable fetch for tests. */
export type MentionFetchImpl = TypeSafeFetch;

export interface SlackMentionIntentResult {
  intent: SlackMentionIntent;
  /** Probability [0, 1] that the chosen intent is correct. */
  probability: number;
}

/**
 * Use TypeSafe Choice to classify what a Slack mention is asking for.
 * Returns null when apiKey is absent, or on HTTP/parse failure — callers
 * treat null as no classification and proceed unchanged.
 *
 * The result sharpens the orchestrator system prompt; it does not gate the
 * run. The approval card remains the human checkpoint regardless of intent.
 */
export async function classifySlackMentionIntent(
  apiKey: string,
  mentionText: string,
  threadSummary: string,
  fetchImpl: MentionFetchImpl = fetch,
): Promise<SlackMentionIntentResult | null> {
  if (!apiKey.trim() || !mentionText.trim()) return null;
  const answers = await postSystemOne(
    apiKey,
    { mention: mentionText, thread: threadSummary },
    {
      intent: {
        type: "choice",
        instructions: "What is the user primarily asking the coding agent to do?",
        criteria: {
          fix: "Fix a bug, error, test failure, or broken behaviour",
          implement: "Add a new feature, function, endpoint, or capability",
          explain: "Explain, summarise, or document existing code or behaviour",
          other: "Anything else: refactor, chore, question, or unclear",
        },
      },
    },
    fetchImpl,
  );
  if (answers === null) return null;
  const parsed = readChoiceAnswer(answers, "intent");
  if (!parsed) return null;
  const intent = SLACK_INTENT_TYPES.includes(parsed.choice as SlackMentionIntent)
    ? (parsed.choice as SlackMentionIntent)
    : "other";
  return { intent, probability: parsed.probability };
}

/**
 * Build a sharpened system-prompt hint from a TypeSafe intent classification.
 * Returns an empty string when classification is absent so callers can append
 * it without a branch.
 */
export function intentHint(classification: SlackMentionIntentResult | null): string {
  if (!classification) return "";
  const labels: Record<SlackMentionIntent, string> = {
    fix: "The user wants you to fix a bug or broken behaviour.",
    implement: "The user wants you to implement a new feature or capability.",
    explain: "The user wants an explanation or documentation update.",
    other: "",
  };
  return labels[classification.intent] ?? "";
}


export async function handleSlackEvent(
  body: SlackEventCallbackBody,
  env: Env,
  deps: SlackMentionDeps = {},
): Promise<void> {
  // @mentions in channels and direct messages both start work; everything
  // else (channel chatter, bot echoes, edits) is ignored.
  const reply = asThreadReply(body.event);
  const event = asAppMention(body.event) ?? asDirectMessage(body.event) ?? reply;
  if (!event) return;

  const token = env.SLACK_BOT_TOKEN?.trim() ?? "";
  const teamId = typeof body.team_id === "string" ? body.team_id : "";
  const channelId = event.channel?.trim() ?? "";
  const userId = event.user?.trim() ?? "";
  const mentionText = event.text ?? "";
  const workspaceTarget = slackWorkspaceTarget(stripMentionMarkers(mentionText));
  const threadTs = resolveThreadTs({ thread_ts: event.thread_ts, ts: event.ts });
  if (!channelId || !threadTs || !isSlackMessageTimestamp(event.ts)) return;
  const incoming: SlackThreadMessage = {
    user: userId || "unknown",
    text: mentionText,
    ts: Number(event.ts),
    messageTs: event.ts,
    eventId: body.event_id,
  };
  // An aside stays outside both the active-turn queue and task fallback.
  if (applyThreadControls([incoming]).length === 0) return;

  const postMessage =
    deps.postMessage ??
    (token ? (input: Parameters<NonNullable<SlackMentionDeps["postMessage"]>>[0]) => defaultPostMessage(token, input) : undefined);
  // No bot token: cannot ask or post a card, so start no run.
  if (!postMessage) return;

  if (event.thread_ts) {
    const threadKey = buildSlackThreadName(teamId, channelId, threadTs);
    const buffer = deps.bufferMessage ?? (env.CodingOrchestrator ? async (input: BufferedSlackMessage & { threadKey: string }) => {
      const stub = await getSlackThreadStub<{ fetch(request: Request): Promise<Response> }>(env, { teamId, channelId, threadTs });
      const response = await stub.fetch(await signSlackBufferRequest(new Request("https://internal/api/slack/buffer", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      }), env.INTERNAL_SIGNING_KEY ?? ""));
      if (!response.ok) throw new Error(`Slack buffer unavailable (${response.status}).`);
      return await response.json() as { buffered: boolean; status?: string };
    } : undefined);
    if (buffer) {
      try {
        const result = await buffer({ threadKey, eventId: body.event_id, userId, text: mentionText, createdAt: Date.now(), messageTs: event.ts });
        if (result.buffered || result.status === "duplicate") return;
        if (result.status === "full" || result.status === "invalid") {
          await postMessage({ channel: channelId, threadTs, text: "That follow-up could not fit in the queue. Please send a shorter message after this turn completes." });
          return;
        }
      } catch (error) {
        console.error("Slack turn buffering failed", redactSecrets(String(error)));
        await postMessage({ channel: channelId, threadTs, text: "I could not save that follow-up. Please try again after this turn completes." });
        return;
      }
    }
    if (reply) return;
  }

  let threadMessages = [incoming];
  const fetchThread = deps.fetchThread ?? (token ? (ch: string, ts: string) => defaultFetchThread(token, ch, ts) : undefined);
  if (fetchThread) {
    try {
      const fetched = await fetchThread(channelId, threadTs);
      threadMessages = mergeIncomingMessage(fetched, incoming);
    } catch (error) {
      console.error("Slack thread fetch failed", redactSecrets(String(error)));
    }
  }

  const resolution = resolveSlackRepo({
    mentionText,
    threadTexts: threadMessages.map((m) => m.text),
    channelId,
    channelRepos: parseChannelRepoMap(env.SLACK_CHANNEL_REPOS),
  });

  const task = gatherSlackContext({ threadMessages,
    ...(event.type === "app_mention" ? { verifiedMentionEventId: body.event_id } : {}),
  }) || stripMentionMarkers(mentionText);
  if (!task) {
    await postMessage({
      channel: channelId,
      threadTs,
      text: slackAskForTask(),
    });
    return;
  }

  const employeeResolution = workspaceTarget
    ? { kind: "none" as const, taskText: task }
    : await resolveChatEmployeeFromText(env, task);
  if (employeeResolution.kind === "error") {
    await postMessage({ channel: channelId, threadTs, text: employeeResolution.error });
    return;
  }
  const taskForRun = employeeResolution.taskText;
  if (!taskForRun) {
    await postMessage({ channel: channelId, threadTs, text: slackAskForTask() });
    return;
  }

  // TypeSafe Choice: classify intent to sharpen the orchestrator system prompt.
  // Fail-open — null means no classification, no change to the run path.
  const intentApiKey = env.TYPESAFE_API_KEY?.trim() ?? "";
  const intentClassification = intentApiKey
    ? await classifySlackMentionIntent(
        intentApiKey,
        stripMentionMarkers(mentionText),
        taskForRun,
        deps.typeSafeFetch,
      ).catch(() => null)
    : null;
  const hint = intentHint(intentClassification);

  const threadKey = buildSlackThreadName(teamId, channelId, threadTs);
  // The hint becomes part of the task the run executes — the card renders
  // taskWithHint verbatim so the human approves exactly what will run.
  const taskWithHint = hint ? `${hint}
${taskForRun}` : taskForRun;

  let employeeExtras: Awaited<ReturnType<typeof chatEmployeeQueueExtras>> | null = null;
  if (employeeResolution.kind === "ok") {
    employeeExtras = await chatEmployeeQueueExtras(
      env,
      employeeResolution.agent,
      employeeResolution.orgId,
      taskWithHint,
      resolution.kind === "ask" ? null : resolution.repoUrl,
    );
    if (!employeeExtras.ok) {
      if (employeeExtras.error) {
        await postMessage({ channel: channelId, threadTs, text: employeeExtras.error });
        return;
      }
      await postMessage({ channel: channelId, threadTs, text: slackAskForRepo() });
      return;
    }
  }

  if (!workspaceTarget && !employeeExtras?.ok && resolution.kind === "ask") {
    await postMessage({ channel: channelId, threadTs, text: slackAskForRepo() });
    return;
  }

  const repoUrl = workspaceTarget ? "" : employeeExtras?.ok
    ? (employeeExtras.extras.repoUrl ?? "")
    : resolution.kind === "ask"
      ? ""
      : resolution.repoUrl;
  const harness = employeeExtras?.ok && employeeExtras.extras.harness
    ? employeeExtras.extras.harness
    : resolveSlackHarness(env);
  const payload = buildSlackRunPayload({
    repoUrl,
    ...(workspaceTarget ? { workspaceTarget } : {}),
    task: employeeExtras?.ok ? employeeExtras.task : taskWithHint,
    channelId,
    userId,
    harness,
    ...(employeeExtras?.ok
      ? {
          orgId: employeeExtras.extras.orgId,
          customAgentId: employeeExtras.extras.customAgentId,
          customAgentVersion: employeeExtras.extras.customAgentVersion,
          ...(employeeExtras.extras.employeeToolPolicyVersion !== undefined
            ? { employeeToolPolicyVersion: employeeExtras.extras.employeeToolPolicyVersion }
            : {}),
          ...(employeeExtras.extras.executionTarget
            ? { executionTarget: employeeExtras.extras.executionTarget }
            : {}),
          publishPullRequest: employeeExtras.extras.publishPullRequest,
        }
      : {}),
  });
  const queueRun =
    deps.queueRun ??
    (async (input) => {
      const stub = await getSlackThreadStub<{ fetch: (request: Request) => Promise<Response> }>(env, {
        teamId,
        channelId,
        threadTs,
      });
      let request = new Request("https://internal/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, threadKey: input.threadKey }),
        });
      if ((env.INTERNAL_SIGNING_KEY?.length ?? 0) >= 32 && slackCanvasOwner(env, input.threadKey)) {
        request = await signSlackCanvasIntake(request, env.INTERNAL_SIGNING_KEY ?? "", input.threadKey);
      }
      const queued = await stub.fetch(request);
      if (!queued.ok) throw new Error(`Queue failed (${queued.status}).`);
      const queuedBody = (await queued.json().catch(() => ({}))) as { approvalId?: string };
      if (!queuedBody.approvalId) throw new Error("Orchestrator did not return an approval id.");
      return { approvalId: queuedBody.approvalId };
    });

  try {
    const { approvalId } = await queueRun({
      threadKey,
      repoUrl,
      task: payload.task,
      ...(workspaceTarget ? { workspaceTarget } : {}),
      publishPullRequest: payload.publishPullRequest,
      channelId,
      userId,
      harness,
    });
    const liveCanvasUrl = buildSlackCanvasUrl(env, { threadKey, approvalId });
    const canvasUrl = liveCanvasUrl ?? slackCanvasUrl(env.WORKER_HOSTNAME);
    await postMessage({
      channel: channelId,
      threadTs,
      text: slackAck({
        repoUrl: repoUrl || undefined,
        harness,
        ...(employeeExtras?.ok ? { employeeLabel: employeeExtras.extras.employeeLabel } : {}),
      }),
      blocks: buildApprovalBlocks({
        threadKey,
        approvalId,
        repoUrl: repoUrl || "(artifact workspace)",
        task: payload.task,
        harness,
        canvasUrl,
        liveCanvas: !!liveCanvasUrl,
        workspaceLabel: workspaceTarget ? `Workspace ${workspaceTarget.workspaceId}` : repoUrl || "Ephemeral workspace",
        publishPullRequest: payload.publishPullRequest,
        ...(employeeExtras?.ok ? { employeeLabel: employeeExtras.extras.employeeLabel } : {}),
      }),
    });
  } catch (error) {
    console.error("Slack mention dispatch failed", redactSecrets(String(error)));
    await postMessage({
      channel: channelId,
      threadTs,
      text: slackQueueFailed(),
    });
  }
}
