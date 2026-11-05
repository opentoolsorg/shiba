import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Env } from "../src/env.js";
import { handleWorkspaceIntegrations } from "../src/workspace-integrations-routes.js";
import { createTeamWorkspace, createTeamWorkspaceInvitation, acceptTeamWorkspaceInvitation, getTeamWorkspaceMembership } from "../src/team-workspaces-store.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { openConnectorConnectionName, openConnectorWorkspaceConnectionName } from "../src/integrations/openconnector-provider.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const actor = vi.hoisted(() => ({ email: "owner@example.test", native: true, accounts: {} as Record<string, string>, nativeReads: 0, afterNativeRead: undefined as (() => void) | undefined }));
vi.mock("@shiba/auth/better-auth", async (original) => ({ ...await original<typeof import("@shiba/auth/better-auth")>(),
  resolveBetterAuthSessionAccount: async () => {
    actor.nativeReads++; actor.afterNativeRead?.();
    return actor.native && actor.accounts[actor.email]
      ? { policy: { accountId: actor.accounts[actor.email], email: actor.email, kind: "invited", createdAt: 1 }, emailVerified: true } : null;
  },
}));
vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: async () => true, resolveUserId: async () => actor.email,
}));
const OWNER = "owner@example.test", MEMBER = "member@example.test", ADMIN = "admin@example.test";
beforeEach(() => { actor.email = OWNER; actor.native = true; actor.accounts = {}; actor.nativeReads = 0; actor.afterNativeRead = undefined; });
afterEach(() => { vi.restoreAllMocks(); });
type Account = { id: string; service: string; connectionName: string; configured: boolean; virtual: boolean; oauthAuthorizationId: string; profile: { displayName: string } };
async function fixture() {
  const db = customAgentD1();
  db.sqlite.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY,email TEXT UNIQUE,emailVerified INTEGER); CREATE TABLE shiba_auth_account_policy (account_id TEXT PRIMARY KEY,email TEXT)');
  for (const email of [OWNER, MEMBER, ADMIN, "other-owner@example.test"]) {
    const accountId = crypto.randomUUID(); actor.accounts[email] = accountId;
    db.sqlite.prepare('INSERT INTO "user"(id,email,emailVerified) VALUES(?,?,1)').run(accountId, email);
    db.sqlite.prepare("INSERT INTO shiba_auth_account_policy(account_id,email) VALUES(?,?)").run(accountId, email);
  }
  const accounts: Account[] = [{ id: "private-owned-row", service: "github", connectionName: await openConnectorConnectionName(OWNER), configured: true, virtual: false,
    oauthAuthorizationId: "private-consent", profile: { displayName: "Private account must stay private" } }];
  let pending: { state: string; service: string; connectionName: string } | undefined;
  let afterAccountRead: (() => void) | undefined;
  let rejectAction = false;
  let holdAction: ((response: Response) => void) | undefined;
  let pendingAction: Promise<Response> | undefined;
  let actionArrived: (() => void) | undefined;
  const effects: unknown[] = [];
  /** Fixture sibling HTTP only. No OAuth server, vendor account or action is contacted. */
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/connections" && init?.method !== "DELETE") {
      const snapshot = structuredClone(accounts); afterAccountRead?.(); afterAccountRead = undefined;
      return Response.json(snapshot);
    }
    if (url.pathname === "/v1/providers/github/setup") return Response.json({ success: true, data: { service: "github", oauthClient: { configured: true, missingFields: [] } } });
    if (url.pathname === "/api/providers") return Response.json([{ service: "github", displayName: "GitHub", authTypes: ["oauth2"] }]);
    if (url.pathname === "/api/oauth/authorizations") {
      const body = JSON.parse(String(init?.body)) as { service: string; connectionName: string };
      pending = { ...body, state: crypto.randomUUID() };
      expect(body.connectionName.startsWith("w_")).toBe(true);
      return Response.json({ state: pending.state, authorizationUrl: `https://oauth.vendor.example/authorize?state=${pending.state}` });
    }
    if (url.pathname === "/api/connections/github" && init?.method === "DELETE") {
      const body = JSON.parse(String(init.body)) as { connectionName: string };
      for (let index = accounts.length - 1; index >= 0; index -= 1) if (accounts[index]?.connectionName === body.connectionName) accounts.splice(index, 1);
      return Response.json({ ok: true });
    }
    const action = { id: "github.create_issue", service: "github", name: "Create issue", description: "Fixture write", inputSchema: { type: "object", properties: { title: { type: "string" } } } };
    if (url.pathname === "/v1/actions/search") return Response.json({ success: true, data: [action] });
    if (url.pathname === "/v1/actions/github.create_issue") {
      if (init?.method !== "POST") return Response.json({ success: true, data: action });
      expect(new Headers(init.headers).get("x-oo-connector-alias")).toMatch(/^w_/);
      effects.push(JSON.parse(String(init.body)));
      actionArrived?.();
      if (rejectAction) throw new Error("Unknown action transport fixture");
      if (pendingAction) return pendingAction;
      return Response.json({ success: true, data: { id: "shared-result", title: "Created with exact consent" } });
    }
    throw new Error(`Unexpected fixture URL ${url.pathname}`);
  });
  const env = { AGENT_AUDIT: db.database, OPEN_CONNECTOR: { fetch: transport }, OPEN_CONNECTOR_ADMIN_TOKEN: "fixture-admin", OPEN_CONNECTOR_RUNTIME_TOKEN: "fixture-runtime" } as unknown as Env;
  const workspace = await createTeamWorkspace(env, OWNER, { name: "Workspace A" });
  const other = await createTeamWorkspace(env, "other-owner@example.test", { name: "Workspace B" });
  for (const [email, role] of [[MEMBER, "member"], [ADMIN, "admin"]] as const) {
    const invitation = await createTeamWorkspaceInvitation(env, workspace.workspaceId, OWNER, { email, role });
    await acceptTeamWorkspaceInvitation(env, email, invitation.token);
  }
  const employee = await createCustomAgent(env, `team:${workspace.workspaceId}`, "workspace-helper", { name: "Shared helper", instructions: "Use explicit shared account requests", harness: "opencode" });
  const request = (path: string, method = "GET", body?: unknown, space = workspace.workspaceId) => new Request(`https://shiba.test/api/workspace-integrations${path}`, {
    method, headers: { Origin: "https://shiba.test", "Content-Type": "application/json", "X-Shiba-Workspace": space }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const call = async (path: string, method = "GET", body?: unknown, space?: string) => {
    const response = await handleWorkspaceIntegrations(request(path, method, body, space), env);
    return { response: response!, body: await response!.json() as Record<string, unknown> };
  };
  const connect = async () => {
    actor.email = OWNER;
    const created = await call("/connect", "POST", { providerKey: "github", audienceConsent: "workspace-members" });
    expect(created.response.status, JSON.stringify(created.body)).toBe(201);
    const connection = created.body.connection as { id: string; version: number };
    const consent = pending!;
    accounts.push({ id: "workspace-upstream-row", service: consent.service, connectionName: consent.connectionName, configured: true, virtual: false, oauthAuthorizationId: consent.state, profile: { displayName: "Explicit workspace-shared account" } });
    const input = { expectedVersion: connection.version, pendingId: created.body.pendingId, authorizationFingerprint: created.body.authorizationFingerprint };
    const linked = await call(`/connections/${connection.id}/reconcile`, "POST", input);
    expect(linked.response.status, JSON.stringify(linked.body)).toBe(200);
    return { connection: linked.body.connection as { id: string; version: number }, input };
  };
  const grant = async (connection: { id: string; version: number }, manager = OWNER) => {
    actor.email = manager;
    const member = await getTeamWorkspaceMembership(env, workspace.workspaceId, OWNER);
    const result = await call(`/connections/${connection.id}/grants`, "PUT", { employeeId: employee.id, employeeVersion: employee.version, actorId: OWNER,
      actorMembershipVersion: member!.version, expectedConnectionVersion: connection.version, expectedGrantVersion: null, permissions: ["discover", "execute"] });
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
  };
  const actionRequest = async (connection: { id: string }) => {
    actor.email = MEMBER;
    return call(`/connections/${connection.id}/actions/request`, "POST", { employeeId: employee.id, employeeVersion: employee.version,
      actionId: "github.create_issue", arguments: { title: "Exact human approved title" }, requestId: crypto.randomUUID() });
  };
  return { ...db, env, workspace, other, employee, request, call, connect, grant, actionRequest, effects, transport, accounts,
    afterAccountRead(fn: () => void) { afterAccountRead = fn; }, unknownAction() { rejectAction = true; },
    holdAction() { pendingAction = new Promise<Response>((resolve) => { holdAction = resolve; }); return new Promise<void>((resolve) => { actionArrived = resolve; }); },
    releaseAction() { holdAction!(Response.json({ success: true, data: { id: "held-result" } })); } };
}
import { handleFounderConnectorJobs } from "../src/founder-connector-routes.js";
import { tickFounderConnectorJobs } from "../src/founder-connector-jobs.js";
import { installSkillDefinition } from "../src/skill-library/install.js";
import { activateSkill, getSkill, reviewSkill } from "../src/skills-store.js";
import { getFounderSkillLibraryEntry, type FounderConnectorState } from "@shiba/shared";
const libraryId = "founder-pr-digest";
async function founderFixture() {
  const f = await fixture();
  f.sqlite.function("julianday", (_value: unknown) => 2_440_587.5 + Date.now() / 86_400_000);
  const { connection } = await f.connect(); await f.grant(connection);
  actor.email = OWNER;
  const member = (await getTeamWorkspaceMembership(f.env, f.workspace.workspaceId, OWNER))!;
  const options = { teamGrant: { ...member, role: "owner" as const } };
  const recipe = getFounderSkillLibraryEntry(libraryId)!;
  const installed = await installSkillDefinition(f.env, `team:${f.workspace.workspaceId}`, OWNER, {
    slug: libraryId, name: recipe.name, instructions: recipe.instructions, sourceUrl: recipe.sourceUrl, version: "1.0.0",
  }, options);
  const skill = (await getSkill(f.env, `team:${f.workspace.workspaceId}`, OWNER, installed.skillId))!;
  await reviewSkill(f.env, skill.orgId, OWNER, skill.id, skill.version, skill.content.instructions, Date.now(), options);
  await activateSkill(f.env, skill.orgId, OWNER, skill.id, skill.version, skill.content.instructions, Date.now(), options);
  for (const key of ["AI", "CodingOrchestrator", "Sandbox", "TYPESAFE_API_KEY", "AI_GATEWAY_TOKEN"])
    Object.defineProperty(f.env, key, { get: () => { throw new Error(`Founder connector flow must not access ${key}`); } });
  const input = { employeeId: f.employee.id, employeeVersion: f.employee.version, skillId: skill.id, skillVersion: skill.version,
    connectionId: connection.id, connectionVersion: connection.version, actionId: "github.create_issue", arguments: { title: "One exact reviewed founder operation" },
    cadence: "daily", localTime: "09:00", timezone: "UTC", expiresAt: Date.now()+7*86_400_000, expectedVersion: 0 };
  const call = async (suffix="", method="GET", body?: unknown) => {
    const response = (await handleFounderConnectorJobs(new Request(`https://shiba.test/api/founder-skills/${libraryId}/connector-job${suffix}`, {
      method, headers: { Origin:"https://shiba.test", "Content-Type":"application/json", "X-Shiba-Workspace":f.workspace.workspaceId },
      ...(body === undefined ? {} : { body:JSON.stringify(body) }),
    }),f.env))!;
    return {response, body: await response.json() as FounderConnectorState & {error?:string}};
  };
  const configure = async () => { actor.email=OWNER; const result=await call("","POST",input); expect(result.response.status,JSON.stringify(result.body)).toBe(200); return result.body; };
  const pointer = (state:FounderConnectorState) => ({expectedVersion:state.plan!.version,digest:state.plan!.digest,reviewed:true as const});
  const due = async () => {
    const draft=await configure(), enabled=await call("/enable","POST",pointer(draft));
    expect(enabled.response.status,JSON.stringify(enabled.body)).toBe(200);
    vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(enabled.body.plan!.nextDueAt+100);
    const before=f.transport.mock.calls.length;
    expect(await tickFounderConnectorJobs(f.env)).toEqual({created:1,blocked:0});
    expect(f.transport.mock.calls.length).toBe(before);
    const state=(await call()).body;
    return state;
  };
  const occurrencePointer = (state:FounderConnectorState) => ({expectedVersion:state.plan!.version,digest:state.plan!.digest,occurrenceDigest:state.occurrences[0]!.digest});
  const prepare = async () => {
    const state=await due(), result=await call(`/occurrences/${encodeURIComponent(state.occurrences[0]!.id)}/prepare`,"POST",occurrencePointer(state));
    expect(result.response.status,JSON.stringify(result.body)).toBe(200); return result.body;
  };
  return {...f,connection,input,call,configure,due,prepare,pointer,occurrencePointer};
}
async function workspaceCall(f: Awaited<ReturnType<typeof founderFixture>>, path: string, method = "POST", body?: unknown) {
  return (await handleWorkspaceIntegrations(new Request(`https://shiba.test/api/workspace-integrations${path}`, { method,
    headers: { Origin: "https://shiba.test", "Content-Type": "application/json", "X-Shiba-Workspace": f.workspace.workspaceId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), f.env))!;
}
async function approve(f: Awaited<ReturnType<typeof founderFixture>>, state: FounderConnectorState) {
  actor.email = ADMIN;
  const result = await workspaceCall(f, `/approvals/${state.occurrences[0]!.approval!.id}/decision`, "POST", { approved: true });
  expect(result.status, await result.clone().text()).toBe(200);
  actor.email = OWNER;
}
afterEach(()=>vi.useRealTimers());

describe("founder connector occurrence workflow with real SQLite and fixture sibling HTTP",()=>{
  it("emits inert due work, then requires explicit request, human manager review and original requester execution",async()=>{
    const f=await founderFixture();
    const state=await f.prepare();
    expect(f.effects).toHaveLength(0);
    expect(state.occurrences[0]).toMatchObject({status:"awaiting-approval",canPrepare:false,canExecute:false});
    const occurrence=state.occurrences[0]!, approval=occurrence.approval!;
    expect(approval.arguments).toEqual(f.input.arguments);
    actor.email=ADMIN;
    const managerDecision=await f.env.AGENT_AUDIT.prepare("SELECT status FROM workspace_app_approvals WHERE id=?").bind(approval.id).first();
    expect(managerDecision).toEqual({status:"pending"});
    const decision=await handleWorkspaceIntegrations(new Request(`https://shiba.test/api/workspace-integrations/approvals/${approval.id}/decision`,{method:"POST",headers:{Origin:"https://shiba.test","Content-Type":"application/json","X-Shiba-Workspace":f.workspace.workspaceId},body:JSON.stringify({approved:true})}),f.env);
    expect(decision!.status,await decision!.clone().text()).toBe(200);
    expect(f.effects).toHaveLength(0);
    actor.email=OWNER;
    const result=await f.call(`/occurrences/${encodeURIComponent(occurrence.id)}/execute`,"POST",{...f.occurrencePointer(state),approvalId:approval.id,inputHash:approval.inputHash});
    expect(result.response.status,JSON.stringify(result.body)).toBe(200);
    expect(f.effects).toHaveLength(1);
    expect(result.body.occurrences[0]).toMatchObject({status:"completed",approval:{result:{id:"shared-result"}}});
    const replay=await f.call(`/occurrences/${encodeURIComponent(occurrence.id)}/execute`,"POST",{...f.occurrencePointer(result.body),approvalId:approval.id,inputHash:approval.inputHash});
    expect(replay.response.status,JSON.stringify(replay.body)).toBe(200);
    expect(f.effects).toHaveLength(1);
    actor.email=ADMIN;
    const managerView=await handleWorkspaceIntegrations(new Request(`https://shiba.test/api/workspace-integrations/approvals`,{headers:{"X-Shiba-Workspace":f.workspace.workspaceId}}),f.env);
    const body=await managerView!.json() as {approvals:Array<{id:string,result:unknown}>};
    expect(body.approvals.find(item=>item.id===approval.id)?.result).toBeNull();
  });
  it("blocks the direct generic execution route after the human pauses its founder plan", async () => {
    const f = await founderFixture(), state = await f.prepare();
    await approve(f, state);
    const paused = await f.call("/pause", "POST", f.pointer(state));
    expect(paused.response.status).toBe(200);
    const approval = state.occurrences[0]!.approval!;
    expect((await workspaceCall(f, `/approvals/${approval.id}/execute`, "POST", {})).status).toBe(409);
    expect(f.effects).toEqual([]);
    const listed = await (await workspaceCall(f, "/approvals", "GET")).json() as { approvals: Array<{ id: string; arguments: unknown; result: unknown; canExecute: boolean }> };
    expect(listed.approvals.find((item) => item.id === approval.id)).toMatchObject({ arguments: {}, result: null, canExecute: false });
  });
  it.each(["paused", "revoked"])("prevents a late vendor POST when the plan becomes %s during an awaited account read", async (stateAfter) => {
    const f = await founderFixture(), state = await f.prepare();
    await approve(f, state);
    f.afterAccountRead(() => f.sqlite.prepare("UPDATE founder_connector_jobs SET state=?,version=version+1 WHERE id=?").run(stateAfter, state.plan!.id));
    const approval = state.occurrences[0]!.approval!;
    await workspaceCall(f, `/approvals/${approval.id}/execute`, "POST", {});
    expect(f.effects).toEqual([]);
    expect(f.sqlite.prepare("SELECT status FROM workspace_app_approvals WHERE id=?").get(approval.id)).toEqual({ status: "failed" });
  });
  it("rechecks the active installed skill in generic execution and suppresses protected source output after revocation", async () => {
    const f = await founderFixture(), state = await f.prepare();
    await approve(f, state);
    f.sqlite.prepare("UPDATE skills SET status='disabled' WHERE id=?").run(f.input.skillId);
    const approval = state.occurrences[0]!.approval!;
    expect((await workspaceCall(f, `/approvals/${approval.id}/execute`, "POST", {})).status).toBe(409);
    expect(f.effects).toEqual([]);
    const read = await f.call();
    expect(read.body).toMatchObject({ plan: null, occurrences: [], stalePlan: { id: state.plan!.id, canRevoke: true } });
    expect(JSON.stringify(read.body)).not.toContain(f.input.arguments.title);
  });
  it("does not retry an unknown action outcome or mint another occurrence on its account", async () => {
    const f = await founderFixture(), state = await f.prepare();
    await approve(f, state); f.unknownAction();
    const occurrence = state.occurrences[0]!, approval = occurrence.approval!;
    const input = { ...f.occurrencePointer(state), approvalId: approval.id, inputHash: approval.inputHash };
    const result = await f.call(`/occurrences/${encodeURIComponent(occurrence.id)}/execute`, "POST", input);
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.occurrences[0]).toMatchObject({ status: "unknown", canExecute: false });
    expect(f.effects).toHaveLength(1);
    await f.call(`/occurrences/${encodeURIComponent(occurrence.id)}/execute`, "POST", input);
    expect(f.effects).toHaveLength(1);
    const before = f.transport.mock.calls.length;
    expect(await tickFounderConnectorJobs(f.env)).toEqual({ created: 0, blocked: 1 });
    expect(await tickFounderConnectorJobs(f.env)).toEqual({ created: 0, blocked: 0 });
    expect(f.transport.mock.calls.length).toBe(before);
    expect((await f.call(`/occurrences/${encodeURIComponent(occurrence.id)}/prepare`, "POST", f.occurrencePointer(state))).response.status).toBe(409);
    expect(f.effects).toHaveLength(1);
  });
  it("retains an active execution and its private completion receipt when cron overlaps the vendor response", async () => {
    const f = await founderFixture(), state = await f.prepare();
    await approve(f, state);
    const arrived = f.holdAction(), occurrence = state.occurrences[0]!, approval = occurrence.approval!;
    const execution = f.call(`/occurrences/${encodeURIComponent(occurrence.id)}/execute`, "POST", { ...f.occurrencePointer(state), approvalId: approval.id, inputHash: approval.inputHash });
    await arrived;
    const before = f.transport.mock.calls.length;
    expect(await tickFounderConnectorJobs(f.env)).toEqual({ created: 0, blocked: 0 });
    expect(f.transport.mock.calls.length).toBe(before);
    expect(f.sqlite.prepare("SELECT state,version FROM founder_connector_jobs").get()).toEqual({ state: "enabled", version: state.plan!.version });
    f.releaseAction();
    const result = await execution;
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.occurrences[0]).toMatchObject({ status: "completed", approval: { result: { id: "held-result" } } });
    expect(f.effects).toHaveLength(1);
  });
  it.each(["expired", "cancelled"] as const)("withholds cached approval content when its occurrence becomes %s during the final read", async (nextState) => {
    const f = await founderFixture(), state = await f.prepare();
    await approve(f, state);
    const occurrence = state.occurrences[0]!, approval = occurrence.approval!;
    const completed = await f.call(`/occurrences/${encodeURIComponent(occurrence.id)}/execute`, "POST", { ...f.occurrencePointer(state), approvalId: approval.id, inputHash: approval.inputHash });
    expect(completed.body.occurrences[0]!.approval!.result).toMatchObject({ id: "shared-result" });
    if (nextState === "expired") vi.setSystemTime(occurrence.expiresAt - 1);
    const original = f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);
    let changed = false;
    f.env.AGENT_AUDIT.prepare = (sql) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({ ...statement,
        bind: (...values: unknown[]) => wrap(statement.bind(...values)),
        all: async <T>() => {
          const result = await statement.all<T>();
          if (!changed && /SELECT \* FROM founder_connector_occurrences WHERE plan_id=\? AND plan_version=\?/.test(sql)) {
            changed = true;
            if (nextState === "expired") vi.setSystemTime(occurrence.expiresAt + 1);
            f.sqlite.prepare("UPDATE founder_connector_occurrences SET state=? WHERE id=?").run(nextState, occurrence.id);
          }
          return result;
        },
      } as D1PreparedStatement);
      return wrap(original(sql));
    };
    const read = await f.call();
    expect(changed).toBe(true);
    expect(read.response.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.occurrences[0]).toMatchObject({ approval: null, canPrepare: false, canDecide: false, canExecute: false });
    expect(read.body.plan!.contract.arguments).toEqual(f.input.arguments);
    expect(f.effects).toHaveLength(1);
  });
  it("rechecks an unprepared occurrence before returning its prepare capability", async () => {
    const f = await founderFixture(), state = await f.due(), occurrence = state.occurrences[0]!;
    const original = f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);
    f.env.AGENT_AUDIT.prepare = (sql) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({ ...statement,
        bind: (...values: unknown[]) => wrap(statement.bind(...values)),
        all: async <T>() => {
          const result = await statement.all<T>();
          if (/SELECT \* FROM founder_connector_occurrences WHERE plan_id=\? AND plan_version=\?/.test(sql)) f.sqlite.prepare("UPDATE founder_connector_occurrences SET state='cancelled' WHERE id=?").run(occurrence.id);
          return result;
        },
      } as D1PreparedStatement);
      return wrap(original(sql));
    };
    expect((await f.call()).body.occurrences[0]).toMatchObject({ approval: null, canPrepare: false, canDecide: false, canExecute: false });
    expect(f.effects).toEqual([]);
  });
  it("recovers an orphaned approval handoff by exact local receipt without renewing its original expiry", async () => {
    const f = await founderFixture(), state = await f.due();
    const original = f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);
    f.env.AGENT_AUDIT.prepare = (sql) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({ ...statement,
        bind: (...values: unknown[]) => wrap(statement.bind(...values)),
        run: async (...args: Parameters<D1PreparedStatement["run"]>) => {
          if (/UPDATE founder_connector_occurrences SET approval_id=\?/.test(sql)) throw new Error("Fixture acknowledgement lost");
          return statement.run(...args);
        },
      } as D1PreparedStatement);
      return wrap(original(sql));
    };
    const pointer = f.occurrencePointer(state), id = state.occurrences[0]!.id;
    expect((await f.call(`/occurrences/${encodeURIComponent(id)}/prepare`, "POST", pointer)).response.status).toBe(503);
    f.env.AGENT_AUDIT.prepare = original;
    const expiry = f.sqlite.prepare("SELECT expires_at FROM workspace_app_approvals").get();
    const recovered = await f.call();
    expect(recovered.body.occurrences[0]).toMatchObject({ id, status: "awaiting-approval", canPrepare: false });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect((await f.call(`/occurrences/${encodeURIComponent(id)}/prepare`, "POST", pointer)).response.status).toBe(200);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_app_approvals").get()).toEqual({ n: 1 });
    expect(f.sqlite.prepare("SELECT expires_at FROM workspace_app_approvals").get()).toEqual(expiry);
    expect(f.effects).toEqual([]);
  });
  it("never adopts a generic action that collides with an occurrence request ID", async () => {
    const f = await founderFixture(), state = await f.due(), occurrence = state.occurrences[0]!;
    const generic = await workspaceCall(f, `/connections/${f.connection.id}/actions/request`, "POST", { employeeId: f.employee.id, employeeVersion: f.employee.version,
      actionId: f.input.actionId, arguments: { title: "Different generic action" }, requestId: occurrence.requestId });
    expect(generic.status, await generic.clone().text()).toBe(202);
    const stateAfter = await f.call();
    expect(stateAfter.body.occurrences[0]).toMatchObject({ status: "unknown", approval: null, canPrepare: false, canExecute: false });
    expect((await f.call(`/occurrences/${encodeURIComponent(occurrence.id)}/prepare`, "POST", f.occurrencePointer(state))).response.status).toBe(409);
    expect(f.effects).toEqual([]);
  });
  it("retains fixed occurrence and approval deadlines rather than refreshing expired human consent", async () => {
    const f = await founderFixture(), state = await f.prepare(), occurrence = state.occurrences[0]!, approval = occurrence.approval!;
    expect(approval.expiresAt).toBeLessThanOrEqual(occurrence.expiresAt);
    vi.setSystemTime(approval.expiresAt + 1);
    const decision = await workspaceCall(f, `/approvals/${approval.id}/decision`, "POST", { approved: true });
    expect(decision.status).toBe(409);
    expect((await f.call()).body.occurrences[0]).toMatchObject({ status: "expired", canPrepare: false, canExecute: false });
    expect(f.effects).toEqual([]);
  });
  it("rejects automatic execution flags, secret-bearing arguments and a different native creator", async () => {
    const f = await founderFixture();
    expect((await f.call("", "POST", { ...f.input, autoExecute: true })).response.status).toBe(400);
    expect((await f.call("", "POST", { ...f.input, arguments: { access_token: "do-not-persist" } })).response.status).toBe(400);
    const state = await f.configure();
    actor.email = ADMIN;
    expect((await f.call()).body).toMatchObject({ plan: null, occurrences: [] });
    expect((await f.call("/enable", "POST", f.pointer(state))).response.status).toBe(409);
    actor.email = MEMBER;
    expect((await f.call()).response.status).toBe(403);
    expect(f.effects).toEqual([]);
  });
});
