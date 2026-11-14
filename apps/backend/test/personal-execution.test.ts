import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localRunEnvelopeSchema, personalExecutionContextDigest, PERSONAL_CONTROL_BODY_LIMIT, PERSONAL_EVENTS_BODY_LIMIT, PERSONAL_RESULT_BODY_LIMIT, type PersonalExecutionSnapshot } from "@shiba/shared";
import { handleBetterAuth } from "../src/better-auth.js";
import type { Env } from "../src/env.js";
import { handlePersonalExecution } from "../src/personal-execution-routes.js";
import { LocalDispatch } from "../src/local-dispatch.js";
import { handleLocalAdapter } from "../src/local-routes.js";
import { createTeamWorkspace, createTeamWorkspaceInvitation, acceptTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import { resolvePersonalExecutionOwner, resolvePersonalExecutionGrant, revalidatePersonalExecutionSnapshot } from "../src/personal-execution-store.js";
import { sha256Hex } from "../src/agent-tokens.js";
import { handleCollaboration } from "../src/collaboration-routes.js";
import { handleRuns } from "../src/runs-routes.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { verifyInternalRequest } from "../src/edge-identity.js";
import { applyEmailOutboxSchema } from "./fixtures/email-outbox-schema.js";

const claim = vi.hoisted(() => ({ allowed: true, calls: 0, hook: undefined as (() => void | Promise<void>) | undefined }));
const sourceFence = vi.hoisted(() => ({ allowed: true, calls: 0 }));
const routed = vi.hoisted(() => ({ fetch: undefined as ((name: string, request: Request) => Promise<Response>) | undefined }));
vi.mock("../src/personal-execution-claim.js", () => ({ validatePersonalExecutionClaim: async () => { claim.calls++; await claim.hook?.(); return claim.allowed; } }));
vi.mock("../src/slack-coworker-store.js", async (original) => ({ ...await original<typeof import("../src/slack-coworker-store.js")>(), isSlackCoworkerClaimSourceCurrent: async () => { sourceFence.calls++; return sourceFence.allowed; } }));
vi.mock("agents/routing", async (original) => ({ ...await original<typeof import("agents/routing")>(), getAgentByName: async (_namespace: unknown, name: string) => ({ fetch: (input: Request | string) => {
  if (!routed.fetch) throw new Error("Unexpected agent lookup in personal foundation fixture.");
  return routed.fetch(name, input instanceof Request ? input : new Request(input));
} }) }));
const BASE = "https://personal.example.test", OWNER = "owner@example.test", ALICE = "alice@example.test", BOB = "bob@example.test";
const ACCOUNT = "a".repeat(64), AUTH = "b".repeat(64), REPO = "https://github.com/opentoolsorg/shiba";
const databases: DatabaseSync[] = [];
interface FixtureStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  transaction<T>(operation: (tx: FixtureStorage) => Promise<T>): Promise<T>;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); claim.allowed = true; claim.calls = 0; claim.hook = undefined; sourceFence.allowed = true; sourceFence.calls = 0; routed.fetch = undefined; });

