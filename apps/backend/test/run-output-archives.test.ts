import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newRunOutputArchivePolicy, runInputHash, createPendingApproval } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { sealChildDispatch } from "../src/child-dispatch.js";
import type { CodingTaskInput } from "../src/opencode-input.js";
import type { PreparedRuntimeExecution } from "../src/runtime-recovery.js";
import { bindArchiveSource, type ArchiveSource } from "../src/run-output-archive.js";
import { prepareRunOutputArchive } from "../src/run-output-archive-admission.js";
import { reserveRunOutputArchive, revokeRoomOutputArchives } from "../src/run-output-archive-reservations.js";
import { ConversationRoom } from "../src/conversation-room-do.js";
import { createRunJournalPublisher } from "../src/run-journal-publisher.js";
import { handleRunOutputArchives } from "../src/run-output-archive-routes.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { fakeSqlStorage } from "./fixtures/do-sql-storage.js";
const session = vi.hoisted(() => ({ available: true, id: "native-owner", email: "owner@example.test" }));
vi.mock("@shiba/auth/better-auth", async (original) => ({ ...await original<typeof import("@shiba/auth/better-auth")>(),
  resolveBetterAuthSessionAccount: async () => session.available ? { policy: { accountId: session.id, email: session.email, kind: "bootstrap" }, emailVerified: true, sessionId: "native-fixture-session", sessionExpiresAt: Date.now() + 86_400_000 } : null,
}));
const databases: DatabaseSync[] = [];
beforeEach(() => { session.available = true; session.id = "native-owner"; session.email = "owner@example.test"; });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); });
const OWNER = "owner@example.test", EPOCH = "11111111-1111-4111-8111-111111111111";
async function fixture() {
  const d1 = customAgentD1(); databases.push(d1.sqlite);
  d1.sqlite.exec(readFileSync(new URL("../migrations/0022_run_output_archives.sql", import.meta.url), "utf8"));
  d1.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER);CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT,kind TEXT)');
  d1.sqlite.exec('CREATE TABLE "session"(id TEXT PRIMARY KEY,userId TEXT,expiresAt INTEGER)');
  d1.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(session.id, OWNER); d1.sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?,'bootstrap')").run(session.id, OWNER);
  d1.sqlite.prepare('INSERT INTO "session" VALUES(?,?,?)').run("native-fixture-session", session.id, Date.now() + 86_400_000);
  const db = new DatabaseSync(":memory:"); databases.push(db);
  const storage = { ...fakeSqlStorage(db), sql: { exec: (sql: string, ...params: unknown[]) => {
    const rows = db.prepare(sql).all(...params as never[]); return { toArray: () => rows };
  } }, setAlarm: vi.fn(async () => undefined), deleteAlarm: vi.fn(async () => undefined) };
  const ctx = { storage, getWebSockets: () => [] } as unknown as DurableObjectState;
  const source: ArchiveSource = { jobId: "a".repeat(64), digest: "d".repeat(64), epoch: EPOCH, currentEpoch: EPOCH, deadline: Date.now() + 60_000, state: "running" };
  let afterInspection: (() => void) | undefined;
  const getExecutionClaim = vi.fn(async () => { const value = { ...source }; afterInspection?.(); afterInspection = undefined; return value; });
  const start = vi.fn(() => { throw new Error("Archive recovery must never START"); });
  let room: ConversationRoom;
  const env = { INTERNAL_SIGNING_KEY: "fixture-archive-signing-key-only-1234567890", AGENT_AUDIT: d1.database,
    Sandbox: { idFromName: (id: string) => id, idFromString: (id: string) => id, get: () => ({ getExecutionClaim, startExecution: start, exec: start }) },
    ConversationRoom: { getByName: () => room },
  } as unknown as Env;
  room = new ConversationRoom(ctx, env);
  const identity = { ownerId: OWNER, sessionId: "default", runId: "agent-tool:approval-original" };
  const input: CodingTaskInput = { repoUrl: "https://github.com/fixture/repo", task: "Explicit owner task", baseBranch: "main", publishPullRequest: false,
    sandboxId: "archive-fixture", runtime: "sandbox", sandboxProvider: "cloudflare", codingModel: "fixture/model", accessAgent: OWNER, initiatorUserId: OWNER,
    outputArchive: newRunOutputArchivePolicy(Date.now(), session.id), runRoom: identity };
  Object.assign(input, await sealChildDispatch(env, { approvalId: "approval-original", sandboxId: input.sandboxId, inputHash: runInputHash(input) }, input));
  const capsule: PreparedRuntimeExecution = { version: 1, phase: "harness", provider: "cloudflare", sandboxId: input.sandboxId, harness: "opencode", workdir: "/workspace/fixture",
    approvalId: input.dispatchApprovalId!, inputHash: input.dispatchInputHash!, envelopeHash: input.dispatchEnvelopeHash!, commandIdentity: "c".repeat(64), jobId: source.jobId,
    issuedAt: input.dispatchIssuedAt!, preparedAt: Date.now(), deadline: source.deadline, recoveryDeadline: input.dispatchExpiresAt!, baseRevision: "a".repeat(40), baselineCommit: "b".repeat(40), setupCommit: null };
  const auth = await prepareRunOutputArchive(env, input, capsule), journal = { jobId: source.jobId, generation: capsule.envelopeHash, archive: auth };
  const publisher = () => createRunJournalPublisher(env, identity, journal, (text) => text.replaceAll("fixture-secret-value", "[safe]"));
  const read = (after = 0) => room.readRunOutputArchive(identity, auth.reservation.id, session.id, after);
  const frame = (sequence: number, data: string | Uint8Array, stream: "stdout" | "stderr" = "stdout") => ({ sequence, stream, dataBase64: Buffer.from(data).toString("base64") });
  const call = (suffix = "", method = "GET", headers?: Record<string, string>) => handleRunOutputArchives(new Request(`https://shiba.test/api/run-output-archives${suffix}`, { method, headers: { Origin: "https://shiba.test", ...headers } }), env).then((response) => response!);
  return { ...d1, db, ctx, env, identity, input, capsule, auth, journal, source, getExecutionClaim, start, publisher, read, frame, call,
    afterInspection: (fn: () => void) => { afterInspection = fn; }, restart: () => { room = new ConversationRoom(ctx, env); return room; }, room: () => room };
}
describe("bounded private output archive, real SQLite with a native binding fixture", () => {
  it("binds exact policy into human approval/hash and immutable dispatch, without upgrading legacy approvals", async () => {
    const f = await fixture(), before = runInputHash(f.input);
    expect(runInputHash({ ...f.input, outputArchive: { ...f.input.outputArchive!, expiresAt: f.input.outputArchive!.expiresAt - 1 } })).not.toBe(before);
    const pending = createPendingApproval([], { threadKey: OWNER, approvalId: "new", ...f.input, createdAt: Date.now() });
    expect(pending[0]!.outputArchive).toEqual(f.input.outputArchive);
    const legacy = createPendingApproval([], { threadKey: OWNER, approvalId: "old", repoUrl: f.input.repoUrl, task: "legacy", createdAt: Date.now() });
    expect(legacy[0]!.outputArchive).toBeUndefined();
    await expect(prepareRunOutputArchive(f.env, { ...f.input, outputArchive: { ...f.input.outputArchive!, ownerAccountId: "other" } }, f.capsule)).rejects.toThrow();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("recovers only the ACKed sanitized prefix after native replacement, never a replacement START", async () => {
    const f = await fixture(), p = await f.publisher(); await p.accept(f.frame(1, "prefix\n"));
    f.source.currentEpoch = "22222222-2222-4222-8222-222222222222"; f.restart();
    const page = await f.read();
    expect(page).toMatchObject({ state: "incomplete", acknowledgedThrough: 1, lastObservedSource: 1, incompleteTail: true, tailUpperBound: null });
    expect(page.events.map((item) => item.event.data).join("")).toBe("prefix\n");
    await expect(p.accept(f.frame(2, "unacknowledged tail\n"))).rejects.toThrow();
    expect((await f.read()).events).toHaveLength(1); expect(f.start).not.toHaveBeenCalled();
  });
  it("keeps committed event frontier distinct from source ACK across unfinished secrets and UTF8", async () => {
    const f = await fixture(), p = await f.publisher();
    await p.accept(f.frame(1, "fixture-secret-")); await p.accept(f.frame(2, "stderr committed\n", "stderr"));
    const page = await f.read(); expect(page.acknowledgedThrough).toBe(0); expect(page.eventCount).toBe(1);
    expect(JSON.stringify(page)).not.toContain("fixture-secret");
    await p.accept(f.frame(3, "value\n"));
    const utf8 = new TextEncoder().encode("🙂\n"); await p.accept(f.frame(4, utf8.slice(0, 2))); await p.accept(f.frame(5, utf8.slice(2)));
    const full = await f.read(); expect(full.acknowledgedThrough).toBe(5); expect(full.events.map((item) => item.event.data)).toEqual(["stderr committed\n", "[safe]\n", "🙂\n"]);
  });
  it("retains archive bytes after the independent 2048-event display cap prunes them", async () => {
    const f = await fixture(), p = await f.publisher();
    for (let i = 1; i <= 2049; i++) await p.accept(f.frame(i, `line ${i}\n`));
    expect(f.db.prepare("SELECT count(*) AS n FROM room_run_events").get()).toEqual({ n: 2048 });
    expect(f.db.prepare("SELECT count(*) AS n FROM room_output_archive_events").get()).toEqual({ n: 2049 });
    const first = await f.read(); expect(first.events[0]!.event.data).toBe("line 1\n"); expect(first.hasMore).toBe(true); expect(first.events).toHaveLength(32);
  }, 20_000);
  it("atomically rejects an over-budget append without storing bytes, receipts or advancing ACK", async () => {
    const f = await fixture(), p = await f.publisher(); await p.accept(f.frame(1, "safe\n"));
    f.db.prepare("UPDATE room_output_archives SET byte_count=?").run(f.input.outputArchive!.maxBytes - 1);
    await expect(p.accept(f.frame(2, "new data\n"))).rejects.toThrow();
    expect((await f.read()).acknowledgedThrough).toBe(1);
    expect(f.db.prepare("SELECT count(*) AS n FROM room_run_journal_receipts").get()).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT count(*) AS n FROM room_output_archive_events").get()).toEqual({ n: 1 });
  });
  it("adopts an atomically committed ACK after response loss without duplicate archive events", async () => {
    const f = await fixture(), method = f.room().appendRunJournalBatch.bind(f.room()); let lose = 2;
    vi.spyOn(f.room(), "appendRunJournalBatch").mockImplementation(async (...args) => { const result = await method(...args); if (lose-- > 0) throw new Error("committed response loss"); return result; });
    const first = await f.publisher(); await expect(first.accept(f.frame(1, "one\n"))).rejects.toThrow(); f.restart();
    const second = await f.publisher(); await second.accept(f.frame(1, "one\n")); await second.accept(f.frame(2, "two\n"));
    expect((await f.read()).events.map((item) => item.event.data)).toEqual(["one\n", "two\n"]);
  });
  it.each([
    "UPDATE room_output_archive_events SET body='{}' WHERE ordinal=1",
    "UPDATE room_output_archive_events SET event_id='changed' WHERE ordinal=1",
    "UPDATE room_output_archive_events SET room_sequence=99 WHERE ordinal=1",
    "UPDATE room_output_archive_events SET source_sequence=99 WHERE ordinal=1",
    "UPDATE room_output_archive_events SET created_at=0 WHERE ordinal=1",
    "UPDATE room_output_archive_events SET chain_digest='changed' WHERE ordinal=1",
    "DELETE FROM room_output_archive_events WHERE ordinal=1",
    "DELETE FROM room_output_archive_events WHERE ordinal=2",
    "UPDATE room_output_archives SET chain_digest='changed'",
  ])("withholds corrupted retained output after replacement: %s", async (corrupt) => {
    const f = await fixture(), p = await f.publisher();
    await p.accept(f.frame(1, "protected prefix\n")); await p.accept(f.frame(2, "protected tail\n"));
    f.db.exec(corrupt); f.source.currentEpoch = null; f.restart();
    await expect(f.read()).rejects.toThrow(/archive/i);
    const response = await f.call(`/${f.auth.reservation.id}`);
    expect(response.status).toBe(404); expect(await response.text()).not.toContain("protected");
    expect(f.db.prepare("SELECT acknowledged_through FROM room_output_archives").get()).toEqual({ acknowledged_through: 2 });
    expect(f.start).not.toHaveBeenCalled();
  });
  it("verifies multiple retained pages and the empty final cursor after replacement", async () => {
    const f = await fixture(), p = await f.publisher();
    for (let i = 1; i <= 35; i++) await p.accept(f.frame(i, `line ${i}\n`));
    f.source.currentEpoch = null; f.restart();
    const first = await f.read(), second = await f.read(first.nextCursor), final = await f.read(second.nextCursor);
    expect(first.events).toHaveLength(32); expect(second.events).toHaveLength(3);
    expect(second.previousChainDigest).toBe(first.events.at(-1)!.chainDigest);
    expect(final).toMatchObject({ events: [], hasMore: false, nextCursor: 35, acknowledgedThrough: 35, incompleteTail: true });
    f.db.exec("UPDATE room_output_archives SET chain_digest='changed'");
    await expect(f.read(35)).rejects.toThrow(/checkpoint/);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("rejects guessed epoch seals and dropping archive authority after admission", async () => {
    const f = await fixture(), p = await f.publisher(); await p.accept(f.frame(1, "one\n"));
    const proof = await bindArchiveSource(f.env, f.auth);
    await expect(f.room().appendRunJournalBatch(f.identity, { ...f.journal, archiveSource: { ...proof, epoch: "22222222-2222-4222-8222-222222222222" }, sourceSequence: 2, acknowledgedThrough: 2, events: [] })).rejects.toThrow();
    await expect(f.room().openRunJournal(f.identity, { jobId: f.journal.jobId, generation: f.journal.generation })).rejects.toThrow();
    expect((await f.read()).acknowledgedThrough).toBe(1);
  });
  it("withholds read output if native identity or explicit source authority changes during native observation", async () => {
    const f = await fixture(), p = await f.publisher(); await p.accept(f.frame(1, "protected\n"));
    f.afterInspection(() => { f.sqlite.exec("UPDATE run_output_archive_reservations SET state='revoked'"); });
    await expect(f.read()).rejects.toThrow(); expect(f.start).not.toHaveBeenCalled();
  });
  it("withholds append/ACK if native account is removed during an awaited source proof", async () => {
    const f = await fixture(), p = await f.publisher();
    f.afterInspection(() => { f.sqlite.exec("DELETE FROM shiba_auth_account_policy"); });
    await expect(p.accept(f.frame(1, "protected\n"))).rejects.toThrow();
    expect(f.db.prepare("SELECT acknowledged_through FROM room_run_journals").get()).toEqual({ acknowledged_through: 0 });
    expect(f.db.prepare("SELECT count(*) AS n FROM room_output_archive_events").get()).toEqual({ n: 0 });
  });
  it("requires an original verified completion receipt and preserves known completion after replacement", async () => {
    const f = await fixture(), p = await f.publisher(); await p.accept(f.frame(1, "claimed success text\n"));
    const proof = await bindArchiveSource(f.env, f.auth);
    await expect(f.room().completeRunOutputArchive(f.identity, f.journal, proof, 1, 0)).rejects.toThrow();
    f.source.state = "exited"; await p.end(17); f.source.currentEpoch = null; f.restart();
    expect(await f.read()).toMatchObject({ state: "complete", incompleteTail: false, tailUpperBound: 1, finalExitCode: 17 });
  });
  it("reserves owner/room capacity atomically and never refunds unknown or revoked leases", async () => {
    const f = await fixture(), first = f.auth.reservation;
    const clone = (index: number, sessionId: string) => ({ ...first, id: String(index).repeat(64), jobId: String(index).repeat(64), sessionId });
    await reserveRunOutputArchive(f.env, first); await reserveRunOutputArchive(f.env, clone(2, "default"));
    await expect(reserveRunOutputArchive(f.env, clone(3, "default"))).rejects.toThrow();
    await reserveRunOutputArchive(f.env, clone(3, "11111111-1111-4111-8111-111111111111"));
    await reserveRunOutputArchive(f.env, clone(4, "11111111-1111-4111-8111-111111111111"));
    await revokeRoomOutputArchives(f.env, OWNER, "default");
    await expect(reserveRunOutputArchive(f.env, clone(5, "22222222-2222-4222-8222-222222222222"))).rejects.toThrow();
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM run_output_archive_reservations").get()).toEqual({ n: 4 });
  });
  it("serves only current native owner pages and blocks bearer, workspace, same-email replacement and source revocation", async () => {
    const f = await fixture(), p = await f.publisher(); await p.accept(f.frame(1, "protected\n"));
    const suffix = `/${f.auth.reservation.id}`;
    expect((await f.call(suffix)).status).toBe(200);
    expect((await f.call(suffix, "GET", { Authorization: "Bearer guessed" })).status).toBe(403);
    expect((await f.call(suffix, "GET", { "X-Shiba-Workspace": "ws_" + "a".repeat(24) })).status).toBe(403);
    session.id = "replacement-native-id"; expect((await f.call(suffix)).status).toBe(404); session.id = "native-owner";
    const read = f.room().readRunOutputArchive.bind(f.room());
    vi.spyOn(f.room(), "readRunOutputArchive").mockImplementation(async (...args) => { const result = await read(...args); f.sqlite.exec("UPDATE run_output_archive_reservations SET state='revoked'"); return result; });
    const denied = await f.call(suffix); expect(denied.status).toBe(404); expect(await denied.text()).not.toContain("protected");
    expect(f.start).not.toHaveBeenCalled();
  });
  it("hides lease-expired output and rejects resurrection under an extended policy", async () => {
    const f = await fixture(), p = await f.publisher(); await p.accept(f.frame(1, "protected\n"));
    vi.useFakeTimers(); vi.setSystemTime(f.input.outputArchive!.expiresAt + 1);
    await expect(f.read()).rejects.toThrow();
    expect((await f.call(`/${f.auth.reservation.id}`)).status).toBe(404);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("does not return protected bytes when the final D1 snapshot resumes after the absolute lease", async () => {
    const f = await fixture(), p = await f.publisher(); await p.accept(f.frame(1, "protected prefix\n"));
    const prepare = f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);
    vi.useFakeTimers();
    vi.spyOn(f.env.AGENT_AUDIT, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes("json_group_array")) return statement;
      return { ...statement, bind(...values: unknown[]) {
        const bound = statement.bind(...values);
        return { ...bound, async first() {
          const captured = await bound.first(); vi.setSystemTime(f.auth.reservation.policy.expiresAt + 1); return captured;
        } } as D1PreparedStatement;
      } } as D1PreparedStatement;
    });
    const response = await f.call(`/${f.auth.reservation.id}`);
    expect(response.status).toBe(404); expect(await response.text()).not.toContain("protected prefix");
  });
  it("rechecks actual session rows after a cached directory snapshot before returning metadata", async () => {
    const f = await fixture(); const prepare = f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);
    vi.spyOn(f.env.AGENT_AUDIT, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes("SELECT r.id,r.session_id")) return statement;
      return { ...statement, bind(...values: unknown[]) {
        const bound = statement.bind(...values);
        return { ...bound, async all() { const captured = await bound.all(); f.sqlite.exec('DELETE FROM "session"'); return captured; } } as D1PreparedStatement;
      } } as D1PreparedStatement;
    });
    const response = await f.call(); expect(response.status).toBe(404); expect(await response.text()).not.toContain(f.auth.reservation.id);
  });
});
