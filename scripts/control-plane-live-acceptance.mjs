#!/usr/bin/env node
/** Sample safe identity/deployment metadata. Run observation is blocked pending a non-waking API. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const GAP_STATUSES = new Set(["stream_gap", "stream_limited"]);
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REPLAY_FRAMES = 2_048;
const MAX_REPLAY_BYTES = 12_000_000;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasControl = (value) => Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export class AcceptanceError extends Error {
  constructor(code) { super(code); this.name = "AcceptanceError"; this.code = code; }
}
function insist(condition, code) { if (!condition) throw new AcceptanceError(code); }
function keys(value, allowed, code) {
  insist(record(value) && Object.keys(value).every((key) => allowed.includes(key)), code);
}

/** Configuration contains selectors and reviewed hashes, never credentials or arbitrary routes. */
export function validateConfig(value) {
  keys(value, ["schemaVersion", "origin", "revision", "versionId", "imageDigest", "scope", "expectedApproval", "observeMs"], "invalid_config");
  insist(value.schemaVersion === 1 && typeof value.origin === "string", "invalid_config");
  let origin;
  try { origin = new URL(value.origin); } catch { throw new AcceptanceError("invalid_origin"); }
  insist(origin.protocol === "https:" && origin.origin === value.origin && !origin.username && !origin.password &&
    !origin.port && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(origin.hostname) &&
    !/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(origin.hostname), "invalid_origin");
  insist(SHA.test(value.revision) && UUID.test(value.versionId) && /^sha256:[a-f0-9]{64}$/.test(value.imageDigest), "invalid_revision");
  keys(value.scope, ["kind", "ownerId", "sessionId", "runId", "approvalId", "inputHash", "teamId", "fixtureLabel"], "invalid_scope");
  const scope = value.scope;
  insist(scope.kind === "dashboard-session" && scope.teamId === null && scope.fixtureLabel === "isolated-nonproduction" &&
    typeof scope.ownerId === "string" && scope.ownerId.length > 0 && scope.ownerId.length <= 320 && scope.ownerId === scope.ownerId.trim().toLowerCase() &&
    !/\s/.test(scope.ownerId) && !hasControl(scope.ownerId) && !/^(default|system|automation|agent|mcp|child|subagent)(:|$)/i.test(scope.ownerId) &&
    UUID.test(scope.sessionId) && typeof scope.approvalId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(scope.approvalId) &&
    scope.runId === `agent-tool:${scope.approvalId}` && HASH.test(scope.inputHash), "invalid_scope");
  insist(["pending", "approved"].includes(value.expectedApproval), "invalid_approval_mode");
  const observeMs = value.observeMs ?? 1_000;
  insist(Number.isSafeInteger(observeMs) && observeMs >= 0 && observeMs <= 10_000, "invalid_observation_window");
  return { ...structuredClone(value), observeMs };
}

export function requireOptIn({ executeReadOnly, env }) {
  insist(executeReadOnly === true && env.SHIBA_CONTROL_PLANE_LIVE === "1", "live_opt_in_required");
  const cookie = env.SHIBA_LIVE_COOKIE;
  insist(typeof cookie === "string" && cookie.length > 0 && cookie.length <= 32_768 && !hasControl(cookie), "existing_session_cookie_required");
  return cookie;
}

export function verifyRevision(body, config) {
  insist(record(body) && body.versionId === config.versionId && body.revision === config.revision, "deployment_revision_mismatch");
}

export function verifyIdentity(body, config) {
  insist(record(body) && body.agent === config.scope.ownerId && ["access", "better-auth"].includes(body.auth) && body.teamMember !== true, "authenticated_fixture_owner_required");
}

/** Reject an unrelated or automated approval before a run read can wake recovery. */
export function verifyApprovalPointer(body, config) {
  insist(record(body) && Array.isArray(body.approvals) && Array.isArray(body.decided), "invalid_approval_response");
  const candidates = [...body.approvals, ...body.decided].filter((item) => item?.approvalId === config.scope.approvalId);
  insist(candidates.length === 1, "exact_approval_required");
  const approval = candidates[0];
  insist((approval.kind === undefined || approval.kind === "run") && approval.status === config.expectedApproval &&
    approval.threadKey === `web:${config.scope.ownerId}:${config.scope.sessionId}`, "approval_scope_mismatch");
  if (config.expectedApproval === "approved") {
    insist(typeof approval.decidedBy === "string" && approval.decidedBy.trim().length > 0 &&
      !/^(?:(?:default|system|automation|agent|mcp|child|subagent)(?::|$)|task-cancel$|collaboration-cancellation$)/i.test(approval.decidedBy.trim()), "human_approved_run_required");
  }
  return approval;
}

