/**
 * Typed queue dispatch surface for WS07/WS09/WS02. Handlers register by queue
 * binding name; unknown messages are logged and acked so deploys stay safe.
 */
import type { Env } from "../env.js";

export type QueueKind = "INGEST_QUEUE" | "WEBHOOK_QUEUE" | "EMAIL_QUEUE";

export type QueuePayload = {
  kind: QueueKind;
  v: 1;
  body: Record<string, unknown>;
};

export type QueueHandler = (
  message: Message<unknown>,
  env: Env,
  ctx: ExecutionContext,
) => Promise<void>;

const handlersByQueue: Record<string, QueueHandler[]> = {};

/** Other workstreams append handlers here (append-only registry). */
export function registerQueueHandler(queueName: string, handler: QueueHandler): void {
  const list = handlersByQueue[queueName] ?? [];
  list.push(handler);
  handlersByQueue[queueName] = list;
}

export async function enqueue(kind: QueueKind, payload: Record<string, unknown>, env: Env): Promise<void> {
  const binding = env[kind];
  if (!binding || typeof binding !== "object" || !("send" in binding)) {
    throw new Error(`Queue binding ${kind} is not configured on this deployment.`);
  }
  const queue = binding as Queue<QueuePayload>;
  await queue.send({ kind, v: 1, body: payload });
}

export async function dispatchQueueBatch(
  batch: MessageBatch<unknown>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const queueName = batch.queue;
  const handlers = handlersByQueue[queueName] ?? [];
  if (handlers.length === 0) {
    console.log(`queue ${queueName}: no handlers registered (${batch.messages.length} message(s) acked)`);
    for (const message of batch.messages) message.ack();
    return;
  }
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        for (const handler of handlers) await handler(message, env, ctx);
        message.ack();
      } catch (error) {
        console.error(`queue ${queueName} handler failed: ${error instanceof Error ? error.message : String(error)}`);
        message.retry();
      }
    }),
  );
}