function req(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, { method, headers: { Origin: BASE, "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const cookie = (response: Response) => response.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  applyEmailOutboxSchema(sqlite);
  databases.push(sqlite);
  const value = (input: unknown): never => (input instanceof Date ? input.getTime() : typeof input === "boolean" ? Number(input) : input ?? null) as never;
  const prepared = (sql: string, values: unknown[] = []) => ({
    bind: (...input: unknown[]) => prepared(sql, input),
    async all() { const results = sqlite.prepare(sql).all(...values.map(value)); return { results, meta: { changes: Number(sqlite.prepare("SELECT changes() c").get()?.c) } }; },
    async run() { return this.all(); },
    async first() { return sqlite.prepare(sql).get(...values.map(value)) ?? null; },
  });
  const database = { prepare: (sql: string) => prepared(sql), exec: (sql: string) => sqlite.exec(sql), async batch(statements: ReturnType<typeof prepared>[]) {
    sqlite.exec("BEGIN IMMEDIATE"); try { const result = []; for (const statement of statements) result.push(await statement.all()); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } } as unknown as D1Database;
  const send = vi.fn(async (_mail: unknown) => {});
  const env = { AGENT_AUDIT: database, BETTER_AUTH_SECRET: "s".repeat(32), BETTER_AUTH_URL: BASE,
    BETTER_AUTH_BOOTSTRAP_TOKEN: "fixture-bootstrap", BETTER_AUTH_VERIFICATION_FROM: "auth@example.test", SEND_EMAIL: { send },
    SHIBA_LOCAL_RUNTIME: "1", SHIBA_PERSONAL_LOCAL_EXECUTION: "1", PAIRING_SECRET: "fixture-pairing-key-at-least-32-characters", LOCAL_ADAPTER_TOKEN: "legacy-operator-token",
    INTERNAL_SIGNING_KEY: "fixture-internal-key-at-least-32-characters",
  } as unknown as Env;
  const map = new Map<string, unknown>();
  let transactionQueue = Promise.resolve();
  const storage: FixtureStorage = {
    async get<T>(key: string) { return map.get(key) as T | undefined; }, async put(key: string, input: unknown) { map.set(key, input); },
    async delete(key: string) { return map.delete(key); }, async list<T>({ prefix }: { prefix: string }) { return new Map([...map].filter(([key]) => key.startsWith(prefix))) as Map<string, T>; },
    transaction<T>(operation: (tx: FixtureStorage) => Promise<T>): Promise<T> { const pending = transactionQueue.then(() => operation(storage)); transactionQueue = pending.then(() => {}, () => {}); return pending; },
  };
  const dispatch = new LocalDispatch({ storage } as never, env);
  env.LocalDispatch = { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => dispatch.fetch(request) }) } as unknown as DurableObjectNamespace;
  const native = (request: Request) => handleBetterAuth(request, env, { teamMemberPolicyEnabled: true });
  expect((await native(req("/api/auth/sign-up/email", "POST", { name: "Owner", email: OWNER, password: "fixture-owner-password" }, { "x-shiba-bootstrap-token": "fixture-bootstrap" })))?.status).toBe(200);
  const workspace = await createTeamWorkspace(env, OWNER, { name: "Personal run fixture" });
  const cookies = new Map<string, string>();
  for (const email of [ALICE, BOB]) {
    const invitation = await createTeamWorkspaceInvitation(env, workspace.workspaceId, OWNER, { email, role: "member" });
    const registered = (await native(req("/api/auth/sign-up/email", "POST", { name: email, email, password: "fixture-member-password", callbackURL: "/app/" }, { "x-shiba-workspace-invitation": invitation.token })))!;
    expect(registered.status).toBe(200); cookies.set(email, cookie(registered));
    const mail = send.mock.calls.at(-1)?.[0] as { text?: string };
    const verification = mail.text?.match(/https:\/\/\S+/)?.[0]; if (!verification) throw new Error("Fixture verification URL missing.");
    expect((await native(new Request(verification)))?.status).toBe(302);
    await acceptTeamWorkspaceInvitation(env, email, invitation.token);
  }
  const headers = (email = ALICE) => ({ cookie: cookies.get(email)!, "X-Shiba-Workspace": workspace.workspaceId });
  const api = (path: string, method = "GET", body?: unknown, email = ALICE) => handlePersonalExecution(req(`/api/personal-execution${path}`, method, body, headers(email)), env);
  const local = (path: string, body: unknown, token?: string) => handleLocalAdapter(req(`/api/local/${path}`, "POST", body, token ? { Authorization: `Bearer ${token}` } : {}), env);
  const http = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.github.com/repos/opentoolsorg/shiba");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    return Response.json({ private: false, html_url: REPO });
  });
  vi.stubGlobal("fetch", http);
  async function pair(email = ALICE) {
    const minted = await api("/pairing-token", "POST", { harness: "claude-code", accountFingerprint: ACCOUNT }, email);
    expect(minted?.status).toBe(200);
    const token = await minted!.json() as { token: string; connectCommand: string };
    expect(token.connectCommand).toContain(`--personal-harness claude-code --personal-billing native-subscription --personal-account ${ACCOUNT}`);
    const response = await local("pair", { pairingToken: token.token, hostname: "Own computer", platform: "linux-x64", daemonVersion: "fixture", harnesses: ["claude", "codex"] });
    expect(response.status).toBe(200);
    return { ...await response.json() as { adapterToken: string; machineId: string }, pairingToken: token.token };
  }
  const receipt = () => ({ schemaVersion: 1, harness: "claude-code", billingMode: "native-subscription", accountFingerprint: ACCOUNT, authVersion: AUTH, cliVersion: "2.1.0", probeMethod: "claude-auth-status", probedAt: Date.now() });
  async function ready(email = ALICE) {
    const machine = await pair(email);
    expect((await local("personal-account", { account: receipt() }, machine.adapterToken)).status).toBe(200);
    const computers = await (await api("/computers", "GET", undefined, email))!.json() as { computers: Array<{ machineId: string; personalExecution: { revision: number } }> };
    return { ...machine, revision: computers.computers.find((item) => item.machineId === machine.machineId)!.personalExecution.revision };
  }
  async function grant(machine: Awaited<ReturnType<typeof ready>>, email = ALICE) {
    const response = await api("/grants", "POST", { machineId: machine.machineId, machineRevision: machine.revision, harness: "claude-code", accountFingerprint: ACCOUNT, authVersion: AUTH,
      codingModel: "anthropic/claude-sonnet-4-6", repoUrl: REPO, expiresAt: Date.now() + 3_600_000, consent: true, hostingConsent: true }, email);
    expect(response?.status).toBe(201);
    return (await response!.json() as { snapshot: PersonalExecutionSnapshot }).snapshot;
  }
  function envelope(snapshot: PersonalExecutionSnapshot, sandboxId = "personal-job") {
    const proof = { snapshot, approvalId: "approval-fixture", inputHash: "d".repeat(64), generation: 0,
      executionOwner: `web:${ALICE}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, handoffId: "handoff-fixture", contextDigest: "e".repeat(64), approvedUntil: Date.now() + 60_000 };
    const result = localRunEnvelopeSchema.parse({ version: 1, sandboxId, repoUrl: REPO, baseBranch: "main", task: "Review this public repository.",
      harness: "claude-code", cloneDir: "${SHIBA_LOCAL_RUN_ROOT}/work", homeDir: "${SHIBA_LOCAL_RUN_ROOT}/home", setupCommands: [], configFiles: [], argv: [], env: {},
      execAllowlist: [], setupAllowlist: [], createdAt: Date.now(), deadlineAt: Date.now() + 60_000, orgId: `team:${snapshot.workspaceId}`,
      customAgentId: "employee-fixture", customAgentVersion: 1, session: { provider: "claude", model: "claude-sonnet-4-6", permissionMode: "approval-required" }, personalExecution: proof });
    result.personalExecution!.contextDigest = personalExecutionContextDigest({ ...result, handoffId: proof.handoffId });
    return result;
  }
  const dispatchJob = (snapshot: PersonalExecutionSnapshot, sandboxId?: string) => dispatch.fetch(new Request("https://local-dispatch/dispatch", { method: "POST", body: JSON.stringify({ envelope: envelope(snapshot, sandboxId), targetMachineId: snapshot.machineId, dashboardOwnerId: snapshot.actorId }) }));
  return { env, sqlite, map, dispatch, api, local, headers, pair, ready, grant, receipt, http, workspace, envelope, dispatchJob };
}

describe("personal execution ownership foundations with signed native sessions", () => {
  it("denies default-off, forged header, tampered cookie and missing explicit local account selection", async () => {
    const f = await fixture();
    expect((await handlePersonalExecution(req("/api/personal-execution/grants", "GET", undefined, { "X-Shiba-Workspace": f.workspace.workspaceId, "CF-Access-Authenticated-User-Email": ALICE }), f.env))?.status).toBe(404);
    expect((await handlePersonalExecution(req("/api/personal-execution/grants", "GET", undefined, { ...f.headers(), cookie: "better-auth.session_token=forged.signature" }), f.env))?.status).toBe(404);
    expect((await f.api("/pairing-token", "POST", {}))?.status).toBe(400);
    f.env.SHIBA_PERSONAL_LOCAL_EXECUTION = "0";
    expect((await f.api("/grants"))?.status).toBe(404);
    expect(f.http).not.toHaveBeenCalled();
  });

  it("binds one-use pairing and fleet visibility to the verified member and workspace", async () => {
    const f = await fixture(), alice = await f.pair(), bob = await f.pair(BOB);
    const a = await (await f.api("/computers"))!.json() as { computers: Array<{ machineId: string }> };
    const b = await (await f.api("/computers", "GET", undefined, BOB))!.json() as { computers: Array<{ machineId: string }> };
    expect(a.computers.map((item) => item.machineId)).toEqual([alice.machineId]); expect(b.computers.map((item) => item.machineId)).toEqual([bob.machineId]);
    expect((await f.api(`/computers/${alice.machineId}`, "DELETE", { expectedRevision: 1 }, BOB))?.status).toBe(404);
    expect((await f.local("pair", { pairingToken: alice.pairingToken, hostname: "replay", platform: "linux", daemonVersion: "fixture", harnesses: ["claude"] })).status).toBe(401);
    expect(await (await f.dispatch.fetch(new Request("https://local-dispatch/computers"))).json()).toEqual({ computers: [] });
    expect((await f.local("heartbeat", { machineId: alice.machineId, hostname: "spoof", platform: "linux", daemonVersion: "fixture", harnesses: ["claude"] }, "legacy-operator-token")).status).toBe(403);
  });

  it("pins observed account/model/repository and invalidates grants on account revision or removal", async () => {
    const f = await fixture(), machine = await f.ready(), snapshot = await f.grant(machine);
    const owner = (await resolvePersonalExecutionOwner(req("/", "GET", undefined, f.headers()), f.env))!;
    expect(await resolvePersonalExecutionGrant(f.env, owner, snapshot.grantId)).toEqual(snapshot);
    expect((await f.api(`/grants/${snapshot.grantId}`, "DELETE", { expectedVersion: 1 }, BOB))?.status).toBe(409);
    expect((await f.local("personal-account", { account: f.receipt() }, machine.adapterToken)).status).toBe(200);
    expect(await revalidatePersonalExecutionSnapshot(f.env, snapshot)).toBe(true);
    await f.local("personal-account", { account: { ...f.receipt(), authVersion: "c".repeat(64) } }, machine.adapterToken);
    expect(await revalidatePersonalExecutionSnapshot(f.env, snapshot)).toBe(false);
    f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE workspace_id=? AND user_id=?").run(f.workspace.workspaceId, ALICE);
    expect((await f.api("/grants"))?.status).toBe(404);
    expect((await f.local("claim", {}, machine.adapterToken)).status).toBe(401);
  });

  it("claims only one own pinned job after independent approval validation and denies operator or another member", async () => {
    const f = await fixture(), machine = await f.ready(), other = await f.ready(BOB), snapshot = await f.grant(machine);
    const envelope = f.envelope(snapshot);
    const dispatch = () => f.dispatch.fetch(new Request("https://local-dispatch/dispatch", { method: "POST", body: JSON.stringify({ envelope, targetMachineId: machine.machineId, dashboardOwnerId: ALICE }) }));
    claim.allowed = false; expect((await dispatch()).status).toBe(403); expect(f.map.has("run:personal-job")).toBe(false);
    claim.allowed = true; expect((await dispatch()).status).toBe(200);
    expect(await (await f.local("claim", {}, "legacy-operator-token")).json()).toEqual({ envelope: null });
    expect(await (await f.local("claim", {}, other.adapterToken)).json()).toEqual({ envelope: null });
    const claimed = await f.local("claim", {}, machine.adapterToken); expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ envelope: { sandboxId: "personal-job" }, claimToken: expect.any(String) });
    expect(await (await f.local("claim", {}, machine.adapterToken)).json()).toEqual({ envelope: null });
    expect((await f.local("events", { sandboxId: "personal-job", claimToken: "guessed", event: {} }, other.adapterToken)).status).toBe(404);
    expect((await f.api(`/grants/${snapshot.grantId}`, "DELETE", { expectedVersion: 1 }))?.status).toBe(200);
    expect(f.map.get("run:personal-job")).toMatchObject({ status: "cancelled", claimToken: undefined });
    expect(claim.calls).toBeGreaterThanOrEqual(2);
  });

  it("rejects modified executable context under retained approval proof before dispatch", async () => {
    const f = await fixture(), machine = await f.ready(), snapshot = await f.grant(machine);
    const source = f.envelope(snapshot), before = claim.calls;
    const mutations = [{ task: "Changed task" }, { baseBranch: "another-branch" }, { customAgentVersion: 2 }, { expectedDeliverables: ["another-file.txt"] },
      { session: { ...source.session!, reasoningEffort: "high" } }, { env: { OPENAI_API_KEY: "not-adopted" } }];
    for (const mutation of mutations) {
      const response = await f.dispatch.fetch(new Request("https://local-dispatch/dispatch", { method: "POST", body: JSON.stringify({ envelope: { ...source, ...mutation }, targetMachineId: machine.machineId, dashboardOwnerId: ALICE }) }));
      expect(response.status).toBe(403);
    }
    expect(claim.calls).toBe(before);
    expect(f.map.has("run:personal-job")).toBe(false);
  });

  it("rechecks membership after asynchronous approval validation and never claims after removal", async () => {
    const f = await fixture(), machine = await f.ready(), snapshot = await f.grant(machine);
    expect((await f.dispatchJob(snapshot)).status).toBe(200);
    claim.hook = () => { f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE workspace_id=? AND user_id=?").run(f.workspace.workspaceId, ALICE); };
    expect((await f.local("claim", {}, machine.adapterToken)).status).toBe(409);
    expect(f.map.get("run:personal-job")).toMatchObject({ status: "pending" });
    expect(f.map.get("run:personal-job")).not.toHaveProperty("claimToken");
  });

  it("does not claim when retained source authority changes during final mailbox reads", async () => {
    const f = await fixture(), machine = await f.ready(), snapshot = await f.grant(machine);
    const envelope = f.envelope(snapshot);
    envelope.personalExecution!.handoffId = `scx_${"a".repeat(32)}`;
    envelope.personalExecution!.contextDigest = personalExecutionContextDigest({ ...envelope, handoffId: envelope.personalExecution!.handoffId });
    const dispatched = await f.dispatch.fetch(new Request("https://local-dispatch/dispatch", { method: "POST", body: JSON.stringify({
      envelope, targetMachineId: machine.machineId, dashboardOwnerId: ALICE,
    }) }));
    expect(dispatched.status).toBe(200);
    const before = claim.calls;
    claim.hook = () => { if (claim.calls === before + 1) sourceFence.allowed = false; };
    const response = await f.local("claim", {}, machine.adapterToken);
    expect(response.status).toBe(409);
    expect(claim.calls).toBe(before + 1);
    expect(sourceFence.calls).toBe(1);
    expect(f.map.get("run:personal-job")).toMatchObject({ status: "pending" });
    expect(f.map.get("run:personal-job")).not.toHaveProperty("claimToken");
    expect(await revalidatePersonalExecutionSnapshot(f.env, snapshot)).toBe(true);
  });

  it("cannot reset a claimed run through a late concurrent duplicate dispatch", async () => {
    const f = await fixture(), machine = await f.ready(), snapshot = await f.grant(machine), envelope = f.envelope(snapshot);
    const validator = f.dispatch as unknown as { personalDispatchCurrent: (...args: unknown[]) => Promise<boolean> };
    const original = validator.personalDispatchCurrent.bind(f.dispatch);
    let validations = 0;
    let release!: () => void, enter!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; }), entered = new Promise<void>((resolve) => { enter = resolve; });
    validator.personalDispatchCurrent = async (...args) => {
      const current = await original(...args);
      if (++validations === 2) { enter(); await held; }
      return current;
    };
    const send = () => f.dispatch.fetch(new Request("https://local-dispatch/dispatch", { method: "POST", body: JSON.stringify({ envelope, targetMachineId: machine.machineId, dashboardOwnerId: ALICE }) }));
    const first = send(), second = send();
    try {
      await entered;
      expect((await first).status).toBe(200);
      expect((await f.local("claim", {}, machine.adapterToken)).status).toBe(200);
    } finally { release(); }
    expect((await second).status).toBe(409);
    expect(f.map.get("run:personal-job")).toMatchObject({ status: "claimed" });
  });

  it("requires anonymous public repository proof and rejects private repos, stale account, changed model and expired grants", async () => {
    const f = await fixture(), machine = await f.ready(), snapshot = await f.grant(machine);
    f.http.mockResolvedValueOnce(Response.json({ private: true, html_url: REPO }));
    expect(await revalidatePersonalExecutionSnapshot(f.env, snapshot)).toBe(false);
    expect(await revalidatePersonalExecutionSnapshot(f.env, { ...snapshot, codingModel: "anthropic/other-model" })).toBe(false);
    expect(await revalidatePersonalExecutionSnapshot(f.env, { ...snapshot, expiresAt: Date.now() - 1 })).toBe(false);
    const stored = f.map.get(`computer:${machine.machineId}`) as { personalExecution: { accounts: Array<{ receivedAt: number }> } };
    stored.personalExecution.accounts[0]!.receivedAt = Date.now() - 76_000;
    expect(await revalidatePersonalExecutionSnapshot(f.env, snapshot)).toBe(false);
    expect((await f.local("reason-network/v1/status", {}, machine.adapterToken)).status).toBe(404);
  });

  it("serializes concurrent account changes without losing server revisions or resurrecting revoked computers", async () => {
    const f = await fixture(), machine = await f.ready();
    const at = Date.now();
    const observations = await Promise.all(["c", "d"].map((letter) => f.local("personal-account", { account: { ...f.receipt(), probedAt: at, authVersion: letter.repeat(64) } }, machine.adapterToken)));
    expect(observations.every((response) => response.status === 200)).toBe(true);
    expect(f.map.get(`computer:${machine.machineId}`)).toMatchObject({ personalExecution: { revision: machine.revision + 2 } });
    expect((await f.api(`/computers/${machine.machineId}`, "DELETE", { expectedRevision: machine.revision }))?.status).toBe(200);
    expect((await f.local("heartbeat", { machineId: machine.machineId, hostname: "resurrection", platform: "linux", daemonVersion: "fixture", harnesses: ["claude"] }, machine.adapterToken)).status).toBe(401);
    expect(f.map.has(`computer:${machine.machineId}`)).toBe(false);
  });

  it("bounds all personal machine POST bodies before mailbox parsing without truncation or work creation", async () => {
    const f = await fixture(), machine = await f.ready();
    for (const [path, limit] of [["claim", PERSONAL_CONTROL_BODY_LIMIT], ["events", PERSONAL_EVENTS_BODY_LIMIT], ["result", PERSONAL_RESULT_BODY_LIMIT]] as const) {
      const response = await f.local(path, { padding: "x".repeat(limit) }, machine.adapterToken);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "personal_request_too_large", limit });
    }
    expect([...f.map.keys()].filter((key) => key.startsWith("run:"))).toEqual([]);
    expect(claim.calls).toBe(0);
  });

  it("permits only the native machine owner to decide a complete exact permission once", async () => {
    const f = await fixture(), machine = await f.ready(), snapshot = await f.grant(machine);
    await f.dispatchJob(snapshot);
    const held = await (await f.local("claim", {}, machine.adapterToken)).json() as { claimToken: string };
    const expiresAt = Date.now() + 30_000, requestId = "permission-once";
    const detail = JSON.stringify({ version: 1, provider: "claude", method: "can_use_tool", payload: { request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git status" } } } });
    const actionHash = await sha256Hex(detail);
    const pending = { sandboxId: "personal-job", claimToken: held.claimToken, request: { requestId, kind: "command", title: "Run reviewed command", detail, actionHash, expiresAt } };
    expect((await f.local("approval", pending, machine.adapterToken)).status).toBe(200);
    const pointer = { sandboxId: "personal-job", requestId, actionHash, expiresAt, grantVersion: 1, machineRevision: machine.revision, decision: "allow" };
    expect((await handlePersonalExecution(req("/api/personal-execution/harness/decide", "POST", pointer, { Authorization: `Bearer ${machine.adapterToken}`, "X-Shiba-Workspace": f.workspace.workspaceId }), f.env))?.status).toBe(404);
    f.env.DASHBOARD_APPROVERS = BOB;
    expect((await f.api("/harness/decide", "POST", pointer, BOB))?.status).toBe(404);
    const view = await (await f.api("/harness"))!.json();
    expect(view).toMatchObject({ runs: [{ sandboxId: "personal-job", canAllow: true, canDeny: true, canInterrupt: true, approvals: [{ actionHash, expiresAt, reviewIncomplete: false }] }] });
    expect((await f.api("/harness/decide", "POST", { ...pointer, actionHash: "0".repeat(64) }))?.status).toBe(409);
    expect((await f.api("/harness/decide", "POST", pointer))?.status).toBe(200);
    expect((await f.api("/harness/decide", "POST", { ...pointer, decision: "deny" }))?.status).toBe(409);
    const poll = { sandboxId: "personal-job", claimToken: held.claimToken, requestId, actionHash, expiresAt };
    expect(await (await f.local("approval", poll, machine.adapterToken)).json()).toEqual({ decision: "allow", actionHash, expiresAt });
    expect((await f.local("approval", poll, machine.adapterToken)).status).toBe(409);
    expect((await f.local("approval", pending, machine.adapterToken)).status).toBe(409);
    expect((await f.local("approval", { ...pending, request: { ...pending.request, requestId: "oversize", detail: "x".repeat(2001) } }, machine.adapterToken)).status).toBe(409);
    expect((await f.local("approval", { ...pending, request: { ...pending.request, requestId: "expired", expiresAt: Date.now() - 1 } }, machine.adapterToken)).status).toBe(409);
    expect((await f.local("approval", { ...pending, request: { ...pending.request, requestId: "missing-hash", actionHash: undefined } }, machine.adapterToken)).status).toBe(409);
    expect((await f.local("approval", { ...pending, request: { ...pending.request, requestId: "changed-args", detail: detail.replace("git status", "git diff") } }, machine.adapterToken)).status).toBe(409);
    const delegation = JSON.stringify({ version: 1, provider: "claude", method: "can_use_tool", payload: { request: { subtype: "can_use_tool", tool_name: "Agent", input: { prompt: "Delegate" } } } });
    expect((await f.local("approval", { ...pending, request: { ...pending.request, requestId: "nested-agent", detail: delegation, actionHash: await sha256Hex(delegation) } }, machine.adapterToken)).status).toBe(409);
    expect((await f.local("harness-decide", pointer, machine.adapterToken)).status).toBe(404);
  });

  it("keeps STOP and unpair owner-only after membership revocation without granting permission or replay", async () => {
    const f = await fixture(), machine = await f.ready(), snapshot = await f.grant(machine);
    await f.dispatchJob(snapshot);
    await f.local("claim", {}, machine.adapterToken);
    const stop = { sandboxId: "personal-job", grantVersion: 1, machineRevision: machine.revision, interrupt: true };
    expect((await f.api("/harness/control", "POST", stop, BOB))?.status).toBe(404);
    const record = f.map.get("run:personal-job") as Record<string, unknown>;
    f.map.set("run:personal-job", { ...record, sessionEvents: [{ seq: 1, at: Date.now(), type: "message", text: "private context" }], liveDiff: "private diff" });
    f.sqlite.prepare("UPDATE personal_execution_grants SET status='revoked',version=version+1 WHERE grant_id=?").run(snapshot.grantId);
    expect(await (await f.api("/harness"))!.json()).toEqual({ runs: [{ sandboxId: "personal-job", events: [], diff: "", approvals: [], grantVersion: 1, machineRevision: machine.revision, canInterrupt: true, canAllow: false, canDeny: false }] });
    f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE workspace_id=? AND user_id=?").run(f.workspace.workspaceId, ALICE);
    expect((await f.api("/harness"))?.status).toBe(404);
    expect((await f.api("/harness/control", "POST", stop))?.status).toBe(200);
    expect(f.map.get("run:personal-job")).toMatchObject({ status: "cancelled", claimToken: undefined, interrupt: true });
    expect((await f.dispatchJob(snapshot)).status).toBe(409);
    expect((await f.api(`/computers/${machine.machineId}`, "DELETE", { expectedRevision: machine.revision }))?.status).toBe(200);
    expect(f.map.has(`computer:${machine.machineId}`)).toBe(false);
    expect((await f.local("claim", {}, machine.adapterToken)).status).toBe(401);
  });

  it("queues native member work through the actual room and run intake with only a private server-owned grant pin", async () => {
    const f = await fixture(), machine = await f.ready(), snapshot = await f.grant(machine), other = await f.ready(BOB), otherGrant = await f.grant(other, BOB);
    const send = (path: string, method = "GET", body?: unknown) => handleCollaboration(req(`/api/collaboration${path}`, method, body, f.headers()), f.env);
    const created = await send("/rooms", "POST", { title: "Native personal work", visibility: "shared" });
    expect(created?.status).toBe(201);
    const { room } = await created!.json() as { room: { roomId: string } };
    const profile = await createCustomAgent(f.env, `team:${f.workspace.workspaceId}`, "own-engineer", { name: "Own engineer", harness: "claude-code", instructions: "Work on the approved public repository only." });
    expect((await send(`/rooms/${room.roomId}/agents`, "POST", { profileId: profile.id, profileVersion: 1 }))?.status).toBe(201);
    const captured: Array<{ name: string; request: Request; body: Record<string, unknown> }> = [];
    routed.fetch = async (name, request) => {
      const body = await request.clone().json() as Record<string, unknown>; captured.push({ name, request, body });
      return Response.json({ approvalId: `approval-${captured.length}`, task: body.task });
    };
    const queue = (id: string, extra: Record<string, unknown> = {}) => send(`/rooms/${room.roomId}/handoffs`, "POST", {
      handoffId: id, taskId: id, recipientActorId: `agent:${profile.id}`, task: "Inspect this public repository.", personalExecution: { grantId: snapshot.grantId, expectedVersion: 1 }, ...extra });
    const valid = await queue("native-personal-approved");
    expect(await valid?.clone().json()).not.toHaveProperty("error");
    expect(valid?.status).toBe(201);
    expect(captured).toHaveLength(1);
    const first = captured[0]!;
    expect(first.name).toMatch(/^web:alice@example\.test:/);
    expect(first.body).toMatchObject({ personalExecution: snapshot, repoUrl: REPO, runtime: "local", targetMachineId: machine.machineId,
      orgId: `team:${f.workspace.workspaceId}`, customAgentId: profile.id, customAgentVersion: 1, collaborationHandoffId: "native-personal-approved", threadKey: first.name });
    expect(first.body).not.toHaveProperty("connectionId");
    expect(first.body).not.toHaveProperty("publishPullRequest");
    expect(await verifyInternalRequest(first.request, f.env)).toEqual({ ok: true, signed: true });
    const saved = f.sqlite.prepare("SELECT executor_agent_name,approval_id,run_id FROM collaboration_handoffs WHERE handoff_id=?").get("native-personal-approved");
    expect(saved).toMatchObject({ executor_agent_name: first.name, approval_id: "approval-1", run_id: "agent-tool:approval-1" });
    expect((await queue("native-stale-version", { personalExecution: { grantId: snapshot.grantId, expectedVersion: 2 } }))?.status).toBe(409);
    expect((await queue("native-cross-user", { personalExecution: { grantId: otherGrant.grantId, expectedVersion: 1 } }))?.status).toBe(409);
    expect((await queue("native-override", { runtime: "sandbox" }))?.status).toBe(400);
    expect((await queue("native-external-snapshot", { personalExecution: snapshot }))?.status).toBe(400);
    const appProfile = await createCustomAgent(f.env, `team:${f.workspace.workspaceId}`, "app-employee", { name: "App employee", harness: "claude-code", instructions: "Read app data.", toolScopes: ["mcp:shiba:gmail_read"] });
    expect((await send(`/rooms/${room.roomId}/agents`, "POST", { profileId: appProfile.id, profileVersion: 1 }))?.status).toBe(201);
    expect((await queue("native-no-worker-apps", { recipientActorId: `agent:${appProfile.id}` }))?.status).toBe(403);
    expect((await handleRuns(req("/api/runs", "POST", { task: "Direct forged snapshot", personalExecution: snapshot }, f.headers()), f.env))?.status).toBe(403);
    expect((await f.api(`/grants/${snapshot.grantId}`, "DELETE", { expectedVersion: 1 }))?.status).toBe(200);
    expect((await queue("native-revoked"))?.status).toBe(409);
    expect(captured).toHaveLength(1);
  });
});
