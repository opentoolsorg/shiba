import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { startJournalWorkerFixture, waitFor } from "./worker-journal-fixture.mjs";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const sourceText = (page, stream = "stdout") => page.frames.filter((frame) => frame.stream === stream).map((frame) => Buffer.from(frame.dataBase64, "base64").toString("utf8")).join("");
const archiveText = (page, stream = "stdout") => page.events.filter((frame) => frame.event.stream === stream).map((frame) => frame.event.data).join("");
async function readPages(fixture, first = undefined) {
  const pages = [first ?? (await fixture.api("/archive")).body];
  while (pages.at(-1).hasMore) {
    const previous = pages.at(-1);
    const response = await fixture.api(`/archive?after=${previous.nextCursor}`);
    assert.equal(response.status, 200);
    const page = response.body;
    assert.equal(page.after, previous.nextCursor);
    assert.equal(page.previousChainDigest, previous.events.at(-1).chainDigest);
    pages.push(page);
  }
  const events = pages.flatMap((page) => page.events);
  assert.deepEqual(events.map((event) => event.ordinal), events.map((_, index) => index + 1));
  assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
  assert.equal(events.at(-1)?.chainDigest, pages.at(-1).chainDigest);
  return { ...pages[0], events, pages: pages.length };
}
test("actual workerd replacement archive retains committed sanitized prefix and never STARTs again", { timeout: 120_000, skip: process.platform !== "linux" && "Fixed journal fixture requires Linux identity" }, async (context) => {
  const files = ["./worker-archive-replacement-entry.ts", "./worker-journal-fixture.mjs", "../../src/run-output-archive.ts", "../../src/run-output-archive-admission.ts", "../../src/run-output-archive-reservations.ts", "../../src/run-output-archive-store.ts", "../../src/conversation-room-do.ts", "../../src/run-journal-publisher.ts", "../../src/sandbox/execution-journal.ts"];
  const sourceHashes = async () => Object.fromEntries(await Promise.all(files.map(async (file) => [file, digest(await readFile(new URL(file, import.meta.url)))])));
  const sourceAtStart = await sourceHashes();
  const fixture = await startJournalWorkerFixture({ purpose: "replacement-archive" });
  try {
    const db = await fixture.database();
    const migration = await readFile(new URL("../../migrations/0022_run_output_archives.sql", import.meta.url), "utf8");
    const statements = migration.replace(/^--.*$/gm, "").split(";").map((item) => item.trim()).filter(Boolean);
    await db.batch(statements.map((sql) => db.prepare(sql)));
    await db.prepare('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT,emailVerified INTEGER)').run();
    await db.prepare("CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT,kind TEXT)").run();
    await db.prepare('INSERT INTO "user" VALUES(?,?,1)').bind("native-archive-fixture", "journal-fixture@example.test").run();
    await db.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?,'bootstrap')").bind("native-archive-fixture", "journal-fixture@example.test").run();
    assert.equal((await fixture.api("/network-probe")).body.status, 502);
    await fixture.start(); const identity = await fixture.sourceIdentity();
    assert.equal((await fixture.api("/setup", { digest: identity.digest, commandIdentity: digest(fixture.input.command), deadline: fixture.input.deadline })).status, 200);
    const first = await waitFor(fixture.read, (page) => sourceText(page).includes("prefix\n") && sourceText(page, "stderr").includes("stderr-prefix\n"));
    const socket = await fixture.socket();
    assert.equal((await fixture.api("/publish", { frames: first.frames, loseAck: true })).status, 503);
    const committed = (await fixture.api("/archive")).body;
    assert(committed.acknowledgedThrough > 0); assert(committed.eventCount > 0);
    await fixture.restart(); assert(fixture.sourceAlive()); assert.equal(await fixture.launches(), 1);
    const recovered = (await fixture.api("/archive")).body;
    assert.equal(recovered.acknowledgedThrough, committed.acknowledgedThrough);
    await fixture.release(1); await fixture.phaseReady(2);
    const middle = await waitFor(fixture.read, (page) => {
      const stdout = Buffer.concat(page.frames.filter((frame) => frame.stream === "stdout").map((frame) => Buffer.from(frame.dataBase64, "base64"))).toString("utf8");
      return stdout.includes("fixture-secret-value\n🙂\n");
    });
    assert.equal((await fixture.api("/publish", { frames: middle.frames })).status, 200);
    const beforeLoss = await readPages(fixture);
    const expected = `prefix\n${Array.from({ length: 36 }, (_, i) => `page-line-${i}-${"x".repeat(3990)}\n`).join("")}[fixture-redacted]\n🙂\n`;
    assert(beforeLoss.pages > 1, "actual source output crosses an archive page boundary");
    assert.equal(digest(archiveText(beforeLoss)), digest(expected));
    assert.equal(archiveText(beforeLoss, "stderr"), "stderr-prefix\n");
    assert.equal(beforeLoss.acknowledgedThrough, middle.cursor);
    assert(!JSON.stringify(beforeLoss).includes("fixture-secret"));
    await fixture.release(2);
    const unacknowledged = await waitFor(fixture.read, (page) => sourceText(page).includes("unacknowledged-tail\n"));
    assert(unacknowledged.cursor > beforeLoss.acknowledgedThrough);
    await fixture.destroySource(); assert.equal(fixture.sourceAlive(), false); assert.equal(await fixture.launches(), 1);
    assert.equal((await fixture.api("/replace", {})).status, 200); await fixture.restart();
    const firstRetainedPage = (await fixture.api("/archive")).body;
    assert.equal(firstRetainedPage.hasMore, true);
    await fixture.restart();
    const retained = await readPages(fixture, firstRetainedPage);
    assert.equal(retained.state, "incomplete"); assert.equal(retained.incompleteTail, true); assert.equal(retained.tailUpperBound, null);
    assert.equal(retained.acknowledgedThrough, beforeLoss.acknowledgedThrough); assert.equal(retained.chainDigest, beforeLoss.chainDigest);
    assert.equal(digest(archiveText(retained)), digest(expected)); assert(!JSON.stringify(retained).includes("unacknowledged-tail"));
    assert.equal((await fixture.api("/publish", { frames: unacknowledged.frames })).status, 409);
    assert.equal((await fixture.api("/stats")).body.starts, 0); assert.equal(await fixture.launches(), 1);
    const freshSocket = await fixture.socket(), replay = await freshSocket.replay(0);
    const wire = replay.filter((frame) => frame.type === "run:event").map((frame) => frame.event.data ?? "").join("");
    assert(!wire.includes("fixture-secret")); assert(!wire.includes("unacknowledged-tail"));
    assert.equal((await fixture.api("/revoke", {})).status, 200); assert.equal((await fixture.api("/archive")).status, 409);
    assert.deepEqual(fixture.trace.deniedNetwork, ["https://example.invalid"]);
    assert.deepEqual(await sourceHashes(), sourceAtStart, "Executed recovery sources stayed frozen through the runtime drill");
    context.diagnostic(JSON.stringify({ sourceAtStart, kind: "actual-local-workerd-replacement-archive", runtimes: fixture.trace.workerStarts, sqliteAndD1: true, actualTcpWebSocket: true,
      sourceLaunches: await fixture.launches(), replacementStarts: 0, committedSourceFrontier: retained.acknowledgedThrough, emittedButUnacknowledgedFrontier: unacknowledged.cursor,
      tailUnknown: true, archivePages: retained.pages, pagedContinuationAfterRestart: true, stdoutSha256: digest(expected), revokedReadDenied: true, externalRequests: 0,
      boundary: "Actual workerd/SQLite/D1/TCP and production Node journal; native Container epoch/claim RPC fixture. No Container, provider, model or coding CLI." }));
    socket.client.close();
  } finally { await fixture.stop(); }
});
