/**
 * Telegram bot lane.
 *
 * Telegram signs nothing. setWebhook's `secret_token` is echoed on every
 * delivery in `X-Telegram-Bot-Api-Secret-Token`, so that header is the
 * authentication — header-only, never a query parameter
 * (https://core.telegram.org/bots/api#setwebhook).
 *
 * `/shiba <repo-url> <task>` queues a pending approval on the chat's
 * orchestrator (`telegram:{chatId}`) and replies with an inline-keyboard
 * card. The button data is a pointer: only TELEGRAM_APPROVERS user ids may
 * press it, and the orchestrator honors it only while it is still pending.
 *
 * Telegram redelivers on any non-2xx, so an authenticated update is acked
 * at once and the work runs behind `ctx.waitUntil`, deduped on `update_id`.
 */
import { buildCompactDecisionData, buildDecisionData, parseChatThreadName, parseDecisionData } from "@shiba/shared";
import {
  CARD_TASK_LIMIT,
  chatApprovalText,
  chatTaskChunks,
  createSeenRing,
  decideChatApproval,
  decisionLine,
  parseChatTaskRequest,
  queueChatRun,
  telegramApi,
  type ResolveOrchestrator,
} from "./chat-lane.js";
import {
  createTelegramAdapter,
  TELEGRAM_SECRET_HEADER,
  telegramTransport,
  type TelegramCall,
} from "./channels/telegram/index.js";
import type { ChannelAdapter, InboundAction, InboundMessage } from "./ports/channel/index.js";
import { chatEmployeeQueueExtras, resolveChatEmployeeFromText } from "./chat-employee.js";
import type { Env } from "./env.js";
import { tryAnswerUiBlockFallback } from "./ui-block-fallback.js";
import { redactSecrets } from "./security.js";
import { isApprover, parseApproverAllowlist, type ExecutionContextLike } from "./slack-approval.js";
import { timingSafeEqual } from "./slack.js";
import { log } from "./obs/log.js";

export const TELEGRAM_WEBHOOK_PATH = "/api/telegram/webhook";
export { TELEGRAM_SECRET_HEADER };
export const TELEGRAM_USAGE = "Usage: /shiba <github-repo-url> <task>";

const COMMAND = /^\/shiba(?:@\w+)?(?=\s|$)/i;
const HELP = /^\/(?:start|help)(?:@\w+)?(?=\s|$)/i;

const seenUpdates = createSeenRing(1000);

/** Test hook: reset the dedupe ring between tests. */
export function clearSeenTelegramUpdates(): void {
  seenUpdates.clear();
}

export interface TelegramUpdate {
  update_id?: number;
  message?: unknown;
  callback_query?: unknown;
}

export interface TelegramDeps {
  /** Bot API call; defaults to api.telegram.org with TELEGRAM_BOT_TOKEN. */
  call?: TelegramCall;
  /** Resolve the chat's orchestrator; defaults to the Agents SDK router. */
  resolveOrchestrator?: ResolveOrchestrator;
  /** Durable check-and-record for update ids. True = already seen. */
  dedupe?: (updateId: string) => Promise<boolean>;
}

const NUMERIC_ID = /^-?\d+$/;
export const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;
const TELEGRAM_MESSAGE_TEXT_LIMIT = 4000;
const PUBLICATION_FAIL_CLOSED_NOTE =
  "\n\nTelegram cannot carry this exact approval pointer in a button. No Telegram approval action was enabled; decide the pending publication in the Shiba dashboard.";

function callbackDataFits(data: string): boolean {
  return new TextEncoder().encode(data).byteLength <= TELEGRAM_CALLBACK_DATA_LIMIT_BYTES;
}

/**
 * Prefer the legacy decision spelling, then the compact spelling. Null means
 * Telegram must not render the action at all: a clipped or rewritten pointer
 * is never a safe approval authority.
 */
export function telegramDecisionData(approved: boolean, approvalId: string): string | null {
  const valid = (data: string) => {
    const parsed = parseDecisionData(data);
    return parsed?.approved === approved && parsed.approvalId === approvalId ? data : null;
  };
  const standard = buildDecisionData(approved, approvalId);
  if (callbackDataFits(standard)) return valid(standard);
  const compact = buildCompactDecisionData(approved, approvalId);
  return callbackDataFits(compact) ? valid(compact) : null;
}