/** The approval is observed, never answered. The input hash is an operator-reviewed selector. */
export function verifyApproval(body, run, config, now = Date.now()) {
  const approval = verifyApprovalPointer(body, config);
  if (config.expectedApproval === "pending") {
    insist(Number.isSafeInteger(approval.createdAt) && approval.createdAt <= now && now - approval.createdAt < 30 * 60_000 &&
      !approval.decidedBy && !approval.decidedAt && run === null, "pending_run_must_not_exist");
    return { state: "pending", namedHumanDecision: false, inputHashVerified: false };
  }
  const decision = run?.approval;
  insist(record(run) && run.runId === config.scope.runId && record(decision) && decision.approvalId === config.scope.approvalId &&
    decision.inputHash === config.scope.inputHash && typeof decision.decidedBy === "string" && decision.decidedBy.trim().length > 0 &&
    !/^(?:(?:default|system|automation|agent|mcp|child|subagent)(?::|$)|task-cancel$|collaboration-cancellation$)/i.test(decision.decidedBy.trim()) &&
    Number.isSafeInteger(decision.decidedAt) && decision.decidedAt > 0 && decision.decidedAt <= now &&
    decision.decidedBy === approval.decidedBy && decision.decidedAt === approval.decidedAt &&
    ["pending", "running", "completed", "error", "aborted", "cancelled", "unknown"].includes(run.status), "human_approved_run_required");
  return { state: run.status, namedHumanDecision: true, inputHashVerified: true };
}

/** Store hashes and counts only. Untrusted terminal text never enters the report. */
export function summarizeReplay(messages, config, after) {
  insist(Array.isArray(messages) && messages.length <= MAX_REPLAY_FRAMES + 100, "replay_bound_exceeded");
  const frames = [], ids = new Set(), gapMarkers = [];
  let cursor = after, deliveredThrough = after, completedAt = null, bytes = 0, stdout = 0, stderr = 0;
  for (const message of messages) {
    insist(record(message), "invalid_room_frame");
    bytes += Buffer.byteLength(JSON.stringify(message));
    insist(bytes <= MAX_REPLAY_BYTES, "replay_bound_exceeded");
    if (message.type === "error") throw new AcceptanceError("room_rejected_subscription");
    if (message.type === "run:replay_gap") {
      insist([message.after, message.oldest, message.latest].every((n) => Number.isSafeInteger(n) && n >= 0), "invalid_gap_marker");
      gapMarkers.push({ kind: "retention_gap", after: message.after, oldest: message.oldest, latest: message.latest });
    }
    if (message.type === "run:replay_complete") {
      insist(completedAt === null && Number.isSafeInteger(message.sequence) && message.sequence >= deliveredThrough, "invalid_replay_complete");
      completedAt = message.sequence;
    }
    if (message.type !== "run:event") continue;
    insist(Number.isSafeInteger(message.sequence) && message.sequence > deliveredThrough, "duplicate_or_unordered_run_frame");
    deliveredThrough = message.sequence;
    // A private session may contain earlier runs. They are never exported or hashed.
    if (message.runId !== config.scope.runId) continue;
    insist(Number.isSafeInteger(message.sequence) && message.sequence > cursor && UUID.test(message.eventId) &&
      !ids.has(message.eventId) && record(message.event), "duplicate_or_unordered_run_frame");
    const event = message.event;
    insist(["terminal", "status", "diff", "child"].includes(event.kind), "invalid_run_event");
    if (event.kind === "terminal") {
      insist(["stdout", "stderr"].includes(event.stream) && typeof event.data === "string" && event.data.length <= 4_000, "invalid_terminal_frame");
      if (event.stream === "stdout") stdout++;
      else stderr++;
    }
    if (event.kind === "status" && GAP_STATUSES.has(event.status)) gapMarkers.push({ kind: event.status, sequence: message.sequence });
    ids.add(message.eventId);
    cursor = message.sequence;
    frames.push({ sequence: cursor, eventHash: sha(JSON.stringify([message.eventId, event])), terminal: event.kind === "terminal" });
  }
  insist(completedAt !== null && completedAt >= after, "replay_not_completed");
  return { frames, after, cursor, completedAt, stdout, stderr, gapMarkers };
}

