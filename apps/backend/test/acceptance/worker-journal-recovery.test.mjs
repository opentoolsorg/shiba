import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { startJournalWorkerFixture, waitFor } from "./worker-journal-fixture.mjs";

const digest = (text) => createHash("sha256").update(text).digest("hex");
const bytesFor = (frames, stream) => Buffer.concat(frames.filter((frame) => frame.stream === stream).map((frame) => Buffer.from(frame.dataBase64, "base64")));
const terminal = (frames) => frames.filter((frame) => frame.type === "run:event" && frame.event.kind === "terminal");
const textFor = (frames, stream) => terminal(frames).filter((frame) => frame.event.stream === stream).map((frame) => frame.event.data).join("");

test("actual local workerd restart retains journal acknowledgments and TCP WebSocket replay", { timeout: 120_000, skip: process.platform !== "linux" && "Production supervisor uses Linux process identity" }, async (context) => {
  const sourceFiles = ["../../src/conversation-room-do.ts", "../../src/run-journal-publisher.ts", "../../src/sandbox/execution-journal.ts", "../../../../packages/sandbox/src/adapters/cloudflare-journal.ts", "./worker-journal-fixture-entry.ts", "./worker-journal-fixture.mjs"];
  const sourceDigests = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, digest(await readFile(new URL(file, import.meta.url)))])));
  const sourceAtStart = await sourceDigests();
  const fixture = await startJournalWorkerFixture();
  try {
    assert.equal((await fixture.api("/network-probe")).body.status, 502, "All outbound network is denied by the fixture service");
    assert.deepEqual(fixture.trace.deniedNetwork, ["https://example.invalid"]);
    await fixture.start();
    const sourceIdentity = await fixture.sourceIdentity();
    const first = await waitFor(fixture.read, (page) => bytesFor(page.frames, "stdout").includes(Buffer.from("fixture-secret-")) && bytesFor(page.frames, "stderr").includes(Buffer.from("stderr-before\n")));
    const viewer = await fixture.socket();
    assert.equal((await fixture.api("/publish", { frames: first.frames })).status, 200);
    await waitFor(() => terminal(viewer.frames), (frames) => frames.length >= 2);
    assert(!JSON.stringify(viewer.frames).includes("fixture-secret"), "Incomplete raw secret bytes never cross the room binding");
    const priorEvents = terminal(viewer.frames), priorCursor = priorEvents.at(-1).sequence;
    viewer.client.close();

    // The producer survives separately; no Container or coding CLI is started.
    await fixture.restart();
    assert(fixture.sourceAlive(), "The same fixture supervisor survives actual workerd shutdown");
    assert.deepEqual(await fixture.sourceIdentity(), sourceIdentity);
    assert.equal(await fixture.launches(), 1);
    await fixture.release(1); await fixture.phaseReady(2);
    const middle = await waitFor(fixture.read, (page) => bytesFor(page.frames, "stdout").subarray(-2).equals(Buffer.from([0xf0, 0x9f])));
    assert.equal((await fixture.api("/publish", { frames: middle.frames })).status, 200);
    const beforeAck = (await fixture.api("/ack")).body.acknowledged;
    await fixture.release(2);
    const finished = await waitFor(fixture.read, (page) => page.done);
    assert.equal(finished.state, "exited"); assert.equal(finished.exitCode, 0);
    const rawStdout = "before\nfixture-secret-value\n🙂\nafter\n", rawStderr = "stderr-before\nstderr-after\n";
    assert.equal(bytesFor(finished.frames, "stdout").toString("utf8"), rawStdout);
    assert.equal(bytesFor(finished.frames, "stderr").toString("utf8"), rawStderr);
    assert(middle.frames.some((frame) => frame.stream === "stdout" && Buffer.from(frame.dataBase64, "base64").subarray(-2).equals(Buffer.from([0xf0, 0x9f]))), "The Unicode code point crosses a real source-frame boundary");

    // Both append attempts commit, then lose their replies. A later owner adopts the durable ack.
    const lost = await fixture.api("/publish", { frames: finished.frames, end: true, loseAck: true });
    assert.equal(lost.status, 503); assert.equal(lost.body.injected, "committed-acknowledgment-loss");
    const committedAck = (await fixture.api("/ack")).body.acknowledged;
    assert(committedAck > beforeAck); assert(committedAck <= finished.cursor, "Only the committed prefix may be acknowledged after a lost reply");
    await fixture.restart();
    assert.equal((await fixture.api("/ack")).body.acknowledged, committedAck, "Actual SQLite acknowledgment survives a second workerd restart");
    assert.deepEqual(await fixture.sourceIdentity(), sourceIdentity);

    const attached = await fixture.attach();
    assert.equal(attached.starts, 0, "Production attach-only adapter never invokes START");
    assert.equal(attached.result.stdout, rawStdout); assert.equal(attached.result.stderr, rawStderr); assert.equal(attached.result.exitCode, 0);
    assert.equal(await fixture.launches(), 1);
    assert.equal((await fixture.api("/publish", { frames: attached.frames, end: true })).status, 200);
    assert.equal((await fixture.api("/ack")).body.acknowledged, finished.cursor, "Reattachment durably publishes the remaining source suffix");
    const replay = await fixture.socket();
    const suffix = await replay.replay(priorCursor);
    assert(!suffix.some((frame) => frame.type === "run:replay_gap"));
    const events = [...priorEvents, ...terminal(suffix)];
    assert.equal(new Set(events.map((event) => event.eventId)).size, events.length, "Uncertain delivery and source replay produce no duplicate event");
    for (let index = 0; index < events.length; index++) assert.equal(events[index].sequence, index + 1);
    const expectedStdout = rawStdout.replace("fixture-secret-value", "[fixture-redacted]");
    assert.equal(digest(textFor(events, "stdout")), digest(expectedStdout));
    assert.equal(digest(textFor(events, "stderr")), digest(rawStderr));
    assert(!JSON.stringify(events).includes("fixture-secret"));
    assert.equal(suffix.at(-1).type, "run:replay_complete"); assert.equal(suffix.at(-1).sequence, events.at(-1).sequence);
    const durable = await fixture.api("/replay?after=0");
    assert.equal(durable.body.gap, false); assert.equal(durable.body.frames.length, events.length);
    assert.equal(fixture.trace.workerStarts, 3);

    // The display history is deliberately smaller than the bounded source journal.
    assert.equal((await fixture.api("/retention?retention=1", {})).body.events, 2049);
    const bounded = await fixture.socket(true), gap = await bounded.replay(0);
    assert(gap.some((frame) => frame.type === "run:replay_gap"), "Retention loss is explicitly signaled over the real socket");
    assert.equal(terminal(gap).length, 2048);
    assert.equal(gap.at(-1).type, "run:replay_complete"); assert.equal(gap.at(-1).sequence, 2049);
    assert.deepEqual(fixture.trace.deniedNetwork, ["https://example.invalid"], "No provider, model, metadata or other outbound request occurred");
    assert.deepEqual(await sourceDigests(), sourceAtStart, "Recovery sources stayed frozen through the actual runtime drill");
    context.diagnostic(JSON.stringify({ kind: "actual-local-workerd-journal-recovery", workerRuntimes: fixture.trace.workerStarts,
      tcpWebSocket: true, sqlitePersistence: true, sourceLaunches: await fixture.launches(), attachStarts: attached.starts,
      sourceFrames: finished.cursor, deliveredEvents: events.length, stdoutSha256: digest(expectedStdout), stderrSha256: digest(rawStderr),
      retentionProduced: 2049, retentionReplayed: 2048, retentionGapExplicit: true, externalRequests: 0, blockedProbe: 1,
      boundary: "Real workerd, SQLite, TCP WebSocket and Node supervisor; fixture container bridge. No Cloudflare Container, coding CLI, model, provider or parent agent SDK recovery.", sourceAtStart }));
  } finally { await fixture.stop(); }
});

test("early fixture cleanup waits for the owned detached source group to exit", { timeout: 45_000, skip: process.platform !== "linux" && "Production supervisor uses Linux process identity" }, async () => {
  const fixture = await startJournalWorkerFixture();
  let pin;
  const identity = async () => {
    if (!pin) return null;
    try {
      const stat = await readFile(`/proc/${pin.pid}/stat`, "utf8"), values = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return { state: values[0], group: Number(values[2]), session: Number(values[3]), start: values[19] };
    } catch { return null; }
  };
  try {
    await fixture.start();
    const meta = JSON.parse(await readFile(`${fixture.root}/journals/${fixture.jobId}/meta.json`, "utf8"));
    pin = { pid: meta.childPid, start: meta.childStart };
    const before = await identity();
    assert.equal(before?.start, pin.start); assert.equal(before.group, pin.pid); assert.equal(before.session, pin.pid);
    await fixture.stop();
    const after = await identity();
    assert(!after || after.start !== pin.start || after.state === "Z", "The owned detached anchor must not survive early cleanup");
    assert.equal(fixture.sourceAlive(), false);
  } finally { await fixture.stop(); }
});
