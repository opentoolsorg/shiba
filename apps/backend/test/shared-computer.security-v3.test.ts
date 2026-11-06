// Shared route/SQLite/DO fixture setup follows shared-computers.test.ts. No policy implementation is duplicated.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SharedComputerSession } from "@shiba/shared";
import { ComputerSession } from "../src/computer-session.js";
import { handleSharedComputers } from "../src/shared-computer-routes.js";
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

describe("independent computer security v3", () => {
  it("allows a named viewer capture but cannot convert capture permission into a control lease", async () => {
    const f = await fixture(), running = await f.start(await f.fund(await f.prepare({ controllers: [OWNER] })));
    auth.user = VIEWER;
    expect((await f.call(`/sessions/${running.id}/capture`, { expectedVersion: running.version })).response.status).toBe(200);
    expect((await f.call(`/sessions/${running.id}/lease`, { expectedVersion: running.version, digest: running.digest, leaseMs: 60_000 })).response.status).toBe(403);
    expect(f.calls.some(x => x[0] === "xdotool")).toBe(false);
  });
  it.each(["stop", "remove-viewer", "replace-native-account"])("withholds a JPEG already in flight after %s", async (mode) => {
    const f = await fixture(), running = await f.start();
    let release!: (response: Response) => void, arrived!: () => void;
    const entered = new Promise<void>(resolve => { arrived = resolve; });
    capture.gate = new Promise<Response>(resolve => { release = resolve; }); capture.hook = arrived;
    const pending = f.call(`/sessions/${running.id}/capture`, { expectedVersion: running.version }); await entered;
    if (mode === "stop") expect((await f.call(`/sessions/${running.id}/stop`, { expectedVersion: running.version })).response.status).toBe(200);
    else if (mode === "remove-viewer") f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE room_id=? AND user_id=?").run(f.roomId, VIEWER);
    else f.sqlite.prepare('DELETE FROM "user" WHERE id=?').run(auth.ids[OWNER]!);
    release(new Response(new Uint8Array([255, 216, 255, 217])));
    const result = await pending;
    expect(result.response.status).toBeGreaterThanOrEqual(400);
    expect(result.response.headers.get("content-type")).not.toBe("image/jpeg");
    expect(f.starts).toHaveLength(1);
  });
});


describe("offline policy cannot be upgraded into online or agent authority", { timeout: 20_000 }, () => {
  it.each([
    ["internet", true],
    ["allowedDomains", ["example.test"]],
    ["credentials", { account: "fixture-only" }],
    ["purpose", "online-agent-desktop"],
    ["agentId", "agent:fixture"],
    ["controlMode", "agent"],
    ["sources", ["fixture-source"]],
  ])("rejects prepare extension %s before writing or allocating", async (field, value) => {
    const f = await fixture();
    const result = await f.call("/sessions/prepare", { ...f.input, [field as string]: value });
    expect(result.response.status).toBe(400);
    expect(result.body).toEqual({ error: "shared_computer_body_invalid" });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='shared_computer_sessions'").get()).toEqual({ count: 0 });
    expect(f.instances.size).toBe(0); expect(f.starts).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });
  it("refuses online escalation at every reviewed control gate without consuming valid authority", async () => {
    const f = await fixture(), draft = await f.prepare();
    auth.user = OPERATOR;
    expect((await f.call(`/sessions/${draft.id}/fund`, { ...f.review(draft), billingConsent: true, internet: true })).response.status).toBe(400);
    expect(f.sqlite.prepare("SELECT state,consumed FROM shared_computer_sessions WHERE id=?").get(draft.id)).toEqual({ state: "draft", consumed: 0 });
    const funded = await f.fund(draft); auth.user = OWNER;
    expect((await f.call(`/sessions/${funded.id}/start`, { ...f.review(funded), sharedDisplayConsent: true, allowedDomains: ["example.test"] })).response.status).toBe(400);
    expect(f.starts).toHaveLength(0);
    expect(f.sqlite.prepare("SELECT state,consumed FROM shared_computer_sessions WHERE id=?").get(draft.id)).toEqual({ state: "funded", consumed: 0 });
    const running = await f.start(funded);
    expect((await f.call(`/sessions/${running.id}/lease`, { expectedVersion: running.version, digest: running.digest, leaseMs: 60_000, controlMode: "agent" })).response.status).toBe(400);
    const leased = await f.lease(running), input = f.action(leased);
    expect((await f.call(`/sessions/${leased.id}/input`, { ...input, agentId: "agent:fixture" })).response.status).toBe(400);
    expect((await f.call(`/sessions/${leased.id}/input`, { ...input, action: { type: "navigate", url: "https://example.test" } })).response.status).toBe(400);
    expect((await f.call(`/sessions/${leased.id}/capture`, { expectedVersion: leased.version, audience: "agent:fixture" })).response.status).toBe(400);
    expect(f.sqlite.prepare("SELECT sequence,input_count,frame_count FROM shared_computer_sessions WHERE id=?").get(leased.id)).toEqual({ sequence: 0, input_count: 0, frame_count: 0 });
    expect(f.calls.filter(argv => ["xdotool", "scrot"].includes(argv[0]!))).toHaveLength(0);
    expect((await f.call(`/sessions/${leased.id}/input`, input)).response.status).toBe(200);
    expect(f.starts).toEqual([{ image: IMAGE, instance: "standard-1", enableInternet: false, env: { SHIBA_COMPUTER_EXPIRES_AT: String(funded.contract.expiresAt) }, labels: { purpose: "offline-desktop", session: running.id } }]);
  });
  it("does not reinterpret a signed human display capsule as agent or online authority", async () => {
    const f = await fixture(), running = await f.start(), runtime = f.instances.get(running.id)!;
    const row = await readComputerRow(f.env, f.workspace.workspaceId, running.id);
    const capsule = await signComputerOperation(f.env, row, { accountId: auth.ids[OWNER]!, userId: OWNER }, { operation: "capture" });
    for (const body of [
      { ...capsule.body, scope: "shiba.online-computer-operation.v1" },
      { ...capsule.body, details: { operation: "capture", audience: "agent:fixture" } },
      { ...capsule.body, internet: true },
    ]) await expect(runtime.captureFrame({ ...capsule, body } as never)).rejects.toThrow("shared_computer_operation_invalid");
    expect(f.calls.filter(argv => argv[0] === "scrot")).toHaveLength(0);
    await runtime.captureFrame(capsule);
    expect(f.calls.filter(argv => argv[0] === "scrot")).toHaveLength(1);
  });
});
