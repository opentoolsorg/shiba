export interface ThreadQueueMessage {
  id: string;
  threadId: string;
  text: string;
  clientKey?: string;
  createdAt: number;
}

export interface ThreadQueue {
  /** First accepted content wins for a message ID or a thread's client key. */
  enqueue(threadKey: string, message: ThreadQueueMessage): Promise<{ message: ThreadQueueMessage; deduped: boolean }>;
  /** Non-destructive read in acceptance order. Unacked messages can be retried. */
  drain(threadKey: string, limit: number): Promise<ThreadQueueMessage[]>;
  /** Returns only IDs transitioned by this call; acknowledged IDs remain reserved. */
  ack(ids: string[]): Promise<string[]>;
  /** Return a claimed message to the pending queue after failed delivery. */
  release(id: string): Promise<void>;
}
