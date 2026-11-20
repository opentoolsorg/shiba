/**
 * Discord mention lane. A gateway MESSAGE_CREATE that mentions the bot in
 * an active installation becomes a Shiba task with an in-channel approval
 * card, posted as a reply in the same channel or thread. The card's
 * buttons come back through the signed interactions endpoint, so approval
 * keeps the DISCORD_APPROVERS check and the orchestrator's pending gate.
 */
import { buildChatThreadName } from "@shiba/shared";
import { seenDelivery } from "./automations-stub.js";
import { createDiscordAdapter, NO_MENTIONS } from "./channels/discord/index.js";
import { queueChatRun, type ResolveOrchestrator } from "./chat-lane.js";
import { discordApprovalCard, discordTaskFollowUps, prepareDiscordTask, stripDiscordMentions } from "./discord.js";
import { checkDiscordGuildAccess, discordOAuthConfigured } from "./discord-installations.js";
import type { Env } from "./env.js";
import type { ChannelAdapter } from "./ports/channel/index.js";

export interface DiscordGatewayMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: { id: string; username?: string; bot?: boolean };
  mentions?: Array<{ id: string }>;
  webhook_id?: string;
}

export interface DiscordMentionResult {
  outcome: "queued" | "ignored" | "rejected" | "failed";
  reason?: string;
  approvalId?: string;
}

export interface DiscordMentionDeps {
  adapter?: ChannelAdapter;
  resolveOrchestrator?: ResolveOrchestrator;
  seen?: (key: string) => Promise<boolean>;
}

export async function handleDiscordMention(
  env: Env,
  message: DiscordGatewayMessage,
  botUserId: string,
  deps: DiscordMentionDeps = {},
): Promise<DiscordMentionResult> {
  if (message.author?.bot || message.webhook_id || message.author?.id === botUserId) {
    return { outcome: "ignored", reason: "bot or webhook author" };
  }
  if (!botUserId || !(message.mentions ?? []).some((user) => user.id === botUserId)) {
    return { outcome: "ignored", reason: "bot not mentioned" };
  }
  let threadKey: string;
  try {
    threadKey = buildChatThreadName("discord", message.channel_id);
  } catch {
    return { outcome: "ignored", reason: "malformed channel" };
  }
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  const adapter = deps.adapter ?? (botToken ? createDiscordAdapter({ botToken }) : null);
  if (!adapter) return { outcome: "failed", reason: "DISCORD_BOT_TOKEN is not set" };
  const reply = (text: string, native?: Record<string, unknown>) =>
    adapter.post({
      placeId: message.channel_id,
      text,
      replyToMessageId: message.id,
      ...(native ? { native } : {}),
    });

  if (!discordOAuthConfigured(env)) return { outcome: "ignored", reason: "Discord installation setup is incomplete" };
  const access = await checkDiscordGuildAccess(env, message.guild_id);
  if (!access.ok) return { outcome: "rejected", reason: access.message };
  const seen = deps.seen ?? ((key: string) => seenDelivery(env, key).catch(() => false));
  if (await seen(`discord-message:${message.id}`)) return { outcome: "ignored", reason: "duplicate delivery" };

  const text = stripDiscordMentions(message.content ?? "");
  if (!text) {
    await reply("Mention me with a task, for example: @Shiba fix the flaky login test https://github.com/owner/repo");
    return { outcome: "rejected", reason: "empty task" };
  }
  const prepared = await prepareDiscordTask(env, { threadKey, userId: message.author.id, text });
  if ("error" in prepared) {
    await reply(prepared.error);
    return { outcome: "rejected", reason: prepared.error };
  }
  const queued = await queueChatRun(env, prepared.queueBody, deps.resolveOrchestrator);
  if ("error" in queued) {
    await reply(`Failed to queue the task. ${queued.error}`);
    return { outcome: "failed", reason: queued.error };
  }
  const card = discordApprovalCard(prepared.queueBody, queued);
  await reply(card.content, { components: card.components, allowed_mentions: NO_MENTIONS });
  for (const chunk of discordTaskFollowUps(prepared.queueBody.task)) {
    await adapter.post({ placeId: message.channel_id, text: chunk });
  }
  return { outcome: "queued", approvalId: queued.approvalId };
}
