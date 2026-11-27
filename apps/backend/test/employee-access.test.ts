import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { governanceD1Fixture } from "./fixtures/governance-d1.js";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import { addWorkspaceGroupMember, createWorkspaceGroup, removeWorkspaceGroupMember } from "../src/governance/governance-store.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { employeeAccessDenial, filterEmployeesByAccess, listEmployeeAccess, resolveEmployeeAccess, setEmployeeAccess, visibleEmployees } from "../src/governance/employee-access.js";
import { enforceEmployeeRouteAccess } from "../src/governance/employee-route-auth.js";
import { handleEmployeeAccess } from "../src/governance/employee-access-routes.js";
import { resolveOrgForApiRequest } from "../src/org-request-auth.js";
import { resolveUserId } from "../src/request-auth.js";
import { verifyToken } from "../src/agent-tokens.js";
import { addCollaborationMember, COLLAB_TENANT_ID, createCollaborationRoom, ensureCollaborationSchema, listCollaborationMemberships } from "../src/collaboration-store.js";
import { coordinateHumanMessage, setWorkspacePrimaryBot } from "../src/collaboration-router.js";
import { ackListenAllAgents, ackThreadOwner } from "../src/collaboration-reply-claims.js";
import { loadRankedBots, primaryActorId } from "../src/collaboration-router-rank.js";
import { listPaletteBots, searchPaletteBots } from "../src/palette-store.js";
import { handleCustomAgents } from "../src/custom-agents-routes.js";
import { handleWebSessions } from "../src/sessions-routes.js";
import { getAgentByName } from "agents/routing";

vi.mock("../src/org-request-auth.js", () => ({ resolveOrgForApiRequest: vi.fn() }));
vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(), isAuthorizedRequest: vi.fn(async () => true), resolveUserId: vi.fn() }));
vi.mock("../src/agent-tokens.js", async (original) => ({ ...await original<typeof import("../src/agent-tokens.js")>(), verifyToken: vi.fn(async () => null) }));
vi.mock("agents/routing", () => ({ getAgentByName: vi.fn() }));
const owner = "alice@example.test", member = "bob@example.test";
async function fixture() {
  const { env, sqlite } = await governanceD1Fixture();
  sqlite.exec(readFileSync(new URL("../migrations/0069_employee_access.sql", import.meta.url), "utf8"));
  const workspace = await createTeamWorkspace(env, owner, { name: "Team" });
  const invitation = await createTeamWorkspaceInvitation(env, workspace.workspaceId, owner, { email: member, role: "member" });
  const joined = await acceptTeamWorkspaceInvitation(env, member, invitation.token);
  const employee = await createCustomAgent({ AGENT_AUDIT: env.AGENT_AUDIT! }, `team:${workspace.workspaceId}`, "finance", { name: "Finance", instructions: "Finance tasks", harness: "opencode" });
  const set = (principalKind: string, principalId: string, level: string) => setEmployeeAccess(env, workspace.workspaceId, employee.id, owner, { principalKind, principalId, level });
  const resolve = (actor = member) => resolveEmployeeAccess(env, workspace.workspaceId, employee.id, actor);
  const auth = (actor = member) => {
    vi.mocked(resolveUserId).mockResolvedValue(actor);
    vi.mocked(resolveOrgForApiRequest).mockResolvedValue({ orgId: employee.orgId, principal: null, workspace: actor === member ? joined.membership : workspace.membership });
  };
  return { env, sqlite, workspaceId: workspace.workspaceId, employee, set, resolve, auth };
}

