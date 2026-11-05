// Fixture setup follows team-model-sessions.test.ts; adversarial cases below exercise imported production routes and real SQLite.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEAM_MODEL_TEXT_MODEL, TEAM_MODEL_LLAMA_MODEL, teamModelMaximumDebitMicroUsd } from "@shiba/shared";
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

function seedHistory(f: Awaited<ReturnType<typeof fixture>>, grant: string, total: number, state: string) {
  const insert = f.sqlite.prepare("INSERT INTO team_model_money_ledger(turn_id,grant_id,workspace_id,input_hash,quote_digest,reserved_micro_usd,state,created_at,updated_at) VALUES(?,?,?,'history','history',?,?,1,1)");
  for (let i = 0, left = total; left > 0; i++) {
    const amount = Math.min(left, 8341); insert.run(`history-${i}`, grant, f.workspace.workspaceId, amount, state); left -= amount;
  }
}
describe("independent cumulative funding security v3", () => {
  it.each(["confirmed", "unknown"])("serializes two distinct grants at the permanent actor ceiling including %s history", async (state) => {
    const f = await fixture();
    const prior = await f.fund(), a = await f.fund(), b = await f.fund();
    const one = await f.approve(await f.turn(a)), two = await f.approve(await f.turn(b));
    const debit = teamModelMaximumDebitMicroUsd(64);
    seedHistory(f, prior.id, 1_000_000 - debit, state);
    const outcomes = await Promise.all([f.execute(one), f.execute(two)]);
    expect(outcomes.map(x => x.response.status).sort()).toEqual([200, 409]);
    expect(f.calls).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT SUM(reserved_micro_usd) AS total FROM team_model_money_ledger").get()).toEqual({ total: 1_000_000 });
    expect(f.sqlite.prepare("SELECT SUM(used_requests) AS calls FROM team_model_funding").get()).toEqual({ calls: 1 });
    // Revoke and age the old grant: the already incurred reservation remains cumulative.
    f.sqlite.prepare("UPDATE team_model_funding SET state='revoked',updated_at=1 WHERE id=?").run(prior.id);
    await f.execute(one); await f.execute(two);
    expect(f.calls).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT SUM(reserved_micro_usd) AS reserved_micro_usd,state FROM team_model_money_ledger WHERE grant_id=?").get(prior.id)).toEqual({ reserved_micro_usd: 1_000_000 - debit, state });
  });
  it("counts orphaned unknown workspace debits while two different grants compete", async () => {
    const f = await fixture(), a = await f.fund(), b = await f.fund();
    const one = await f.approve(await f.turn(a)), two = await f.approve(await f.turn(b));
    const debit = teamModelMaximumDebitMicroUsd(64);
    seedHistory(f, "absent-grant", 10_000_000 - debit, "unknown");
    const outcomes = await Promise.all([f.execute(one), f.execute(two)]);
    expect(outcomes.map(x => x.response.status).sort()).toEqual([200, 409]); expect(f.calls).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT SUM(reserved_micro_usd) AS total FROM team_model_money_ledger").get()).toEqual({ total: 10_000_000 });
  });
  it("rolls back both request counter and turn claim when durable reservation insert fails", async () => {
    const f = await fixture(), grant = await f.fund(), turn = await f.approve(await f.turn(grant));
    f.sqlite.exec("CREATE TRIGGER deny_reservation BEFORE INSERT ON team_model_money_ledger BEGIN SELECT RAISE(ABORT,'fixture durable write failure'); END");
    expect((await f.execute(turn)).response.status).toBe(503); expect(f.calls).toHaveLength(0);
    expect(f.sqlite.prepare("SELECT used_requests FROM team_model_funding WHERE id=?").get(grant.id)).toEqual({ used_requests: 0 });
    expect(f.sqlite.prepare("SELECT status FROM team_model_turns WHERE id=?").get(turn.id)).toEqual({ status: "approved" });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM team_model_money_ledger").get()).toEqual({ n: 0 });
  });
});

describe("independent Llama model money security v3", () => {
  it("binds native frozen Llama input and reserves exactly 5158 microUSD without fabricating provider identity", async () => {
    const f = await fixture(); f.env.SHIBA_TEAM_MODEL_MODEL = TEAM_MODEL_LLAMA_MODEL;
    const grant = await f.fund({ model: TEAM_MODEL_LLAMA_MODEL, maxOutputTokens: 1024 }), turn = await f.approve(await f.turn(grant));
    f.run.mockResolvedValueOnce({ response: "Fixture response", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    expect((await f.execute(turn)).response.status).toBe(200);
    expect(f.run).toHaveBeenCalledTimes(1); expect(f.run.mock.calls[0]![0]).toBe(TEAM_MODEL_LLAMA_MODEL);
    expect(Object.keys(f.run.mock.calls[0]![1]).sort()).toEqual(["max_tokens", "messages", "stream"]);
    const ledger = f.sqlite.prepare("SELECT reserved_micro_usd,reported_micro_usd,receipt_json FROM team_model_money_ledger").get()!;
    expect(ledger).toMatchObject({ reserved_micro_usd: 5158, reported_micro_usd: 2 });
    expect(JSON.parse(String(ledger.receipt_json))).toMatchObject({ requestedModel: TEAM_MODEL_LLAMA_MODEL, bindingRequestId: turn.id, providerCompletionId: null, providerModel: null, inputHash: turn.inputHash });
  });
  it.each(["absent-usage", "contradictory-model"])("holds the full Llama debit permanently after %s", async (mode) => {
    const f = await fixture(); f.env.SHIBA_TEAM_MODEL_MODEL = TEAM_MODEL_LLAMA_MODEL;
    const grant = await f.fund({ model: TEAM_MODEL_LLAMA_MODEL, maxOutputTokens: 1024 }), turn = await f.approve(await f.turn(grant));
    f.run.mockResolvedValueOnce(mode === "absent-usage" ? { response: "unverified" } : { response: "unverified", model: TEAM_MODEL_TEXT_MODEL, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    expect((await f.execute(turn)).body.turn).toMatchObject({ status: "unknown", output: null });
    expect(f.sqlite.prepare("SELECT reserved_micro_usd,state FROM team_model_money_ledger").get()).toEqual({ reserved_micro_usd: 5158, state: "unknown" });
    await f.execute(turn); expect(f.run).toHaveBeenCalledTimes(1);
    expect((await f.call("/turns/prepare", "POST", { grantId: grant.id, expectedGrantVersion: grant.version, prompt: "Retry", messageIds: [], memoryRefs: [], requestId: crypto.randomUUID() })).response.status).toBe(409);
  });
});
