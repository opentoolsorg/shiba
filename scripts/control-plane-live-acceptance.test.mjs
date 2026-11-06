import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  checklist, compareReplays, observeFixtureRun as observeExistingRun, observeExistingRun as observeLiveExistingRun, observeRoomReplay, requireOptIn, summarizeReplay, validateConfig,
  verifyApproval, verifyIdentity, verifyRevision,
} from "./control-plane-live-acceptance.mjs";

const now = 1_600_000_000_000;
const config = () => ({
  schemaVersion: 1, origin: "https://isolated-preview.shiba.dev", revision: "a".repeat(40),
  versionId: "12345678-abcd-4123-8123-123456789abc", imageDigest: `sha256:${"b".repeat(64)}`,
  scope: { kind: "dashboard-session", fixtureLabel: "isolated-nonproduction", teamId: null,
    ownerId: "fixture-owner@shiba.dev", sessionId: "23456789-abcd-4123-8123-123456789abc",
    approvalId: "fixture-human-approved", runId: "agent-tool:fixture-human-approved", inputHash: "c".repeat(64) },
  expectedApproval: "approved", observeMs: 0,
});
const options = { executeReadOnly: true, env: { SHIBA_CONTROL_PLANE_LIVE: "1", SHIBA_LIVE_COOKIE: "fixture=private-cookie-never-export" } };
const approvalBody = (c = config()) => ({ approvals: [], decided: [{ approvalId: c.scope.approvalId,
  threadKey: `web:${c.scope.ownerId}:${c.scope.sessionId}`, kind: "run", status: "approved",
  decidedBy: "fixture-human@shiba.dev", decidedAt: now - 1, createdAt: now - 1_000 }] });
const runBody = (c = config()) => ({ run: { runId: c.scope.runId, status: "completed", approval: {
  approvalId: c.scope.approvalId, inputHash: c.scope.inputHash, decidedBy: "fixture-human@shiba.dev", decidedAt: now - 1,
} } });
const frame = (sequence, overrides = {}) => ({ type: "run:event", sequence,
  eventId: `12345678-abcd-4123-8123-${String(sequence).padStart(12, "0")}`,
  runId: config().scope.runId, createdAt: now, event: { kind: "terminal", stream: sequence % 2 ? "stdout" : "stderr", data: `PRIVATE-FIXTURE-OUTPUT-${sequence}\n` }, ...overrides });
const replay = (frames, latest = frames.at(-1)?.sequence ?? 0) => [...frames, { type: "run:replay_complete", sequence: latest }];

function fixture(c = config()) {
  const reads = [], cursors = [];
  const responses = new Map([
    ["/api/whoami", { agent: c.scope.ownerId, auth: "access" }],
    ["/api/setup/deployment", { versionId: c.versionId, revision: c.revision }],
    ["/api/approvals", approvalBody(c)],
    [`/api/runs/${encodeURIComponent(c.scope.runId)}?session=${c.scope.sessionId}`, runBody(c)],
  ]);
  let closed = 0, revisions = 0, opens = 0;
  const state = { anonymous: 401, mutate: () => {} };
  return {
    reads, cursors, responses, state,
    counts: () => ({ closed, opens }),
    dependencies: { open: async (passed, cookie) => {
      opens++;
      assert.equal(passed.origin, c.origin);
      assert.equal(cookie, options.env.SHIBA_LIVE_COOKIE);
      return {
        anonymousStatus: async () => state.anonymous,
        json: async (path, status) => {
          reads.push({ path, status });
          if (path === "/api/setup/deployment") state.mutate(++revisions, responses);
          return responses.get(path);
        },
        replay: async (after) => { cursors.push(after); return replay([frame(1), frame(2), frame(3)].filter((f) => f.sequence > after), 3); },
        close: async () => { closed++; },
      };
    } },
  };
}

