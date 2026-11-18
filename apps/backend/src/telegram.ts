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
import { buildDecisionData, parseDecisionData } from "@shiba/shared";
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
import type { Env } from "./env.js";
import { tryAnswerUiBlockFallback } from "./ui-block-fallback.js";
import { redactSecrets } from "./security.js";
import { isApprover, parseApproverAllowlist, type ExecutionContextLike } from "./slack-approval.js";

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

async function handleMessage(message: InboundMessage, env: Env, adapter: ChannelAdapter, deps: TelegramDeps): Promise<void> {
  const chatId = message.placeId;
  const text = message.text.trim();
  if (!NUMERIC_ID.test(chatId) || !NUMERIC_ID.test(message.messageId)) return;
  const reply = (body: { text: string; reply_markup?: unknown }) =>
    adapter.post({
      placeId: chatId,
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
  const parsed = parseChatTaskRequest({
    text: text.replace(COMMAND, ""),
    conversationId: chatId,
    repoMap: env.TELEGRAM_CHAT_REPOS,
    mapName: "TELEGRAM_CHAT_REPOS",
    usage: TELEGRAM_USAGE,
  });
  if ("error" in parsed) {
    await reply({ text: parsed.error });
    return;
  }
  const queued = await queueChatRun(env, {
    platform: "telegram",
    threadKey: message.conversationKey,
    repoUrl: parsed.repoUrl,
    task: parsed.task,
    userId: message.authorId,
    harness: env.TELEGRAM_AGENT_HARNESS ?? env.AGENT_HARNESS,
  }, deps.resolveOrchestrator);
  if ("error" in queued) {
    await reply({ text: `Failed to queue the task. ${queued.error}` });
    return;
  }
  await reply({
    text: chatApprovalText({ ...parsed, approvalId: queued.approvalId, route: queued.route }),
    reply_markup: {
      inline_keyboard: [[
        { text: "Approve", callback_data: buildDecisionData(true, queued.approvalId) },
        { text: "Reject", callback_data: buildDecisionData(false, queued.approvalId) },
      ]],
    },
  });
  // Telegram's message cap is 4096; a task over the card limit posts in full
  // right after the card so Approve never signs off on hidden text.
  for (const chunk of chatTaskChunks(parsed.task, CARD_TASK_LIMIT, 3900)) {
    await adapter.post({ placeId: chatId, text: chunk });
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
    console.error("Telegram approval card update failed", redactSecrets(String(error)));
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
    console.error("Telegram update failed", redactSecrets(String(error)));
  });
  if (ctx) {
    ctx.waitUntil(work);
  } else {
    await work;
  }
  return new Response("", { status: 200 });
}
