import { SlackChatChannel } from "../../adapters/chat-channel/slack/index.js";
import type { ChatChannel } from "./types.js";

export interface ChannelRegistration {
  id: string;
  enabled: () => boolean;
  create: () => ChatChannel;
}

/** Per-context factories: no credentials or adapters are kept in a global singleton. */
export class ChatChannelRegistry {
  private readonly registrations = new Map<string, ChannelRegistration>();

  register(registration: ChannelRegistration): this {
    if (this.registrations.has(registration.id)) throw new Error(`Duplicate chat channel: ${registration.id}`);
    this.registrations.set(registration.id, registration);
    return this;
  }

  get(id: string): ChatChannel | undefined {
    const registration = this.registrations.get(id);
    return registration?.enabled() ? registration.create() : undefined;
  }

  listEnabled(): ChatChannel[] {
    return [...this.registrations.keys()].flatMap((id) => {
      const adapter = this.get(id);
      return adapter ? [adapter] : [];
    });
  }
}

export function createChatChannelRegistry(env: { SLACK_BOT_TOKEN?: string; SLACK_SIGNING_SECRET?: string }): ChatChannelRegistry {
  return new ChatChannelRegistry().register({
    id: "slack",
    enabled: () => Boolean(env.SLACK_BOT_TOKEN?.trim()),
    create: () => new SlackChatChannel({ ...env, SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN?.trim() }),
  });
}