test("default CLI prints all seven blocked cases and performs no live action", () => {
  const child = spawnSync(process.execPath, [new URL("./control-plane-live-acceptance.mjs", import.meta.url).pathname], { encoding: "utf8", env: {} });
  assert.equal(child.status, 0);
  const result = JSON.parse(child.stdout);
  assert.equal(result.networkRequests, 0);
  assert.equal(result.fullPlanAccepted, false);
  assert.equal(result.scenarios.length, 7);
  assert(result.scenarios.every((item) => item.status === "blocked"));
  assert.equal(child.stderr, "");
});

test("live entry blocks on the missing non-waking contract before any approval, run, session or room read", async () => {
  const f = fixture();
  const result = await observeLiveExistingRun(config(), options, f.dependencies);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "non_waking_observation_unavailable");
  assert.deepEqual(f.reads.map((entry) => entry.path), ["/api/whoami", "/api/setup/deployment", "/api/whoami", "/api/setup/deployment"]);
  assert.deepEqual(f.cursors, []);
  assert.equal(f.reads.some((entry) => /^\/api\/(approvals|runs|sessions)/.test(entry.path)), false);
  assert.equal(result.operation.runOrApprovalReads, 0);
  assert.equal(result.revisionObservation.mode, "start_end_samples");
  assert.equal(result.revisionObservation.continuousProof, false);
  assert(result.scenarios.every((entry) => entry.status === "blocked"));
  assert.equal(result.fullPlanAccepted, false);
  assert.equal(f.counts().closed, 1);
});

test("live metadata entry still requires both gates before opening a transport", async () => {
  const f = fixture();
  await assert.rejects(() => observeLiveExistingRun(config(), { ...options, executeReadOnly: false }, f.dependencies), /live_opt_in_required/);
  assert.equal(f.counts().opens, 0);
});

for (const [name, change] of [
  ["HTTP origin", (c) => { c.origin = "http://isolated-preview.shiba.dev"; }],
  ["credential URL", (c) => { c.origin = "https://secret@isolated-preview.shiba.dev"; }],
  ["origin path", (c) => { c.origin += "/app/"; }],
  ["origin query", (c) => { c.origin += "?token=secret"; }],
  ["internal host", (c) => { c.origin = "https://worker.internal"; }],
  ["IP host", (c) => { c.origin = "https://127.0.0.1"; }],
  ["short revision", (c) => { c.revision = "ad9c2f3"; }],
  ["unknown config", (c) => { c.authorization = "private"; }],
  ["blank owner", (c) => { c.scope.ownerId = ""; }],
  ["system owner", (c) => { c.scope.ownerId = "automation:fixture"; }],
  ["default session", (c) => { c.scope.sessionId = "default"; }],
  ["shared team", (c) => { c.scope.teamId = "team-fixture"; }],
  ["arbitrary run", (c) => { c.scope.runId = "other-run"; }],
  ["unbounded wait", (c) => { c.observeMs = 60_000; }],
]) {
  test(`fails closed before browser or network on ${name}`, async () => {
    const c = config(), f = fixture(c); change(c);
    await assert.rejects(() => observeExistingRun(c, options, f.dependencies));
    assert.deepEqual(f.counts(), { opens: 0, closed: 0 });
    assert.equal(f.reads.length, 0);
  });
}

test("both explicit gates and existing bounded cookies are required before browser launch", async () => {
  for (const bad of [
    { executeReadOnly: false, env: options.env },
    { executeReadOnly: true, env: { SHIBA_LIVE_COOKIE: "fixture=secret" } },
    { executeReadOnly: true, env: { SHIBA_CONTROL_PLANE_LIVE: "1" } },
    { executeReadOnly: true, env: { SHIBA_CONTROL_PLANE_LIVE: "1", SHIBA_LIVE_COOKIE: "fixture=secret\r\nInjected: true" } },
  ]) {
    const f = fixture();
    await assert.rejects(() => observeExistingRun(config(), bad, f.dependencies));
    assert.equal(f.counts().opens, 0);
  }
  assert.throws(() => requireOptIn({ executeReadOnly: true, env: { SHIBA_CONTROL_PLANE_LIVE: "1", SHIBA_LIVE_COOKIE: "a".repeat(32_769) } }));
});

