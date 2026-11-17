/**
 * Production queue consumers (email, ingest, outbound webhooks). Loaded on the
 * first `dispatchQueueBatch` so Worker cold start does not evaluate their graphs.
 */
let registered = false;
let registerPromise: Promise<void> | undefined;

export function ensureQueueConsumersRegistered(): Promise<void> {
  if (registered) return Promise.resolve();
  registerPromise ??= (async () => {
    await import("../email/delivery.js");
    await import("../knowledge/knowledge-ingest-queue.js");
    const { registerWebhookQueueConsumers } = await import("../webhooks/consumer.js");
    registerWebhookQueueConsumers();
    registered = true;
  })();
  return registerPromise;
}

/** Test seam: reset lazy registration between cases. */
export function resetQueueConsumersRegistrationForTests(): void {
  registered = false;
  registerPromise = undefined;
}