export function compareReplays(before, after, cursor) {
  const expected = before.frames.filter((frame) => frame.sequence > cursor);
  const observed = new Map(after.frames.map((frame) => [frame.sequence, frame]));
  insist(expected.every((frame) => observed.get(frame.sequence)?.eventHash === frame.eventHash), "retained_replay_mismatch");
  const terminalCount = expected.filter((frame) => frame.terminal).length;
  return {
    status: before.gapMarkers.length || after.gapMarkers.length ? "failed" : terminalCount ? "passed" : "blocked",
    cursor, comparedFrames: expected.length, comparedTerminalFrames: terminalCount,
    beforeTerminalFrames: before.stdout + before.stderr, afterTerminalFrames: after.stdout + after.stderr,
    stdoutFrames: after.stdout, stderrFrames: after.stderr,
    gapMarkers: [...before.gapMarkers, ...after.gapMarkers],
    digest: sha(JSON.stringify(expected.map(({ sequence, eventHash }) => [sequence, eventHash]))),
  };
}

export function checklist() {
  return [
    { id: 1, status: "blocked", requirement: "Approved ephemeral run and proof no sandbox starts before human approval", reason: "Existing-run observation cannot inspect container creation or prove a historical negative." },
    { id: 2, status: "blocked", requirement: "Private archive bytes, entries, digest and invalid capability/upload cases", reason: "Requires separately authorized artifact creation and explicit download tests." },
    { id: 3, status: "blocked", requirement: "Bounded real specialists, route denial, cancellation and zero container secrets", reason: "Requires approved specialist execution and trusted container inspection." },
    { id: 4, status: "blocked", requirement: "Two authenticated viewers, durable room replay and viewer revocation", reason: "This observer covers one fixture owner only. Second-user authorization and revocation remain operator checks." },
    { id: 5, status: "blocked", requirement: "Installed Slack personas, buffering and exact attributed approvals", reason: "No Slack send or approval action is performed." },
    { id: 6, status: "blocked", requirement: "Actual source-thread completion delivery and final artifact or PR", reason: "Requires separately permitted completion delivery and destination evidence." },
    { id: 7, status: "blocked", requirement: "Same-container source transport, child and parent recovery without duplicate retained frames", reason: "Browser replay is not source RPC interruption or process reattachment proof. Operator must retain source counts, job/container identity, generation and durable acknowledgment. Replacement and over-limit loss are separate outcomes." },
  ];
}

/** Only metadata and identity reads are safe until a scoped, non-waking read contract exists. */
export async function observeExistingRun(rawConfig, options = {}, dependencies = {}) {
  const config = validateConfig(rawConfig);
  const cookie = requireOptIn({ executeReadOnly: options.executeReadOnly, env: options.env ?? process.env });
  const open = dependencies.open ?? openMetadataObserver;
  const observer = await open(config, cookie);
  const startedAt = new Date().toISOString();
  try {
    insist(await observer.anonymousStatus() === 401, "anonymous_api_not_locked");
    verifyIdentity(await observer.json("/api/whoami"), config);
    verifyRevision(await observer.json("/api/setup/deployment"), config);
    verifyIdentity(await observer.json("/api/whoami"), config);
    verifyRevision(await observer.json("/api/setup/deployment"), config);
    return {
      schemaVersion: 1, capturedAt: new Date().toISOString(), kind: "live-metadata-observation",
      status: "blocked", reason: "non_waking_observation_unavailable",
      target: { origin: config.origin, revision: config.revision, versionId: config.versionId,
        imageDigest: config.imageDigest, imageDigestVerified: false, scopeHash: sha(JSON.stringify(config.scope)) },
      revisionObservation: { mode: "start_end_samples", startedAt, endedAt: new Date().toISOString(), continuousProof: false },
      operation: { httpMethods: ["GET"], paths: ["/api/whoami", "/api/setup/deployment"], socketCommands: [],
        queuedRuns: 0, approvalsAnswered: 0, controlledEvictions: 0, runOrApprovalReads: 0 },
      retainedRoomReplay: { status: "blocked", reason: "non_waking_observation_unavailable" },
      sourceRecovery: { status: "blocked", sourceFrameCount: null, acknowledgedThrough: null },
      scenarios: checklist(), fullPlanAccepted: false,
    };
  } finally { await observer.close(); }
}

