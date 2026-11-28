/**
 * Channel registry: the one place the backend learns which chat platforms
 * exist. A new platform is one ChannelDefinition added here. Publication
 * cards stay fail-closed unless the platform also has a CHANNEL_PUBLICATIONS
 * implementation below.
 */
import { parseChatThreadName } from "@shiba/shared";
import { discordChannel, postDiscordPublicationApproval } from "../../channels/discord/index.js";
import { emailChannel } from "../../channels/email/index.js";
import { slackChannel } from "../../channels/slack/index.js";
import { postTeamsPublicationApproval } from "../../channels/teams/connection.js";
import { teamsChannel } from "../../channels/teams/index.js";
import { telegramChannel } from "../../channels/telegram/index.js";
import type { Env } from "../../env.js";
import { postSlackPublicationApproval } from "../../slack-approval.js";
import {
  CHANNEL_PUBLICATION_CAPABILITIES,
  type ChannelAdapter,
  type ChannelAdapterOptions,
  type ChannelDefinition,
  type ChannelId,
  type ChannelPublication,
  type ChannelPublicationCardInput,
  type ChannelPublicationResult,
} from "./index.js";

const CHANNELS: Readonly<Record<ChannelId, ChannelDefinition>> = {
  slack: slackChannel,
  discord: discordChannel,
  telegram: telegramChannel,
  teams: teamsChannel,
  email: emailChannel,
};

export function listChannels(): ChannelDefinition[] {
  return Object.values(CHANNELS);
}

export function getChannel(id: ChannelId): ChannelDefinition {
  return CHANNELS[id];
}

/** Required secrets the env leaves unset or blank. */
export function missingChannelSecrets(env: Env, id: ChannelId): string[] {
  return CHANNELS[id].requiredSecrets.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim() === "";
  });
}

export function createChannelAdapter(env: Env, id: ChannelId, options?: ChannelAdapterOptions): ChannelAdapter | null {
  return CHANNELS[id].createAdapter(env, options);
}

/** The channel that owns an orchestrator conversation key (`slack:…`, `telegram:…`). */
export function channelForConversationKey(key: string): ChannelDefinition | null {
  const prefix = key.slice(0, key.indexOf(":"));
  return Object.hasOwn(CHANNELS, prefix) ? CHANNELS[prefix as ChannelId] : null;
}

const PUBLICATION_APPROVAL_CARD = new Set(CHANNEL_PUBLICATION_CAPABILITIES);

/**
 * Publication delivery is narrower than generic posting. A channel enters
 * this map only with an implementation that renders its interactive approval
 * pointer; every other registered channel resolves as unsupported.
 */
const CHANNEL_PUBLICATIONS: Partial<Record<ChannelId, ChannelPublication>> = {
  slack: {
    channel: "slack",
    capabilities: PUBLICATION_APPROVAL_CARD,
    postApprovalCard: postSlackPublicationApproval,
  },
  teams: {
    channel: "teams",
    capabilities: PUBLICATION_APPROVAL_CARD,
    async postApprovalCard(env, input) {
      const posted = await postTeamsPublicationApproval(env, input.threadKey, input.text, input.approvalId);
      return posted
        ? { status: "posted" }
        : { status: "unavailable", reason: "Teams publication conversation is unavailable." };
    },
  },
  discord: {
    channel: "discord",
    capabilities: PUBLICATION_APPROVAL_CARD,
    async postApprovalCard(env, input) {
      const posted = await postDiscordPublicationApproval(env, input.threadKey, input.text, input.approvalId);
      return posted
        ? { status: "posted" }
        : { status: "unavailable", reason: "Discord publication conversation is unavailable." };
    },
  },
};

/** The publication implementation for a channel, or null when that channel fails closed. */
export function channelPublicationFor(id: ChannelId): ChannelPublication | null {
  const publication = CHANNEL_PUBLICATIONS[id];
  return publication?.capabilities.has("publicationApprovalCard") ? publication : null;
}

export type ChannelPublicationResolution =
  | { status: "supported"; publication: ChannelPublication }
  | { status: "unsupported"; channel: string; reason: string };

/**
 * Resolve the publication owner for one orchestrator thread key. Registered
 * channels without a publication implementation fail closed; unprefixed
 * legacy orchestrator names keep Slack's existing dashboard/command routing.
 */
export function resolveChannelPublication(threadKey: string): ChannelPublicationResolution {
  const explicit = channelForConversationKey(threadKey);
  if (explicit) {
    const publication = channelPublicationFor(explicit.id);
    if (publication) return { status: "supported", publication };
    return {
      status: "unsupported",
      channel: explicit.id,
      reason: `${explicit.id} does not support publication approval cards.`,
    };
  }
  const chat = parseChatThreadName(threadKey);
  if (chat) {
    return {
      status: "unsupported",
      channel: chat.platform,
      reason: `${chat.platform} does not support publication approval cards.`,
    };
  }
  // Web session names can carry an additional owner segment (`web:devin:session`)
  // that the generic chat parser does not accept; they are still a known chat
  // surface and must not fall through to Slack's legacy fallback.
  if (threadKey.startsWith("web:")) {
    return { status: "unsupported", channel: "web", reason: "web does not support publication approval cards." };
  }
  const slack = channelPublicationFor("slack");
  if (slack) return { status: "supported", publication: slack };
  return { status: "unsupported", channel: "slack", reason: "slack does not support publication approval cards." };
}

/** Dispatch one publication approval through the owning channel implementation. */
export async function postChannelPublicationApproval(
  env: Env,
  input: ChannelPublicationCardInput,
): Promise<ChannelPublicationResult> {
  const resolved = resolveChannelPublication(input.threadKey);
  if (resolved.status === "unsupported") {
    return { status: "unsupported", channel: resolved.channel, reason: resolved.reason };
  }
  return resolved.publication.postApprovalCard(env, input);
}
