import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { deliverEmailOutboxMessage } from "../src/email/delivery.js";
import { enqueueTransactionalEmail, recordEmailDeliveryFailure } from "../src/email/outbox.js";

const migration = readFileSync(new URL("../migrations/0040_email_outbox.sql", import.meta.url), "utf8");
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec(migration);
  const value = (item: unknown): never => (typeof item === "boolean" ? Number(item) : item ?? null) as never;
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...args: unknown[]) => statement(sql, args),
    async all() { return { results: sqlite.prepare(sql).all(...values.map(value)), meta: {} }; },
    async run() { return this.all(); },
    async first() { return sqlite.prepare(sql).get(...values.map(value)) ?? null; },
  });
  const database = { prepare: (sql: string) => statement(sql), exec: (sql: string) => sqlite.exec(sql),
    batch: async (items: ReturnType<typeof statement>[]) => Promise.all(items.map((item) => item.all())) } as unknown as D1Database;
  const send = vi.fn(async () => ({}));
  const env = {
    AGENT_AUDIT: database,
    BETTER_AUTH_URL: "https://mail.example.test",
    BETTER_AUTH_VERIFICATION_FROM: "auth@example.test",
    SEND_EMAIL: { send },
  } as unknown as Env;
  return { sqlite, env, send };
}

describe("email outbox", () => {
  it("enqueues and delivers through SEND_EMAIL", async () => {
    const f = fixture();
    const outboxId = await enqueueTransactionalEmail(f.env, {
      kind: "password_reset",
      to: "user@example.test",
      meta: { url: "https://mail.example.test/auth/reset?token=abc" },
    });
    expect(outboxId).toMatch(/^eml_/);
    expect(f.send).toHaveBeenCalledTimes(1);
    const row = f.sqlite.prepare("SELECT status FROM email_outbox WHERE outbox_id = ?").get(outboxId) as { status: string };
    expect(row.status).toBe("sent");
  });

  it("retries with backoff then dead-letters and suppresses", async () => {
    const f = fixture();
    const outboxId = await enqueueTransactionalEmail(f.env, {
      kind: "verification",
      to: "retry@example.test",
      meta: { url: "https://mail.example.test/api/auth/verify-email?token=abc" },
    });
    f.send.mockClear();
    for (let attempt = 0; attempt < 5; attempt++) {
      f.send.mockRejectedValueOnce(new Error(`fail-${attempt}`));
      expect(await recordEmailDeliveryFailure(f.env, outboxId!, `fail-${attempt}`)).toBe(attempt < 4 ? "retry" : "dead");
    }
    expect(f.sqlite.prepare("SELECT status FROM email_outbox WHERE outbox_id = ?").get(outboxId)?.status).toBe("dead");
    expect(f.sqlite.prepare("SELECT reason FROM email_suppressions WHERE to_address = ?").get("retry@example.test")?.reason).toBe("delivery_exhausted");
  });

  it("records failure when sender is not configured", async () => {
    const f = fixture();
    delete (f.env as { SEND_EMAIL?: unknown }).SEND_EMAIL;
    const outboxId = await enqueueTransactionalEmail(f.env, {
      kind: "verification",
      to: "nobody@example.test",
      meta: { url: "https://mail.example.test/api/auth/verify-email" },
    });
    expect(f.sqlite.prepare("SELECT status FROM email_outbox WHERE outbox_id = ?").get(outboxId)?.status).toBe("failed");
  });
});