/** Queued follow-up messages for active threads (delivery=queue). */
import type { AgentTokensEnv } from "./agent-tokens.js";
import { randomHex } from "./mailbox-store.js";
import type { ThreadQueue, ThreadQueueMessage } from "./ports/thread-queue/index.js";
import { threadQueueFor, type ThreadQueueEnv } from "./ports/thread-queue/registry.js";

export type QueuedThreadMessage = ThreadQueueMessage;
type QueueEnv = AgentTokensEnv & ThreadQueueEnv;
type QueueResolver = (env: ThreadQueueEnv, threadKey: string) => ThreadQueue;

/** Import before deleting; retries preserve IDs even after acknowledgment. */
async function migratedQueue(env: QueueEnv, threadId: string, resolve: QueueResolver): Promise<ThreadQueue> {
  const queue = resolve(env, threadId);
  const key = `msgq_${threadId}`;
  const raw = await env.AGENT_TOKENS.get(key, { type: "text" });
  if (raw !== null) {
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error("Invalid legacy thread queue");
    for (const item of items) {
      if (!item || typeof item.id !== "string" || item.threadId !== threadId || typeof item.text !== "string"
        || !Number.isFinite(item.createdAt) || (item.clientKey !== undefined && typeof item.clientKey !== "string")) {
        throw new Error("Invalid legacy thread message");
      }
      await queue.enqueue(threadId, item as ThreadQueueMessage);
    }
    await env.AGENT_TOKENS.delete(key);
  }
  return queue;
}

export async function listQueuedMessages(env: QueueEnv, threadId: string, resolve: QueueResolver = threadQueueFor): Promise<QueuedThreadMessage[]> {
  return (await migratedQueue(env, threadId, resolve)).drain(threadId, Number.MAX_SAFE_INTEGER);
}

export async function enqueueThreadMessage(env: QueueEnv, threadId: string, text: string, clientKey?: string, resolve: QueueResolver = threadQueueFor) {
  const queue = await migratedQueue(env, threadId, resolve);
  return queue.enqueue(threadId, { id: `msg_${randomHex(8)}`, threadId, text,
    ...(clientKey ? { clientKey } : {}), createdAt: Date.now() });
}

export async function removeQueuedMessage(env: QueueEnv, threadId: string, messageId: string, resolve: QueueResolver = threadQueueFor): Promise<QueuedThreadMessage | null> {
  const queue = await migratedQueue(env, threadId, resolve);
  const removed = (await queue.drain(threadId, Number.MAX_SAFE_INTEGER)).find(item => item.id === messageId);
  if (!removed) return null;
  return (await queue.ack([removed.id])).includes(removed.id) ? removed : null;
}

export async function releaseQueuedMessage(env: QueueEnv, threadId: string, messageId: string, resolve: QueueResolver = threadQueueFor): Promise<void> {
  await (await migratedQueue(env, threadId, resolve)).release(messageId);
}