describe("employee access", () => {
  it("removes user and group overrides to inheritance with named before-to-null audit entries", async () => {
    const { env, sqlite, workspaceId, set, resolve } = await fixture();
    const group = await createWorkspaceGroup(env, workspaceId, owner, { name: "Finance team" });
    await addWorkspaceGroupMember(env, workspaceId, owner, group.groupId, member);
    await set("everyone", "*", "view");
    await set("group", group.groupId, "chat");
    await set("user", member, "none");
    await set("user", member, "inherit");
    expect(await resolve()).toBe("chat");
    await set("group", group.groupId, "inherit");
    expect(await resolve()).toBe("view");
    const removals = sqlite.prepare("SELECT detail FROM audit_log WHERE json_extract(detail,'$.after') IS NULL").all() as { detail: string }[];
    expect(removals.map((row) => JSON.parse(row.detail))).toEqual(expect.arrayContaining([
      expect.objectContaining({ principalName: member, before: "none", after: null }),
      expect.objectContaining({ principalName: "Finance team", before: "chat", after: null }),
    ]));
    await set("user", member, "inherit");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toMatchObject({ n: 5 });
    await expect(set("everyone", "*", "inherit")).rejects.toThrow("Everyone requires an explicit level");
  });
  it("requires manage authority for employee runtime recovery", async () => {
    const { env, employee, workspaceId, set, auth } = await fixture(); auth();
    const request = () => new Request(`https://app.test/api/custom-agents/${employee.id}/runtime/recover`, { method: "POST", headers: { "X-Shiba-Workspace": workspaceId }, body: "{}" });
    const v1Request = () => new Request(`https://app.test/api/v1/org-agents/${employee.id}/runtime/recover`, { method: "POST", headers: { "X-Shiba-Workspace": workspaceId }, body: "{}" });
    for (const [level, status] of [["none", 404], ["view", 403], ["chat", 403], ["manage", undefined]] as const) {
      await set("everyone", "*", level);
      expect((await enforceEmployeeRouteAccess(request(), env))?.status).toBe(status);
      expect((await enforceEmployeeRouteAccess(v1Request(), env))?.status).toBe(status);
    }
  });

  it("applies runtime memory authority to public v1 org-agent aliases", async () => {
    const { env, employee, workspaceId, set, auth } = await fixture(); auth();
    const request = () => new Request(`https://app.test/api/v1/org-agents/${employee.id}/runtime/memory/update`, { method: "POST", headers: { "X-Shiba-Workspace": workspaceId }, body: "{}" });
    for (const [level, status] of [["none", 404], ["view", 403], ["chat", undefined]] as const) {
      await set("everyone", "*", level);
      expect((await enforceEmployeeRouteAccess(request(), env))?.status).toBe(status);
    }
  });

  it("leaves empty or unparseable new session bodies to the session handler", async () => {
    const { env, auth } = await fixture(); auth();
    for (const body of [undefined, "", "{"]) expect(await enforceEmployeeRouteAccess(new Request("https://app.test/api/sessions", { method: "POST", body }), env)).toBeNull();
    expect((await enforceEmployeeRouteAccess(new Request("https://app.test/api/runs", { method: "POST", body: "{" }), env))?.status).toBe(400);
  });
  it("supports workspace query selectors for artifact downloads without overriding conflicting selectors", async () => {
    const { env, sqlite, workspaceId, employee, set, auth } = await fixture(); auth();
    await ensureCollaborationSchema(env);
    const scope = { tenantId: COLLAB_TENANT_ID, workspaceId, userId: owner };
    await createCollaborationRoom(env, scope, { roomId: "room", title: "Artifacts", visibility: "private", createdAt: 1 });
    await addCollaborationMember(env, scope, "room", { userId: owner, displayName: "Finance", actorId: `agent:${employee.id}`, kind: "agent", profileVersion: 1, createdAt: 2 });
    sqlite.prepare(`INSERT INTO collaboration_handoffs (tenant_id,workspace_id,handoff_id,recipient_actor_id,room_id,task_id,sender_user_id,sender_actor_id,recipient_user_id,root_handoff_id,depth,ancestor_handoff_ids_json,remaining_budget,granted_capabilities_json,status,created_at)
      VALUES (?,?,'handoff',?,'room','task',?,?,?,'handoff',0,'[]',4,'[]','active',1)`).run(COLLAB_TENANT_ID, workspaceId, `agent:${employee.id}`, owner, `human:${owner}`, owner);
    const url = `https://app.test/api/collaboration/rooms/room/handoffs/handoff/artifacts/0?workspaceId=${workspaceId}`;
    expect(await enforceEmployeeRouteAccess(new Request(url), env)).toBeNull();
    expect(new Headers(vi.mocked(resolveOrgForApiRequest).mock.lastCall?.[0].headers).get("X-Shiba-Workspace")).toBe(workspaceId);
    await set("everyone", "*", "none");
    expect((await enforceEmployeeRouteAccess(new Request(url), env))?.status).toBe(404);
    expect((await enforceEmployeeRouteAccess(new Request(url, { headers: { "X-Shiba-Workspace": "ws_" + "f".repeat(24) } }), env))?.status).toBe(404);
  });
  it("hides employee sessions and resolves resume authority from stored metadata", async () => {
    const { env, employee, workspaceId, auth, set } = await fixture(); auth();
    const session = { id: "11111111-1111-4111-8111-111111111111", userId: member, name: "Finance", createdAt: 1, updatedAt: 1, metadata: { customAgentId: employee.id, orgId: `team:${workspaceId}`, teamWorkspaceId: workspaceId } };
    const fetch = vi.fn(async (url: string) => Response.json(url.endsWith("/web-sessions") ? { sessions: [session] } : { session }));
    vi.mocked(getAgentByName).mockResolvedValue({ fetch } as never);
    const headers = { "X-Shiba-Workspace": workspaceId };
    const resume = () => new Request(`https://app.test/api/sessions/${session.id}/resume`, { method: "POST", headers });
    await set("everyone", "*", "none");
    expect(await (await handleWebSessions(new Request("https://app.test/api/sessions", { headers }), env))?.json()).toMatchObject({ sessions: [] });
    expect((await enforceEmployeeRouteAccess(resume(), env))?.status).toBe(404);
    await set("everyone", "*", "view");
    expect((await enforceEmployeeRouteAccess(resume(), env))?.status).toBe(403);
    expect(await (await handleWebSessions(new Request("https://app.test/api/sessions", { headers }), env))?.json()).toMatchObject({ sessions: [expect.objectContaining({ id: session.id })] });
    await set("everyone", "*", "chat");
    expect(await enforceEmployeeRouteAccess(resume(), env)).toBeNull();
    fetch.mockResolvedValue(Response.json({ error: "Not found" }, { status: 404 }));
    expect((await enforceEmployeeRouteAccess(resume(), env))?.status).toBe(404);
  });
  it("does not reauthenticate API keys during additional runtime access checks", async () => {
    const { env, employee, workspaceId, set } = await fixture();
    await set("everyone", "*", "chat");
    const record = { principal: member, orgId: `team:${workspaceId}`, kind: "api_key" as const, scopes: ["api:write" as const], created: 1, revoked: false };
    vi.mocked(verifyToken).mockResolvedValue(record);
    vi.mocked(resolveOrgForApiRequest).mockClear();
    const request = new Request(`https://app.test/api/v1/org-agents/${employee.id}/runtime/memory/update`, { method: "POST", headers: { authorization: "Bearer human-key" }, body: "{}" });
    expect(await enforceEmployeeRouteAccess(request, env)).toBeNull();
    expect(resolveOrgForApiRequest).not.toHaveBeenCalled();
    const withWorkspaceSelector = new Request(request.url, { method: "POST", headers: { authorization: "Bearer human-key", "X-Shiba-Workspace": workspaceId }, body: "{}" });
    expect((await enforceEmployeeRouteAccess(withWorkspaceSelector, env))?.status).toBe(403);
  });

  it("does not let human API keys or arbitrary authorization headers bypass access", async () => {
    const { env, employee, workspaceId, set, auth } = await fixture(); auth();
    await set("everyone", "*", "none");
    const record = { principal: member, orgId: `team:${workspaceId}`, kind: "api_key" as const, scopes: ["api:read" as const], created: 1, revoked: false };
    vi.mocked(verifyToken).mockResolvedValue(record);
    vi.mocked(resolveOrgForApiRequest).mockResolvedValue({ orgId: record.orgId, principal: { ...record, scopes: record.scopes } });
    vi.mocked(resolveUserId).mockResolvedValue(null);
    const request = new Request(`https://app.test/api/custom-agents/${employee.id}`, { headers: { authorization: "Bearer human-key" } });
    expect((await enforceEmployeeRouteAccess(request, env))?.status).toBe(404);
    expect(await (await handleCustomAgents(new Request("https://app.test/api/custom-agents", { headers: request.headers }), env))?.json()).toMatchObject({ agents: [] });
    vi.mocked(verifyToken).mockResolvedValue(null);
    auth();
    expect((await enforceEmployeeRouteAccess(request, env))?.status).toBe(404);
    vi.mocked(verifyToken).mockResolvedValue({ ...record, kind: "agent" });
    expect(await enforceEmployeeRouteAccess(request, env)).toBeNull();
    vi.mocked(verifyToken).mockResolvedValue(null);
  });
  it("requires chat for funded turn prepare, approve and execute and direct employee session selection", async () => {
    const { env, sqlite, employee, set, auth, workspaceId } = await fixture(); auth();
    // Fixture applies every migration; swap in a minimal stand-in schema.
    sqlite.exec("DROP TABLE IF EXISTS team_model_turns; DROP TABLE IF EXISTS team_model_funding;");
    sqlite.exec(`CREATE TABLE team_model_funding (id TEXT, workspace_id TEXT, contract_json TEXT, room_id TEXT DEFAULT 'room');
      CREATE TABLE team_model_turns (id TEXT, workspace_id TEXT, grant_id TEXT);`);
    sqlite.prepare("INSERT INTO team_model_funding (id,workspace_id,contract_json) VALUES ('funding', ?, ?)").run(workspaceId, JSON.stringify({ employeeId: employee.id }));
    sqlite.prepare("INSERT INTO team_model_turns VALUES ('turn', ?, 'funding')").run(workspaceId);
    const request = (path: string, body = {}) => new Request(`https://app.test/api/${path}`, { method: "POST", body: JSON.stringify(body) });
    const requests = () => [request("team-model-sessions/turns/prepare", { grantId: "funding", employeeId: "spoofed" }), request("team-model-sessions/turns/turn/approve"), request("team-model-sessions/turns/turn/execute"), request("sessions", { employeeId: "spoofed", metadata: { customAgentId: employee.id } }), request("sessions/existing", { employeeId: "spoofed", metadata: { customAgentId: employee.id } }), request("runs", { employeeId: "spoofed", customAgentId: employee.id }), request("collaboration/rooms/room/handoffs", { employeeId: "spoofed", recipientActorId: `agent:${employee.slug}` })];
    for (const [level, status] of [["none", 404], ["view", 403], ["chat", undefined]] as const) {
      await set("everyone", "*", level);
      expect(await enforceEmployeeRouteAccess(new Request("https://app.test/api/team-model-sessions/state?roomId=room"), env)).toBeNull();
      for (const req of requests()) expect((await enforceEmployeeRouteAccess(req, env))?.status).toBe(status);
    }
    expect((await enforceEmployeeRouteAccess(request("team-model-sessions/turns/prepare", {}), env))?.status).toBe(404);
    expect((await enforceEmployeeRouteAccess(request("team-model-sessions/turns/missing/execute"), env))?.status).toBe(404);
    expect((await enforceEmployeeRouteAccess(new Request("https://app.test/api/team-model-sessions/turns/prepare", { method: "POST", body: "{" }), env))?.status).toBe(400);
    expect(await enforceEmployeeRouteAccess(request("sessions"), env)).toBeNull();
    expect(await enforceEmployeeRouteAccess(new Request("https://app.test/api/team-model-sessions/state?roomId=empty"), env)).toBeNull();
    sqlite.exec("DROP TABLE team_model_funding");
    expect(await enforceEmployeeRouteAccess(new Request("https://app.test/api/team-model-sessions/state?roomId=room"), env)).toBeNull();
  });
  it("filters every coordination selector using the posting member, canonicalizes slugs, and hides discovery", async () => {
    const { env, sqlite, employee, workspaceId, set } = await fixture();
    await ensureCollaborationSchema(env);
    const scope = { tenantId: COLLAB_TENANT_ID, workspaceId, userId: owner };
    const room = await createCollaborationRoom(env, scope, { roomId: "room_access", title: "Team", visibility: "private", createdAt: 1 });
    await addCollaborationMember(env, scope, room.roomId, { userId: member, displayName: member, actorId: `human:${member}`, kind: "human", createdAt: 2 });
    const allowed = await createCustomAgent({ AGENT_AUDIT: env.AGENT_AUDIT! }, `team:${workspaceId}`, "engineer", { name: "Engineer", instructions: "Engineering tasks", harness: "opencode" });
    for (const bot of [employee, allowed]) await addCollaborationMember(env, scope, room.roomId, { userId: owner, displayName: bot.config.name!, actorId: `agent:${bot.slug}`, kind: "agent", profileVersion: 1, createdAt: 2 });
    const posting = { ...scope, userId: member };
    await setWorkspacePrimaryBot(env, scope, `agent:${employee.slug}`, 1);
    await set("everyone", "*", "none");
    const items = [employee.id, `agent:${employee.slug}`, allowed.id];
    expect(await filterEmployeesByAccess(env, posting, items, "chat", (id) => id)).toEqual([allowed.id]);
    expect(await resolveEmployeeAccess(env, workspaceId, employee.slug, member)).toBe("none");
    expect((await loadRankedBots(env, posting, room.roomId, "channel", "Finance tasks")).map((bot) => bot.actorId)).toEqual(["agent:engineer"]);
    expect(await primaryActorId(env, posting)).toBe(`agent:${allowed.id}`);
    const members = await listCollaborationMemberships(env, posting, room.roomId);
    expect(members.filter((row) => row.actorKind === "agent").map((row) => row.actorId)).toEqual(["agent:engineer"]);
    expect((await listPaletteBots(env, workspaceId, `team:${workspaceId}`, member)).map((bot) => bot.agentId)).toEqual([allowed.id]);
    expect(await searchPaletteBots(env, workspaceId, `team:${workspaceId}`, member, "Finance", 10)).toEqual([]);
    const mentions = await coordinateHumanMessage(env, posting, { roomId: room.roomId, messageId: "blocked-mention", body: "@agent:finance", now: 10 });
    expect(mentions.handoffs).toEqual([]);
    sqlite.prepare(`INSERT INTO collaboration_task_threads (tenant_id,workspace_id,room_id,root_message_id,owner_actor_id,task_id,title,owner_user_id,status,created_at,updated_at) VALUES (?,?,?,?,?,'task','Finance','${owner}','open',1,1)`)
      .run(scope.tenantId, workspaceId, room.roomId, "root", "agent:finance");
    expect(await ackThreadOwner(env, posting, { roomId: room.roomId, triggerMessageId: "owner-blocked", threadRootId: "root", now: 11 })).toBe(false);
    for (const bot of [employee, allowed]) sqlite.prepare("INSERT INTO collaboration_agent_listen_mode VALUES (?,?,?,?, 'all', 1)").run(scope.tenantId, workspaceId, room.roomId, `agent:${bot.slug}`);
    expect(await ackListenAllAgents(env, posting, { roomId: room.roomId, triggerMessageId: "listen", now: 12 })).toBe(true);
    expect(sqlite.prepare("SELECT actor_id FROM collaboration_reply_claims WHERE trigger_message_id='listen'").get()).toMatchObject({ actor_id: "agent:engineer" });
    await set("everyone", "*", "view");
    expect((await listCollaborationMemberships(env, posting, room.roomId)).filter((row) => row.actorKind === "agent")).toHaveLength(2);
    expect((await coordinateHumanMessage(env, posting, { roomId: room.roomId, messageId: "view-mention", body: "@agent:finance", now: 13 })).handoffs).toEqual([]);
    await set("everyone", "*", "chat");
    expect((await coordinateHumanMessage(env, posting, { roomId: room.roomId, messageId: "chat-mention", body: "@agent:finance", now: 14 })).handoffs).toHaveLength(1);
    expect(await ackThreadOwner(env, posting, { roomId: room.roomId, triggerMessageId: "owner-allowed", threadRootId: "root", now: 15 })).toBe(true);
    expect(await filterEmployeesByAccess(env, posting, [], "chat", (id: string) => id)).toEqual([]);
    sqlite.exec("DROP TABLE employee_access");
    await expect(filterEmployeesByAccess(env, posting, [employee.id], "chat", (id) => id)).rejects.toThrow();
  });
  it("defaults compatibly, denies nonmembers and preserves owner/admin authority", async () => {
    const { resolve, set } = await fixture();
    expect(await resolve()).toBe("manage");
    expect(await resolve("other@example.test")).toBe("none");
    await set("everyone", "*", "none");
    expect(await resolve()).toBe("none");
    expect(await resolve(owner)).toBe("manage");
  });
  it("uses direct overrides, highest active group, then Everyone; removal takes effect immediately", async () => {
    const { env, workspaceId, set, resolve } = await fixture();
    const group = await createWorkspaceGroup(env, workspaceId, owner, { name: "Finance team" });
    const second = await createWorkspaceGroup(env, workspaceId, owner, { name: "Reviewers" });
    await set("everyone", "*", "none");
    await addWorkspaceGroupMember(env, workspaceId, owner, group.groupId, member);
    await addWorkspaceGroupMember(env, workspaceId, owner, second.groupId, member);
    await set("group", group.groupId, "chat");
    await set("group", second.groupId, "view");
    expect(await resolve()).toBe("chat");
    await removeWorkspaceGroupMember(env, workspaceId, owner, group.groupId, member);
    expect(await resolve()).toBe("view");
    await set("user", member, "none");
    expect(await resolve()).toBe("none");
  });
  it("audits every change with employee and principal names captured at that time", async () => {
    const { env, sqlite, workspaceId, employee, set } = await fixture();
    const group = await createWorkspaceGroup(env, workspaceId, owner, { name: "Finance team" });
    await set("group", group.groupId, "chat");
    sqlite.prepare("UPDATE workspace_groups SET name='Renamed'").run();
    const row = sqlite.prepare("SELECT detail FROM audit_log WHERE tool='employee.access.changed'").get() as { detail: string };
    expect(JSON.parse(row.detail)).toMatchObject({ employeeName: "Finance", principalName: "Finance team", actorName: owner, before: null, after: "chat" });
    await expect(set("user", "missing@example.test", "chat")).rejects.toThrow("Member not found");
    await expect(set("everyone", "*", "invalid")).rejects.toThrow("Invalid employee access");
    expect(await listEmployeeAccess(env, workspaceId, employee.id)).toHaveLength(1);
  });
  it("filters hidden employees and gates reads, writes and approvals in the route table", async () => {
    const { env, workspaceId, employee, set, auth } = await fixture(); auth();
    const request = (path: string, method = "GET", body?: unknown) => new Request(`https://app.test${path}`, { method, headers: { "X-Shiba-Workspace": workspaceId, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    await set("everyone", "*", "none");
    expect(await visibleEmployees(env, workspaceId, member, [employee])).toEqual([]);
    expect((await enforceEmployeeRouteAccess(request(`/api/custom-agents/${employee.id}`), env))?.status).toBe(404);
    await set("everyone", "*", "view");
    expect(await enforceEmployeeRouteAccess(request(`/api/custom-agents/${employee.id}`), env)).toBeNull();
    expect((await enforceEmployeeRouteAccess(request(`/api/custom-agents/${employee.id}`, "PUT", {}), env))?.status).toBe(403);
    expect((await enforceEmployeeRouteAccess(request("/api/employee-tools/approvals/a", "POST", { employeeId: employee.id }), env))?.status).toBe(403);
    await set("everyone", "*", "chat");
    expect(await enforceEmployeeRouteAccess(request("/api/employee-tools/approvals/a", "POST", { employeeId: employee.id }), env)).toBeNull();
    expect((await enforceEmployeeRouteAccess(request(`/api/employee-tools/${employee.id}/policy`, "PUT", {}), env))?.status).toBe(403);
    expect(employeeAccessDenial("manage", "manage")).toBeNull();
  });
  it("serves empty settings and rejects invalid input and unauthorized changes", async () => {
    const { env, employee, workspaceId, set, auth } = await fixture(); auth(owner);
    const url = `https://app.test/api/governance/employees/${employee.id}/access`;
    const response = await handleEmployeeAccess(new Request(url), env);
    expect(await response!.json()).toEqual({ level: "manage", grants: [] });
    expect((await handleEmployeeAccess(new Request(url, { method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://app.test" }, body: "null" }), env))?.status).toBe(400);
    await set("everyone", "*", "view"); auth();
    expect((await handleEmployeeAccess(new Request(url, { method: "PUT", headers: { "X-Shiba-Workspace": workspaceId }, body: "{}" }), env))?.status).toBe(403);
    vi.mocked(resolveOrgForApiRequest).mockResolvedValue({ orgId: "self-hosted", principal: null });
    expect(await enforceEmployeeRouteAccess(new Request(`https://app.test/api/custom-agents/${employee.id}`), env)).toBeNull();
  });
});
