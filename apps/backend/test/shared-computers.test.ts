import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { SharedComputerSession } from "@shiba/shared";
import { ComputerSession } from "../src/computer-session.js";
import { handleSharedComputers } from "../src/shared-computer-routes.js";
import { computerDocumentPreview, computerDocumentAction, computerDocumentImportSchema, computerDocumentPreviewSchema } from "../src/shared-computer-documents.js";
import { computerInputArgv } from "../src/shared-computer-runtime.js";
import { readComputerRow, type SharedComputerEnv } from "../src/shared-computer-store.js";
import { signComputerOperation } from "../src/shared-computer-auth.js";
import { createTeamWorkspace, createTeamWorkspaceInvitation, acceptTeamWorkspaceInvitation, getTeamWorkspaceMembership } from "../src/team-workspaces-store.js";
import { createCollaborationRoom, addCollaborationMember, humanActorId } from "../src/collaboration-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const auth = vi.hoisted(() => ({ user: "owner@example.test", native: true, ids: {} as Record<string, string>, hook: undefined as (() => void) | undefined }));
const capture = vi.hoisted(() => ({ bytes: new Uint8Array([255, 216, 255, 217]), hook: undefined as (() => void) | undefined, gate: undefined as Promise<Response> | undefined }));
vi.mock("@shiba/auth/better-auth", async (original) => ({ ...await original<typeof import("@shiba/auth/better-auth")>(), resolveBetterAuthSessionAccount: async () => {
  auth.hook?.(); return auth.native ? { policy: { accountId: auth.ids[auth.user], email: auth.user, kind: auth.user === "operator@example.test" ? "bootstrap" : "invited" }, emailVerified: true } : null;
} }));
vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(), isAuthorizedRequest: async () => true, resolveUserId: async () => auth.user }));
vi.mock("@cloudflare/sandbox", () => ({ Files: class { async readFile() { capture.hook?.(); return capture.gate ?? new Response(capture.bytes); } } }));
const OWNER = "owner@example.test", OPERATOR = "operator@example.test", VIEWER = "viewer@example.test", OTHER = "other@example.test";
const IMAGE = `registry.cloudflare.com/test/offline@sha256:${"a".repeat(64)}`;
beforeEach(() => { auth.user = OWNER; auth.native = true; auth.ids = {}; auth.hook = undefined; capture.bytes = new Uint8Array([255, 216, 255, 217]); capture.hook = undefined; capture.gate = undefined; });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function fixture() {
  const db = customAgentD1();
  db.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT UNIQUE,emailVerified INTEGER); CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT,kind TEXT)');
  for (const email of [OWNER, OPERATOR, VIEWER, OTHER]) { const uuid = crypto.randomUUID(); auth.ids[email] = uuid; db.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(uuid, email); db.sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?,?)").run(uuid, email, email === OPERATOR ? "bootstrap" : "invited"); }
  const calls: string[][] = [], starts: unknown[] = [], instances = new Map<string, ComputerSession>(), containers = new Map<string, FakeContainer>();
  let failStart = false, failInput = false, failDestroy = false;
  class FakeContainer {
    running = false; images = { computer: IMAGE }; labels: Record<string, string> = {}; actualImage = IMAGE;
    start(options: { image: string; labels: Record<string, string> }) { starts.push(options); if (failStart) throw new Error("unknown start"); this.running = true; this.actualImage = options.image; this.labels = options.labels; }
    async inspect() { return this.running ? { image: this.actualImage, labels: this.labels } : null; }
    async setInactivityTimeout() {}
    async exec(argv: string[]) { calls.push(argv); if (failInput && argv[0] === "xdotool") throw new Error("unknown input"); return { stdout: new ReadableStream({ start(c) { c.close(); } }), stderr: new ReadableStream({ start(c) { c.close(); } }), exitCode: Promise.resolve(0) }; }
    async destroy() { if (failDestroy) throw new Error("unknown stop"); this.running = false; }
  }
  const env = { AGENT_AUDIT: db.database, SHIBA_SHARED_COMPUTER: "1", SHIBA_SHARED_COMPUTER_IMAGE: IMAGE, INTERNAL_SIGNING_KEY: "fixture-only-internal-control-key-20261105" } as SharedComputerEnv;
  const id = (name: string) => ({ name, equals(other: { name: string }) { return other.name === name; } });
  env.ComputerSession = { idFromName: id, get(value: { name: string }) {
    if (!instances.has(value.name)) {
      const sqlite = new DatabaseSync(":memory:"), map = new Map<string, unknown>(), container = new FakeContainer(); containers.set(value.name, container);
      const ctx = { id: value, container, storage: { sql: { exec(sql: string, ...args: unknown[]) { const statement = sqlite.prepare(sql); if (/^SELECT/.test(sql)) { const result = statement.all(...args as never[]); return { rowsWritten: 0, toArray: () => result }; } const result = statement.run(...args as never[]); return { rowsWritten: Number(result.changes), toArray: () => [] }; } },
        get: async (key: string) => map.get(key), put: async (key: string, val: unknown) => { map.set(key, val); }, setAlarm: async () => {}, deleteAlarm: async () => {} } };
      instances.set(value.name, new ComputerSession(ctx as unknown as DurableObjectState, env));
    }
    return instances.get(value.name)!;
  } } as unknown as NonNullable<SharedComputerEnv["ComputerSession"]>;
  for (const key of ["AI", "Sandbox", "CodingOrchestrator", "Memory", "LOCAL_ADAPTER_TOKEN", "GITHUB_TOKEN", "SLACK_BOT_TOKEN", "AI_GATEWAY_TOKEN"])
    Object.defineProperty(env, key, { get() { throw new Error(`Offline computer must not access ${key}`); } });
  const workspace = await createTeamWorkspace(env, OWNER, { name: "Computer workspace" });
  for (const [email, role] of [[OPERATOR, "admin"], [VIEWER, "member"], [OTHER, "member"]] as const) {
    const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, OWNER, { email, role }); await acceptTeamWorkspaceInvitation(env, email, invite.token);
  }
  const roomId = `room_${"d".repeat(24)}`, scope = { tenantId: "self-hosted", workspaceId: workspace.workspaceId, userId: OWNER };
  await createCollaborationRoom(env, scope, { roomId, title: "Desktop room", visibility: "shared", createdAt: 1 });
  for (const email of [OPERATOR, VIEWER]) await addCollaborationMember(env, scope, roomId, { userId: email, actorId: humanActorId(email), displayName: email, kind: "human", createdAt: 2 });
  const selections = await Promise.all([OWNER, OPERATOR, VIEWER].map(async (email) => ({ userId: email, version: (await getTeamWorkspaceMembership(env, workspace.workspaceId, email))!.version })));
  const input = { requestId: crypto.randomUUID(), roomId, fundingMember: selections[1]!, viewers: [selections[0]!, selections[2]!], controllers: [OWNER, VIEWER], expiresAt: Date.now() + 300_000 };
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", options: RequestInit = {}) => new Request(`https://shiba.test/api/shared-computers${path}`, { method, headers: { Origin: "https://shiba.test", "Content-Type": "application/json", "X-Shiba-Workspace": workspace.workspaceId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options });
  const call = async (path: string, body?: unknown, method?: string, options?: RequestInit) => { const response = await handleSharedComputers(request(path, body, method, options), env); const payload = response!.headers.get("content-type")?.includes("json") ? await response!.json() as Record<string, unknown> : {}; return { response: response!, body: payload, session: payload.session as SharedComputerSession }; };
  const prepare = async (changes: Record<string, unknown> = {}) => { auth.user = OWNER; const result = await call("/sessions/prepare", { ...input, ...changes }); expect(result.response.status, JSON.stringify(result.body)).toBe(201); return result.session; };
  const review = (s: SharedComputerSession) => ({ expectedVersion: s.version, digest: s.digest, reviewed: true });
  const fund = async (s = undefined as SharedComputerSession | undefined) => { const draft = s ?? await prepare(); auth.user = OPERATOR; const result = await call(`/sessions/${draft.id}/fund`, { ...review(draft), billingConsent: true }); expect(result.response.status, JSON.stringify(result.body)).toBe(200); return result.session; };
  const start = async (s = undefined as SharedComputerSession | undefined) => { const funded = s ?? await fund(); auth.user = OWNER; const result = await call(`/sessions/${funded.id}/start`, { ...review(funded), sharedDisplayConsent: true }); expect(result.response.status, JSON.stringify(result.body)).toBe(200); return result.session; };
  const lease = async (s: SharedComputerSession) => { const result = await call(`/sessions/${s.id}/lease`, { expectedVersion: s.version, digest: s.digest, leaseMs: 60_000 }); expect(result.response.status, JSON.stringify(result.body)).toBe(200); return result.session; };
  const action = (s: SharedComputerSession, changes: Record<string, unknown> = {}) => ({ requestId: crypto.randomUUID(), expectedVersion: s.version, digest: s.digest, leaseVersion: s.lease!.version, sequence: s.nextSequence, action: { type: "type", text: "Shared local text" }, ...changes });
  return { ...db, env, roomId, workspace, input, call, request, prepare, review, fund, start, lease, action, starts, calls, instances, containers,
    failStart: () => { failStart = true; }, failInput: () => { failInput = true; }, failDestroy: () => { failDestroy = true; } };
}
describe("separate native-funded offline shared computer, real SQLite/DO with fake container", { timeout: 20_000 }, () => {
  it.each(["disabled", "missing-binding", "missing-image"])("fails closed for %s without allocating", async (mode) => {
    const f = await fixture(); if (mode === "disabled") f.env.SHIBA_SHARED_COMPUTER = "0"; if (mode === "missing-binding") delete f.env.ComputerSession; if (mode === "missing-image") delete f.env.SHIBA_SHARED_COMPUTER_IMAGE;
    expect((await f.call("/sessions/prepare", f.input)).response.status).toBe(503); expect(f.starts).toHaveLength(0); expect(f.instances.size).toBe(0);
  });
  it("requires owner review and distinct explicit operator funding before one allocation", async () => {
    const f = await fixture(), draft = await f.prepare(); expect(f.starts).toHaveLength(0); expect(f.instances.size).toBe(0);
    expect((await f.call(`/sessions/${draft.id}/start`, { ...f.review(draft), sharedDisplayConsent: true })).response.status).toBe(403);
    expect((await f.call(`/sessions/${draft.id}/fund`, { ...f.review(draft), billingConsent: true })).response.status).toBe(403);
    const funded = await f.fund(draft); expect(f.starts).toHaveLength(0); const running = await f.start(funded);
    expect(running).toMatchObject({ state: "running", consumed: true, contract: { internet: false, credentials: null, sources: [], purpose: "offline-human-desktop" } });
    expect(f.starts).toEqual([{ image: IMAGE, instance: "standard-1", enableInternet: false, env: { SHIBA_COMPUTER_EXPIRES_AT: String(funded.contract.expiresAt) }, labels: { purpose: "offline-desktop", session: running.id } }]);
    await f.call(`/sessions/${funded.id}/start`, { ...f.review(funded), sharedDisplayConsent: true }); expect(f.starts).toHaveLength(1);
  });
  it("does not let a workspace manager or room agent confer deployment billing", async () => {
    const f = await fixture(); expect((await f.call("/sessions/prepare", { ...f.input, fundingMember: f.input.viewers[0] })).response.status).toBe(409);
    auth.user = VIEWER; expect((await f.call("/sessions/prepare", f.input)).response.status).toBe(403); expect(f.starts).toHaveLength(0);
  });
  it("rejects Access-only, bearer, foreign, extra fields, excess TTL and non-viewer controllers", async () => {
    const f = await fixture(); auth.native = false; expect((await f.call("/sessions/prepare", f.input)).response.status).toBe(403); auth.native = true;
    expect((await f.call("/sessions/prepare", { ...f.input, codingModel: "x" })).response.status).toBe(400);
    expect((await f.call("/sessions/prepare", { ...f.input, expiresAt: Date.now() + 601_000 })).response.status).toBe(400);
    expect((await f.call("/sessions/prepare", { ...f.input, controllers: [OTHER] })).response.status).toBe(400);
    auth.user = OTHER; expect((await f.call(`/state?roomId=${f.roomId}`)).response.status).toBe(404); expect(f.starts).toHaveLength(0);
  });
  it("has only one exclusive controller and serializes bounded one-shot input", async () => {
    const f = await fixture(), running = await f.start(); auth.user = OWNER; const leased = await f.lease(running);
    auth.user = VIEWER; expect((await f.call(`/sessions/${running.id}/lease`, { expectedVersion: leased.version, digest: leased.digest, leaseMs: 60_000 })).response.status).toBe(409);
    auth.user = OWNER; const input = f.action(leased), result = await f.call(`/sessions/${leased.id}/input`, input); expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    await f.call(`/sessions/${leased.id}/input`, input);
    expect(f.calls.filter((argv) => argv[0] === "xdotool")).toEqual([["xdotool", "type", "--clearmodifiers", "--delay", "0", "--", "Shared local text"]]);
    expect(f.sqlite.prepare("SELECT status FROM shared_computer_commands").get()).toEqual({ status: "completed" });
    expect(JSON.stringify(f.sqlite.prepare("SELECT * FROM shared_computer_commands").all())).not.toContain("Shared local text");
  });
  it("retains an unknown input and never retries it", async () => {
    const f = await fixture(), leased = await f.lease(await f.start()); f.failInput(); const input = f.action(leased);
    expect((await f.call(`/sessions/${leased.id}/input`, input)).response.status).toBe(503); await f.call(`/sessions/${leased.id}/input`, input);
    expect(f.calls.filter((argv) => argv[0] === "xdotool")).toHaveLength(1); expect(f.sqlite.prepare("SELECT status FROM shared_computer_commands").get()).toEqual({ status: "unknown" });
  });
  it("retains consumed start after lost acknowledgment and cannot reuse the approval", async () => {
    const f = await fixture(), funded = await f.fund(); f.failStart(); auth.user = OWNER;
    const body = { ...f.review(funded), sharedDisplayConsent: true }; expect((await f.call(`/sessions/${funded.id}/start`, body)).response.status).toBe(503);
    await f.call(`/sessions/${funded.id}/start`, body); expect(f.starts).toHaveLength(1); expect(f.sqlite.prepare("SELECT consumed FROM shared_computer_sessions").get()).toEqual({ consumed: 1 });
  });
  it("blocks funding revocation and expired review before allocation", async () => {
    const f = await fixture(), funded = await f.fund(); auth.user = OWNER;
    f.sqlite.prepare("UPDATE team_workspace_memberships SET version=version+1 WHERE workspace_id=? AND user_id=?").run(f.workspace.workspaceId, OPERATOR);
    expect((await f.call(`/sessions/${funded.id}/start`, { ...f.review(funded), sharedDisplayConsent: true })).response.status).toBe(403); expect(f.starts).toHaveLength(0);
  });
  it("refuses another deployment's workspace slot while an unknown allocation is retained", async () => {
    const f = await fixture(), funded = await f.fund();
    // A consumed allocation in another workspace holds the global slot. The
    // response contains no foreign ID, owner or private room information.
    f.sqlite.prepare("INSERT INTO shared_computer_sessions SELECT 'scs_foreign','foreign-workspace','foreign-room',owner_account_id,'foreign-request',request_hash,1,digest,binding_json,contract_json,'unknown',1,NULL,NULL,0,0,0,0,0,0,0,0,created_at,updated_at FROM shared_computer_sessions WHERE id=?").run(funded.id);
    auth.user = OWNER; const refused = await f.call(`/sessions/${funded.id}/start`, { ...f.review(funded), sharedDisplayConsent: true });
    expect(refused.response.status).toBe(409); expect(JSON.stringify(refused.body)).not.toContain("foreign-workspace"); expect(f.starts).toHaveLength(0);
  });
  it("rejects mismatched frozen image without starting or falling back to coding runtime", async () => {
    const f = await fixture(), funded = await f.fund(); const ns = f.env.ComputerSession!, get = ns.get.bind(ns);
    vi.spyOn(ns, "get").mockImplementation((id) => { const stub = get(id); f.containers.get(funded.id)!.images.computer = `registry.cloudflare.com/other@sha256:${"b".repeat(64)}`; return stub; });
    auth.user = OWNER; expect((await f.call(`/sessions/${funded.id}/start`, { ...f.review(funded), sharedDisplayConsent: true })).response.status).toBe(503); expect(f.starts).toHaveLength(0);
  });
  it("ends in a current source fence after runtime inspection and before input", async () => {
    const f = await fixture(), leased = await f.lease(await f.start()), container = f.containers.get(leased.id)!;
    const inspect = container.inspect.bind(container);
    vi.spyOn(container, "inspect").mockImplementation(async () => { const result = await inspect(); f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE room_id=? AND user_id=?").run(f.roomId, VIEWER); return result; });
    expect((await f.call(`/sessions/${leased.id}/input`, f.action(leased))).response.status).toBe(503); expect(f.calls.some((argv) => argv[0] === "xdotool")).toBe(false);
  });
  it("binds duplicate preparation to the same expiry and audience", async () => {
    const f = await fixture(), first = await f.prepare(); const duplicate = await f.prepare(); expect(duplicate.id).toBe(first.id);
    expect((await f.call("/sessions/prepare", { ...f.input, expiresAt: f.input.expiresAt + 1000 })).response.status).toBe(409); expect(f.starts).toHaveLength(0);
  });
  it("refuses an expired controller lease without dispatching", async () => {
    const f = await fixture(), leased = await f.lease(await f.start()); f.sqlite.prepare("UPDATE shared_computer_sessions SET lease_expires_at=1 WHERE id=?").run(leased.id);
    expect((await f.call(`/sessions/${leased.id}/input`, f.action(leased))).response.status).toBe(409); expect(f.calls.some((argv) => argv[0] === "xdotool")).toBe(false);
  });
  it("permanently invalidates room remove/re-add and never shows cached screenshots", async () => {
    const f = await fixture(), running = await f.start();
    f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE room_id=? AND user_id=?").run(f.roomId, VIEWER);
    f.sqlite.prepare("UPDATE collaboration_memberships SET status='active' WHERE room_id=? AND user_id=?").run(f.roomId, VIEWER);
    expect((await f.call(`/sessions/${running.id}/capture`, { expectedVersion: running.version })).response.status).toBe(409);
    expect(f.calls.some((x) => x[0] === "scrot")).toBe(false); expect(f.sqlite.prepare("SELECT state FROM shared_computer_sessions").get()).toEqual({ state: "blocked" });
    await f.instances.get(running.id)!.alarm(); expect(f.containers.get(running.id)!.running).toBe(false);
  });
  it("checks native UUID replacement and grant expiry before input without fallback", async () => {
    const f = await fixture(), leased = await f.lease(await f.start());
    f.sqlite.prepare('UPDATE "user" SET emailVerified=0 WHERE id=?').run(auth.ids[OWNER]!);
    expect((await f.call(`/sessions/${leased.id}/input`, f.action(leased))).response.status).toBe(403); expect(f.calls.some((x) => x[0] === "xdotool")).toBe(false);
  });
  it("captures only for named viewers, returns no-store JPEG and rechecks source after capture", async () => {
    const f = await fixture(), running = await f.start(); auth.user = OPERATOR;
    expect((await f.call(`/sessions/${running.id}/capture`, { expectedVersion: running.version })).response.status).toBe(403);
    auth.user = OWNER; const frame = await f.call(`/sessions/${running.id}/capture`, { expectedVersion: running.version });
    expect(frame.response.status, JSON.stringify(frame.body)).toBe(200); expect(frame.response.headers.get("cache-control")).toContain("no-store"); expect(frame.response.headers.get("content-type")).toBe("image/jpeg");
    f.sqlite.prepare("UPDATE shared_computer_sessions SET last_frame_at=0 WHERE id=?").run(running.id);
    capture.hook = () => { f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE room_id=? AND user_id=?").run(f.roomId, VIEWER); };
    expect((await f.call(`/sessions/${running.id}/capture`, { expectedVersion: running.version })).response.status).toBe(403);
  });
  it("rejects oversized screenshots instead of truncating or leaking them", async () => {
    const f = await fixture(), running = await f.start(); capture.bytes = new Uint8Array(524_289);
    expect((await f.call(`/sessions/${running.id}/capture`, { expectedVersion: running.version })).response.status).toBe(503);
  });
  it("allows retained native owner STOP after membership removal and stops only this desktop", async () => {
    const f = await fixture(), running = await f.start();
    f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE workspace_id=? AND user_id=?").run(f.workspace.workspaceId, OWNER);
    expect((await f.call(`/sessions/${running.id}/stop`, { expectedVersion: 1 })).response.status).toBe(200); expect(f.containers.get(running.id)!.running).toBe(false);
    expect(f.calls).toEqual([["/usr/local/bin/shiba-computer-ready"]]);
  });
  it("keeps capacity occupied when destruction is uncertain", async () => {
    const f = await fixture(), running = await f.start(); f.failDestroy();
    expect((await f.call(`/sessions/${running.id}/stop`, { expectedVersion: running.version })).response.status).toBe(503);
    const next = await f.prepare({ requestId: crypto.randomUUID() }), funded = await f.fund(next); auth.user = OWNER;
    expect((await f.call(`/sessions/${funded.id}/start`, { ...f.review(funded), sharedDisplayConsent: true })).response.status).toBe(409); expect(f.starts).toHaveLength(1);
  });
  it("withdraws an unconsumed draft without any runtime lookup while another desktop runs", async () => {
    const f = await fixture(); await f.start(); const draft = await f.prepare({ requestId: crypto.randomUUID() }), before = f.instances.size;
    expect((await f.call(`/sessions/${draft.id}/stop`, { expectedVersion: draft.version })).response.status).toBe(200);
    expect(f.instances.size).toBe(before); expect(f.starts).toHaveLength(1); expect(f.sqlite.prepare("SELECT state,consumed FROM shared_computer_sessions WHERE id=?").get(draft.id)).toEqual({ state: "stopped", consumed: 0 });
  });
  it("does not allocate or restart on state reads or unknown HTTP routes", async () => {
    const f = await fixture(); expect((await f.call(`/state?roomId=${f.roomId}`)).response.status).toBe(200); expect(f.instances.size).toBe(0);
    const running = await f.start(); expect((await f.instances.get(running.id)!.fetch()).status).toBe(404); expect(f.starts).toHaveLength(1);
  });
  it("requires a Worker-signed operation before guessed RPC allocation, read, input or destruction", async () => {
    const f = await fixture(), funded = await f.fund();
    const runtime = f.env.ComputerSession!.get(f.env.ComputerSession!.idFromName(funded.id));
    const guessed = { body: { sessionId: funded.id, accountId: auth.ids[OWNER] }, signature: "0".repeat(64) } as never;
    await expect(runtime.startSession(guessed)).rejects.toThrow(); await expect(runtime.captureFrame(guessed)).rejects.toThrow(); await expect(runtime.applyInput(guessed, { type: "key", key: "Tab" })).rejects.toThrow(); await expect(runtime.stopSession(guessed)).rejects.toThrow();
    expect(f.starts).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });
  it("durably retires STOP before releasing an older start authority snapshot", async () => {
    const f = await fixture(), funded = await f.fund(), prepare = f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);
    let entered!: () => void, release!: () => void, held = false;
    const arrived = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(f.env.AGENT_AUDIT, "prepare").mockImplementation((sql) => {
      const wrap = (statement: D1PreparedStatement, values: unknown[] = []): D1PreparedStatement => ({ ...statement,
        bind: (...args: unknown[]) => wrap(statement.bind(...args), args),
        first: async <T>() => { const snapshot = await statement.first<T>(); if (!held && values.length === 5 && sql.includes("SELECT 1 AS current FROM shared_computer_sessions s WHERE")) { held = true; entered(); await gate; } return snapshot; },
      } as D1PreparedStatement); return wrap(prepare(sql));
    });
    auth.user = OWNER;
    const starting = f.call(`/sessions/${funded.id}/start`, { ...f.review(funded), sharedDisplayConsent: true });
    await arrived;
    const stopped = await f.call(`/sessions/${funded.id}/stop`, { expectedVersion: funded.version }); expect(stopped.response.status).toBe(200); expect(f.starts).toHaveLength(0);
    release(); expect((await starting).response.status).toBe(503); expect(f.starts).toHaveLength(0);
    expect(f.sqlite.prepare("SELECT state,consumed FROM shared_computer_sessions WHERE id=?").get(funded.id)).toEqual({ state: "stopped", consumed: 1 });
  });
  it("rejects altered, wrong-operation, foreign-native and replayed signed RPC capsules", async () => {
    const f = await fixture(), running = await f.start(), runtime = f.instances.get(running.id)!, row = await readComputerRow(f.env, f.workspace.workspaceId, running.id);
    const actor = { accountId: auth.ids[OWNER]!, userId: OWNER };
    const captureOp = await signComputerOperation(f.env, row, actor, { operation: "capture" });
    await expect(runtime.stopSession(captureOp)).rejects.toThrow();
    await expect(runtime.captureFrame({ ...captureOp, body: { ...captureOp.body, accountId: auth.ids[VIEWER]! } })).rejects.toThrow();
    const foreign = await signComputerOperation(f.env, row, { accountId: auth.ids[OTHER]!, userId: OTHER }, { operation: "capture" });
    await expect(runtime.captureFrame(foreign)).rejects.toThrow();
    await runtime.captureFrame(captureOp); await expect(runtime.captureFrame(captureOp)).rejects.toThrow();
    expect(f.calls.filter((argv) => argv[0] === "scrot")).toHaveLength(1); expect(f.containers.get(running.id)!.running).toBe(true);
  });
  it("expires operation capsules before their first read/effect and after runtime awaits", async () => {
    const f = await fixture(), leased = await f.lease(await f.start()), runtime = f.instances.get(leased.id)!, row = await readComputerRow(f.env, f.workspace.workspaceId, leased.id);
    const op = await signComputerOperation(f.env, row, { accountId: auth.ids[OWNER]!, userId: OWNER }, { operation: "capture" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(op.body.expiresAt + 1);
    await expect(runtime.captureFrame(op)).rejects.toThrow(); expect(f.calls.some((argv) => argv[0] === "scrot")).toBe(false); clock.mockRestore();
    const container = f.containers.get(leased.id)!, inspect = container.inspect.bind(container), future = Date.now() + 20000;
    vi.spyOn(container, "inspect").mockImplementation(async () => { const result = await inspect(); vi.spyOn(Date, "now").mockReturnValue(future); return result; });
    expect((await f.call(`/sessions/${leased.id}/input`, f.action(leased))).response.status).toBe(503); expect(f.calls.some((argv) => argv[0] === "xdotool")).toBe(false);
  });
  it("rejects a signed non-owner STOP and a stale generation without destroying the desktop", async () => {
    const f = await fixture(), running = await f.start(), runtime = f.instances.get(running.id)!, row = await readComputerRow(f.env, f.workspace.workspaceId, running.id);
    const foreign = await signComputerOperation(f.env, row, { accountId: auth.ids[VIEWER]!, userId: VIEWER }, { operation: "stop" });
    await expect(runtime.stopSession(foreign)).rejects.toThrow();
    const stale = await signComputerOperation(f.env, row, { accountId: auth.ids[OWNER]!, userId: OWNER }, { operation: "stop" });
    await f.lease(running); await expect(runtime.stopSession(stale)).rejects.toThrow(); expect(f.containers.get(running.id)!.running).toBe(true);
  });
  it("bounds an exec ignoring abort, never retries input and destroys via its private alarm", async () => {
    const f = await fixture(), leased = await f.lease(await f.start()), container = f.containers.get(leased.id)!, exec = container.exec.bind(container);
    let entered!: () => void; const arrived = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(container, "exec").mockImplementation(async (argv) => { if (argv[0] !== "xdotool") return exec(argv); f.calls.push(argv); entered(); return await new Promise<never>(() => {}); });
    vi.useFakeTimers(); const pending = f.call(`/sessions/${leased.id}/input`, f.action(leased)); await arrived;
    await vi.advanceTimersByTimeAsync(5001); expect((await pending).response.status).toBe(503); expect(f.calls.filter((argv) => argv[0] === "xdotool")).toHaveLength(1);
    vi.useRealTimers(); await f.instances.get(leased.id)!.alarm(); expect(container.running).toBe(false);
  });
  it("bounds Files.readFile even when its transport ignores abort", async () => {
    const f = await fixture(), running = await f.start(); let entered!: () => void; const arrived = new Promise<void>((resolve) => { entered = resolve; });
    capture.hook = entered; capture.gate = new Promise<Response>(() => {});
    vi.useFakeTimers(); const pending = f.call(`/sessions/${running.id}/capture`, { expectedVersion: running.version }); await arrived;
    await vi.advanceTimersByTimeAsync(5001); expect((await pending).response.status).toBe(503);
  });
  it("bounds unknown destruction and retains the consumed deployment slot", async () => {
    const f = await fixture(), running = await f.start(), container = f.containers.get(running.id)!;
    let entered!: () => void; const arrived = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(container, "destroy").mockImplementation(async () => { entered(); await new Promise<void>(() => {}); });
    vi.useFakeTimers(); const pending = f.call(`/sessions/${running.id}/stop`, { expectedVersion: running.version }); await arrived;
    await vi.advanceTimersByTimeAsync(5001); expect((await pending).response.status).toBe(503); expect(f.sqlite.prepare("SELECT state,consumed FROM shared_computer_sessions").get()).toEqual({ state: "unknown", consumed: 1 });
  });
  it("keeps the append-only migration in parity with runtime schema", async () => {
    const f = await fixture(); await f.prepare(); f.sqlite.exec(readFileSync(new URL("../migrations/0019_shared_computers.sql", import.meta.url), "utf8")); expect(f.starts).toHaveLength(0);
  });
});
describe("typed offline desktop input construction", () => {
  it("preserves metacharacters as one argument without a shell", () => { expect(computerInputArgv({ type: "type", text: "; touch /tmp/x $(id)" }).at(-1)).toBe("; touch /tmp/x $(id)"); });
  it.each([{ type: "click", x: -1, y: 0, button: "left" }, { type: "click", x: 1024, y: 0, button: "left" }, { type: "key", key: "exec" }, { type: "type", text: "a\u0000b" }, { type: "scroll", direction: "up", ticks: 6 }, { type: "type", text: "😀".repeat(300) }])("rejects invalid input before runtime", (value) => { expect(() => computerInputArgv(value as never)).toThrow(); });
});

describe("bundled public document import, offline fixture only", { timeout: 20_000 }, () => {
  const documentId = "rfc2606-example-domains-v1";
  async function reviewed(f: Awaited<ReturnType<typeof fixture>>, s: SharedComputerSession) {
    const result = await f.call(`/sessions/${s.id}/documents/preview`, { expectedVersion: s.version, documentId });
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    return result.body.document as { text: string; documentDigest: string; format: string };
  }
  const importBody = (f: Awaited<ReturnType<typeof fixture>>, s: SharedComputerSession, documentDigest: string) => {
    const { action: _action, ...input } = f.action(s);
    return { ...input, documentId, documentDigest, reviewed: true };
  };
  it("previews exact bounded text and types once without fetch, cookies, tokens or networking", async () => {
    const f = await fixture(), leased = await f.lease(await f.start());
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No public retrieval authorized"));
    const preview = await reviewed(f, leased), input = importBody(f, leased, preview.documentDigest);
    expect(preview.format).toBe("inert-text-snapshot");
    expect(new TextEncoder().encode(preview.text).length).toBeLessThanOrEqual(1024);
    const path = `/sessions/${leased.id}/documents/import`;
    expect((await f.call(path, input)).response.status).toBe(200);
    expect((await f.call(path, input)).response.status).not.toBe(200);
    expect(f.calls.filter((a) => a[0] === "xdotool")).toEqual([computerInputArgv({ type: "type", text: preview.text })]);
    expect(network).not.toHaveBeenCalled();
    expect(f.starts).toMatchObject([{ enableInternet: false }]);
    const audit = JSON.stringify(f.sqlite.prepare("SELECT * FROM shared_computer_commands").all());
    expect(audit).not.toContain(preview.text);
  });
  it("binds reviewed bytes to session, version and digest and refuses unreviewed or substituted content", async () => {
    const f = await fixture(), leased = await f.lease(await f.start()), preview = await reviewed(f, leased);
    const path = `/sessions/${leased.id}/documents/import`, input = importBody(f, leased, preview.documentDigest);
    for (const changes of [{ reviewed: false }, { documentDigest: "0".repeat(64) }, { text: "secret replacement" }, { action: { type: "type", text: "replacement" } }, { expectedVersion: leased.version + 1 }, { digest: "0".repeat(64) }])
      expect((await f.call(path, { ...input, ...changes })).response.status).not.toBe(200);
    const row = await readComputerRow(f.env, f.workspace.workspaceId, leased.id);
    for (const changed of [{ ...row, workspace_id: "foreign" }, { ...row, id: `scs_${"f".repeat(32)}` }, { ...row, version: row.version + 1 }, { ...row, digest: "0".repeat(64) }]) {
      expect((await computerDocumentPreview(changed)).documentDigest).not.toBe(preview.documentDigest);
      await expect(computerDocumentAction(changed, computerDocumentImportSchema.parse(input))).rejects.toThrow("shared_computer_document_changed");
    }
    expect(f.calls.some((a) => a[0] === "xdotool")).toBe(false);
  });
  it.each(["http://127.0.0.1", "http://169.254.169.254/latest/meta-data", "https://[::1]", "https://public.test/redirect", "https://rebind.test", "https://user:password@public.test", "file:///etc/passwd"])("does not accept a URL or redirect target: %s", async (url) => {
    const f = await fixture(), leased = await f.lease(await f.start()), preview = await reviewed(f, leased);
    expect((await f.call(`/sessions/${leased.id}/documents/preview`, { expectedVersion: leased.version, documentId: url })).response.status).toBe(400);
    expect((await f.call(`/sessions/${leased.id}/documents/import`, { ...importBody(f, leased, preview.documentDigest), url })).response.status).toBe(400);
    expect(f.calls.some((a) => a[0] === "xdotool")).toBe(false);
  });
  it("rejects oversized and credential-bearing extensions without consuming the sequence", async () => {
    const f = await fixture(), leased = await f.lease(await f.start()), preview = await reviewed(f, leased);
    const path = `/sessions/${leased.id}/documents/import`, input = importBody(f, leased, preview.documentDigest);
    expect((await f.call(path, { ...input, text: "x".repeat(9000) })).response.status).toBe(413);
    for (const extra of [{ cookies: "session=secret" }, { authorization: "secret" }, { agentId: "agent" }, { redirect: "follow" }])
      expect((await f.call(path, { ...input, ...extra })).response.status).toBe(400);
    expect((await f.call(path, input)).response.status).toBe(200);
    expect(computerDocumentPreviewSchema.safeParse({ expectedVersion: 1, documentId, url: "https://other.test" }).success).toBe(false);
  });
  it("separates native viewers and controllers and denies foreign workspaces and bearer agents", async () => {
    const f = await fixture(), draft = await f.prepare({ controllers: [OWNER] }), leased = await f.lease(await f.start(await f.fund(draft))), preview = await reviewed(f, leased);
    const path = `/sessions/${leased.id}/documents/import`, input = importBody(f, leased, preview.documentDigest);
    auth.user = VIEWER;
    expect((await reviewed(f, leased)).documentDigest).toBe(preview.documentDigest);
    expect((await f.call(path, input)).response.status).not.toBe(200);
    auth.user = OTHER;
    expect((await f.call(`/sessions/${leased.id}/documents/preview`, { expectedVersion: leased.version, documentId })).response.status).not.toBe(200);
    auth.user = OWNER; auth.native = false;
    expect((await f.call(path, input)).response.status).toBe(403);
    auth.native = true;
    const headers = { Origin: "https://shiba.test", "Content-Type": "application/json", "X-Shiba-Workspace": f.workspace.workspaceId, Authorization: "Bearer fixture-agent" };
    expect((await f.call(path, input, "POST", { headers })).response.status).toBe(403);
    delete (headers as Partial<typeof headers>).Authorization;
    headers["X-Shiba-Workspace"] = "foreign-workspace";
    expect((await f.call(path, input, "POST", { headers })).response.status).not.toBe(200);
    expect(f.calls.some((a) => a[0] === "xdotool")).toBe(false);
  });
  it.each(["room", "account", "lease", "expiry", "stop"])("fences import after %s revocation", async (kind) => {
    const f = await fixture(), leased = await f.lease(await f.start()), preview = await reviewed(f, leased);
    if (kind === "room") f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE room_id=? AND user_id=?").run(f.roomId, VIEWER);
    if (kind === "account") f.sqlite.prepare('UPDATE "user" SET emailVerified=0 WHERE id=?').run(auth.ids[OWNER]!);
    if (kind === "lease") f.sqlite.prepare("UPDATE shared_computer_sessions SET lease_expires_at=1 WHERE id=?").run(leased.id);
    if (kind === "expiry") vi.spyOn(Date, "now").mockReturnValue(leased.contract.expiresAt + 1);
    if (kind === "stop") expect((await f.call(`/sessions/${leased.id}/stop`, { expectedVersion: leased.version })).response.status).toBe(200);
    expect((await f.call(`/sessions/${leased.id}/documents/import`, importBody(f, leased, preview.documentDigest))).response.status).not.toBe(200);
    expect(f.calls.some((a) => a[0] === "xdotool")).toBe(false);
  });
  it("never retries an uncertain import", async () => {
    const f = await fixture(), leased = await f.lease(await f.start()), preview = await reviewed(f, leased);
    f.failInput();
    const path = `/sessions/${leased.id}/documents/import`, input = importBody(f, leased, preview.documentDigest);
    expect((await f.call(path, input)).response.status).toBe(503);
    expect((await f.call(path, input)).response.status).not.toBe(200);
    expect(f.calls.filter((a) => a[0] === "xdotool")).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT status FROM shared_computer_commands").get()).toEqual({ status: "unknown" });
  });
});

describe("snapshot import authority revalidation", { timeout: 20_000 }, () => {
  it("rechecks native session after the input claim and before runtime dispatch", async () => {
    const f = await fixture(), leased = await f.lease(await f.start());
    const row = await readComputerRow(f.env, f.workspace.workspaceId, leased.id), preview = await computerDocumentPreview(row);
    const { action: _action, ...input } = f.action(leased);
    let checks = 0; auth.hook = () => { if (++checks === 2) auth.native = false; };
    const result = await f.call(`/sessions/${leased.id}/documents/import`, { ...input, documentId: preview.documentId, documentDigest: preview.documentDigest, reviewed: true });
    expect(result.response.status).toBe(503);
    expect(f.calls.some((a) => a[0] === "xdotool")).toBe(false);
    expect(f.sqlite.prepare("SELECT status FROM shared_computer_commands").get()).toEqual({ status: "unknown" });
  });
});
