// Existing archive fixture scaffolding; tests exercise production seals, reservations, publisher and room DO.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newRunOutputArchivePolicy, runInputHash } from "@shiba/shared";
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

describe("independent archive security v3", () => {
  it("admits only one of competing final room slots and retains revoked capacity", async () => {
    const f = await fixture(), first = f.auth.reservation;
    const clone = (n: number) => ({ ...first, id: String(n).repeat(64), jobId: String(n).repeat(64) });
    const results = await Promise.allSettled([reserveRunOutputArchive(f.env, clone(2)), reserveRunOutputArchive(f.env, clone(3))]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    await revokeRoomOutputArchives(f.env, OWNER, "default");
    await expect(reserveRunOutputArchive(f.env, clone(4))).rejects.toThrow();
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_output_archive_reservations").get()).toEqual({ n: 2 });
    expect(f.start).not.toHaveBeenCalled();
  });
  it.each(["jobId", "epoch", "digest"])("cannot transplant signed source %s into an archive append", async (field) => {
    const f = await fixture(), publisher = await f.publisher(); await publisher.accept(f.frame(1, "committed\n"));
    const proof = await bindArchiveSource(f.env, f.auth);
    const forged = { ...proof, [field]: field === "epoch" ? "22222222-2222-4222-8222-222222222222" : "b".repeat(64) };
    await expect(f.room().appendRunJournalBatch(f.identity, { ...f.journal, archiveSource: forged, sourceSequence: 2, acknowledgedThrough: 2, events: [] })).rejects.toThrow();
    expect((await f.read()).acknowledgedThrough).toBe(1); expect(f.start).not.toHaveBeenCalled();
  });
  it("valid old-epoch seal after replacement cannot advance ACK or launch a source", async () => {
    const f = await fixture(), publisher = await f.publisher(); await publisher.accept(f.frame(1, "retained\n"));
    const proof = await bindArchiveSource(f.env, f.auth); f.source.currentEpoch = null; f.restart();
    await expect(f.room().appendRunJournalBatch(f.identity, { ...f.journal, archiveSource: proof, sourceSequence: 2, acknowledgedThrough: 2, events: [] })).rejects.toThrow();
    expect(await f.read()).toMatchObject({ acknowledgedThrough: 1, incompleteTail: true, state: "incomplete" });
    expect(f.start).not.toHaveBeenCalled();
  });
});
