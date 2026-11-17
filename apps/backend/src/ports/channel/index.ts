/**
 * Channel port: one contract every chat platform implements.
 *
 * A channel is two halves. The transport authenticates an inbound delivery
 * with the platform's own mechanism and parses it into one InboundMessage or
 * InboundAction shape with a per-platform conversation key. The adapter is
 * the outbound side: post, edit, react, upload, download, thread history,
 * recent messages, author and place names, and mention extraction.
 *
 * The port carries no policy. Approver lists, approval cards and run
 * queueing stay in each lane; a transport only says who sent what, and
 * verifying a delivery authenticates the platform, never the human.
 */
import type { Env } from "../../env.js";

export type ChannelId = "slack" | "discord" | "telegram" | "teams";

export const CHANNEL_CAPABILITIES = [
  "post",
  "edit",
  "react",
  "upload",
  "download",
  "history",
  "recent",
  "authorName",
  "placeName",
] as const;

export type ChannelCapability = (typeof CHANNEL_CAPABILITIES)[number];

/** Where a posted message lives: the place (channel/chat) and its platform id. */
export interface ChannelMessageRef {
  placeId: string;
  messageId: string;
  threadId?: string;
}

export interface ChannelPostInput {
  placeId: string;
  /** Slack thread_ts, Discord thread channel; ignored where a platform has none. */
  threadId?: string;
  /** Reply to one message (Telegram reply_parameters). */
  replyToMessageId?: string;
  text: string;
  /** Platform-native fields merged into the request (blocks, reply_markup, components). */
  native?: Record<string, unknown>;
}

export interface ChannelEditInput {
  ref: ChannelMessageRef;
  text: string;
  native?: Record<string, unknown>;
}

export interface ChannelUploadInput {
  placeId: string;
  threadId?: string;
  filename: string;
  contentType: string;
  data: Uint8Array<ArrayBuffer>;
  comment?: string;
}

export interface ChannelFile {
  data: Uint8Array;
  contentType: string;
}

export interface ChannelHistoryMessage {
  messageId: string;
  authorId: string;
  text: string;
  isBot: boolean;
  threadId?: string;
}

export interface ChannelAdapter {
  readonly channel: ChannelId;
  readonly capabilities: ReadonlySet<ChannelCapability>;
  post(input: ChannelPostInput): Promise<ChannelMessageRef>;
  edit(input: ChannelEditInput): Promise<void>;
  /** Slack-style name ("eyes", ":eyes:") or a unicode emoji; adapters convert to what the platform takes. */
  react(ref: ChannelMessageRef, emoji: string): Promise<void>;
  upload(input: ChannelUploadInput): Promise<ChannelMessageRef>;
  /** A platform file id or URL taken from an inbound message. */
  download(file: string): Promise<ChannelFile>;
  history(placeId: string, threadId: string, limit?: number): Promise<ChannelHistoryMessage[]>;
  recent(placeId: string, limit?: number): Promise<ChannelHistoryMessage[]>;
  authorName(userId: string, placeId?: string): Promise<string>;
  placeName(placeId: string): Promise<string>;
  /** User ids mentioned in platform text, in order, without duplicates. */
  mentions(text: string): string[];
}

/** Thrown by an adapter method its platform cannot perform. */
export class ChannelUnsupportedError extends Error {
  constructor(readonly channel: ChannelId, readonly capability: ChannelCapability) {
    super(`${channel} does not support ${capability}.`);
    this.name = "ChannelUnsupportedError";
  }
}

interface InboundBase {
  channel: ChannelId;
  /** Platform delivery id for dedupe (event_id, update_id, interaction id); "" when the platform has none. */
  deliveryId: string;
  /** Orchestrator conversation this event belongs to; "" when the platform payload names no place. */
  conversationKey: string;
  placeId: string;
  /** Workspace / tenant / guild, when the platform has one. */
  workspaceId?: string;
  raw: unknown;
}

export interface InboundMessage extends InboundBase {
  kind: "message";
  messageId: string;
  threadId?: string;
  authorId: string;
  authorName?: string;
  text: string;
  mentionedUserIds: string[];
  isDirect: boolean;
  isBot: boolean;
  /** Structured command input (Discord slash command options). */
  command?: { name: string; options: Record<string, string> };
}

export interface InboundAction extends InboundBase {
  kind: "action";
  /** The message carrying the button, when the platform says. */
  messageId?: string;
  messageText?: string;
  actorId: string;
  actorName?: string;
  /** Platform action id (Slack action_id); equals value where the platform has only one field. */
  actionId: string;
  value: string;
}

export type InboundEvent = InboundMessage | InboundAction;

export type ChannelVerification =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

export interface ChannelTransport {
  readonly channel: ChannelId;
  /** Authenticate a raw delivery before anything parses it. */
  verify(rawBody: string, headers: Headers, env: Env, now?: number): Promise<ChannelVerification>;
  /** Parse a verified delivery; null for envelopes that carry no message or action. Never throws. */
  parse(rawBody: string): InboundEvent | null;
  conversationKey(event: InboundEvent): string;
}

export interface ChannelAdapterOptions {
  fetch?: typeof fetch;
}

export interface ChannelDefinition {
  id: ChannelId;
  /** Env names the channel cannot run without. */
  requiredSecrets: readonly (keyof Env & string)[];
  transport: ChannelTransport;
  /** Null when the channel's outbound credential is not configured. */
  createAdapter(env: Env, options?: ChannelAdapterOptions): ChannelAdapter | null;
}

export function dedupeIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)];
}
