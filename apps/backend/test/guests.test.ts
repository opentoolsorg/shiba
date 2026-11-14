import { describe, expect, it } from "vitest";
import { createTeamWorkspace } from "../src/team-workspaces-store.js";
import { inviteWorkspaceGuest, acceptGuestToken } from "../src/governance/guests-store.js";
import { canAccess } from "../src/governance/resource-access.js";
import { governanceD1Fixture } from "./fixtures/governance-d1.js";

const alice = "alice@example.test";

describe("workspace guests", () => {
  it("limits guests to granted resources", async () => {
    const { env } = await governanceD1Fixture();
    const workspace = await createTeamWorkspace(env, alice, { name: "Guests" }, 1);
    const fileId = "file-123";
    const invite = await inviteWorkspaceGuest(env, workspace.workspaceId, alice, {
      email: "guest@example.test",
      resourceKind: "file",
      resourceId: fileId,
      access: "view",
    }, 2);
    const accepted = await acceptGuestToken(env, invite.token, 3);
    expect(accepted?.guestId).toBe(invite.guestId);
    const allowed = await canAccess(env, {
      actor: { workspaceId: workspace.workspaceId, userId: "guest@example.test", guestId: invite.guestId },
      resourceKind: "file",
      resourceId: fileId,
      access: "view",
    });
    expect(allowed.allowed).toBe(true);
    const denied = await canAccess(env, {
      actor: { workspaceId: workspace.workspaceId, userId: "guest@example.test", guestId: invite.guestId },
      resourceKind: "file",
      resourceId: "other-file",
      access: "view",
    });
    expect(denied.allowed).toBe(false);
  });
});