/** Local protocol test seam only. The CLI cannot call this or supply its observer. */
export async function observeFixtureRun(rawConfig, options = {}, dependencies = {}) {
  const config = validateConfig(rawConfig);
  const cookie = requireOptIn({ executeReadOnly: options.executeReadOnly, env: options.env ?? process.env });
  insist(typeof dependencies.open === "function", "isolated_fixture_observer_required");
  const observer = await dependencies.open(config, cookie);
  try {
    insist(await observer.anonymousStatus() === 401, "anonymous_api_not_locked");
    verifyIdentity(await observer.json("/api/whoami"), config);
    verifyRevision(await observer.json("/api/setup/deployment"), config);
    const approvals = await observer.json("/api/approvals");
    verifyApprovalPointer(approvals, config);
    const runPath = `/api/runs/${encodeURIComponent(config.scope.runId)}?session=${config.scope.sessionId}`;
    const runBody = await observer.json(runPath, config.expectedApproval === "pending" ? 404 : 200);
    const approval = verifyApproval(approvals, runBody?.run ?? null, config);
    let replay = { status: "blocked", reason: "Pending human approval. No room observation was attempted." };
    if (config.expectedApproval === "approved") {
      const before = summarizeReplay(await observer.replay(0), config, 0);
      const target = before.frames.filter((frame) => frame.terminal);
      // Deliberately reconnect from an earlier retained cursor to require actual replay.
      const cursor = target.length > 1 ? target[Math.floor((target.length - 1) / 2)].sequence : 0;
      const after = summarizeReplay(await observer.replay(cursor), config, cursor);
      replay = compareReplays(before, after, cursor);
    }
    verifyIdentity(await observer.json("/api/whoami"), config);
    verifyRevision(await observer.json("/api/setup/deployment"), config);
    const scenarios = checklist();
    if (replay.status === "passed") scenarios[3] = { ...scenarios[3], status: "partial", retainedOwnerReplay: "passed" };
    if (replay.status === "failed") scenarios[3] = { ...scenarios[3], status: "failed", retainedOwnerReplay: "failed" };
    return {
      schemaVersion: 1, capturedAt: new Date().toISOString(), kind: "local-existing-run-fixture",
      target: { origin: config.origin, revision: config.revision, versionId: config.versionId,
        imageDigest: config.imageDigest, imageDigestVerified: false, scopeHash: sha(JSON.stringify(config.scope)) },
      operation: { httpMethods: ["GET"], socketCommands: config.expectedApproval === "approved" ? ["subscribe"] : [],
        queuedRuns: 0, approvalsAnswered: 0, controlledEvictions: 0 },
      approval, retainedRoomReplay: replay,
      sourceRecovery: { status: "blocked", sourceFrameCount: null, acknowledgedThrough: null,
        reason: "Source journal and acknowledgment are binding-only. This observer cannot obtain trusted source counts through the public API." },
      scenarios, fullPlanAccepted: false,
    };
  } finally { await observer.close(); }
}

/** Runs in the browser page. Keep this function independent of Node helpers. */
export function observeRoomReplay({ sessionId, viewer, after, observeMs, maxFrames, maxBytes, timeoutMs = 15_000, closeTimeoutMs = 1_000 }) {
  return new Promise((resolveReplay, reject) => {
    const url = new URL(`/api/sessions/${sessionId}/realtime`, location.origin);
    url.protocol = "wss:"; url.searchParams.set("viewer", viewer);
    const socket = new WebSocket(url), frames = [];
    let bytes = 0, completed = false, finishing = false, settled = false, failed = false, finishTimer, closeTimer;
    const settle = () => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(finishTimer); clearTimeout(closeTimer);
      if (failed) reject(new Error("room_observation_failed"));
      else resolveReplay(frames);
    };
    const finish = (error) => {
      if (finishing) return;
      finishing = true; failed = Boolean(error); clearTimeout(deadline); clearTimeout(finishTimer);
      if (socket.readyState === WebSocket.CLOSED) return settle();
      closeTimer = setTimeout(() => { failed = true; settle(); }, closeTimeoutMs);
      try { socket.close(); } catch { failed = true; settle(); }
    };
    const deadline = setTimeout(() => finish(true), timeoutMs);
    socket.onopen = () => socket.send(JSON.stringify({ type: "subscribe", after }));
    socket.onerror = () => finish(true);
    socket.onclose = () => { if (finishing) settle(); else finish(true); };
    socket.onmessage = (message) => {
      if (finishing) return;
      if (typeof message.data !== "string") return finish(true);
      bytes += message.data.length;
      if (bytes > maxBytes || frames.length >= maxFrames) return finish(true);
      let frame;
      try { frame = JSON.parse(message.data); } catch { return finish(true); }
      if (frame === null || typeof frame !== "object" || Array.isArray(frame)) return finish(true);
      if (frame.type === "run:event" || frame.type === "run:replay_gap" || frame.type === "run:replay_complete" || frame.type === "error") frames.push(frame);
      if (frame.type === "error") return finish(true);
      if (frame.type === "run:replay_complete" && !completed) { completed = true; finishTimer = setTimeout(() => finish(false), observeMs); }
    };
  });
}