export function telegramDecisionKeyboard(approvalId: string): { inline_keyboard: { text: string; callback_data: string }[][] } | null {
  const approve = telegramDecisionData(true, approvalId);
  const reject = telegramDecisionData(false, approvalId);
  if (!approve || !reject) return null;
  return {
    inline_keyboard: [[
      { text: "Approve", callback_data: approve },
      { text: "Reject", callback_data: reject },
    ]],
  };
}

function publicationFailClosedText(text: string): string {
  return `${text.slice(0, TELEGRAM_MESSAGE_TEXT_LIMIT - PUBLICATION_FAIL_CLOSED_NOTE.length)}${PUBLICATION_FAIL_CLOSED_NOTE}`;
}

/** Post the second publication approval into the originating Telegram chat or topic. */
export async function postTelegramPublicationApproval(
  env: Env,
  threadKey: string,
  text: string,
  approvalId: string,
  deps: { adapter?: ChannelAdapter } = {},
): Promise<boolean> {
  const chat = parseChatThreadName(threadKey);
  if (chat?.platform !== "telegram") return false;
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const adapter = deps.adapter ?? (token ? createTelegramAdapter({ token }) : null);
  if (!adapter) return false;
  const target = {
    placeId: chat.conversationId,
    ...(chat.topicId ? { threadId: chat.topicId } : {}),
  };
  const keyboard = telegramDecisionKeyboard(approvalId);
  if (!keyboard) {
    await adapter.post({ ...target, text: publicationFailClosedText(text) });
    return true;
  }
  await adapter.post({
    ...target,
    text: text.slice(0, TELEGRAM_MESSAGE_TEXT_LIMIT),
    native: { reply_markup: keyboard },
  });
  return true;
}

async function handleMessage(message: InboundMessage, env: Env, adapter: ChannelAdapter, deps: TelegramDeps): Promise<void> {
  const chatId = message.placeId;
  const text = message.text.trim();
  if (!NUMERIC_ID.test(chatId) || !NUMERIC_ID.test(message.messageId)) return;
  const reply = (body: { text: string; reply_markup?: unknown }) =>
    adapter.post({
      placeId: chatId,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      replyToMessageId: message.messageId,
      text: body.text,
      ...(body.reply_markup ? { native: { reply_markup: body.reply_markup } } : {}),
    });
  if (await tryAnswerUiBlockFallback(env, message.conversationKey, message.authorId, text.replace(COMMAND, "").trim())) {
    await reply({ text: "Answer recorded." });
    return;
  }
  if (HELP.test(text)) {
    await reply({ text: `${TELEGRAM_USAGE}\nNothing runs until someone on the approver list presses Approve.` });
    return;
  }
  if (!COMMAND.test(text)) return;
  const command = text.replace(COMMAND, "").trim();
  const parsed = parseChatTaskRequest({
    text: command,
    conversationId: chatId,
    repoMap: env.TELEGRAM_CHAT_REPOS,
    mapName: "TELEGRAM_CHAT_REPOS",
    usage: TELEGRAM_USAGE,
  });
  const employee = await resolveChatEmployeeFromText(env, "error" in parsed ? command : parsed.task);
  if (employee.kind === "error") {
    await reply({ text: employee.error });
    return;
  }
  const request: Parameters<typeof queueChatRun>[1] = {
    platform: "telegram",
    threadKey: message.conversationKey,
    repoUrl: "error" in parsed ? "" : parsed.repoUrl,
    task: employee.taskText,
    userId: message.authorId,
    harness: env.TELEGRAM_AGENT_HARNESS ?? env.AGENT_HARNESS,
    publishPullRequest: true,
  };
  if (employee.kind === "ok") {
    if (!request.task) {
      await reply({ text: "Describe the task for this employee." });
      return;
    }
    const configured = await chatEmployeeQueueExtras(env, employee.agent, employee.orgId, request.task, request.repoUrl || null);
    if (!configured.ok) {
      await reply({ text: configured.error || ("error" in parsed ? parsed.error : TELEGRAM_USAGE) });
      return;
    }
    Object.assign(request, configured.extras, {
      task: configured.task, harness: configured.extras.harness ?? request.harness,
    });
  } else if ("error" in parsed) {
    await reply({ text: parsed.error });
    return;
  }
  const queued = await queueChatRun(env, request, deps.resolveOrchestrator);
  if ("error" in queued) {
    await reply({ text: `Failed to queue the task. ${queued.error}` });
    return;
  }
  const keyboard = telegramDecisionKeyboard(queued.approvalId);
  if (!keyboard) {
    await reply({ text: "Approval queued, but Telegram cannot carry its exact approval pointer in a button. Decide it in the Shiba dashboard; no Telegram approval action was enabled." });
    return;
  }
  await reply({
    text: chatApprovalText({ ...request, approvalId: queued.approvalId, route: queued.route }),
    reply_markup: keyboard,
  });
  // Telegram's message cap is 4096; a task over the card limit posts in full
  // right after the card so Approve never signs off on hidden text.
  for (const chunk of chatTaskChunks(request.task, CARD_TASK_LIMIT, 3900)) {
    await adapter.post({ placeId: chatId, ...(message.threadId ? { threadId: message.threadId } : {}), text: chunk });
  }
}

