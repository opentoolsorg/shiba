import {
  claimCollaborationSlackDeliveryIntent,
  finishCollaborationSlackDeliveryIntent,
  isCollaborationSlackDeliverySendable,
  type CollaborationScope,
} from "./collaboration-store.js";
import type { Env } from "./env.js";
import { isApprover, parseApproverAllowlist } from "./slack-approval.js";
import { postSlackMessageWithReceipt, SlackPostRejectedError, verifySlackBotInstallation } from "./slack.js";

export interface SlackRoomOutboxDeps {
  verifyInstallation?: (token: string) => Promise<{ teamId: string; userId: string; botId: string }>;
  postMessage?: (token: string, input: {
    channel: string;
    threadTs: string;
    text: string;
    clientMsgId: string;
  }) => Promise<{ channel: string; ts: string }>;
}

export type SlackRoomOutboxResult =
  | { status: "disabled" | "not_ready" }
  | { status: "blocked" | "failed" | "unknown" }
  | { status: "sent"; channel: string; ts: string };

async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function stableClientMsgId(intentId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(intentId)));
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * One-shot approved outbox worker. `sending` and `unknown` outcomes are never
 * retried automatically, because Slack may have accepted a request before a
 * network timeout. A stable client_msg_id is included as an extra dedupe aid.
 */
export async function deliverApprovedSlackRoomIntent(
  env: Pick<Env, "AGENT_AUDIT" | "SLACK_BOT_TOKEN" | "SLACK_APPROVALS_CHANNEL" | "SLACK_ROOM_OUTBOX_ENABLED" | "DASHBOARD_APPROVERS">,
  scope: CollaborationScope,
  roomId: string,
  intentId: string,
  deps: SlackRoomOutboxDeps = {},
): Promise<SlackRoomOutboxResult> {
  if (env.SLACK_ROOM_OUTBOX_ENABLED?.trim() !== "true") return { status: "disabled" };
  const token = env.SLACK_BOT_TOKEN?.trim();
  const approvalsChannel = env.SLACK_APPROVALS_CHANNEL?.trim();
  if (!token || !approvalsChannel) return { status: "disabled" };

  const intent = await claimCollaborationSlackDeliveryIntent(env, scope, roomId, intentId);
  if (!intent) return { status: "not_ready" };
  if (
    intent.status !== "pending" || intent.deliveryStatus !== "sending" ||
    intent.channelId !== approvalsChannel || !intent.content ||
    await contentHash(intent.content) !== intent.contentHash ||
    !intent.approvedByUserId || !isApprover(intent.approvedByUserId, parseApproverAllowlist(env.DASHBOARD_APPROVERS))
  ) {
    await finishCollaborationSlackDeliveryIntent(env, scope, {
      intentId,
      roomId,
      status: "blocked",
      detail: "Intent configuration or content binding no longer matches.",
    });
    return { status: "blocked" };
  }

  let installation: { teamId: string; userId: string; botId: string };
  try {
    installation = await (deps.verifyInstallation ?? verifySlackBotInstallation)(token);
  } catch (error) {
    await finishCollaborationSlackDeliveryIntent(env, scope, {
      intentId, roomId, status: "blocked",
      detail: error instanceof Error ? error.message : "Slack installation verification failed.",
    });
    return { status: "blocked" };
  }
  if (installation.teamId !== intent.teamId || !installation.userId || !installation.botId) {
    await finishCollaborationSlackDeliveryIntent(env, scope, {
      intentId, roomId, status: "blocked", detail: "Bot token workspace does not match the linked Slack thread.",
    });
    return { status: "blocked" };
  }

  // Recheck the exact room link, message author, content, and revocation fence immediately before Slack I/O.
  if (
    !isApprover(intent.approvedByUserId, parseApproverAllowlist(env.DASHBOARD_APPROVERS)) ||
    !(await isCollaborationSlackDeliverySendable(env, scope, roomId, intentId))
  ) {
    await finishCollaborationSlackDeliveryIntent(env, scope, {
      intentId, roomId, status: "blocked", detail: "The Slack room link or source message is no longer active.",
    });
    return { status: "blocked" };
  }

  try {
    const receipt = await (deps.postMessage ?? postSlackMessageWithReceipt)(token, {
      channel: intent.channelId,
      threadTs: intent.threadTs,
      text: intent.content,
      clientMsgId: await stableClientMsgId(intent.intentId),
    });
    if (receipt.channel !== intent.channelId || !receipt.ts) {
      await finishCollaborationSlackDeliveryIntent(env, scope, {
        intentId, roomId, status: "unknown", detail: "Slack returned a receipt that did not match the approved destination.",
      });
      return { status: "unknown" };
    }
    const persisted = await finishCollaborationSlackDeliveryIntent(env, scope, {
      intentId, roomId, status: "sent", receiptTs: receipt.ts,
    });
    if (!persisted) {
      await finishCollaborationSlackDeliveryIntent(env, scope, {
        intentId, roomId, status: "unknown",
        detail: "Slack returned a receipt, but it could not be durably recorded.",
      });
      return { status: "unknown" };
    }
    return { status: "sent", channel: receipt.channel, ts: receipt.ts };
  } catch (error) {
    const knownRejected = error instanceof SlackPostRejectedError && error.outcomeKnown;
    await finishCollaborationSlackDeliveryIntent(env, scope, {
      intentId,
      roomId,
      status: knownRejected ? "failed" : "unknown",
      detail: error instanceof Error ? error.message : "Slack delivery outcome is unknown.",
    });
    return { status: knownRejected ? "failed" : "unknown" };
  }
}