test("approved observer reconnects from an explicit retained cursor and exports no private payload", async () => {
  const f = fixture();
  const result = await observeExistingRun(config(), options, f.dependencies);
  assert.deepEqual(f.cursors, [0, 2]);
  assert.deepEqual(f.counts(), { opens: 1, closed: 1 });
  assert.equal(result.retainedRoomReplay.status, "passed");
  assert.equal(result.retainedRoomReplay.comparedTerminalFrames, 1);
  assert.equal(result.retainedRoomReplay.gapMarkers.length, 0);
  assert.equal(result.scenarios[3].status, "partial");
  assert.equal(result.sourceRecovery.sourceFrameCount, null);
  assert.equal(result.sourceRecovery.acknowledgedThrough, null);
  assert.equal(result.target.imageDigestVerified, false);
  assert.equal(result.fullPlanAccepted, false);
  assert.deepEqual(result.operation.httpMethods, ["GET"]);
  const serialized = JSON.stringify(result);
  for (const secret of ["PRIVATE-FIXTURE-OUTPUT", config().scope.ownerId, config().scope.approvalId, "private-cookie-never-export", "fixture-human@shiba.dev"]) assert.equal(serialized.includes(secret), false);
  assert.equal(f.reads.filter((r) => r.path === "/api/setup/deployment").length, 2);
});

test("pending approval never observes a socket or answers an approval", async () => {
  const c = config(); c.expectedApproval = "pending";
  const f = fixture(c);
  const pending = { ...approvalBody(c).decided[0], status: "pending", createdAt: Date.now() - 100 };
  delete pending.decidedBy; delete pending.decidedAt;
  f.responses.set("/api/approvals", { approvals: [pending], decided: [] });
  f.responses.set(`/api/runs/${encodeURIComponent(c.scope.runId)}?session=${c.scope.sessionId}`, null);
  const result = await observeExistingRun(c, options, f.dependencies);
  assert.deepEqual(f.cursors, []);
  assert.equal(result.approval.state, "pending");
  assert.equal(result.approval.inputHashVerified, false);
  assert.equal(result.retainedRoomReplay.status, "blocked");
  assert.deepEqual(f.reads.find((r) => r.path.startsWith("/api/runs/")).status, 404);
  assert(result.scenarios.every((item) => item.status === "blocked"));
});

test("anonymous API exposure fails before any authenticated read", async () => {
  const f = fixture(); f.state.anonymous = 200;
  await assert.rejects(() => observeExistingRun(config(), options, f.dependencies), /anonymous_api_not_locked/);
  assert.equal(f.reads.length, 0);
  assert.equal(f.counts().closed, 1);
});

for (const identity of [
  { agent: "other-owner@shiba.dev", auth: "access" },
  { agent: config().scope.ownerId, auth: "none" },
  { agent: config().scope.ownerId, auth: "access", teamMember: true },
]) {
  test(`refuses mismatched or unsupported identity ${JSON.stringify(identity)}`, () => {
    assert.throws(() => verifyIdentity(identity, config()), /authenticated_fixture_owner_required/);
  });
}

test("revision mismatch and missing metadata fail closed", () => {
  assert.throws(() => verifyRevision({}, config()), /deployment_revision_mismatch/);
  assert.throws(() => verifyRevision({ versionId: config().versionId, revision: "d".repeat(40) }, config()), /deployment_revision_mismatch/);
});

test("deployment drift during observation invalidates the whole result", async () => {
  const f = fixture();
  f.state.mutate = (read, responses) => { if (read === 2) responses.set("/api/setup/deployment", { versionId: config().versionId, revision: "d".repeat(40) }); };
  await assert.rejects(() => observeExistingRun(config(), options, f.dependencies), /deployment_revision_mismatch/);
  assert.equal(f.counts().closed, 1);
});

for (const bad of ["agent:reviewer", "automation:daily", "default", "task-cancel"]) {
  test(`denies automation approval ${bad} before reading or waking a run`, async () => {
    const f = fixture(); f.responses.get("/api/approvals").decided[0].decidedBy = bad;
    await assert.rejects(() => observeExistingRun(config(), options, f.dependencies), /human_approved_run_required/);
    assert.equal(f.reads.some((r) => r.path.startsWith("/api/runs/")), false);
    assert.equal(f.cursors.length, 0);
  });
}

