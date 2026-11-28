/**
 * Chat-lane wire shapes: one conversation is one CodingOrchestrator
 * conversation named `{platform}:{id}` — Telegram group, Discord channel,
 * or a dashboard web session. Only the naming/parse helpers live here;
 * the bot-API plumbing stays in the backend.
 */

export type ChatPlatform = "telegram" | "discord" | "teams" | "web";

// Telegram group chat ids are negative; Discord ids are numeric snowflakes.
const CONVERSATION_ID = /^-?\d{1,24}$/;
const TELEGRAM_CONVERSATION_ID = /^(-?\d{1,24})(?::([1-9]\d{0,15}))?$/;
// Web conversation ids are opaque but bounded: letters, digits, dash, and
// underscore only, so a name can never smuggle a second colon.
const WEB_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Teams conversation ids look like `19:abc@thread.tacv2;messageid=1` or `a:1xyz`.
const TEAMS_CONVERSATION_ID = /^[A-Za-z0-9:@._;=-]{1,256}$/;
const THREAD_NAME = /^(telegram|discord|teams|web):(.+)$/;
const DECISION_DATA = /^(approve|reject):([a-z0-9][a-z0-9:_-]{0,119})$/;
const COMPACT_DECISION_DATA = /^(a|r):([a-z0-9][a-z0-9:_-]{0,119})$/;
const EMPLOYEE_DECISION_DATA = /^(emp-approve|emp-reject):(eap-[0-9a-f]{32})$/;

function isValidConversationId(platform: ChatPlatform, id: string): boolean {
  if (platform === "web") return WEB_CONVERSATION_ID.test(id);
  if (platform === "teams") return TEAMS_CONVERSATION_ID.test(id);
  if (platform === "telegram") return TELEGRAM_CONVERSATION_ID.test(id);
  return CONVERSATION_ID.test(id);
}

export function buildChatThreadName(platform: ChatPlatform, conversationId: string): string {
  const id = conversationId.trim();
  if (!isValidConversationId(platform, id)) {
    throw new Error(`Cannot name a ${platform} conversation: id "${id}" is malformed.`);
  }
  return `${platform}:${id}`;
}

export function parseChatThreadName(name: string): { platform: ChatPlatform; conversationId: string; topicId?: string } | null {
  const match = THREAD_NAME.exec(name);
  if (!match) return null;
  const platform = match[1] as ChatPlatform;
  const conversationId = match[2]!;
  if (!isValidConversationId(platform, conversationId)) return null;
  if (platform === "telegram") {
    const [, chatId, topicId] = TELEGRAM_CONVERSATION_ID.exec(conversationId)!;
    return { platform, conversationId: chatId!, ...(topicId ? { topicId } : {}) };
  }
  return { platform, conversationId };
}

export interface ChatTaskRequest {
  repoUrl: string;
  task: string;
}

export interface ChatDecision {
  approved: boolean;
  approvalId: string;
}

/**
 * Button payload: a bounded pointer, not a capability. The legacy spelling
 * remains the default for surfaces with larger action payloads.
 */
export function buildDecisionData(approved: boolean, approvalId: string): string {
  return `${approved ? "approve" : "reject"}:${approvalId}`;
}

/**
 * Compact spelling for Telegram's 64-byte callback_data budget. It carries
 * the same exact approval pointer; parsing accepts both spellings so cards
 * posted before a deploy remain decidable while they are still pending.
 */
export function buildCompactDecisionData(approved: boolean, approvalId: string): string {
  return `${approved ? "a" : "r"}:${approvalId}`;
}

export function parseDecisionData(value: string): ChatDecision | null {
  const match = DECISION_DATA.exec(value);
  if (match) return { approved: match[1] === "approve", approvalId: match[2]! };
  const compact = COMPACT_DECISION_DATA.exec(value);
  if (!compact) return null;
  return { approved: compact[1] === "a", approvalId: compact[2]! };
}

/** Discord/Telegram button payload for employee-tool exact-payload approvals. */
export function buildEmployeeDecisionData(approved: boolean, approvalId: string): string {
  return `${approved ? "emp-approve" : "emp-reject"}:${approvalId}`;
}

export function parseEmployeeDecisionData(value: string): ChatDecision | null {
  const match = EMPLOYEE_DECISION_DATA.exec(value);
  if (!match) return null;
  return { approved: match[1] === "emp-approve", approvalId: match[2]! };
}
