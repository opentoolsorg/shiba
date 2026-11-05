import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { TEAM_MODEL_TEXT_MODEL, TEAM_MODEL_LLAMA_MODEL, teamModelMaximumDebitMicroUsd, teamModelStateResponseSchema } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { handleTeamModelSessions } from "../src/team-model-routes.js";
import { createTeamWorkspace, createTeamWorkspaceInvitation, acceptTeamWorkspaceInvitation, getTeamWorkspaceMembership } from "../src/team-workspaces-store.js";
import { createCollaborationRoom, addCollaborationMember, createCollaborationMessage, humanActorId, type CollaborationScope } from "../src/collaboration-store.js";
import { createCollaborationMemory } from "../src/collaboration-memory.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const user = vi.hoisted(() => ({ email: "operator@example.test", native: true, accounts: {} as Record<string, string>, afterNative: undefined as (() => void) | undefined }));
vi.mock("@shiba/auth/better-auth", async (original) => ({ ...await original<typeof import("@shiba/auth/better-auth")>(), resolveBetterAuthSessionAccount: async () => {
  user.afterNative?.();
  return user.native ? { policy: { accountId: user.accounts[user.email], email: user.email, kind: user.email === "operator@example.test" ? "bootstrap" : "invited" }, emailVerified: true } : null;
} }));
vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(), isAuthorizedRequest: async () => true, resolveUserId: async () => user.email }));
const OPERATOR = "operator@example.test", MEMBER = "member@example.test", MANAGER = "manager@example.test";
beforeEach(() => { user.email = OPERATOR; user.native = true; user.accounts = {}; user.afterNative = undefined; });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
type GrantReceipt = { id: string; version: number; digest: string; state: string; usedRequests: number; reservedInputBytes: number; reservedOutputTokens: number };
type TurnReceipt = { id: string; version: number; inputHash: string; status: string; output: string | null; inputBytes: number; expiresAt: number; canCancel: boolean };
function aiResponse(content: string) { return { id: `fixture_${crypto.randomUUID()}`, model: TEAM_MODEL_TEXT_MODEL, usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 }, choices: [{ message: { content } }] }; }
async function fixture(enabled = true) {
  const db = customAgentD1();
  db.sqlite.exec('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT UNIQUE,emailVerified INTEGER); CREATE TABLE shiba_auth_account_policy(account_id TEXT PRIMARY KEY,email TEXT,kind TEXT)');
  for (const email of [OPERATOR, MEMBER, MANAGER, "other@example.test"]) {
    const id = crypto.randomUUID(); user.accounts[email] = id;
    db.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(id, email);
    db.sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?,?)").run(id, email, email === OPERATOR ? "bootstrap" : "invited");
  }
  const calls: Array<{ model: string; input: Record<string, unknown>; signal: AbortSignal }> = [];
  let held: Promise<unknown> | undefined, release: ((result: unknown) => void) | undefined;
  let arrived: (() => void) | undefined, throwInference = false;
  const run = vi.fn(async (model: string, input: Record<string, unknown>, options: { signal: AbortSignal }) => {
    calls.push({ model, input, signal: options.signal }); arrived?.();
    if (throwInference) throw new Error("Fixture unknown AI response");
    return held ? await held : aiResponse("Fixture text response");
  });
  const env = { AGENT_AUDIT: db.database, AI: { run }, SHIBA_TEAM_MODEL_SESSIONS: enabled ? "1" : "0", SHIBA_TEAM_MODEL_MODEL: TEAM_MODEL_TEXT_MODEL } as unknown as Env;
  for (const field of ["CodingOrchestrator", "Sandbox", "Memory", "OPEN_CONNECTOR", "OPEN_CONNECTOR_ADMIN_TOKEN", "AI_GATEWAY_TOKEN", "GITHUB_TOKEN", "SLACK_BOT_TOKEN"])
    Object.defineProperty(env, field, { get() { throw new Error(`Team text must not access ${field}`); } });
  const workspace = await createTeamWorkspace(env, OPERATOR, { name: "Funded workspace" });
  const other = await createTeamWorkspace(env, "other@example.test", { name: "Other workspace" });
  for (const [email, role] of [[MEMBER, "member"], [MANAGER, "admin"]] as const) {
    const invitation = await createTeamWorkspaceInvitation(env, workspace.workspaceId, OPERATOR, { email, role });
    await acceptTeamWorkspaceInvitation(env, email, invitation.token);
  }
  const scope: CollaborationScope = { tenantId: "self-hosted", workspaceId: workspace.workspaceId, userId: OPERATOR };
  const roomId = `room_${"a".repeat(24)}`;
  await createCollaborationRoom(env, scope, { roomId, title: "Funded room", visibility: "shared", createdAt: 1 });
  for (const email of [MEMBER, MANAGER]) await addCollaborationMember(env, scope, roomId, { userId: email, actorId: humanActorId(email), displayName: email, kind: "human", createdAt: 2 });
  const employee = await createCustomAgent(env, `team:${workspace.workspaceId}`, "team-writer", { name: "Team writer", instructions: "Draft clear text. Never execute tools.", harness: "opencode" });
  await addCollaborationMember(env, scope, roomId, { userId: OPERATOR, actorId: `agent:${employee.id}`, displayName: "Team writer", kind: "agent", profileVersion: employee.version, createdAt: 3 });
  await createCollaborationMessage(env, scope, { ...scope, roomId, messageId: "message-human", senderUserId: OPERATOR, senderActorId: humanActorId(OPERATOR), senderKind: "human", body: "Explicit shared objective", profileVersion: null, createdAt: 4 });
  const note = await createCollaborationMemory(env, scope, roomId, { id: "ctx_model_note", title: "Shared fact", content: "A deliberately selected fact." });
  const request = (path: string, method = "GET", body?: unknown, ws = workspace.workspaceId, signal?: AbortSignal) => new Request(`https://shiba.test/api/team-model-sessions${path}`, { method,
    headers: { Origin: "https://shiba.test", "Content-Type": "application/json", "X-Shiba-Workspace": ws }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
  const call = async (path: string, method = "GET", body?: unknown, ws?: string, signal?: AbortSignal) => {
    const response = await handleTeamModelSessions(request(path, method, body, ws, signal), env);
    return { response: response!, body: await response!.json() as Record<string, unknown> };
  };
  const member = (await getTeamWorkspaceMembership(env, workspace.workspaceId, MEMBER))!;
  const fundingInput = { roomId, employeeId: employee.id, employeeVersion: employee.version, memberId: MEMBER, memberVersion: member.version,
    model: TEAM_MODEL_TEXT_MODEL, currency: "USD", budgetMicroUsd: 100_000, maxRequests: 2, maxInputBytes: 4096, maxOutputTokens: 64, expiresAt: Date.now() + 3_600_000 };
  const prepare = async (changes: Record<string, unknown> = {}) => {
    const result = await call("/funding/prepare", "POST", { ...fundingInput, ...changes });
    expect(result.response.status, JSON.stringify(result.body)).toBe(201); return result.body.grant as GrantReceipt;
  };
  const fund = async (changes: Record<string, unknown> = {}) => {
    user.email = OPERATOR; const draft = await prepare(changes);
    const result = await call(`/funding/${draft.id}/activate`, "POST", { expectedVersion: draft.version, digest: draft.digest, reviewed: true, billingConsent: true });
    expect(result.response.status, JSON.stringify(result.body)).toBe(200); return result.body.grant as GrantReceipt;
  };
  const turn = async (grant: GrantReceipt, changes: Record<string, unknown> = {}) => {
    user.email = MEMBER;
    const result = await call("/turns/prepare", "POST", { grantId: grant.id, expectedGrantVersion: grant.version, prompt: "Prepare a short response.", messageIds: [], memoryRefs: [], requestId: crypto.randomUUID(), ...changes });
    expect(result.response.status, JSON.stringify(result.body)).toBe(201); return result.body.turn as TurnReceipt;
  };
  const approve = async (value: TurnReceipt) => {
    const result = await call(`/turns/${value.id}/approve`, "POST", { expectedVersion: value.version, inputHash: value.inputHash, reviewed: true });
    expect(result.response.status, JSON.stringify(result.body)).toBe(200); return result.body.turn as TurnReceipt;
  };
  const execute = (value: TurnReceipt, signal?: AbortSignal) => call(`/turns/${value.id}/execute`, "POST", { expectedVersion: value.version, inputHash: value.inputHash }, undefined, signal);
  return { ...db, env, roomId, workspace, other, employee, note, fundingInput, calls, run, call, request, prepare, fund, turn, approve, execute,
    hold() { held = new Promise<unknown>((resolve) => { release = resolve; }); return new Promise<void>((resolve) => { arrived = resolve; }); },
    release() { release?.(aiResponse("Late fixture output")); }, unknown() { throwInference = true; } };
}
function interceptD1(env: Env, matches: (sql: string, operation: "first" | "all") => boolean, effect: () => void | Promise<void>) {
  const prepare = env.AGENT_AUDIT.prepare.bind(env.AGENT_AUDIT);
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, { get(target, key) {
    if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
    if (key === "first" || key === "all") return async (...args: unknown[]) => { if (matches(sql, key)) await effect(); return Reflect.apply(target[key], target, args); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  vi.spyOn(env.AGENT_AUDIT, "prepare").mockImplementation((sql) => wrap(prepare(sql), sql));
}
function holdAuthorityRead(env: Env, nth: number) {
  let seen = 0, entered: (() => void) | undefined, release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  interceptD1(env, (sql, op) => op === "first" && sql.includes("dispatch_deadline>") && ++seen === nth, async () => { entered!(); await gate; });
  return { started, release: () => release!() };
}
function seedPermanentReservations(f: Awaited<ReturnType<typeof fixture>>, grantId: string, amount: number, workspaceId = f.workspace.workspaceId) {
  const insert = f.sqlite.prepare("INSERT INTO team_model_money_ledger(turn_id,grant_id,workspace_id,input_hash,quote_digest,reserved_micro_usd,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'confirmed',1,1)");
  const prefix = crypto.randomUUID();
  for (let i = 0, remaining = amount; remaining > 0; i++) {
    const debit = Math.min(8341, remaining); remaining -= debit;
    insert.run(`${prefix}-${i}`, grantId, workspaceId, "prior-hash", "prior-quote", debit);
  }
}

describe("default-off native funded text with actual routes/SQLite and fixture AI only", { timeout: 20_000 }, () => {
  it("binds a reviewed Llama quote and max_tokens to the selected direct binding", async () => {
    const f = await fixture(); f.env.SHIBA_TEAM_MODEL_MODEL = TEAM_MODEL_LLAMA_MODEL;
    const grant = await f.fund({ model: TEAM_MODEL_LLAMA_MODEL, maxOutputTokens: 1024 });
    const approved = await f.approve(await f.turn(grant));
    f.run.mockResolvedValueOnce({ response: "Llama fixture", usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } });
    expect((await f.execute(approved)).body.turn).toMatchObject({ status: "completed", output: "Llama fixture" });
    expect(f.run.mock.calls[0]![0]).toBe(TEAM_MODEL_LLAMA_MODEL);
    expect(f.run.mock.calls[0]![1]).toMatchObject({ max_tokens: 1024, stream: false });
    expect(f.run.mock.calls[0]![1]).not.toHaveProperty("max_completion_tokens");
    expect(f.sqlite.prepare("SELECT reserved_micro_usd FROM team_model_money_ledger").get()).toEqual({ reserved_micro_usd: 5158 });
    const receipt = JSON.parse(String(f.sqlite.prepare("SELECT receipt_json FROM team_model_money_ledger").get()!.receipt_json));
    expect(receipt).toMatchObject({ requestedModel: TEAM_MODEL_LLAMA_MODEL, bindingRequestId: approved.id, providerModel: null, providerCompletionId: null });
  });
  it.each(["missing usage", "wrong echoed model"])("holds the Llama reservation on %s", async (kind) => {
    const f = await fixture(); f.env.SHIBA_TEAM_MODEL_MODEL = TEAM_MODEL_LLAMA_MODEL;
    const grant = await f.fund({ model: TEAM_MODEL_LLAMA_MODEL }), approved = await f.approve(await f.turn(grant));
    f.run.mockResolvedValueOnce(kind === "missing usage" ? { response: "unconfirmed" } : { response: "unconfirmed", model: TEAM_MODEL_TEXT_MODEL, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    expect((await f.execute(approved)).body.turn).toMatchObject({ status: "unknown", output: null });
    expect(f.sqlite.prepare("SELECT state FROM team_model_money_ledger").get()).toEqual({ state: "unknown" });
    await f.execute(approved); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it("requires a distinct native sponsor and requester", async () => {
    const f = await fixture(), operator = await getTeamWorkspaceMembership(f.env, f.workspace.workspaceId, OPERATOR);
    const result = await f.call("/funding/prepare", "POST", { ...f.fundingInput, memberId: OPERATOR, memberVersion: operator!.version });
    expect(result.response.status).toBe(403); expect(f.calls).toHaveLength(0);
  });
  it("synthesizes a report only from explicitly reviewed native sources", async () => {
    const f = await fixture(), grant = await f.fund();
    const pending = await f.turn(grant, { prompt: "Synthesize the selected sources into a short report.", messageIds: ["message-human"], memoryRefs: [{ id: f.note.id, version: f.note.version, sha256: f.note.sha256 }] });
    expect(f.calls).toHaveLength(0);
    const approved = await f.approve(pending);
    expect(f.calls).toHaveLength(0);
    expect((await f.execute(approved)).body.turn).toMatchObject({ status: "completed" });
    expect(JSON.stringify(f.calls[0]!.input)).toContain("Explicit shared objective");
    expect(JSON.stringify(f.calls[0]!.input)).toContain("A deliberately selected fact.");
    expect(f.calls[0]!.input).toMatchObject({ stream: false, tool_choice: "none", store: false });
  });
  it("keeps previously authorized output readable while a prior policy cannot dispatch", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant));
    await f.execute(approved);
    const previous = JSON.stringify({ version: "shiba.team-text.v1", model: TEAM_MODEL_TEXT_MODEL, enabled: true });
    f.sqlite.prepare("UPDATE team_model_funding SET policy_key=? WHERE id=?").run(previous, grant.id);
    const state = await f.call(`/state?roomId=${f.roomId}`);
    expect((state.body.turns as Array<Record<string, unknown>>)[0]).toMatchObject({ output: "Fixture text response", canApprove: false, canExecute: false });
    expect((state.body.grants as Array<Record<string, unknown>>)[0]).toMatchObject({ unavailableReason: "team_model_policy_changed", canActivate: false });
  });
  it.each(["requester", "workspace"])("enforces the cumulative %s ceiling before AI.run across grants", async (scope) => {
    const f = await fixture(), prior = await f.fund(), grant = await f.fund({ maxOutputTokens: 1024, budgetMicroUsd: 100_000 });
    const approved = await f.approve(await f.turn(grant));
    const insert = f.sqlite.prepare("INSERT INTO team_model_money_ledger(turn_id,grant_id,workspace_id,input_hash,quote_digest,reserved_micro_usd,state,created_at,updated_at) VALUES(?,?,?,?,?,8341,'confirmed',1,1)");
    // Workspace scope includes all ledger records, even orphaned legacy rows.
    const count = scope === "requester" ? 119 : 1199;
    for (let i = 0; i < count; i++) insert.run(`prior-${i}`, scope === "requester" ? prior.id : "other-grant", f.workspace.workspaceId, "prior-hash", "prior-quote");
    expect((await f.execute(approved)).response.status).toBe(409);
    expect(f.calls).toHaveLength(0);
    expect(f.sqlite.prepare("SELECT used_requests FROM team_model_funding WHERE id=?").get(grant.id)).toEqual({ used_requests: 0 });
  });
  it("shows all-state permanent requester capacity but keeps workspace totals private to the funding operator", async () => {
    const f = await fixture(), prior = await f.fund(), grant = await f.fund();
    seedPermanentReservations(f, prior.id, 1000);
    seedPermanentReservations(f, prior.id, 1000);
    seedPermanentReservations(f, prior.id, 1000);
    const rows = f.sqlite.prepare("SELECT turn_id FROM team_model_money_ledger ORDER BY turn_id").all() as Array<{ turn_id: string }>;
    f.sqlite.prepare("UPDATE team_model_money_ledger SET state='held' WHERE turn_id=?").run(rows[0]!.turn_id);
    f.sqlite.prepare("UPDATE team_model_money_ledger SET state='unknown' WHERE turn_id=?").run(rows[1]!.turn_id);
    seedPermanentReservations(f, "orphan-workspace-grant", 2000);
    seedPermanentReservations(f, prior.id, 3000, f.other.workspaceId);
    user.email = OPERATOR;
    expect((await f.call(`/funding/${prior.id}/revoke`, "POST", { expectedVersion: prior.version })).response.status).toBe(200);
    const funder = teamModelStateResponseSchema.parse((await f.call(`/state?roomId=${f.roomId}`)).body);
    const capacity = { requesterLimitMicroUsd: 1_000_000, requesterReservedMicroUsd: 3000, requesterRemainingMicroUsd: 997_000,
      requesterCanReserveNext: true, workspaceLimitMicroUsd: 10_000_000, workspaceCanReserveNext: true };
    expect(funder.grants.find((g) => g.id === grant.id)!.money!.capacity).toEqual({ ...capacity, workspaceReservedMicroUsd: 5000, workspaceRemainingMicroUsd: 9_995_000 });
    user.email = MEMBER;
    const member = teamModelStateResponseSchema.parse((await f.call(`/state?roomId=${f.roomId}`)).body);
    expect(member.grants.find((g) => g.id === grant.id)!.money!.capacity).toEqual(capacity);
    user.email = MANAGER;
    const manager = teamModelStateResponseSchema.parse((await f.call(`/state?roomId=${f.roomId}`)).body);
    expect(manager.canFund).toBe(false); expect(manager.grants).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });
  it("withholds capacity when the funding source is revoked at the final read snapshot", async () => {
    const f = await fixture(), prior = await f.fund(), grant = await f.fund();
    seedPermanentReservations(f, prior.id, 1234); user.email = OPERATOR;
    let changed = false;
    interceptD1(f.env, (sql, op) => op === "all" && sql.includes("AS id,'actor'") && !changed, () => {
      changed = true; f.sqlite.prepare("UPDATE org_custom_agents SET version=version+1 WHERE id=?").run(f.employee.id);
    });
    const state = teamModelStateResponseSchema.parse((await f.call(`/state?roomId=${f.roomId}`)).body);
    expect(changed).toBe(true);
    expect(state.grants.find((g) => g.id === grant.id)).toMatchObject({ state: "blocked", unavailableReason: "team_model_source_changed" });
    expect(state.grants.every((g) => g.money === undefined)).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
  it.each(["requester", "workspace"])("refuses funding activation, preparation and approval after the %s lifetime headroom is consumed", async (scope) => {
    const f = await fixture(), prior = await f.fund(), grant = await f.fund({ maxOutputTokens: 1024 }), pending = await f.turn(grant);
    user.email = OPERATOR; const draft = await f.prepare({ maxOutputTokens: 1024 });
    const limit = scope === "requester" ? 1_000_000 : 10_000_000;
    const next = teamModelMaximumDebitMicroUsd(1024);
    seedPermanentReservations(f, scope === "requester" ? prior.id : "other-grant", limit - next + 1);
    const reason = `team_model_${scope}_lifetime_limit`;
    const funderState = teamModelStateResponseSchema.parse((await f.call(`/state?roomId=${f.roomId}`)).body);
    expect(funderState.grants.find((g) => g.id === draft.id)).toMatchObject({ canActivate: false, unavailableReason: reason });
    expect((await f.call(`/funding/${draft.id}/activate`, "POST", { expectedVersion: draft.version, digest: draft.digest, billingConsent: true, reviewed: true })).response.status).toBe(409);
    user.email = MEMBER;
    const state = teamModelStateResponseSchema.parse((await f.call(`/state?roomId=${f.roomId}`)).body);
    expect(state.grants.find((g) => g.id === grant.id)).toMatchObject({ unavailableReason: reason });
    expect(state.turns.find((t) => t.id === pending.id)).toMatchObject({ canApprove: false, canExecute: false, error: reason });
    expect((await f.call("/turns/prepare", "POST", { grantId: grant.id, expectedGrantVersion: grant.version, prompt: "No remaining lifetime capacity", messageIds: [], memoryRefs: [], requestId: crypto.randomUUID() })).response.status).toBe(409);
    expect((await f.call(`/turns/${pending.id}/approve`, "POST", { expectedVersion: pending.version, inputHash: pending.inputHash, reviewed: true })).response.status).toBe(409);
    expect(f.sqlite.prepare("SELECT state FROM team_model_funding WHERE id=?").get(draft.id)).toEqual({ state: "draft" });
    expect(f.sqlite.prepare("SELECT status FROM team_model_turns WHERE id=?").get(pending.id)).toEqual({ status: "pending" });
    expect(f.calls).toHaveLength(0);
  });
  it.each(["requester", "workspace"])("admits only one concurrent grant into the exact last %s reservation and reports exhaustion afterward", async (scope) => {
    const f = await fixture(), prior = await f.fund(), first = await f.fund({ maxOutputTokens: 1024 }), second = await f.fund({ maxOutputTokens: 1024 });
    const one = await f.approve(await f.turn(first)), two = await f.approve(await f.turn(second));
    const next = teamModelMaximumDebitMicroUsd(1024), limit = scope === "requester" ? 1_000_000 : 10_000_000;
    seedPermanentReservations(f, scope === "requester" ? prior.id : "other-grant", limit - next);
    const before = teamModelStateResponseSchema.parse((await f.call(`/state?roomId=${f.roomId}`)).body);
    expect(before.turns.filter((t) => [one.id, two.id].includes(t.id)).every((t) => t.canExecute)).toBe(true);
    const outcomes = await Promise.all([f.execute(one), f.execute(two)]);
    expect(outcomes.map((r) => r.response.status).sort()).toEqual([200, 409]); expect(f.calls).toHaveLength(1);
    const after = teamModelStateResponseSchema.parse((await f.call(`/state?roomId=${f.roomId}`)).body);
    const unused = after.turns.find((t) => t.status === "approved")!;
    expect(unused).toMatchObject({ canExecute: false, error: `team_model_${scope}_lifetime_limit` });
    expect(after.turns.find((t) => t.status === "completed")).toMatchObject({ output: "Fixture text response", error: null });
    expect(after.grants.find((g) => g.id === unused.grantId)!.money!.capacity).toMatchObject(scope === "requester"
      ? { requesterReservedMicroUsd: limit, requesterRemainingMicroUsd: 0, requesterCanReserveNext: false }
      : { workspaceCanReserveNext: false });
  });
  it("enforces the exact USD envelope atomically and never releases it after confirmed lower usage", async () => {
    const f = await fixture(), grant = await f.fund({ maxOutputTokens: 1024, budgetMicroUsd: 8341 }), approved = await f.approve(await f.turn(grant));
    const [one, duplicate] = await Promise.all([f.execute(approved), f.execute(approved)]);
    expect([one.response.status, duplicate.response.status]).toContain(200); expect(f.calls).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT reserved_micro_usd,state,reported_micro_usd FROM team_model_money_ledger").all()).toEqual([{ reserved_micro_usd: 8341, state: "confirmed", reported_micro_usd: 6 }]);
    const state = await f.call(`/state?roomId=${f.roomId}`);
    expect((state.body.grants as Array<Record<string, unknown>>)[0]!.money).toEqual({ currency: "USD", authorizedDebitMicroUsd: 8341, remainingBudgetMicroUsd: 0, reportedQuotedMicroUsd: 6, unknownReservedMicroUsd: 0,
      capacity: { requesterLimitMicroUsd: 1_000_000, requesterReservedMicroUsd: 8341, requesterRemainingMicroUsd: 991_659, requesterCanReserveNext: true, workspaceLimitMicroUsd: 10_000_000, workspaceCanReserveNext: true } });
    const next = await f.call("/turns/prepare", "POST", { grantId: grant.id, expectedGrantVersion: grant.version, prompt: "Cannot use the unused estimate", messageIds: [], memoryRefs: [], requestId: crypto.randomUUID() });
    expect(next.response.status).toBe(409); await f.execute(approved); expect(f.calls).toHaveLength(1);
  });
  it("refuses insufficient USD authorization before any model slot or inference", async () => {
    const f = await fixture(), grant = await f.fund({ maxOutputTokens: 1024, budgetMicroUsd: 8340 }); user.email = MEMBER;
    const next = await f.call("/turns/prepare", "POST", { grantId: grant.id, expectedGrantVersion: grant.version, prompt: "Too little authorization", messageIds: [], memoryRefs: [], requestId: crypto.randomUUID() });
    expect(next.response.status).toBe(409); expect(f.calls).toHaveLength(0);
    expect(f.sqlite.prepare("SELECT used_requests FROM team_model_funding WHERE id=?").get(grant.id)).toEqual({ used_requests: 0 });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM team_model_money_ledger").get()).toEqual({ count: 0 });
  });
  it("cannot spend one money envelope across two separately approved concurrent turns", async () => {
    const f = await fixture(), grant = await f.fund({ maxRequests: 10, budgetMicroUsd: teamModelMaximumDebitMicroUsd(64) });
    const first = await f.approve(await f.turn(grant)), second = await f.approve(await f.turn(grant, { prompt: "Another exact human request" }));
    const arrived = f.hold(), running = f.execute(first); await arrived;
    try { expect((await f.execute(second)).response.status).toBe(409); } finally { f.release(); }
    await running; expect((await f.execute(second)).response.status).toBe(409); expect(f.calls).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count,SUM(reserved_micro_usd) AS debit FROM team_model_money_ledger").get()).toEqual({ count: 1, debit: teamModelMaximumDebitMicroUsd(64) });
  });
  it("does not charge or invoke twice when a confirmed settlement acknowledgement is lost", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant));
    const batch = f.database.batch.bind(f.database); let writes = 0;
    f.database.batch = async <T = unknown>(statements: D1PreparedStatement[]) => { const result = await batch<T>(statements); if (++writes === 2) throw new Error("Fixture settlement acknowledgement lost"); return result; };
    expect((await f.execute(approved)).response.status).toBe(503); f.database.batch = batch;
    expect((await f.execute(approved)).body.turn).toMatchObject({ status: "completed", output: "Fixture text response" });
    expect(f.calls).toHaveLength(1); expect(f.sqlite.prepare("SELECT COUNT(*) AS count,SUM(reserved_micro_usd) AS debit FROM team_model_money_ledger").get()).toEqual({ count: 1, debit: teamModelMaximumDebitMicroUsd(64) });
  });
  it("uses the final money snapshot when another debit arrives during a state read", async () => {
    const f = await fixture(), grant = await f.fund({ maxRequests: 10, budgetMicroUsd: teamModelMaximumDebitMicroUsd(64) }), approved = await f.approve(await f.turn(grant));
    const contract = JSON.parse(String(f.sqlite.prepare("SELECT contract_json FROM team_model_funding WHERE id=?").get(grant.id)!.contract_json));
    let injected = false;
    interceptD1(f.env, (sql, op) => op === "all" && sql.includes("'actor' AS kind") && !injected, () => {
      injected = true; f.sqlite.prepare("INSERT INTO team_model_money_ledger(turn_id,grant_id,workspace_id,input_hash,quote_digest,reserved_micro_usd,state,created_at,updated_at) VALUES('fixture-concurrent-turn',?,?,?,?,?,'confirmed',1,1)")
        .run(grant.id, f.workspace.workspaceId, "fixture-other-hash", contract.money.quote.digest, contract.money.maximumDebitPerCallMicroUsd);
    });
    const state = await f.call(`/state?roomId=${f.roomId}`);
    expect((state.body.turns as Array<{ id: string; canExecute: boolean }>).find((turn) => turn.id === approved.id)!.canExecute).toBe(false);
    expect((state.body.grants as Array<{ money: { remainingBudgetMicroUsd: number } }>)[0]!.money.remainingBudgetMicroUsd).toBe(0); expect(f.calls).toHaveLength(0);
  });
  it.each([{ currency: "EUR" }, { budgetMicroUsd: 1_000_001 }, { budgetMicroUsd: 1.1 }, { budgetMicroUsd: -1 }, { currency: undefined }, { budgetMicroUsd: undefined }])("requires an exact supported currency and integer budget %j", async (changes) => {
    const f = await fixture(), result = await f.call("/funding/prepare", "POST", { ...f.fundingInput, ...changes });
    expect(result.response.status).toBe(400); expect(f.calls).toHaveLength(0);
  });
  it.each(["missing usage", "inconsistent usage", "wrong model"])("retains full authorization and blocks the grant after %s", async (mode) => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant));
    const response = aiResponse("Unconfirmed output") as Record<string, unknown>;
    if (mode === "missing usage") delete response.usage;
    else if (mode === "wrong model") response.model = "another-model";
    else response.usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 };
    f.run.mockResolvedValueOnce(response);
    expect((await f.execute(approved)).body.turn).toMatchObject({ status: "unknown", output: null, error: "team_model_usage_unknown" });
    expect(f.sqlite.prepare("SELECT reserved_micro_usd,state,reported_micro_usd FROM team_model_money_ledger").get()).toEqual({ reserved_micro_usd: teamModelMaximumDebitMicroUsd(64), state: "unknown", reported_micro_usd: null });
    await f.execute(approved); expect(f.run).toHaveBeenCalledTimes(1);
    const state = await f.call(`/state?roomId=${f.roomId}`); expect((state.body.grants as Array<{ state: string }>)[0]!.state).toBe("unknown");
  });
  it("expires a quote during final authority await without calling AI or releasing the claim", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant));
    const contract = JSON.parse(String(f.sqlite.prepare("SELECT contract_json FROM team_model_funding WHERE id=?").get(grant.id)!.contract_json));
    const authority = holdAuthorityRead(f.env, 1), execution = f.execute(approved); await authority.started;
    vi.spyOn(Date, "now").mockReturnValue(contract.money.quote.dispatchUntil + 1); authority.release();
    await execution; expect(f.calls).toHaveLength(0);
    expect(f.sqlite.prepare("SELECT reserved_micro_usd,state FROM team_model_money_ledger").get()).toEqual({ reserved_micro_usd: teamModelMaximumDebitMicroUsd(64), state: "unknown" });
  });
  it("keeps completed output readable after dispatch quote expiry without permitting more inference", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant)); await f.execute(approved);
    const contract = JSON.parse(String(f.sqlite.prepare("SELECT contract_json FROM team_model_funding WHERE id=?").get(grant.id)!.contract_json));
    vi.spyOn(Date, "now").mockReturnValue(contract.money.quote.dispatchUntil + 1);
    const state = await f.call(`/state?roomId=${f.roomId}`);
    expect((state.body.turns as TurnReceipt[])[0]).toMatchObject({ status: "completed", output: "Fixture text response" });
    expect((state.body.grants as Array<{ unavailableReason: string }>)[0]!.unavailableReason).toBe("team_model_price_quote_expired");
    expect(f.calls).toHaveLength(1);
  });
  it("renders authorized legacy output while denying new amountless execution", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant)); await f.execute(approved);
    const contract = JSON.parse(String(f.sqlite.prepare("SELECT contract_json FROM team_model_funding WHERE id=?").get(grant.id)!.contract_json));
    delete contract.money; f.sqlite.prepare("UPDATE team_model_funding SET contract_json=? WHERE id=?").run(JSON.stringify(contract), grant.id);
    f.sqlite.prepare("DELETE FROM team_model_money_ledger WHERE grant_id=?").run(grant.id);
    const state = await f.call(`/state?roomId=${f.roomId}`);
    expect((state.body.turns as TurnReceipt[])[0]).toMatchObject({ status: "completed", output: "Fixture text response" });
    const next = await f.call("/turns/prepare", "POST", { grantId: grant.id, expectedGrantVersion: grant.version, prompt: "No old funding fallback", messageIds: [], memoryRefs: [], requestId: crypto.randomUUID() });
    expect(next.response.status).toBe(409); expect(next.body.error).toBe("team_model_budget_upgrade_required"); expect(f.calls).toHaveLength(1);
  });
  it.each(["legacy", "changed price"])("does not dispatch previously approved input under a %s funding quote", async (kind) => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant));
    const contract = JSON.parse(String(f.sqlite.prepare("SELECT contract_json FROM team_model_funding WHERE id=?").get(grant.id)!.contract_json));
    if (kind === "legacy") delete contract.money; else contract.money.quote.outputMicroUsdPerMillionTokens = 1;
    f.sqlite.prepare("UPDATE team_model_funding SET contract_json=? WHERE id=?").run(JSON.stringify(contract), grant.id);
    expect((await f.execute(approved)).response.status).toBe(409); expect(f.calls).toHaveLength(0);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM team_model_money_ledger").get()).toEqual({ count: 0 });
  });
  it("denies default-off funding and never calls AI or any legacy provider", async () => {
    const f = await fixture(false);
    const state = await f.call(`/state?roomId=${f.roomId}`);
    expect(state.body).toMatchObject({ enabled: false, canFund: false, unavailableReason: "team_model_disabled" });
    expect((await f.call("/funding/prepare", "POST", f.fundingInput)).response.status).toBe(403);
    expect(f.calls).toHaveLength(0);
  });
  it.each(["absent", "true", "unknown-model"])("fails closed for the %s deployment policy", async (mode) => {
    const f = await fixture();
    if (mode === "absent") delete f.env.SHIBA_TEAM_MODEL_SESSIONS;
    else if (mode === "true") f.env.SHIBA_TEAM_MODEL_SESSIONS = "true";
    else f.env.SHIBA_TEAM_MODEL_MODEL = "@cf/unsupported/another-model";
    expect((await f.call(`/state?roomId=${f.roomId}`)).body).toMatchObject({ enabled: false, canFund: false });
    expect((await f.call("/funding/prepare", "POST", f.fundingInput)).response.status).toBe(403); expect(f.calls).toHaveLength(0);
  });
  it("requires native bootstrap plus current workspace management, exact billing consent, exact turn review and one-shot text execution", async () => {
    const f = await fixture(); user.email = MANAGER;
    expect((await f.call("/funding/prepare", "POST", f.fundingInput)).response.status).toBe(403);
    user.email = OPERATOR; const draft = await f.prepare();
    expect((await f.call(`/funding/${draft.id}/activate`, "POST", { expectedVersion: draft.version, digest: draft.digest, reviewed: true, billingConsent: false })).response.status).toBe(400);
    const activated = await f.call(`/funding/${draft.id}/activate`, "POST", { expectedVersion: draft.version, digest: draft.digest, reviewed: true, billingConsent: true });
    const grant = activated.body.grant as GrantReceipt, pending = await f.turn(grant, { messageIds: ["message-human"], memoryRefs: [{ id: f.note.id, version: f.note.version, sha256: f.note.sha256 }] });
    expect((await f.execute(pending)).response.status).toBe(403); expect(f.calls).toHaveLength(0);
    const approved = await f.approve(pending), completed = await f.execute(approved);
    expect(completed.response.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.turn).toMatchObject({ status: "completed", output: "Fixture text response" });
    await f.execute(approved); expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.input).toMatchObject({ stream: false, n: 1, max_completion_tokens: 64, modalities: ["text"], tool_choice: "none", store: false, chat_template_kwargs: { enable_thinking: false } });
    expect(f.calls[0]!.input).not.toHaveProperty("tools"); expect(f.calls[0]!.input).not.toHaveProperty("functions");
    const saved = f.sqlite.prepare("SELECT used_requests,reserved_input_bytes,reserved_output_tokens FROM team_model_funding WHERE id=?").get(grant.id);
    expect(saved).toEqual({ used_requests: 1, reserved_input_bytes: pending.inputBytes, reserved_output_tokens: 64 });
  });
  it("rejects unknown input fields, cross-workspace IDs, Access-only identity and ordinary manager billing", async () => {
    const f = await fixture();
    expect((await f.call("/funding/prepare", "POST", { ...f.fundingInput, workspaceId: f.other.workspaceId })).response.status).toBe(400);
    expect((await f.call(`/state?roomId=${f.roomId}`, "GET", undefined, f.other.workspaceId)).response.status).toBe(403);
    user.native = false; expect((await f.call(`/state?roomId=${f.roomId}`)).response.status).toBe(403);
    expect(f.calls).toHaveLength(0);
  });
  it("binds the complete input byte budget, not just the requested prompt", async () => {
    const f = await fixture(), grant = await f.fund({ maxInputBytes: 32 }); user.email = MEMBER;
    const result = await f.call("/turns/prepare", "POST", { grantId: grant.id, expectedGrantVersion: grant.version, prompt: "Hi", messageIds: [], memoryRefs: [], requestId: crypto.randomUUID() });
    expect(result.response.status).toBe(400); expect(result.body.error).toBe("team_model_full_input_exceeds_grant"); expect(f.calls).toHaveLength(0);
  });
  it("permanently invalidates grants after room removal and re-add instead of reviving old approval", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant));
    f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE workspace_id=? AND room_id=? AND user_id=?").run(f.workspace.workspaceId, f.roomId, MEMBER);
    f.sqlite.prepare("UPDATE collaboration_memberships SET status='active' WHERE workspace_id=? AND room_id=? AND user_id=?").run(f.workspace.workspaceId, f.roomId, MEMBER);
    expect(f.sqlite.prepare("SELECT state,version FROM team_model_funding WHERE id=?").get(grant.id)).toEqual({ state: "blocked", version: grant.version + 1 });
    await f.execute(approved); expect(f.calls).toHaveLength(0);
  });
  it("consumes and retains uncertain inference slots without replay or refund", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant)); f.unknown();
    const result = await f.execute(approved); expect(result.body.turn).toMatchObject({ status: "unknown", output: null });
    await f.execute(approved); expect(f.calls).toHaveLength(1);
    const next = await f.call("/turns/prepare", "POST", { grantId: grant.id, expectedGrantVersion: grant.version, prompt: "Another prompt", messageIds: [], memoryRefs: [], requestId: crypto.randomUUID() });
    expect(next.response.status).toBe(409);
    expect(f.sqlite.prepare("SELECT used_requests,reserved_output_tokens FROM team_model_funding WHERE id=?").get(grant.id)).toEqual({ used_requests: 1, reserved_output_tokens: 64 });
  });
  it("uses the append-only migration with the same actual runtime contracts", async () => {
    const f = await fixture(); f.sqlite.exec(readFileSync(new URL("../migrations/0013_team_model_sessions.sql", import.meta.url), "utf8"));
    const grant = await f.fund(); expect(grant.state).toBe("active"); expect(f.calls).toHaveLength(0);
  });
  it.each([OPERATOR, MEMBER])("rejects native UUID replacement for %s without spending or returning cached inputs", async (email) => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant));
    const old = user.accounts[email]!, replacement = crypto.randomUUID();
    f.sqlite.prepare('DELETE FROM "user" WHERE id=?').run(old);
    f.sqlite.prepare('INSERT INTO "user" VALUES(?,?,1)').run(replacement, email);
    f.sqlite.prepare("INSERT INTO shiba_auth_account_policy VALUES(?,?,?)").run(replacement, email, email === OPERATOR ? "bootstrap" : "invited"); user.accounts[email] = replacement;
    await f.execute(approved); expect(f.calls).toHaveLength(0);
    const state = await f.call(`/state?roomId=${f.roomId}`);
    expect(JSON.stringify(state.body)).not.toContain("Prepare a short response."); expect(JSON.stringify(state.body)).not.toContain("Fixture text response");
  });
  it("reserves one slot atomically across duplicate concurrent execution and refuses N+1 before inference", async () => {
    const f = await fixture(), grant = await f.fund({ maxRequests: 1 }), first = await f.approve(await f.turn(grant));
    const second = await f.approve(await f.turn(grant, { prompt: "A separate reviewed turn" }));
    const arrived = f.hold(), running = f.execute(first); await arrived;
    try {
      await Promise.all([f.execute(first), f.execute(second)]);
      expect(f.calls).toHaveLength(1);
    } finally { f.release(); }
    await running;
    const state = await f.call(`/state?roomId=${f.roomId}`), turns = state.body.turns as Array<{ id: string; canExecute: boolean }>;
    expect(turns.find((turn) => turn.id === second.id)?.canExecute).toBe(false);
    expect(f.sqlite.prepare("SELECT used_requests,reserved_output_tokens FROM team_model_funding WHERE id=?").get(grant.id)).toEqual({ used_requests: 1, reserved_output_tokens: 64 });
  });
  it("durably stops an in-flight turn, aborts its active signal and retains uncertainty without a retry or late output", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant));
    const arrived = f.hold(), running = f.execute(approved); await arrived;
    const state = await f.call(`/state?roomId=${f.roomId}`), active = (state.body.turns as TurnReceipt[]).find((turn) => turn.id === approved.id)!;
    const stopped = await f.call(`/turns/${active.id}/cancel`, "POST", { expectedVersion: active.version });
    expect(stopped.body.turn).toMatchObject({ status: "unknown", output: null });
    await vi.waitFor(() => expect(f.calls[0]!.signal.aborted).toBe(true), { timeout: 3000 });
    const result = await running; expect(result.body.turn).toMatchObject({ status: "unknown", output: null });
    f.release(); await f.execute(approved);
    expect(f.calls).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT used_requests,reserved_output_tokens FROM team_model_funding WHERE id=?").get(grant.id)).toEqual({ used_requests: 1, reserved_output_tokens: 64 });
  });
  it("rechecks source revocation at the actual slot transaction after asynchronous preflight", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant, { memoryRefs: [{ id: f.note.id, version: f.note.version, sha256: f.note.sha256 }] }));
    const batch = f.database.batch.bind(f.database);
    f.database.batch = (statements) => { f.sqlite.prepare("UPDATE collaboration_memory SET revoked_at=? WHERE context_id=?").run(Date.now(), f.note.id); return batch(statements); };
    const result = await f.execute(approved); expect(result.response.status).toBe(409); expect(f.calls).toHaveLength(0);
    expect(f.sqlite.prepare("SELECT used_requests FROM team_model_funding WHERE id=?").get(grant.id)).toEqual({ used_requests: 0 });
  });
  it("enforces expiry using the database clock at claim time and never invokes a fallback model", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant));
    f.sqlite.function("julianday", (_value: unknown) => 2_440_587.5 + (approved.expiresAt + 100) / 86_400_000);
    await f.execute(approved); expect(f.calls).toHaveLength(0);
    f.env.SHIBA_TEAM_MODEL_MODEL = "@cf/unsupported/changed";
    await f.execute(approved); expect(f.calls).toHaveLength(0);
  });
  it("cancels a pending turn before any reservation and refuses Slack or agent-result context", async () => {
    const f = await fixture(), grant = await f.fund(), pending = await f.turn(grant);
    expect((await f.call(`/turns/${pending.id}/cancel`, "POST", { expectedVersion: pending.version })).body.turn).toMatchObject({ status: "cancelled", output: null });
    await f.execute(pending); expect(f.calls).toHaveLength(0);
    f.sqlite.prepare("UPDATE collaboration_messages SET source_slack_event_id='unavailable-private-source' WHERE message_id='message-human'").run();
    const selected = await f.call("/turns/prepare", "POST", { grantId: grant.id, expectedGrantVersion: grant.version, prompt: "Explain", messageIds: ["message-human"], memoryRefs: [], requestId: crypto.randomUUID() });
    expect(selected.response.status).toBe(403); expect(f.calls).toHaveLength(0);
    expect(f.sqlite.prepare("SELECT used_requests FROM team_model_funding WHERE id=?").get(grant.id)).toEqual({ used_requests: 0 });
  });
  it("blocks funding for actively Slack-linked rooms instead of borrowing bot visibility", async () => {
    const f = await fixture();
    f.sqlite.prepare("INSERT INTO collaboration_slack_room_links(link_id,tenant_id,workspace_id,room_id,owner_user_id,team_id,channel_id,thread_ts,status,created_at) VALUES('fixture-link','self-hosted',?,?,'operator@example.test','T','C','123.456','active',1)").run(f.workspace.workspaceId, f.roomId);
    expect((await f.call("/funding/prepare", "POST", f.fundingInput)).response.status).toBe(403); expect(f.calls).toHaveLength(0);
  });
  it("deduplicates an exact request ID but rejects changed prompt or selections", async () => {
    const f = await fixture(), grant = await f.fund(), requestId = crypto.randomUUID();
    const first = await f.turn(grant, { requestId }), second = await f.turn(grant, { requestId }); expect(first.id).toBe(second.id);
    const changed = await f.call("/turns/prepare", "POST", { grantId: grant.id, expectedGrantVersion: grant.version, prompt: "Changed request", messageIds: [], memoryRefs: [], requestId });
    expect(changed.response.status).toBe(409); expect(f.calls).toHaveLength(0);
  });
  it("observes an abort during a stalled final authority read without inference or an unhandled rejection", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant)), hold = holdAuthorityRead(f.env, 1), controller = new AbortController();
    const unhandled: unknown[] = [], listener = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", listener);
    try {
      const running = f.execute(approved, controller.signal); await hold.started; controller.abort();
      const result = await running; expect(result.body.turn).toMatchObject({ status: "blocked", output: null });
      expect(f.calls).toHaveLength(0); expect(unhandled).toEqual([]);
      expect(f.sqlite.prepare("SELECT used_requests FROM team_model_funding WHERE id=?").get(grant.id)).toEqual({ used_requests: 1 });
    } finally { hold.release(); process.removeListener("unhandledRejection", listener); }
  });
  it.each(["complete", "abort"])("finishes bounded cleanup after %s when a cancellation polling read is stalled", async (operation) => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant)), held = holdAuthorityRead(f.env, 2);
    const controller = new AbortController(), arrived = f.hold(), running = f.execute(approved, controller.signal); await arrived; await held.started;
    if (operation === "abort") controller.abort(); else f.release();
    try {
      const result = await running; expect(result.body.turn).toMatchObject(operation === "abort" ? { status: "unknown", output: null } : { status: "completed", output: "Late fixture output" }); expect(f.calls).toHaveLength(1);
    } finally { held.release(); f.release(); }
  });
  it("blocks and hides a late response after room removal and re-add during inference", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant)), arrived = f.hold();
    const running = f.execute(approved); await arrived;
    f.sqlite.prepare("UPDATE collaboration_memberships SET status='removed' WHERE workspace_id=? AND room_id=? AND user_id=?").run(f.workspace.workspaceId, f.roomId, MEMBER);
    f.sqlite.prepare("UPDATE collaboration_memberships SET status='active' WHERE workspace_id=? AND room_id=? AND user_id=?").run(f.workspace.workspaceId, f.roomId, MEMBER);
    f.release(); const result = await running;
    expect(JSON.stringify(result.body)).not.toContain("Late fixture output"); expect(JSON.stringify(result.body)).not.toContain("Prepare a short response.");
    expect(f.sqlite.prepare("SELECT output FROM team_model_turns WHERE id=?").get(approved.id)).toEqual({ output: null }); expect(f.calls).toHaveLength(1);
  });
  it("withholds completed prompt, selected context and output when a note is revoked at the final read snapshot", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant, { memoryRefs: [{ id: f.note.id, version: f.note.version, sha256: f.note.sha256 }] }));
    await f.execute(approved); let revoked = false;
    interceptD1(f.env, (sql, op) => op === "all" && sql.includes("AS id,'actor'") && !revoked, () => { revoked = true; f.sqlite.prepare("UPDATE collaboration_memory SET revoked_at=? WHERE context_id=?").run(Date.now(), f.note.id); });
    const state = await f.call(`/state?roomId=${f.roomId}`); expect(revoked).toBe(true);
    for (const text of ["Fixture text response", "Prepare a short response.", "A deliberately selected fact."]) expect(JSON.stringify(state.body)).not.toContain(text);
  });
  it("keeps a member's prompts and outputs private from same-room managers and the funding issuer", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant)); await f.execute(approved);
    for (const email of [MANAGER, OPERATOR]) {
      user.email = email; const state = await f.call(`/state?roomId=${f.roomId}`);
      expect(state.body.turns).toEqual([]); expect(JSON.stringify(state.body)).not.toContain("Fixture text response");
    }
    expect(f.calls).toHaveLength(1);
  });
  it("reconciles a lost committed claim receipt as unknown without replaying or refunding its slot", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant));
    const batch = f.database.batch.bind(f.database);
    f.database.batch = async (statements) => { await batch(statements); throw new Error("Claim receipt lost after commit"); };
    expect((await f.execute(approved)).response.status).toBe(503); f.database.batch = batch;
    f.sqlite.prepare("UPDATE team_model_turns SET dispatch_deadline=? WHERE id=?").run(Date.now() - 1, approved.id);
    const state = await f.call(`/state?roomId=${f.roomId}`);
    expect((state.body.turns as TurnReceipt[])[0]).toMatchObject({ status: "unknown", output: null });
    await f.execute(approved); expect(f.calls).toHaveLength(0);
    expect(f.sqlite.prepare("SELECT used_requests,reserved_input_bytes,reserved_output_tokens FROM team_model_funding WHERE id=?").get(grant.id)).toEqual({ used_requests: 1, reserved_input_bytes: approved.inputBytes, reserved_output_tokens: 64 });
  });
  it.each(["profile", "recipient", "issuer-policy", "issuer-membership"])("denies %s revocation before inference without spending a request", async (source) => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant));
    if (source === "profile") f.sqlite.prepare("UPDATE org_custom_agents SET version=version+1 WHERE id=?").run(f.employee.id);
    else if (source === "recipient") f.sqlite.prepare('UPDATE "user" SET emailVerified=0 WHERE id=?').run(user.accounts[MEMBER]!);
    else if (source === "issuer-policy") f.sqlite.prepare("UPDATE shiba_auth_account_policy SET kind='invited' WHERE account_id=?").run(user.accounts[OPERATOR]!);
    else f.sqlite.prepare("UPDATE team_workspace_memberships SET role='member',version=version+1 WHERE workspace_id=? AND user_id=?").run(f.workspace.workspaceId, OPERATOR);
    await f.execute(approved); expect(f.calls).toHaveLength(0);
    expect(f.sqlite.prepare("SELECT used_requests FROM team_model_funding WHERE id=?").get(grant.id)).toEqual({ used_requests: 0 });
  });
  it("bounds UTF-8 output without inserting an oversized replacement at a split code point", async () => {
    const f = await fixture(), grant = await f.fund(), approved = await f.approve(await f.turn(grant));
    f.run.mockResolvedValueOnce(aiResponse("abc" + "😀".repeat(4096)));
    const result = await f.execute(approved), output = (result.body.turn as TurnReceipt).output!;
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(8192);
    expect(output.endsWith("\n[truncated]")).toBe(true); expect(output).not.toContain("\uFFFD");
  });
});