for (const [name, mutate] of [
  ["wrong thread", (a) => { a.decided[0].threadKey = "web:other-owner:other-session"; }],
  ["publication action", (a) => { a.decided[0].kind = "pr_publish"; }],
  ["duplicate pointer", (a) => { a.approvals.push(a.decided[0]); }],
  ["different input hash", (_a, run) => { run.approval.inputHash = "e".repeat(64); }],
  ["different decider", (_a, run) => { run.approval.decidedBy = "another-human@shiba.dev"; }],
  ["different run", (_a, run) => { run.runId = "agent-tool:other"; }],
]) {
  test(`approval evidence rejects ${name}`, () => {
    const a = approvalBody(), run = runBody().run; mutate(a, run);
    assert.throws(() => verifyApproval(a, run, config(), now));
  });
}

test("pending approval cannot coexist with a run or an expired decision window", () => {
  const c = config(); c.expectedApproval = "pending";
  const pending = { ...approvalBody(c).decided[0], status: "pending", createdAt: now - 1 };
  delete pending.decidedBy; delete pending.decidedAt;
  const body = { approvals: [pending], decided: [] };
  assert.throws(() => verifyApproval(body, runBody(c).run, c, now), /pending_run_must_not_exist/);
  pending.createdAt = now - 31 * 60_000;
  assert.throws(() => verifyApproval(body, null, c, now), /pending_run_must_not_exist/);
});

test("reconnect detects altered, omitted, duplicated or reordered retained frames", () => {
  const c = config(), before = summarizeReplay(replay([frame(1), frame(2), frame(3)]), c, 0);
  for (const entries of [[frame(3)], [frame(2, { event: { kind: "terminal", stream: "stderr", data: "ALTERED" } }), frame(3)]]) {
    assert.throws(() => compareReplays(before, summarizeReplay(replay(entries, 3), c, 1), 1), /retained_replay_mismatch/);
  }
  for (const entries of [[frame(2), frame(2)], [frame(3), frame(2)], [frame(2), frame(3, { eventId: frame(2).eventId })]]) {
    assert.throws(() => summarizeReplay(replay(entries, 3), c, 1), /duplicate_or_unordered_run_frame/);
  }
});

for (const status of ["stream_gap", "stream_limited"]) {
  test(`reports ${status} as a failed retained replay, never a complete run`, () => {
    const c = config();
    const before = summarizeReplay(replay([frame(1), frame(2), frame(3, { event: { kind: "status", status, message: "PRIVATE-DETAIL" } })]), c, 0);
    const after = summarizeReplay(replay([frame(2), frame(3, { event: { kind: "status", status, message: "PRIVATE-DETAIL" } })]), c, 1);
    const result = compareReplays(before, after, 1);
    assert.equal(result.status, "failed");
    assert.equal(result.gapMarkers[0].kind, status);
    assert.equal(JSON.stringify(result).includes("PRIVATE-DETAIL"), false);
  });
}

test("retention gaps are recorded and empty terminal evidence is blocked", () => {
  const c = config();
  const gap = { type: "run:replay_gap", after: 0, oldest: 4, latest: 5 };
  const result = summarizeReplay([gap, ...replay([frame(4), frame(5)])], c, 0);
  assert.equal(compareReplays(result, result, 0).status, "failed");
  const empty = summarizeReplay(replay([]), c, 0);
  assert.equal(compareReplays(empty, empty, 0).status, "blocked");
  assert.throws(() => summarizeReplay([frame(1)], c, 0), /replay_not_completed/);
  assert.throws(() => summarizeReplay(replay([frame(1, { event: { kind: "terminal", stream: "stdout", data: "x".repeat(4_001) } })]), c, 0), /invalid_terminal_frame/);
});