async function handleCallback(
  query: InboundAction,
  env: Env,
  call: TelegramCall,
  adapter: ChannelAdapter,
  deps: TelegramDeps,
): Promise<void> {
  const queryId = query.actionId;
  if (!queryId) return;
  const answer = (text: string, alert = false) =>
    call("answerCallbackQuery", { callback_query_id: queryId, text, show_alert: alert });
  const decision = parseDecisionData(query.value);
  const chatId = query.placeId;
  if (!decision || !NUMERIC_ID.test(chatId)) {
    await answer("This button is not a Shiba approval.", true);
    return;
  }
  // The secret token authenticates Telegram, not the human. Empty list = nobody.
  const userId = query.actorId;
  if (!isApprover(userId, parseApproverAllowlist(env.TELEGRAM_APPROVERS))) {
    await answer("You are not on the approver list.", true);
    return;
  }
  const result = await decideChatApproval(env, {
    platform: "telegram",
    threadKey: query.conversationKey,
    approvalId: decision.approvalId,
    approved: decision.approved,
    decidedBy: `telegram:${userId}`,
  }, deps.resolveOrchestrator);
  if (!result.ok) {
    await answer(result.error, true);
    return;
  }
  const { approved, requestedApproved } = result;
  await answer(approved ? "Approved — run starting." : "Rejected — no run started.");
  const messageId = query.messageId;
  if (messageId === undefined || !NUMERIC_ID.test(messageId)) return;
  const who =
    approved === requestedApproved
      ? query.actorName ?? query.actorId
      : "an earlier decision";
  await adapter.edit({
    ref: { placeId: chatId, messageId },
    text: `${query.messageText ?? "Approval"}\n\n${decisionLine(approved, who)}`,
  }).catch((error: unknown) => {
    log.error("Telegram approval card update failed", redactSecrets(String(error)));
  });
}

/**
 * Handle POST /api/telegram/webhook. Returns null for any other path or
 * method so the Worker can fall through to the remaining routes.
 */
export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContextLike,
  deps: TelegramDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== TELEGRAM_WEBHOOK_PATH || request.method !== "POST") {
    return null;
  }
  const rawBody = await request.text();
  const verified = await telegramTransport.verify(rawBody, request.headers, env);
  if (!verified.ok) {
    return Response.json({ error: verified.error }, { status: verified.status });
  }
  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  let update: unknown;
  try {
    update = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Telegram update is not valid JSON." }, { status: 400 });
  }
  if (typeof update !== "object" || update === null || typeof (update as TelegramUpdate).update_id !== "number") {
    return new Response("", { status: 200 });
  }
  const body = update as TelegramUpdate;
  const key = String(body.update_id);
  if (seenUpdates.has(key)) {
    return new Response("", { status: 200 });
  }
  if (deps.dedupe) {
    try {
      if (await deps.dedupe(key)) {
        seenUpdates.add(key);
        return new Response("", { status: 200 });
      }
    } catch {
      // Dedupe backend down: ack anyway — a duplicate beats a lost update.
    }
  }
  seenUpdates.add(key);
  const call: TelegramCall = deps.call ??
    ((method, payload) => telegramApi(token, method, payload));
  const adapter = createTelegramAdapter({ token, call });
  const inbound = telegramTransport.parse(rawBody);
  const work = (inbound?.kind === "action"
    ? handleCallback(inbound, env, call, adapter, deps)
    : inbound?.kind === "message"
      ? handleMessage(inbound, env, adapter, deps)
      : Promise.resolve()
  ).catch((error: unknown) => {
    log.error("Telegram update failed", redactSecrets(String(error)));
  });
  if (ctx) {
    ctx.waitUntil(work);
  } else {
    await work;
  }
  return new Response("", { status: 200 });
}
