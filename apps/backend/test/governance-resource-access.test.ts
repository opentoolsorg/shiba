import { describe, expect, it } from "vitest";
import {
  acceptTeamWorkspaceInvitation,
  createTeamWorkspace,
  createTeamWorkspaceInvitation,
} from "../src/team-workspaces-store.js";
import {
  addWorkspaceGroupMember,
  createWorkspaceGroup,
  upsertResourceGrant,
} from "../src/governance/governance-store.js";
import { canAccess } from "../src/governance/resource-access.js";
import { governanceD1Fixture } from "./fixtures/governance-d1.js";

const alice = "alice@example.test";
const bob = "bob@example.test";

describe("governance resource access", () => {
  it("grants group view on a room without direct membership", async () => {
    const { env } = await governanceD1Fixture();
    const workspace = await createTeamWorkspace(env, alice, { name: "Design" }, 1);
    const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, alice, { email: bob, role: "member" }, 2);
    await acceptTeamWorkspaceInvitation(env, bob, invite.token, 3);
    const group = await createWorkspaceGroup(env, workspace.workspaceId, alice, { name: "design" }, 3);
    await addWorkspaceGroupMember(env, workspace.workspaceId, alice, group.groupId, bob, 4);
    const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaa";
    await upsertResourceGrant(env, workspace.workspaceId, alice, {
      resourceKind: "room",
      resourceId: roomId,
      principalKind: "group",
      principalId: group.groupId,
      access: "view",
    }, 5);
  const allowed = await canAccess(env, {
      actor: { workspaceId: workspace.workspaceId, userId: bob },
      resourceKind: "room",
      resourceId: roomId,
      access: "view",
    });
    expect(allowed).toMatchObject({ allowed: true, reason: "group_grant" });
    const denied = await canAccess(env, {
      actor: { workspaceId: workspace.workspaceId, userId: bob },
      resourceKind: "room",
      resourceId: roomId,
      access: "edit",
    });
    expect(denied.allowed).toBe(false);
  });

  it("revokes group access when member is removed", async () => {
    const { env } = await governanceD1Fixture();
    const workspace = await createTeamWorkspace(env, alice, { name: "Design" }, 1);
    const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, alice, { email: bob, role: "member" }, 2);
    await acceptTeamWorkspaceInvitation(env, bob, invite.token, 3);
    const group = await createWorkspaceGroup(env, workspace.workspaceId, alice, { name: "design" }, 3);
    await addWorkspaceGroupMember(env, workspace.workspaceId, alice, group.groupId, bob, 4);
    const roomId = "room_bbbbbbbbbbbbbbbbbbbbbbbb";
    await upsertResourceGrant(env, workspace.workspaceId, alice, {
      resourceKind: "room",
      resourceId: roomId,
      principalKind: "group",
      principalId: group.groupId,
      access: "view",
    }, 5);
    await addWorkspaceGroupMember(env, workspace.workspaceId, alice, group.groupId, bob, 6);
    const { removeWorkspaceGroupMember } = await import("../src/governance/governance-store.js");
    await removeWorkspaceGroupMember(env, workspace.workspaceId, alice, group.groupId, bob, 7);
    const denied = await canAccess(env, {
      actor: { workspaceId: workspace.workspaceId, userId: bob },
      resourceKind: "room",
      resourceId: roomId,
      access: "view",
    });
    expect(denied.allowed).toBe(false);
  });
});