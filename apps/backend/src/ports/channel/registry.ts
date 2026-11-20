/**
 * Channel registry: the one place the backend learns which chat platforms
 * exist. A new platform is one ChannelDefinition added here.
 */
import { discordChannel } from "../../channels/discord/index.js";
import { emailChannel } from "../../channels/email/index.js";
import { slackChannel } from "../../channels/slack/index.js";
import { teamsChannel } from "../../channels/teams/index.js";
import { telegramChannel } from "../../channels/telegram/index.js";
import type { Env } from "../../env.js";
import type { ChannelAdapter, ChannelAdapterOptions, ChannelDefinition, ChannelId } from "./index.js";

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
