/* eslint-disable no-restricted-imports -- Adapters sit three levels deep but stay inside the backend app. */
import { postLegacySlackEmailApproval } from "./legacy-email.js";
import { approvalCardText, buildApprovalBlocks, parseBlockActionsPayload, APPROVE_ACTION_ID, REJECT_ACTION_ID } from "../../../slack-approval.js";
import { postSlackMessageWithReceipt, updateSlackMessage, verifySlackRequest, SlackPostRejectedError } from "../../../slack.js";
import { resolveThreadTs } from "../../../slack-thread.js";
import { ChannelError, type ChatChannel, type ChannelEvent, type ChannelIdentity, type ChannelMessageInput, type ChannelMessageRef, type ChannelApprovalInput, type ChannelThreadRef } from "../../../ports/chat-channel/types.js";

export interface SlackChannelEnv {
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
}

export interface SlackChannelDeps {
  post?: typeof postSlackMessageWithReceipt;
  update?: typeof updateSlackMessage;
  /** Bound to a workspace and Slack team by the composition root. */
  resolveUser?: (id: string) => Promise<ChannelIdentity | null>;
}

export function slackChannelError(error: unknown): ChannelError {
  if (error instanceof ChannelError) return error;
  const code = error instanceof SlackPostRejectedError ? error.message : "";
  const kind = ["not_in_channel", "channel_not_found"].includes(code) ? "not_in_channel"
    : ["not_authed", "account_inactive", "app_uninstalled"].includes(code) ? "not_installed"
    : ["invalid_auth", "token_revoked", "token_expired"].includes(code) ? "auth_expired"
    : ["ratelimited", "rate_limited", "Slack API 429"].includes(code) ? "rate_limited"
    : "invalid_request";
  return new ChannelError(kind, { cause: error, outcomeKnown: error instanceof SlackPostRejectedError ? error.outcomeKnown : false });
}

export class SlackChatChannel implements ChatChannel {
  readonly id = "slack";
  readonly capabilities = Object.freeze({ threads: true, edits: true, reactions: false, files: false, buttons: true, modals: false, typing: false, streaming: false });

  constructor(private readonly env: SlackChannelEnv, private readonly deps: SlackChannelDeps = {}) {}

  async verify(request: Request): Promise<boolean> {
    return verifySlackRequest(await request.clone().text(), request.headers, this.env.SLACK_SIGNING_SECRET ?? "");
  }

  async parse(request: Request): Promise<ChannelEvent[]> {
    if (!await this.verify(request)) throw new ChannelError("invalid_request");
    try {
      const raw = await request.clone().text();
      if (request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) {
        const action = parseBlockActionsPayload(new URLSearchParams(raw).get("payload"));
        // Employee tool approvals retain their separate pointer and authority contract.
        if (!action.pointer || ![APPROVE_ACTION_ID, REJECT_ACTION_ID].includes(action.actionId)) return [];
        const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "null");
        const tenantId: unknown = payload.team?.id;
        const conversationId: unknown = payload.channel?.id;
        const threadId: unknown = payload.message?.thread_ts ?? payload.message?.ts;
        if (typeof tenantId !== "string" || !tenantId || typeof conversationId !== "string" || !conversationId || typeof threadId !== "string" || !resolveThreadTs({ ts: threadId })) {
          throw new ChannelError("invalid_request");
        }
        const thread: ChannelThreadRef = { channel: this.id, tenantId, conversationId, threadId };
        return [{ type: "action", thread, userId: action.userId, action: action.actionId === APPROVE_ACTION_ID ? "approve" : "deny", approval: action.pointer }];
      }
      const body = JSON.parse(raw);
      if (body?.type !== "event_callback" || typeof body.team_id !== "string" || typeof body.event_id !== "string") return [];
      const event = body.event;
      if (event?.type === "app_uninstalled") return [{ type: "uninstall", channel: this.id, tenantId: body.team_id }];
      if (!["message", "app_mention"].includes(event?.type) || event.subtype || event.bot_id) return [];
      if (typeof event.channel !== "string" || typeof event.user !== "string" || typeof event.text !== "string" || typeof event.ts !== "string") return [];
      if (event.thread_ts !== undefined && typeof event.thread_ts !== "string") return [];
      const threadId = resolveThreadTs({ ts: event.ts, thread_ts: event.thread_ts });
      if (!threadId) return [];
      return [{ type: event.type === "app_mention" ? "mention" : "message", id: body.event_id, thread: { channel: this.id, tenantId: body.team_id, conversationId: event.channel, threadId }, userId: event.user, text: event.text, messageId: event.ts }];
    } catch (error) {
      throw new ChannelError("invalid_request", { cause: error });
    }
  }

  private token(thread: ChannelThreadRef): string {
    if (thread.channel !== this.id || !thread.conversationId) throw new ChannelError("invalid_request");
    if (!this.env.SLACK_BOT_TOKEN) throw new ChannelError("not_installed");
    return this.env.SLACK_BOT_TOKEN;
  }

  async postMessage(input: ChannelMessageInput): Promise<ChannelMessageRef> {
    try {
      const receipt = await (this.deps.post ?? postSlackMessageWithReceipt)(this.token(input.thread), {
        channel: input.thread.conversationId, threadTs: input.thread.threadId || undefined,
        text: input.text, blocks: input.blocks, persona: input.persona,
      });
      return { thread: { ...input.thread, conversationId: receipt.channel, threadId: input.thread.threadId || receipt.ts }, id: receipt.ts };
    } catch (error) { throw slackChannelError(error); }
  }

  async updateMessage(input: { message: ChannelMessageRef; text: string; blocks?: unknown[] }): Promise<void> {
    try {
      await (this.deps.update ?? updateSlackMessage)(this.token(input.message.thread), {
        channel: input.message.thread.conversationId, ts: input.message.id, text: input.text, blocks: input.blocks,
      });
    } catch (error) { throw slackChannelError(error); }
  }

  postApprovalRequest(input: ChannelApprovalInput): Promise<ChannelMessageRef> {
    return this.postMessage({ thread: input.thread, text: approvalCardText(input), blocks: buildApprovalBlocks(input) });
  }

  async postApprovalNotification(input: Omit<ChannelApprovalInput, "thread"> & { conversationId: string }): Promise<void> {
    if (!this.env.SLACK_BOT_TOKEN) throw new ChannelError("not_installed");
    await postLegacySlackEmailApproval(this.env.SLACK_BOT_TOKEN, input.conversationId, input);
  }

  resolveApprovalRequest(input: { message: ChannelMessageRef; text: string }): Promise<void> {
    return this.updateMessage({ ...input, blocks: [] });
  }

  async postFile(_input: { thread: ChannelThreadRef; name: string; content: Blob }): Promise<ChannelMessageRef> {
    throw new ChannelError("invalid_request");
  }

  async setTyping(_thread: ChannelThreadRef): Promise<void> {
    throw new ChannelError("invalid_request");
  }

  resolveUser(id: string): Promise<ChannelIdentity | null> {
    return this.deps.resolveUser?.(id) ?? Promise.resolve(null);
  }
}