/** Fixed safe reads only. No session registry, approvals, run, room or socket request is exposed. */
async function openMetadataObserver(config, cookie) {
  const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
  const { request } = desktopRequire("playwright-core");
  const context = await request.newContext({ ignoreHTTPSErrors: false, extraHTTPHeaders: { Cookie: cookie } });
  const anonymous = await request.newContext({ ignoreHTTPSErrors: false });
  try {
    const allowed = new Set(["/api/whoami", "/api/setup/deployment"]);
    const json = async (path) => {
      const url = new URL(path, config.origin);
      insist(url.origin === config.origin && allowed.has(url.pathname) && !url.search && !url.hash, "unapproved_observer_route");
      const response = await context.get(url.href, { maxRedirects: 0, timeout: 15_000 });
      insist(response.status() === 200, "authenticated_read_failed");
      try {
        const body = await response.body();
        insist(body.length <= MAX_RESPONSE_BYTES, "response_bound_exceeded");
        try { return JSON.parse(body.toString("utf8")); } catch { throw new AcceptanceError("invalid_json_response"); }
      } finally { await response.dispose(); }
    };
    return {
      json,
      async anonymousStatus() {
        const response = await anonymous.get(`${config.origin}/api/whoami`, { maxRedirects: 0, timeout: 15_000 });
        try { return response.status(); } finally { await response.dispose(); }
      },
      async close() { await Promise.all([context.dispose(), anonymous.dispose()]); },
    };
  } catch (error) { await Promise.all([context.dispose(), anonymous.dispose()]); throw error; }
}

async function main(args) {
  const allowed = new Set(["--config", "--execute-read-only", "--output"]);
  const parsed = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    insist(allowed.has(key) && !Object.hasOwn(parsed, key), "invalid_arguments");
    if (key === "--execute-read-only") parsed[key] = true;
    else { insist(typeof args[index + 1] === "string" && !args[index + 1].startsWith("--"), "invalid_arguments"); parsed[key] = args[++index]; }
  }
  if (!parsed["--execute-read-only"]) {
    process.stdout.write(`${JSON.stringify({ status: "blocked", reason: "live_opt_in_required", networkRequests: 0, scenarios: checklist(), fullPlanAccepted: false }, null, 2)}\n`);
    return;
  }
  insist(parsed["--config"] && parsed["--output"], "config_and_private_output_required");
  const input = await readFile(resolve(parsed["--config"]));
  insist(input.length <= 16_384, "config_bound_exceeded");
  let config;
  try { config = JSON.parse(input.toString("utf8")); } catch { throw new AcceptanceError("invalid_config"); }
  const result = await observeExistingRun(config, { executeReadOnly: true });
  await writeFile(resolve(parsed["--output"]), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ status: result.retainedRoomReplay.status, reason: result.reason, fullPlanAccepted: false, evidenceWritten: true })}\n`);
  if (result.retainedRoomReplay.status === "failed") process.exitCode = 1;
  else if (result.retainedRoomReplay.status === "blocked") process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    // Browser/API exceptions may contain URLs, cookies or payloads. Export only fixed local codes.
    const code = error instanceof AcceptanceError ? error.code : "observer_failed_no_sensitive_details_logged";
    process.stderr.write(`${JSON.stringify({ status: "blocked", reason: code, fullPlanAccepted: false })}\n`);
    process.exitCode = 1;
  });
}
