/**
 * Queued follow-up messages for active threads (delivery=queue).
 */
import type { AgentTokensEnv } from "./agent-tokens.js";
import { randomHex } from "./mailbox-store.js";
import { redactSecrets } from "./security.js";

const PREFIX = "msgq_";

export interface QueuedThreadMessage {
  id: string;
  threadId: string;
  text: string;
  clientKey?: string;
  createdAt: number;
}

function queueKey(threadId: string): string {
  return `${PREFIX}${threadId}`;
}

export async function listQueuedMessages(
  env: AgentTokensEnv,
  threadId: string,
): Promise<QueuedThreadMessage[]> {
  try {
    const raw = await env.AGENT_TOKENS.get(queueKey(threadId), { type: "text" });
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QueuedThreadMessage[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function enqueueThreadMessage(
  env: AgentTokensEnv,
  threadId: string,
  text: string,
  clientKey?: string,
): Promise<{ message: QueuedThreadMessage; deduped: boolean }> {
  const queue = await listQueuedMessages(env, threadId);
  if (clientKey) {
    const prior = queue.find((item) => item.clientKey === clientKey);
    if (prior) return { message: prior, deduped: true };
  }
  const message: QueuedThreadMessage = {
    id: `msg_${randomHex(8)}`,
    threadId,
    text,
    ...(clientKey ? { clientKey } : {}),
    createdAt: Date.now(),
  };
  queue.push(message);
  try {
    await env.AGENT_TOKENS.put(queueKey(threadId), JSON.stringify(queue));
  } catch (error: unknown) {
    console.warn(
      `v1-message-queue: KV put failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
  }
  return { message, deduped: false };
}

export async function removeQueuedMessage(
  env: AgentTokensEnv,
  threadId: string,
  messageId: string,
): Promise<QueuedThreadMessage | null> {
  const queue = await listQueuedMessages(env, threadId);
  const index = queue.findIndex((item) => item.id === messageId);
  if (index < 0) return null;
  const [removed] = queue.splice(index, 1);
  try {
    await env.AGENT_TOKENS.put(queueKey(threadId), JSON.stringify(queue));
  } catch {
    /* deny below */
  }
  return removed ?? null;
}
