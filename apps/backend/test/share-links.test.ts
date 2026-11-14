import { describe, expect, it } from "vitest";
import { createTeamWorkspace } from "../src/team-workspaces-store.js";
import { createShareLink, resolveShareLinkByToken, revokeShareLink } from "../src/governance/share-links-store.js";
import { updateWorkspaceSharingPolicy } from "../src/governance/governance-store.js";
import { governanceD1Fixture } from "./fixtures/governance-d1.js";

const alice = "alice@example.test";

describe("share links", () => {
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