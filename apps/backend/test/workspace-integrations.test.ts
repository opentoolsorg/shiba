import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Env } from "../src/env.js";
import { handleWorkspaceIntegrations } from "../src/workspace-integrations-routes.js";
import { createTeamWorkspace, createTeamWorkspaceInvitation, acceptTeamWorkspaceInvitation, getTeamWorkspaceMembership } from "../src/team-workspaces-store.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { openConnectorConnectionName, openConnectorWorkspaceConnectionName } from "../src/integrations/openconnector-provider.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { CREDENTIAL_INPUT_UNAVAILABLE } from "../src/integrations/action-input-policy.js";

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
async function fixture(service = "github", inputSchema: Record<string, unknown> = { type: "object", properties: { title: { type: "string" } } }) {
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
    if (url.pathname === `/v1/providers/${service}/setup`) return Response.json({ success: true, data: { service, oauthClient: { configured: true, missingFields: [] } } });
    if (url.pathname === "/api/providers") return Response.json([{ service, displayName: "Fixture app", authTypes: ["oauth2"] }]);
    if (url.pathname === "/api/oauth/authorizations") {
      const body = JSON.parse(String(init?.body)) as { service: string; connectionName: string };
      pending = { ...body, state: crypto.randomUUID() };
      expect(body.connectionName.startsWith("w_")).toBe(true);
      return Response.json({ state: pending.state, authorizationUrl: `https://oauth.vendor.example/authorize?state=${pending.state}` });
    }
    if (url.pathname === `/api/connections/${service}` && init?.method === "DELETE") {
      const body = JSON.parse(String(init.body)) as { connectionName: string };
      for (let index = accounts.length - 1; index >= 0; index -= 1) if (accounts[index]?.connectionName === body.connectionName) accounts.splice(index, 1);
      return Response.json({ ok: true });
    }
    const action = { id: `${service}.create_issue`, service, name: "Create issue", description: "Fixture write", inputSchema };
    if (url.pathname === "/v1/actions/search") return Response.json({ success: true, data: [action] });
    if (url.pathname === `/v1/actions/${action.id}`) {
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
    const created = await call("/connect", "POST", { providerKey: service, audienceConsent: "workspace-members" });
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
    const member = await getTeamWorkspaceMembership(env, workspace.workspaceId, MEMBER);
    const result = await call(`/connections/${connection.id}/grants`, "PUT", { employeeId: employee.id, employeeVersion: employee.version, actorId: MEMBER,
      actorMembershipVersion: member!.version, expectedConnectionVersion: connection.version, expectedGrantVersion: null, permissions: ["discover", "execute"] });
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
  };
  const actionRequest = async (connection: { id: string }, args: Record<string, unknown> = { title: "Exact human approved title" }) => {
    actor.email = MEMBER;
    return call(`/connections/${connection.id}/actions/request`, "POST", { employeeId: employee.id, employeeVersion: employee.version,
      actionId: `${service}.create_issue`, arguments: args, requestId: crypto.randomUUID() });
  };
  return { ...db, env, workspace, other, employee, request, call, connect, grant, actionRequest, effects, transport, accounts,
    afterAccountRead(fn: () => void) { afterAccountRead = fn; }, unknownAction() { rejectAction = true; },
    holdAction() { pendingAction = new Promise<Response>((resolve) => { holdAction = resolve; }); return new Promise<void>((resolve) => { actionArrived = resolve; }); },
    releaseAction() { holdAction!(Response.json({ success: true, data: { id: "held-result" } })); } };
}
describe("workspace-shared connections with real route/SQLite and fixture sibling HTTP", { timeout: 20_000 }, () => {
  it.each(["required credential", "supplied credential", "safe schema"])("blocks Google Ads credential inputs before shared approval storage: %s", async (scenario) => {
    const f = await fixture("googleads", scenario === "required credential" ? { type: "object", properties: { developerToken: { type: "string" } }, required: ["developerToken"] } : { type: "object", properties: { customerId: { type: "string" } } });
    const { connection } = await f.connect(); await f.grant(connection);
    const requested = await f.actionRequest(connection, scenario === "supplied credential" ? { developerToken: "fixture-do-not-persist" } : { customerId: "fixture" });
    expect(requested.response.status).toBe(scenario === "safe schema" ? 202 : 409);
    if (scenario !== "safe schema") expect(requested.body).toEqual({ error: CREDENTIAL_INPUT_UNAVAILABLE });
    const approvals = f.sqlite.prepare("SELECT arguments_json FROM workspace_app_approvals").all();
    expect(approvals).toHaveLength(scenario === "safe schema" ? 1 : 0);
    expect(JSON.stringify([requested.body, approvals])).not.toContain("fixture-do-not-persist");
    expect(f.effects).toHaveLength(0);
    actor.email = MEMBER;
    const discovered = await f.call(`/connections/${connection.id}/actions?employeeId=${f.employee.id}&employeeVersion=${f.employee.version}`);
    expect(discovered.response.status).toBe(200);
    expect(JSON.stringify(discovered.body)).not.toContain("developerToken");
    expect(discovered.body.actions).toHaveLength(scenario === "required credential" ? 0 : 1);
  });
  it("keeps the append-only migration compatible and requires fresh consent and grants after disconnect", async () => {
    const f = await fixture();
    f.sqlite.exec(readFileSync(new URL("../migrations/0010_workspace_integrations.sql", import.meta.url), "utf8"));
    const first = await f.connect(); await f.grant(first.connection); actor.email = OWNER;
    const disconnected = await f.call(`/connections/${first.connection.id}/disconnect`, "POST", { expectedVersion: first.connection.version });
    expect(disconnected.response.status).toBe(200);
    expect(disconnected.body.connection).toMatchObject({ state: "revoked", upstreamReady: false });
    expect((await f.call(`/connections/${first.connection.id}/reconcile`, "POST", first.input)).response.status).toBe(409);
    const second = await f.connect();
    expect(second.connection.id).not.toBe(first.connection.id);
    actor.email = MEMBER;
    expect((await f.call("/connections")).body.connections).toEqual([]);
    expect((await f.actionRequest(second.connection)).response.status).toBe(403);
    expect(f.effects).toHaveLength(0);
    expect(f.accounts.some((account) => account.id === "private-owned-row")).toBe(true);
  });
  it("rejects bearer scope selection, cross-origin consent and body workspace overrides before provider calls", async () => {
    const f = await fixture();
    const original = f.request("/connect", "POST", { providerKey: "github", audienceConsent: "workspace-members" });
    const originalBody = await original.text();
    for (const [key, value, status] of [["authorization", "Bearer fixture-not-a-native-session", 401], ["Origin", "https://untrusted.test", 403]] as const) {
      const headers = new Headers(original.headers); headers.set(key, value);
      const response = await handleWorkspaceIntegrations(new Request(original.url, { method: original.method, headers, body: originalBody }), f.env);
      expect(response!.status).toBe(status);
    }
    expect((await f.call("/connect", "POST", { providerKey: "github", audienceConsent: "workspace-members", workspaceId: f.other.workspaceId })).response.status).toBe(400);
    expect((await f.call(`/connections?workspaceId=${f.other.workspaceId}`)).response.status).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("uses a disjoint workspace alias and never discovers personal accounts", async () => {
    const f = await fixture();
    expect(await openConnectorWorkspaceConnectionName(f.workspace.workspaceId)).not.toBe(await openConnectorConnectionName(OWNER));
    const list = await f.call("/connections");
    expect(list.body.connections).toEqual([]);
    expect(JSON.stringify(list.body)).not.toContain("Private account");
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("completes explicit consent once, grants selected member access and requires separate human approval before one-shot execution", async () => {
    const f = await fixture(), linked = await f.connect();
    const repeat = await f.call(`/connections/${linked.connection.id}/reconcile`, "POST", linked.input);
    expect(repeat.response.status).toBe(200);
    expect(f.transport.mock.calls.filter(([url]) => String(url).endsWith("/api/oauth/authorizations"))).toHaveLength(1);
    actor.email = MEMBER;
    expect((await f.call("/connections")).body.connections).toEqual([]);
    await f.grant(linked.connection);
    actor.email = MEMBER;
    expect(((await f.call("/connections")).body.connections as unknown[])).toHaveLength(1);
    const requested = await f.actionRequest(linked.connection);
    expect(requested.response.status, JSON.stringify(requested.body)).toBe(202);
    const approvalId = String(requested.body.approvalId);
    expect((await f.call(`/approvals/${approvalId}/execute`, "POST", {})).response.status).toBe(403);
    expect(f.effects).toHaveLength(0);
    expect((await f.call(`/approvals/${approvalId}/decision`, "POST", { approved: true })).response.status).toBe(403);
    actor.email = OWNER;
    expect((await f.call(`/approvals/${approvalId}/decision`, "POST", { approved: true })).response.status).toBe(200);
    expect((await f.call(`/approvals/${approvalId}/decision`, "POST", { approved: false })).response.status).toBe(409);
    actor.email = MEMBER;
    expect((await f.call(`/approvals/${approvalId}/execute`, "POST", {})).response.status).toBe(200);
    expect((await f.call(`/approvals/${approvalId}/execute`, "POST", {})).response.status).toBe(200);
    expect(f.effects).toEqual([{ input: { title: "Exact human approved title" } }]);
  });
  it("rejects cross-workspace and third-user account/grant discovery", async () => {
    const f = await fixture(), { connection } = await f.connect();
    actor.email = "other-owner@example.test";
    expect((await f.call(`/connections/${connection.id}/grants`, "GET", undefined, f.other.workspaceId)).response.status).toBe(404);
    actor.email = "outsider@example.test";
    expect((await f.call("/connections")).response.status).toBe(404);
    actor.email = MEMBER;
    expect((await f.call("/connect", "POST", { providerKey: "github", audienceConsent: "workspace-members" })).response.status).toBe(403);
    expect(f.effects).toHaveLength(0);
  });
  it("rejects stale issuer consent and wrong callback fingerprints without activating", async () => {
    const f = await fixture();
    const created = await f.call("/connect", "POST", { providerKey: "github", audienceConsent: "workspace-members" });
    const connection = created.body.connection as { id: string; version: number };
    expect((await f.call(`/connections/${connection.id}/reconcile`, "POST", { expectedVersion: connection.version, pendingId: created.body.pendingId, authorizationFingerprint: "a".repeat(64) })).response.status).toBe(403);
    f.sqlite.prepare("UPDATE team_workspace_memberships SET version=version+1 WHERE workspace_id=? AND user_id=?").run(f.workspace.workspaceId, OWNER);
    expect((await f.call(`/connections/${connection.id}/reconcile`, "POST", { expectedVersion: connection.version, pendingId: created.body.pendingId, authorizationFingerprint: created.body.authorizationFingerprint })).response.status).toBe(403);
    expect(f.effects).toHaveLength(0);
  });
  it("does not inherit original consent when a native account UUID is replaced under the same verified email", async () => {
    const f = await fixture(), { connection } = await f.connect();
    await f.grant(connection);
    const original = actor.accounts[OWNER]!, replacement = crypto.randomUUID();
    f.sqlite.prepare('DELETE FROM "user" WHERE id=?').run(original);
    f.sqlite.prepare('INSERT INTO "user"(id,email,emailVerified) VALUES(?,?,1)').run(replacement, OWNER);
    f.sqlite.prepare("INSERT INTO shiba_auth_account_policy(account_id,email) VALUES(?,?)").run(replacement, OWNER);
    actor.accounts[OWNER] = replacement;
    actor.email = MEMBER;
    expect((await f.call("/connections")).body.connections).toEqual([]);
    const requested = await f.actionRequest(connection);
    expect(requested.response.status).toBe(403);
    expect(f.effects).toHaveLength(0);
    actor.email = OWNER;
    const listed = (await f.call("/connections")).body.connections as Array<{ state: string; upstreamReady: boolean; identityLabel: string | null }>;
    expect(listed[0]).toMatchObject({ state: "error", upstreamReady: false, identityLabel: null });
  });
  it("keeps Access-only identities unavailable instead of inventing native account proof", async () => {
    const f = await fixture(); actor.native = false;
    const result = await f.call("/connections");
    expect(result.response.status).toBe(403);
    expect(result.body.error).toBe("workspace_native_session_required");
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each([MEMBER, ADMIN])("invalidates grants after native account replacement for %s", async (replaced) => {
    const f = await fixture(), { connection } = await f.connect();
    await f.grant(connection, ADMIN);
    const requested = await f.actionRequest(connection), approvalId = String(requested.body.approvalId);
    actor.email = OWNER;
    expect((await f.call(`/approvals/${approvalId}/decision`, "POST", { approved: true })).response.status).toBe(200);
    const original = actor.accounts[replaced]!, replacement = crypto.randomUUID();
    f.sqlite.prepare('DELETE FROM "user" WHERE id=?').run(original);
    f.sqlite.prepare('INSERT INTO "user"(id,email,emailVerified) VALUES(?,?,1)').run(replacement, replaced);
    f.sqlite.prepare("INSERT INTO shiba_auth_account_policy(account_id,email) VALUES(?,?)").run(replacement, replaced);
    actor.accounts[replaced] = replacement; actor.email = MEMBER;
    expect((await f.call("/connections")).body.connections).toEqual([]);
    expect((await f.call(`/approvals/${approvalId}/execute`, "POST", {})).response.status).toBe(403);
    expect(f.effects).toHaveLength(0);
  });
  it("deduplicates concurrent request IDs and rejects changed frozen arguments", async () => {
    const f = await fixture(), { connection } = await f.connect(); await f.grant(connection); actor.email = MEMBER;
    const input = { employeeId: f.employee.id, employeeVersion: f.employee.version, actionId: "github.create_issue", arguments: { title: "Frozen" }, requestId: crypto.randomUUID() };
    const results = await Promise.all([f.call(`/connections/${connection.id}/actions/request`, "POST", input), f.call(`/connections/${connection.id}/actions/request`, "POST", input)]);
    expect(results.map((result) => result.response.status)).toEqual([202, 202]);
    expect(results[0]!.body.approvalId).toBe(results[1]!.body.approvalId);
    expect((await f.call(`/connections/${connection.id}/actions/request`, "POST", { ...input, arguments: { title: "Changed" } })).response.status).toBe(409);
    expect(f.effects).toHaveLength(0);
  });
  it("claims concurrent execution once and blocks new account actions while a result is unknown", async () => {
    const f = await fixture(), { connection } = await f.connect(); await f.grant(connection);
    const requested = await f.actionRequest(connection), approvalId = String(requested.body.approvalId);
    actor.email = OWNER; await f.call(`/approvals/${approvalId}/decision`, "POST", { approved: true }); actor.email = MEMBER;
    const arrived = f.holdAction();
    const running = f.call(`/approvals/${approvalId}/execute`, "POST", {});
    await arrived;
    try {
      expect((await f.call(`/approvals/${approvalId}/execute`, "POST", {})).response.status).toBe(200);
      expect((await f.actionRequest(connection)).response.status).toBe(409);
    } finally { f.releaseAction(); }
    await running;
    expect(f.effects).toHaveLength(1);
  });
  it("retains uncertain POST outcomes without replay and blocks the whole account", async () => {
    const f = await fixture(), { connection } = await f.connect(); await f.grant(connection);
    const requested = await f.actionRequest(connection), approvalId = String(requested.body.approvalId);
    actor.email = OWNER; await f.call(`/approvals/${approvalId}/decision`, "POST", { approved: true }); actor.email = MEMBER;
    f.unknownAction();
    const result = await f.call(`/approvals/${approvalId}/execute`, "POST", {});
    expect((result.body.approvals as Array<{ status: string }>)[0]?.status).toBe("unknown");
    await f.call(`/approvals/${approvalId}/execute`, "POST", {});
    expect(f.effects).toHaveLength(1);
    expect((await f.actionRequest(connection)).response.status).toBe(409);
    expect(((await f.call("/connections")).body.connections as Array<{ upstreamReady: boolean; health: string }>)[0]).toMatchObject({ upstreamReady: false, health: "error" });
  });
  it.each(["cancelled", "expired"])("sends zero action POST when %s during an awaited account read", async (reason) => {
    const f = await fixture(), { connection } = await f.connect(); await f.grant(connection);
    const requested = await f.actionRequest(connection), approvalId = String(requested.body.approvalId);
    actor.email = OWNER; await f.call(`/approvals/${approvalId}/decision`, "POST", { approved: true }); actor.email = MEMBER;
    const saved = f.sqlite.prepare("SELECT expires_at FROM workspace_app_approvals WHERE id=?").get(approvalId)!;
    const deadline = Number(saved.expires_at), controller = new AbortController();
    if (reason === "expired") vi.spyOn(Date, "now").mockReturnValue(deadline - 1);
    f.afterAccountRead(() => { if (reason === "cancelled") controller.abort(); else vi.mocked(Date.now).mockReturnValue(deadline + 1); });
    const request = new Request(f.request(`/approvals/${approvalId}/execute`, "POST", {}), { signal: controller.signal });
    await handleWorkspaceIntegrations(request, f.env);
    expect(f.effects).toHaveLength(0);
  });
  it("does not return cached arguments/results when a grant is revoked after its initial source check", async () => {
    const f = await fixture(), { connection } = await f.connect(); await f.grant(connection);
    const requested = await f.actionRequest(connection), approvalId = String(requested.body.approvalId);
    actor.email = OWNER; await f.call(`/approvals/${approvalId}/decision`, "POST", { approved: true }); actor.email = MEMBER;
    await f.call(`/approvals/${approvalId}/execute`, "POST", {});
    const prepare = f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);
    let revoked = false;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (key === "first") return async (...args: unknown[]) => {
          const value = await Reflect.apply(target.first, target, args);
          if (!revoked && sql.includes("connection_id=? AND id<>?")) {
            revoked = true;
            f.sqlite.prepare("UPDATE workspace_app_grants SET state='revoked',version=version+1 WHERE connection_id=?").run(connection.id);
          }
          return value;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    vi.spyOn(f.env.AGENT_AUDIT, "prepare").mockImplementation((sql) => wrap(prepare(sql), sql));
    const history = await f.call("/approvals");
    expect(revoked).toBe(true);
    expect(JSON.stringify(history.body)).not.toContain("Exact human approved title");
    expect(JSON.stringify(history.body)).not.toContain("Created with exact consent");
  });
  it("withholds discovered action metadata when consent is revoked during final session reauthentication", async () => {
    const f = await fixture(), { connection } = await f.connect(); await f.grant(connection); actor.email = MEMBER;
    actor.nativeReads = 0;
    actor.afterNativeRead = () => {
      if (actor.nativeReads === 2) f.sqlite.prepare("UPDATE workspace_app_connections SET state='revoked',version=version+1 WHERE id=?").run(connection.id);
    };
    const discovered = await f.call(`/connections/${connection.id}/actions?employeeId=${f.employee.id}&employeeVersion=${f.employee.version}`);
    expect(actor.nativeReads).toBe(2);
    expect(discovered.response.status).toBe(403);
    expect(JSON.stringify(discovered.body)).not.toContain("github.create_issue");
    expect(f.effects).toHaveLength(0);
  });
  it.each(["grant", "issuer"])("withholds account labels when %s is revoked after DTO source checks", async (source) => {
    const f = await fixture(), { connection } = await f.connect(); await f.grant(connection); actor.email = MEMBER;
    const prepare = f.env.AGENT_AUDIT.prepare.bind(f.env.AGENT_AUDIT);
    let revoked = false;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (key === "first") return async (...args: unknown[]) => {
          const value = await Reflect.apply(target.first, target, args);
          if (!revoked && sql.includes("connection_id=? AND status IN ('executing','unknown')")) {
            revoked = true;
            if (source === "grant") f.sqlite.prepare("UPDATE workspace_app_grants SET state='revoked',version=version+1 WHERE connection_id=?").run(connection.id);
            else f.sqlite.prepare("UPDATE team_workspace_memberships SET version=version+1,status='removed' WHERE workspace_id=? AND user_id=?").run(f.workspace.workspaceId, OWNER);
          }
          return value;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    vi.spyOn(f.env.AGENT_AUDIT, "prepare").mockImplementation((sql) => wrap(prepare(sql), sql));
    const listed = await f.call("/connections");
    expect(revoked).toBe(true);
    expect(listed.response.status).toBe(200);
    expect(listed.body.connections).toEqual([]);
    expect(JSON.stringify(listed.body)).not.toContain("Explicit workspace-shared account");
  });
  it.each(["grant", "actor", "issuer"])("blocks %s revocation during the provider preflight and removes cached results from the actor", async (revoked) => {
    const f = await fixture(), { connection } = await f.connect();
    await f.grant(connection);
    const requested = await f.actionRequest(connection), approvalId = String(requested.body.approvalId);
    actor.email = OWNER;
    expect((await f.call(`/approvals/${approvalId}/decision`, "POST", { approved: true })).response.status).toBe(200);
    actor.email = MEMBER;
    f.afterAccountRead(() => {
      if (revoked === "grant") f.sqlite.prepare("UPDATE workspace_app_grants SET state='revoked',version=version+1 WHERE connection_id=?").run(connection.id);
      else f.sqlite.prepare("UPDATE team_workspace_memberships SET status='removed',version=version+1 WHERE workspace_id=? AND user_id=?").run(f.workspace.workspaceId, revoked === "actor" ? MEMBER : OWNER);
    });
    await f.call(`/approvals/${approvalId}/execute`, "POST", {});
    expect(f.effects).toHaveLength(0);
    const history = await f.call("/approvals");
    expect(JSON.stringify(history.body)).not.toContain("Exact human approved title");
  });
});
