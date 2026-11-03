import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JournalFrame } from "@shiba/sandbox";
import { ConversationRoom } from "../src/conversation-room-do.js";
import type { Env } from "../src/env.js";
import { createRunJournalPublisher } from "../src/run-journal-publisher.js";
import { MAX_RUN_JOURNAL_CHARS, MAX_RUN_JOURNAL_EVENTS, MAX_RUN_ROOM_EVENTS, RUN_ROOM_RPC_TIMEOUT_MS, type RunJournalBatch } from "../src/run-room-events.js";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function frame(sequence: number, text: string | Uint8Array, stream: "stdout" | "stderr" = "stdout"): JournalFrame {
  return { sequence, stream, dataBase64: Buffer.from(text).toString("base64") };
}

function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  const socket = {
    readyState: 1, frames: [] as Array<Record<string, unknown>>,
    deserializeAttachment: () => ({ ownerId: "owner@example.test", actorId: "owner@example.test", viewerLabel: "owner@example.test", connectionId: "12345678-1234-4123-8123-123456789012", sessionId: "default", viewerId: crypto.randomUUID(), joinedAt: 1, typing: false, typingAt: 0 }),
    send(raw: string) {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (value.type === "run:event") expect(db.prepare("SELECT sequence FROM room_run_events WHERE sequence = ?").get(Number(value.sequence))).toBeDefined();
      this.frames.push(value);
    },
    close: vi.fn(),
  };
  const ctx = { storage: {
    sql: { exec<T>(sql: string, ...values: SQLInputValue[]) {
      const rows = db.prepare(sql).all(...values);
      return { toArray: () => rows as T[] };
    } },
    transactionSync<T>(callback: () => T): T {
      db.exec("BEGIN");
      try { const result = callback(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    setAlarm: vi.fn(), deleteAlarm: vi.fn(),
  }, getWebSockets: () => [socket] } as unknown as DurableObjectState;
  const room = new ConversationRoom(ctx, {} as Env);
  const identity = { ownerId: "owner@example.test", sessionId: "default", runId: "approved-run" };
  const journal = { jobId: "a".repeat(64), generation: "b".repeat(64) };
  const env = { ConversationRoom: { getByName: () => room } } as unknown as Env;
  const events = () => db.prepare("SELECT body FROM room_run_events ORDER BY sequence").all().map((row) => JSON.parse(String(row.body)) as { kind: string; stream: string; data: string });
  return { db, room, ctx, socket, identity, journal, env, events };
}

describe("durable source journal publishing", () => {
  it("deduplicates an accepted append whose response was lost before acknowledgment", async () => {
    const f = fixture();
    const append = f.room.appendRunJournalBatch.bind(f.room);
    let lost = true;
    vi.spyOn(f.room, "appendRunJournalBatch").mockImplementation(async (...args) => {
      const ack = await append(...args);
      if (lost) { lost = false; throw new Error("accepted response lost"); }
      return ack;
    });
    const publisher = await createRunJournalPublisher(f.env, f.identity, f.journal);
    await publisher.accept(frame(1, "one\n"));
    expect(publisher.acknowledgedThrough).toBe(1);
    expect(f.events()).toEqual([{ kind: "terminal", stream: "stdout", data: "one\n" }]);
    expect(f.socket.frames).toHaveLength(1);
    expect(f.room.appendRunJournalBatch).toHaveBeenCalledTimes(2);
  });

  it("does not persist unfinished secret bytes, preserves split UTF-8, and scrubs before atomic ack", async () => {
    const f = fixture();
    const scrub = (text: string) => text.replaceAll("approved-private-secret", "[approved-env]");
    const first = await createRunJournalPublisher(f.env, f.identity, f.journal, scrub);
    await first.accept(frame(1, "approved-private-"));
    await first.accept(frame(2, "visible stderr\n", "stderr"));
    expect(first.acknowledgedThrough).toBe(0);
    expect(JSON.stringify(f.db.prepare("SELECT * FROM room_run_journal_receipts").all())).not.toContain("approved-private");
    expect(JSON.stringify(f.events())).not.toContain("approved-private");
    const restarted = new ConversationRoom(f.ctx, {} as Env);
    const env = { ConversationRoom: { getByName: () => restarted } } as unknown as Env;
    const second = await createRunJournalPublisher(env, f.identity, f.journal, scrub);
    await second.accept(frame(1, "approved-private-"));
    await second.accept(frame(2, "visible stderr\n", "stderr"));
    await second.accept(frame(3, "secret\n"));
    const emoji = new TextEncoder().encode("🙂\n");
    await second.accept(frame(4, emoji.slice(0, 2)));
    expect(second.acknowledgedThrough).toBe(3);
    await second.accept(frame(5, emoji.slice(2)));
    await second.end();
    expect(second.acknowledgedThrough).toBe(5);
    expect(f.events().map((event) => event.data)).toEqual(["visible stderr\n", "[approved-env]\n", "🙂\n"]);
    expect(f.db.prepare("SELECT acknowledged_through, event_count FROM room_run_journals").get()).toMatchObject({ acknowledged_through: 5, event_count: 3 });
  });

  it("retains replay dedup receipts after display history pruning and a source publisher eviction", async () => {
    const f = fixture(); f.socket.readyState = 3;
    const first = await createRunJournalPublisher(f.env, f.identity, f.journal);
    await first.accept(frame(1, "unfinished"));
    for (let sequence = 2; sequence <= MAX_RUN_ROOM_EVENTS + 3; sequence++) await first.accept(frame(sequence, `${sequence}\n`, "stderr"));
    expect(first.acknowledgedThrough).toBe(0);
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM room_run_events").get()).toMatchObject({ count: MAX_RUN_ROOM_EVENTS });
    const retained = f.db.prepare("SELECT sequence FROM room_run_events ORDER BY sequence").all();
    const second = await createRunJournalPublisher(f.env, f.identity, f.journal);
    await second.accept(frame(1, "unfinished"));
    for (let sequence = 2; sequence <= MAX_RUN_ROOM_EVENTS + 3; sequence++) await second.accept(frame(sequence, `${sequence}\n`, "stderr"));
    expect(f.db.prepare("SELECT sequence FROM room_run_events ORDER BY sequence").all()).toEqual(retained);
    await second.accept(frame(MAX_RUN_ROOM_EVENTS + 4, " tail\n"));
    expect(second.acknowledgedThrough).toBe(MAX_RUN_ROOM_EVENTS + 4);
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM room_run_journal_receipts").get()).toMatchObject({ count: MAX_RUN_ROOM_EVENTS + 3 });
  }, 15_000);

  it("leaves source unacknowledged after room failure and allows a fresh publisher to replay", async () => {
    const f = fixture();
    const append = vi.spyOn(f.room, "appendRunJournalBatch").mockRejectedValue(new Error("room unavailable"));
    const first = await createRunJournalPublisher(f.env, f.identity, f.journal);
    await expect(first.accept(frame(1, "retry me\n"))).rejects.toThrow("room unavailable");
    expect(first.acknowledgedThrough).toBe(0);
    expect(await f.room.openRunJournal(f.identity, f.journal)).toBe(0);
    expect(f.events()).toHaveLength(0);
    await expect(first.accept(frame(2, "must not skip\n"))).rejects.toThrow("room unavailable");
    append.mockRestore();
    const second = await createRunJournalPublisher(f.env, f.identity, f.journal);
    await second.accept(frame(1, "retry me\n"));
    expect(second.acknowledgedThrough).toBe(1);
    expect(f.events()).toHaveLength(1);
  });

  it("reconciles a crash after append but before the caller received either retry response", async () => {
    const f = fixture();
    const append = f.room.appendRunJournalBatch.bind(f.room);
    const spy = vi.spyOn(f.room, "appendRunJournalBatch").mockImplementation(async (...args) => { await append(...args); throw new Error("response lost"); });
    const first = await createRunJournalPublisher(f.env, f.identity, f.journal);
    await expect(first.accept(frame(1, "accepted once\n"))).rejects.toThrow("response lost");
    expect(first.acknowledgedThrough).toBe(0);
    spy.mockRestore();
    const second = await createRunJournalPublisher(f.env, f.identity, f.journal);
    expect(second.acknowledgedThrough).toBe(1);
    await second.accept(frame(1, "accepted once\n"));
    await second.end();
    expect(f.events()).toHaveLength(1);
    expect(f.socket.frames).toHaveLength(1);
  });

  it("rolls back event, receipt, and ack together on a durable storage failure", async () => {
    const f = fixture();
    const exec = f.ctx.storage.sql.exec.bind(f.ctx.storage.sql);
    vi.spyOn(f.ctx.storage.sql, "exec").mockImplementation((sql, ...values) => {
      if (sql.startsWith("INSERT INTO room_run_journal_receipts")) throw new Error("injected storage failure");
      return exec(sql, ...values);
    });
    const publisher = await createRunJournalPublisher(f.env, f.identity, f.journal);
    await expect(publisher.accept(frame(1, "atomic\n"))).rejects.toThrow("injected storage failure");
    expect(f.events()).toEqual([]);
    expect(await f.room.openRunJournal(f.identity, f.journal)).toBe(0);
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM room_run_journal_receipts").get()).toMatchObject({ count: 0 });
    expect(f.socket.frames).toHaveLength(0);
  });

  it("rejects changed approved generations, changed event bodies, and stale new frames", async () => {
    const f = fixture(); const publisher = await createRunJournalPublisher(f.env, f.identity, f.journal);
    await publisher.accept(frame(1, "original\n"));
    await expect(f.room.openRunJournal(f.identity, { ...f.journal, generation: "c".repeat(64) })).rejects.toThrow("generation");
    await expect(f.room.openRunJournal({ ...f.identity, runId: "other-run" }, f.journal)).rejects.toThrow("generation");
    const id = String(f.db.prepare("SELECT event_id FROM room_run_journal_receipts").get()?.event_id);
    const batch: RunJournalBatch = { ...f.journal, sourceSequence: 1, acknowledgedThrough: 1, events: [{ eventId: id, event: { kind: "terminal", stream: "stdout", data: "modified" } }] };
    await expect(f.room.appendRunJournalBatch(f.identity, batch)).rejects.toThrow("durable receipt");
    await expect(f.room.appendRunJournalBatch(f.identity, { ...batch, events: [{ ...batch.events[0]!, eventId: crypto.randomUUID() }] })).rejects.toThrow("stale");
    await f.room.webSocketMessage(f.socket as unknown as WebSocket, JSON.stringify({ type: "appendRunJournalBatch", ...batch }));
    expect(f.socket.frames.at(-1)).toMatchObject({ type: "error", error: "Unsupported room event." });
    expect(f.events()).toHaveLength(1);
  });

  it("flushes a final partial line only after source completion and safely drops oversized lines", async () => {
    const f = fixture(); const publisher = await createRunJournalPublisher(f.env, f.identity, f.journal);
    for (let sequence = 1; sequence <= 17; sequence++) await publisher.accept(frame(sequence, "x".repeat(4_096)));
    expect(publisher.acknowledgedThrough).toBe(0);
    expect(f.events()).toHaveLength(0);
    await publisher.accept(frame(18, "\nfinal secret-fragment"));
    expect(publisher.acknowledgedThrough).toBe(0);
    expect(f.events().map((event) => event.data)).toEqual(["[Output line exceeded the safety limit.]\n"]);
    await publisher.end();
    expect(publisher.acknowledgedThrough).toBe(18);
    expect(f.events().at(-1)?.data).toBe("final secret-fragment");
  });

  it("enforces durable character budget across publisher eviction rather than resetting it", async () => {
    const f = fixture();
    await f.room.openRunJournal(f.identity, f.journal);
    f.db.prepare("UPDATE room_run_journals SET character_count = ?").run(MAX_RUN_JOURNAL_CHARS - 10);
    const first = await createRunJournalPublisher(f.env, f.identity, f.journal);
    await first.accept(frame(1, "small\n"));
    const second = await createRunJournalPublisher(f.env, f.identity, f.journal, () => "expanded\n");
    await second.accept(frame(1, "small\n"));
    await expect(second.accept(frame(2, "x\n"))).rejects.toThrow("bound");
    expect(await f.room.openRunJournal(f.identity, f.journal)).toBe(1);
    expect(f.db.prepare("SELECT character_count FROM room_run_journals").get()).toMatchObject({ character_count: MAX_RUN_JOURNAL_CHARS - 4 });
    expect(f.events()).toHaveLength(1);
  });

  it("bounds hung room writes without advancing the source acknowledgment", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); const publisher = await createRunJournalPublisher(f.env, f.identity, f.journal);
      const append = vi.spyOn(f.room, "appendRunJournalBatch").mockImplementation(() => new Promise<number>(() => {}));
      const outcome = publisher.accept(frame(1, "pending\n")).then(() => "accepted", (error: Error) => error.message);
      await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(RUN_ROOM_RPC_TIMEOUT_MS * 2 + 1);
      expect(await outcome).toBe("Journal room delivery timed out.");
      expect(publisher.acknowledgedThrough).toBe(0);
      expect(append).toHaveBeenCalledTimes(2);
      expect(await f.room.openRunJournal(f.identity, f.journal)).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("enforces the raw source byte cap and the durable receipt count cap", async () => {
    const f = fixture(); const publisher = await createRunJournalPublisher(f.env, f.identity, f.journal);
    for (let sequence = 1; sequence <= 1_024; sequence++) await publisher.accept(frame(sequence, "x".repeat(4_096)));
    await expect(publisher.accept(frame(1_025, "x"))).rejects.toThrow("byte bound");
    expect(publisher.acknowledgedThrough).toBe(0);
    expect(f.events()).toHaveLength(0);
    f.db.prepare("UPDATE room_run_journals SET event_count = ?").run(MAX_RUN_JOURNAL_EVENTS);
    const resumed = await createRunJournalPublisher(f.env, f.identity, f.journal);
    await expect(resumed.accept(frame(1, "cannot grow receipts\n"))).rejects.toThrow("bound");
    expect(await f.room.openRunJournal(f.identity, f.journal)).toBe(0);
  });

  it.each([
    frame(2, "noncontiguous"), frame(1, new Uint8Array(4_097)),
    { ...frame(1, "x"), dataBase64: "non-base64" }, { ...frame(1, "x"), sequence: 4_097 },
  ])("rejects invalid or oversized raw source without an acknowledgment", async (raw) => {
    const f = fixture(); const publisher = await createRunJournalPublisher(f.env, f.identity, f.journal);
    await expect(publisher.accept(raw)).rejects.toThrow();
    expect(await f.room.openRunJournal(f.identity, f.journal)).toBe(0);
    expect(f.events()).toHaveLength(0);
  });
});
