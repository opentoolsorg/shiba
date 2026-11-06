import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEAM_WORKSPACE_INVITATION_TTL_MS } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { createCollaborationRoom, addCollaborationMember, getCollaborationRoom, humanActorId } from "../src/collaboration-store.js";
import { handleTeamWorkspaces } from "../src/team-workspaces-routes.js";
import {
  acceptTeamWorkspaceInvitation, changeTeamWorkspaceMember, createTeamWorkspace,
  createTeamWorkspaceInvitation, getTeamWorkspace, getTeamWorkspaceMembership,
  isTeamWorkspaceMember, listTeamWorkspaces, renameTeamWorkspace, revokeTeamWorkspaceInvitation,
} from "../src/team-workspaces-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const auth = vi.hoisted(() => ({ userId: "alice@example.test", authorized: true }));
vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: vi.fn(async () => auth.authorized),
  resolveUserId: vi.fn(async () => auth.userId),
}));
const alice = "alice@example.test", bob = "bob@example.test", eve = "eve@example.test";
async function fixture() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database } as unknown as Env;
  const workspace = await createTeamWorkspace(env, alice, { name: "Product" }, 100);
  return { env, sqlite, workspace, workspaceId: workspace.workspaceId };
}
async function join(env: Env, workspaceId: string, email = bob, role = "member") {
  const invite = await createTeamWorkspaceInvitation(env, workspaceId, alice, { email, role }, 200);
  return acceptTeamWorkspaceInvitation(env, email, invite.token, 300);
}
function request(path = "", method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://worker.test/api/workspaces${path}`, {
    method, headers: { origin: "https://worker.test", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(() => { auth.userId = alice; auth.authorized = true; });

describe("explicit team workspace grants", () => {
  it("creates a separate owner scope without importing legacy rooms or private memory", async () => {
    const f = await fixture();
    expect(f.workspace).toMatchObject({ name: "Product", version: 1, members: [{ userId: alice, role: "owner", version: 1 }] });
    expect(f.workspaceId).toMatch(/^ws_[a-f0-9]{24}$/);
    expect(await listTeamWorkspaces(f.env, bob)).toEqual([]);
    expect(await isTeamWorkspaceMember(f.env, "default", alice)).toBe(false);
    expect(await getTeamWorkspace(f.env, f.workspaceId, eve)).toBeNull();
    expect(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%memory%'").all()).toEqual([]);
    expect(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='collaboration_rooms'").all()).toEqual([]);
  });
  it("stores only a hash and never reveals tokens or invitation recipients to ordinary members", async () => {
    const f = await fixture();
    const invite = await createTeamWorkspaceInvitation(f.env, f.workspaceId, alice, { email: " Bob@Example.Test ", role: "member" }, 200);
    const raw = f.sqlite.prepare("SELECT * FROM team_workspace_invitations").get();
    expect(invite.token).toMatch(/^[a-f0-9]{64}$/);
    expect(raw?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(raw)).not.toContain(invite.token);
    expect(invite.invitation.expiresAt).toBe(200 + TEAM_WORKSPACE_INVITATION_TTL_MS);
    await acceptTeamWorkspaceInvitation(f.env, bob, invite.token, 300);
    await createTeamWorkspaceInvitation(f.env, f.workspaceId, alice, { email: eve, role: "member" }, 400);
    const memberView = await getTeamWorkspace(f.env, f.workspaceId, bob, 500);
    expect(memberView?.invitations).toBeUndefined();
    expect(JSON.stringify(memberView)).not.toContain(eve);
    expect(JSON.stringify(await getTeamWorkspace(f.env, f.workspaceId, alice, 500))).not.toContain(invite.token);
  });
  it("requires exact authenticated recipient, rejects expiry and token replay, and consumes once concurrently", async () => {
    const f = await fixture();
    const invite = await createTeamWorkspaceInvitation(f.env, f.workspaceId, alice, { email: bob, role: "member" }, 200);
    await expect(acceptTeamWorkspaceInvitation(f.env, eve, invite.token, 300)).rejects.toMatchObject({ status: 404 });
    expect(await getTeamWorkspaceMembership(f.env, f.workspaceId, eve)).toBeNull();
    const outcomes = await Promise.allSettled([acceptTeamWorkspaceInvitation(f.env, bob, invite.token, 300), acceptTeamWorkspaceInvitation(f.env, bob, invite.token, 300)]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM team_workspace_memberships WHERE user_id=?").get(bob)?.n).toBe(1);
    await expect(acceptTeamWorkspaceInvitation(f.env, bob, invite.token, 301)).rejects.toMatchObject({ status: 404 });
    const expired = await createTeamWorkspaceInvitation(f.env, f.workspaceId, alice, { email: eve, role: "member" }, 200);
    await expect(acceptTeamWorkspaceInvitation(f.env, eve, expired.token, 200 + TEAM_WORKSPACE_INVITATION_TTL_MS)).rejects.toMatchObject({ status: 404 });
  });
  it("rolls membership back when invitation consumption fails, then safely retries", async () => {
    const f = await fixture();
    const invite = await createTeamWorkspaceInvitation(f.env, f.workspaceId, alice, { email: bob, role: "member" }, 200);
    f.sqlite.exec("CREATE TRIGGER fail_invite_accept BEFORE UPDATE OF status ON team_workspace_invitations WHEN NEW.status='accepted' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    await expect(acceptTeamWorkspaceInvitation(f.env, bob, invite.token, 300)).rejects.toThrow("injected failure");
    expect(await getTeamWorkspaceMembership(f.env, f.workspaceId, bob)).toBeNull();
    expect(f.sqlite.prepare("SELECT status FROM team_workspace_invitations").get()?.status).toBe("pending");
    f.sqlite.exec("DROP TRIGGER fail_invite_accept");
    expect((await acceptTeamWorkspaceInvitation(f.env, bob, invite.token, 301)).membership.role).toBe("member");
  });
  it("serializes revoke versus acceptance without leaving a consumed invite without its membership", async () => {
    const f = await fixture();
    const invite = await createTeamWorkspaceInvitation(f.env, f.workspaceId, alice, { email: bob, role: "member" }, 200);
    await Promise.allSettled([revokeTeamWorkspaceInvitation(f.env, f.workspaceId, alice, invite.invitation.invitationId, 300), acceptTeamWorkspaceInvitation(f.env, bob, invite.token, 300)]);
    const status = f.sqlite.prepare("SELECT status FROM team_workspace_invitations").get()?.status;
    const membership = await getTeamWorkspaceMembership(f.env, f.workspaceId, bob);
    expect(status === "accepted").toBe(membership !== null);
    expect(["accepted", "revoked"]).toContain(status);
  });
  it("invalidates outstanding invitations when issuer is revoked or their grant version changes", async () => {
    const f = await fixture();
    await join(f.env, f.workspaceId, bob, "admin");
    const invite = await createTeamWorkspaceInvitation(f.env, f.workspaceId, bob, { email: eve, role: "member" }, 400);
    await changeTeamWorkspaceMember(f.env, f.workspaceId, alice, bob, { role: "member", expectedVersion: 1 }, 500);
    expect((await getTeamWorkspace(f.env, f.workspaceId, alice, 600))?.invitations?.find((i) => i.invitationId === invite.invitation.invitationId)?.status).toBe("invalidated");
    await expect(acceptTeamWorkspaceInvitation(f.env, eve, invite.token, 600)).rejects.toMatchObject({ status: 404 });
    await changeTeamWorkspaceMember(f.env, f.workspaceId, alice, bob, { role: "admin", expectedVersion: 2 }, 700);
    await expect(acceptTeamWorkspaceInvitation(f.env, eve, invite.token, 800)).rejects.toMatchObject({ status: 404 });
    const second = await createTeamWorkspaceInvitation(f.env, f.workspaceId, bob, { email: eve, role: "member" }, 900);
    await changeTeamWorkspaceMember(f.env, f.workspaceId, alice, bob, { remove: true, expectedVersion: 3 }, 1000);
    await expect(acceptTeamWorkspaceInvitation(f.env, eve, second.token, 1100)).rejects.toMatchObject({ status: 404 });
  });
  it("never uses an invitation to overwrite an existing active grant, and rechecks capacity at acceptance", async () => {
    const f = await fixture();
    await join(f.env, f.workspaceId);
    const escalation = await createTeamWorkspaceInvitation(f.env, f.workspaceId, alice, { email: bob, role: "owner" }, 400);
    await expect(acceptTeamWorkspaceInvitation(f.env, bob, escalation.token, 500)).rejects.toMatchObject({ status: 404 });
    expect((await getTeamWorkspaceMembership(f.env, f.workspaceId, bob))?.role).toBe("member");
    const pending = await createTeamWorkspaceInvitation(f.env, f.workspaceId, alice, { email: eve, role: "member" }, 400);
    for (let n = 2; n < 100; n++) f.sqlite.prepare("INSERT INTO team_workspace_memberships(tenant_id,workspace_id,user_id,role,status,version,joined_at) VALUES ('self-hosted',?,?,'member','active',1,500)").run(f.workspaceId, `m${n}@example.test`);
    await expect(acceptTeamWorkspaceInvitation(f.env, eve, pending.token, 600)).rejects.toMatchObject({ status: 404 });
    expect(await getTeamWorkspaceMembership(f.env, f.workspaceId, eve)).toBeNull();
    expect(f.sqlite.prepare("SELECT status FROM team_workspace_invitations WHERE email=?").get(eve)?.status).toBe("pending");
  });
  it("limits admin authority, keeps other workspaces private, and enforces rename CAS", async () => {
    const f = await fixture();
    await join(f.env, f.workspaceId, bob, "admin");
    await expect(createTeamWorkspaceInvitation(f.env, f.workspaceId, bob, { email: eve, role: "owner" })).rejects.toMatchObject({ status: 409 });
    await expect(changeTeamWorkspaceMember(f.env, f.workspaceId, bob, bob, { role: "owner", expectedVersion: 1 })).rejects.toMatchObject({ status: 409 });
    const other = await createTeamWorkspace(f.env, eve, { name: "Private other team" });
    expect(await getTeamWorkspace(f.env, other.workspaceId, bob)).toBeNull();
    await expect(createTeamWorkspaceInvitation(f.env, other.workspaceId, bob, { email: alice, role: "member" })).rejects.toMatchObject({ status: 409 });
    await renameTeamWorkspace(f.env, f.workspaceId, bob, { name: "Renamed", expectedVersion: 1 });
    await expect(renameTeamWorkspace(f.env, f.workspaceId, alice, { name: "Stale", expectedVersion: 1 })).rejects.toMatchObject({ status: 409 });
    expect((await getTeamWorkspace(f.env, f.workspaceId, alice))?.name).toBe("Renamed");
  });
  it("preserves a last owner even with concurrent self-removal and demotion", async () => {
    const f = await fixture();
    await expect(changeTeamWorkspaceMember(f.env, f.workspaceId, alice, alice, { remove: true, expectedVersion: 1 })).rejects.toMatchObject({ status: 409 });
    await join(f.env, f.workspaceId, bob, "owner");
    const outcomes = await Promise.allSettled([
      changeTeamWorkspaceMember(f.env, f.workspaceId, alice, alice, { remove: true, expectedVersion: 1 }),
      changeTeamWorkspaceMember(f.env, f.workspaceId, bob, bob, { role: "member", expectedVersion: 1 }),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM team_workspace_memberships WHERE status='active' AND role='owner'").get()?.n).toBe(1);
  });
  it("revokes owned employees, all affected room grants, root handoffs and pending Slack actions atomically, preserving private scopes", async () => {
    const f = await fixture();
    await join(f.env, f.workspaceId);
    const scope = { tenantId: "self-hosted", workspaceId: f.workspaceId, userId: alice };
    await createCollaborationRoom(f.env, scope, { roomId: "team_room", title: "Team", visibility: "shared", createdAt: 400 });
    await addCollaborationMember(f.env, scope, "team_room", { userId: bob, actorId: humanActorId(bob), kind: "human", displayName: "Bob", createdAt: 500 });
    // Employee owner is bob, regardless of occupational role or room ownership.
    f.sqlite.prepare("INSERT INTO collaboration_memberships(tenant_id,workspace_id,room_id,user_id,display_name,actor_id,actor_kind,role,status,capabilities_json,profile_version,created_at) VALUES ('self-hosted',?,'team_room',?,'Engineer','agent:bob','agent','agent','active','[]',1,500)").run(f.workspaceId, bob);
    await createCollaborationRoom(f.env, { ...scope, workspaceId: "default", userId: bob }, { roomId: "private_room", title: "Private", visibility: "private", createdAt: 400 });
    f.sqlite.prepare("INSERT INTO collaboration_handoffs(handoff_id,tenant_id,workspace_id,room_id,task_id,sender_user_id,sender_actor_id,recipient_user_id,recipient_actor_id,root_handoff_id,depth,ancestor_handoff_ids_json,remaining_budget,granted_capabilities_json,status,created_at) VALUES ('handoff','self-hosted',?,'team_room','task',?,?,?,'agent:bob','handoff',0,'[]',2,'[]','active',600)").run(f.workspaceId, alice, humanActorId(alice), bob);
    f.sqlite.prepare("INSERT INTO collaboration_slack_delivery_intents(intent_id,tenant_id,workspace_id,room_id,link_id,message_id,created_by_user_id,channel_id,thread_ts,status,created_at) VALUES ('intent','self-hosted',?,'team_room','link','msg',?,'channel','123','pending',600)").run(f.workspaceId, bob);
    await changeTeamWorkspaceMember(f.env, f.workspaceId, alice, bob, { remove: true, expectedVersion: 1 }, 700);
    expect(await getTeamWorkspaceMembership(f.env, f.workspaceId, bob)).toBeNull();
    expect(f.sqlite.prepare("SELECT status FROM collaboration_memberships WHERE workspace_id=? AND user_id=?").all(f.workspaceId, bob)).toEqual([{ status: "removed" }, { status: "removed" }]);
    expect(f.sqlite.prepare("SELECT status FROM collaboration_handoffs").get()?.status).toBe("cancelled");
    expect(f.sqlite.prepare("SELECT delivery_status FROM collaboration_slack_delivery_intents").get()?.delivery_status).toBe("blocked");
    expect(await getCollaborationRoom(f.env, { ...scope, userId: bob }, "team_room")).toBeNull();
    expect(await getCollaborationRoom(f.env, { ...scope, workspaceId: "default", userId: bob }, "private_room")).not.toBeNull();
    await join(f.env, f.workspaceId);
    expect(await getCollaborationRoom(f.env, { ...scope, userId: bob }, "team_room")).toBeNull();
  });
  it("bounds workspaces and invitation history inside atomic writes", async () => {
    const f = await fixture();
    for (let n = 1; n < 50; n++) await createTeamWorkspace(f.env, alice, { name: `Team ${n}` });
    await expect(createTeamWorkspace(f.env, alice, { name: "Overflow" })).rejects.toMatchObject({ status: 409 });
    expect((await listTeamWorkspaces(f.env, alice))).toHaveLength(50);
    for (let n = 0; n < 100; n++) await createTeamWorkspaceInvitation(f.env, f.workspaceId, alice, { email: `member${n}@example.test`, role: "member" });
    await expect(createTeamWorkspaceInvitation(f.env, f.workspaceId, alice, { email: eve, role: "member" })).rejects.toMatchObject({ status: 409 });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM team_workspace_invitations").get()?.n).toBe(100);
  });
  it("rolls workspace revocation back if a room revocation fails", async () => {
    const f = await fixture();
    await join(f.env, f.workspaceId);
    const scope = { tenantId: "self-hosted", workspaceId: f.workspaceId, userId: alice };
    await createCollaborationRoom(f.env, scope, { roomId: "room_atomic", title: "Atomic", visibility: "shared", createdAt: 400 });
    await addCollaborationMember(f.env, scope, "room_atomic", { userId: bob, actorId: humanActorId(bob), kind: "human", displayName: "Bob", createdAt: 500 });
    f.sqlite.exec("CREATE TRIGGER fail_room_revoke BEFORE UPDATE OF status ON collaboration_memberships WHEN NEW.status='removed' BEGIN SELECT RAISE(ABORT,'injected cascade failure'); END");
    await expect(changeTeamWorkspaceMember(f.env, f.workspaceId, alice, bob, { remove: true, expectedVersion: 1 })).rejects.toThrow("injected cascade failure");
    expect((await getTeamWorkspaceMembership(f.env, f.workspaceId, bob))?.version).toBe(1);
    expect(await getCollaborationRoom(f.env, { ...scope, userId: bob }, "room_atomic")).not.toBeNull();
  });
});

describe("workspace human-session routes", () => {
  it("returns no-store DTOs, denies cross-workspace reads and has no anonymous invitation lookup", async () => {
    const f = await fixture();
    const response = await handleTeamWorkspaces(request(`/${f.workspaceId}`), f.env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    auth.userId = eve;
    expect((await handleTeamWorkspaces(request(`/${f.workspaceId}`), f.env))?.status).toBe(404);
    expect((await handleTeamWorkspaces(request("/invitations/arbitrary"), f.env))?.status).toBe(404);
    auth.authorized = false;
    expect((await handleTeamWorkspaces(request(), f.env))?.status).toBe(401);
    expect(await handleTeamWorkspaces(new Request("https://worker.test/api/other"), f.env)).toBeNull();
  });
  it("requires same-origin JSON bounded bodies and rejects bearer automation identities and extra grant fields", async () => {
    const f = await fixture();
    expect((await handleTeamWorkspaces(request("", "POST", { name: "X" }, { origin: "https://evil.test" }), f.env))?.status).toBe(403);
    expect((await handleTeamWorkspaces(request("", "POST", { name: "X" }, { "content-type": "text/plain" }), f.env))?.status).toBe(415);
    expect((await handleTeamWorkspaces(request("", "POST", { name: "X" }, { authorization: "Bearer human-looking-token" }), f.env))?.status).toBe(401);
    expect((await handleTeamWorkspaces(request("", "POST", { name: "X", userId: eve }), f.env))?.status).toBe(400);
    expect((await handleTeamWorkspaces(request("", "POST", { name: "x".repeat(5000) }), f.env))?.status).toBe(413);
    auth.userId = "automation:agent";
    expect((await handleTeamWorkspaces(request(), f.env))?.status).toBe(403);
  });
  it("creates and accepts with exact authenticated email and never sends an email automatically", async () => {
    const f = await fixture();
    const create = await handleTeamWorkspaces(request(`/${f.workspaceId}/invitations`, "POST", { email: bob, role: "member" }), f.env);
    expect(create?.status).toBe(201);
    const created = await create!.json() as { token: string };
    const invite = { token: created.token };
    auth.userId = eve;
    expect((await handleTeamWorkspaces(request("/invitations/accept", "POST", invite), f.env))?.status).toBe(404);
    auth.userId = bob;
    expect((await handleTeamWorkspaces(request("/invitations/accept", "POST", invite), f.env))?.status).toBe(200);
    expect((await handleTeamWorkspaces(request("/invitations/accept", "POST", invite), f.env))?.status).toBe(404);
    expect((await handleTeamWorkspaces(request(`/${f.workspaceId}/members/${encodeURIComponent(bob)}`, "DELETE", { expectedVersion: 1 }), f.env))?.status).toBe(200);
    expect((await handleTeamWorkspaces(request(`/${f.workspaceId}`), f.env))?.status).toBe(404);
  });
});