test("completion frontiers cannot precede already delivered frames or occur twice", () => {
  const c = config();
  for (const messages of [
    replay([frame(1), frame(2), frame(3)], 0),
    replay([frame(2), frame(3)], 1),
    replay([frame(3, { runId: "other-run" })], 2),
    [{ type: "run:replay_complete", sequence: 3 }, { type: "run:replay_complete", sequence: 3 }],
    [{ type: "run:replay_complete", sequence: 3 }, { type: "run:replay_complete", sequence: 2 }],
  ]) assert.throws(() => summarizeReplay(messages, c, 0), /invalid_replay_complete/);
  const liveAfterCompletion = summarizeReplay([{ type: "run:replay_complete", sequence: 1 }, frame(2)], c, 0);
  assert.equal(liveAfterCompletion.cursor, 2);
});

test("all seven cases remain explicitly scoped and no checklist alone claims acceptance", () => {
  const rows = checklist();
  assert.deepEqual(rows.map((row) => row.id), [1, 2, 3, 4, 5, 6, 7]);
  assert(rows.every((row) => row.status === "blocked"));
  assert.match(rows[6].reason, /Replacement and over-limit loss are separate/);
  assert.equal(validateConfig(config()).scope.teamId, null);
});

async function withSocketFixture(operation, { messages = replay([frame(1)]), stallsOnClose = false } = {}) {
  const originalSocket = globalThis.WebSocket, originalLocation = globalThis.location;
  const sockets = [];
  class FixtureSocket {
    static CLOSED = 3;
    constructor(url) {
      this.url = url; this.readyState = 0; this.commands = []; this.closed = false;
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen(); });
    }
    send(command) {
      this.commands.push(JSON.parse(command));
      queueMicrotask(() => { for (const message of messages) this.onmessage({ data: JSON.stringify(message) }); });
    }
    close() {
      this.readyState = 2;
      if (stallsOnClose) return;
      queueMicrotask(() => {
        this.readyState = FixtureSocket.CLOSED; this.closed = true; this.onclose();
        // A late frame after closure must not escape into the resolved evidence.
        this.onmessage({ data: JSON.stringify(frame(99)) });
      });
    }
  }
  globalThis.WebSocket = FixtureSocket;
  globalThis.location = { origin: config().origin };
  try { await operation(sockets); } finally { globalThis.WebSocket = originalSocket; globalThis.location = originalLocation; }
}

const socketArgs = () => ({ sessionId: config().scope.sessionId, viewer: config().versionId,
  after: 0, observeMs: 0, maxFrames: 20, maxBytes: 20_000, timeoutMs: 50, closeTimeoutMs: 10 });

test("browser subscription waits for actual close and excludes late frames before reconnect", async () => {
  await withSocketFixture(async (sockets) => {
    const first = await observeRoomReplay(socketArgs());
    assert.equal(sockets[0].closed, true);
    assert.equal(first.some((item) => item.sequence === 99), false);
    await observeRoomReplay(socketArgs());
    assert.equal(sockets.every((socket) => socket.closed), true);
    for (const socket of sockets) {
      assert.deepEqual(socket.commands, [{ type: "subscribe", after: 0 }]);
      assert.equal(socket.url.protocol, "wss:");
      assert.equal(socket.url.origin, config().origin.replace("https:", "wss:"));
    }
  });
});

test("browser subscription rejects an unconfirmed disconnect", async () => {
  await withSocketFixture(async () => {
    await assert.rejects(() => observeRoomReplay(socketArgs()), /room_observation_failed/);
  }, { stallsOnClose: true });
});

test("browser subscription rejects remote errors and invalid or excessive frames", async () => {
  for (const messages of [[{ type: "error", error: "PRIVATE-REMOTE-ERROR" }], [null], replay([frame(1, { event: { kind: "terminal", stream: "stdout", data: "x".repeat(21_000) } })])]) {
    await withSocketFixture(async () => {
      await assert.rejects(() => observeRoomReplay(socketArgs()), /room_observation_failed/);
    }, { messages });
  }
});

test("browser subscription cannot pass without replay completion", async () => {
  await withSocketFixture(async () => {
    await assert.rejects(() => observeRoomReplay(socketArgs()), /room_observation_failed/);
  }, { messages: [frame(1)] });
});
