import { describe, expect, it, vi } from "vitest";
import { acceptTeamWorkspaceInvitation, createTeamWorkspace, createTeamWorkspaceInvitation } from "../src/team-workspaces-store.js";
import type { Env } from "../src/env.js";
import { handleShare } from "../src/share-routes.js";
import { createShareLink, resolveShareLinkByToken, revokeShareLink } from "../src/governance/share-links-store.js";
import { revokeResourceGrant, updateWorkspaceSharingPolicy, upsertResourceGrant } from "../src/governance/governance-store.js";
import { governanceD1Fixture } from "./fixtures/governance-d1.js";

const alice = "alice@example.test";
const bob = "bob@example.test";

describe("share links", () => {
  it.each(["file", "room", "chat"] as const)("rejects a member without access to a %s while allowing the workspace owner", async (resourceKind) => {
    const { env, sqlite } = await governanceD1Fixture();
    const workspace = await createTeamWorkspace(env, alice, { name: "Share" }, 1);
    const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, alice, { email: bob, role: "member" }, 2);
    await acceptTeamWorkspaceInvitation(env, bob, invite.token, 3);
    const resource = { resourceKind, resourceId: "private-resource" };

    await expect(createShareLink(env, workspace.workspaceId, bob, resource, 100))
      .rejects.toMatchObject({ status: 404 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM share_links").get()).toMatchObject({ count: 0 });

    const minted = await createShareLink(env, workspace.workspaceId, alice, resource, 100);
    expect(await resolveShareLinkByToken(env, minted.token, 200)).toMatchObject(resource);
  });

  it.each(["file", "room"] as const)("stops serving a %s when its creator's grant is revoked", async (resourceKind) => {
    const { env } = await governanceD1Fixture();
    const workspace = await createTeamWorkspace(env, alice, { name: "Share" }, 1);
    const invite = await createTeamWorkspaceInvitation(env, workspace.workspaceId, alice, { email: bob, role: "member" }, 2);
    await acceptTeamWorkspaceInvitation(env, bob, invite.token, 3);
    const resource = { resourceKind, resourceId: "private-resource" };
    const grant = await upsertResourceGrant(env, workspace.workspaceId, alice, {
      ...resource, principalKind: "user", principalId: bob, access: "view",
    }, 4);
    const minted = await createShareLink(env, workspace.workspaceId, bob, resource);
    const get = vi.fn(async () => ({ body: "private file", httpMetadata: { contentType: "text/plain" } }));
    env.FILES = { get } as unknown as Env["FILES"];
    const request = () => new Request(`https://shiba.test${minted.urlPath}`);

    const allowed = await handleShare(request(), env);
    expect(allowed?.status).toBe(200);
    if (resourceKind === "file") expect(await allowed?.text()).toBe("private file");
    await revokeResourceGrant(env, workspace.workspaceId, alice, grant.grantId);
    get.mockClear();

    expect(await resolveShareLinkByToken(env, minted.token)).toBeNull();
    const denied = await handleShare(request(), env);
    expect(denied?.status).toBe(404);
    expect(await denied?.json()).toEqual({ error: "Share link not found." });
    expect(get).not.toHaveBeenCalled();
  });

  it("hashes tokens without storing raw values and revokes cleanly", async () => {
    const { env, sqlite } = await governanceD1Fixture();
    const workspace = await createTeamWorkspace(env, alice, { name: "Share" }, 1);
    const minted = await createShareLink(env, workspace.workspaceId, alice, { resourceKind: "chat", resourceId: "chat-1" }, 100);
    expect(minted.token).toMatch(/^[a-f0-9]{64}$/);
    const raw = JSON.stringify(sqlite.prepare("SELECT * FROM share_links").get());
    expect(raw).not.toContain(minted.token);
    const row = await resolveShareLinkByToken(env, minted.token, 200);
    expect(row?.resourceId).toBe("chat-1");
    await revokeShareLink(env, workspace.workspaceId, alice, minted.summary.linkId, 300);
    expect(await resolveShareLinkByToken(env, minted.token, 400)).toBeNull();
  });

  it("returns 403 when public links are disabled", async () => {
    const { env } = await governanceD1Fixture();
    const workspace = await createTeamWorkspace(env, alice, { name: "Share" }, 1);
    await updateWorkspaceSharingPolicy(env, workspace.workspaceId, alice, {
      publicLinksAllowed: false,
      expectedVersion: 0,
    }, 10);
    await expect(createShareLink(env, workspace.workspaceId, alice, { resourceKind: "chat", resourceId: "c1" }, 20))
      .rejects.toMatchObject({ status: 403 });
  });
});
