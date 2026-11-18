// eslint-disable-next-line no-restricted-imports -- This queue port is inside the same backend app.
import type { ThreadQueue, ThreadQueueMessage } from "../../../ports/thread-queue/index.js";

type Row = { id: string; thread_key: string; text: string; client_key: string | null; created_at: number };
function message(row: Row): ThreadQueueMessage {
  return { id: row.id, threadId: row.thread_key, text: row.text, createdAt: row.created_at,
    ...(row.client_key === null ? {} : { clientKey: row.client_key }) };
}

export class D1ThreadQueue implements ThreadQueue {
  constructor(private readonly db: D1Database) {}

  async enqueue(threadKey: string, item: ThreadQueueMessage) {
    if (item.threadId !== threadKey) throw new Error("Thread queue scope mismatch");
    const result = await this.db.prepare(`INSERT INTO thread_queue (id, thread_key, text, client_key, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .bind(item.id, threadKey, item.text, item.clientKey ?? null, item.createdAt).run();
    if (!result.success) throw new Error("Thread queue write failed");
    const prior = await this.db.prepare(`SELECT id, thread_key, text, client_key, created_at FROM thread_queue
      WHERE thread_key = ? AND (id = ? OR (client_key IS NOT NULL AND client_key = ?)) ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, sequence LIMIT 1`)
      .bind(threadKey, item.id, item.clientKey ?? null, item.id).first<Row>();
    if (!prior) throw new Error("Thread queue write unavailable");
    return { message: message(prior), deduped: result.meta.changes === 0 };
  }

  async drain(threadKey: string, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid thread queue limit");
    const rows = await this.db.prepare(`SELECT id, thread_key, text, client_key, created_at FROM thread_queue
      WHERE thread_key = ? AND acknowledged = 0 ORDER BY sequence LIMIT ?`).bind(threadKey, limit).all<Row>();
    if (!rows.success) throw new Error("Thread queue read failed");
    return rows.results.map(message);
  }

  async ack(ids: string[]) {
    const claimed: string[] = [];
    // Bound statement variables and keep each acknowledgment independently retryable.
    for (const id of ids) {
      const result = await this.db.prepare("UPDATE thread_queue SET acknowledged = 1 WHERE id = ? AND acknowledged = 0").bind(id).run();
      if (!result.success) throw new Error("Thread queue acknowledgment failed");
      if (result.meta.changes > 0) claimed.push(id);
    }
    return claimed;
  }

  async release(id: string) {
    const result = await this.db.prepare("UPDATE thread_queue SET acknowledged = 0 WHERE id = ? AND acknowledged = 1").bind(id).run();
    if (!result.success) throw new Error("Thread queue release failed");
  }
}
