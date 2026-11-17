import { describe, expect, it } from "vitest";
import type { ThreadQueue, ThreadQueueMessage } from "./index.js";

/** Register the same guarantees for each adapter using isolated storage per case. */
export function threadQueueContract(name: string, create: () => ThreadQueue) {
  const msg = (id: string, threadId = "thread"): ThreadQueueMessage => ({ id, threadId, text: id, createdAt: 1 });
  describe(`${name} thread queue contract`, () => {
    it("keeps 50 concurrent enqueues in acceptance order on one thread", async () => {
      const queue = create();
      const items = Array.from({ length: 50 }, (_, i) => msg(`msg-${i}`));
      await Promise.all(items.map(item => queue.enqueue("thread", item)));
      expect(await queue.drain("thread", 50)).toEqual(items);
      expect(await queue.drain("thread", 2)).toEqual(items.slice(0, 2));
      expect(await queue.drain("other", 50)).toEqual([]);
    });
    it("deduplicates concurrent message IDs and client keys, including after ack", async () => {
      const queue = create();
      const item = { ...msg("first"), clientKey: "request" };
      const results = await Promise.all(Array.from({ length: 10 }, () => queue.enqueue("thread", item)));
      expect(results.filter(result => !result.deduped)).toHaveLength(1);
      expect(await queue.enqueue("thread", { ...item, id: "retry", text: "changed" })).toEqual({ message: item, deduped: true });
      await queue.ack([item.id]);
      await queue.ack([item.id, "missing"]);
      expect(await queue.enqueue("thread", item)).toEqual({ message: item, deduped: true });
      expect(await queue.drain("thread", 50)).toEqual([]);
      await queue.enqueue("other", { ...item, id: "other", threadId: "other" });
      expect(await queue.drain("other", 50)).toHaveLength(1);
    });
    it("prioritizes an existing message ID over a conflicting client key", async () => {
      const queue = create();
      const older = { ...msg("older"), clientKey: "older-key" };
      const newer = { ...msg("newer"), clientKey: "newer-key" };
      await queue.enqueue("thread", older);
      await queue.enqueue("thread", newer);
      expect(await queue.enqueue("thread", { ...newer, clientKey: older.clientKey })).toEqual({ message: newer, deduped: true });
    });
    it("retains unacknowledged items and rejects mismatched thread scope", async () => {
      const queue = create();
      await queue.enqueue("thread", msg("a"));
      await queue.enqueue("thread", msg("b"));
      await queue.ack(["a"]);
      expect(await queue.drain("thread", 10)).toEqual([msg("b")]);
      expect(await queue.drain("thread", 10)).toEqual([msg("b")]);
      await expect(queue.enqueue("other", msg("bad"))).rejects.toThrow();
    });
  });
}
