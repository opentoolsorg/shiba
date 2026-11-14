/**
 * WS07 ingestion consumer — registers on WS01 queue names via `dispatchQueueBatch`.
 */
import { registerQueueHandler, type QueuePayload } from "../platform/queues.js";
import type { Env } from "../env.js";
import { parseIngestMessage, runIngestionJob } from "./knowledge-ingestion.js";

const INGEST_QUEUE_NAMES = ["shiba-ingest", "shiba-ingest-dogfood"] as const;

async function handleIngestMessage(message: Message<unknown>, env: Env): Promise<void> {
  const wrapped = message.body as Partial<QueuePayload>;
  const body = wrapped?.kind === "INGEST_QUEUE" && wrapped.v === 1 ? wrapped.body : message.body;
  const ingest = parseIngestMessage(body);
  if (!ingest) return;
  await runIngestionJob(env, ingest);
}

for (const queueName of INGEST_QUEUE_NAMES) {
  registerQueueHandler(queueName, async (message, env) => {
    await handleIngestMessage(message, env);
  });
}