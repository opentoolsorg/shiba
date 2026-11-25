import { beforeEach, describe, expect, it, vi } from "vitest";
import { slackIdentityResolver } from "../src/adapters/chat-channel/slack/identity.js";
import { readSlackCoworkerState } from "../src/slack-coworker-store.js";
import type { SlackInstallationEnv } from "../src/slack-installations-store.js";
import type { WorkspaceNativeMember } from "../src/workspace-native-authority.js";

vi.mock("../src/slack-coworker-store.js", () => ({ readSlackCoworkerState: vi.fn() }));

const env = {} as SlackInstallationEnv;
const member: WorkspaceNativeMember = { workspaceId: "workspace-1", userId: "owner@example.test", accountId: "account-1", version: 1, role: "owner", joinedAt: 1 };
const state = (bindings: unknown) => ({ challenges: [], grants: [], bindings, executionAvailable: false });
const currentBinding = { id: "binding-1", installationId: "installation-1", teamId: "T1", slackUserId: "U1" };

beforeEach(() => { vi.mocked(readSlackCoworkerState).mockReset(); });

describe("Slack ChatChannel scoped identity", () => {
  it("resolves only a matching team and user to the supplied native scope", async () => {
    vi.mocked(readSlackCoworkerState).mockResolvedValue(state([currentBinding]));
    await expect(slackIdentityResolver(env, member, "T1")("U1")).resolves.toEqual({ workspaceId: member.workspaceId, userId: member.userId, accountId: member.accountId });
    expect(readSlackCoworkerState).toHaveBeenCalledWith(env, member);
  });

  it("refuses matching user ids from another team and unmatched users", async () => {
    vi.mocked(readSlackCoworkerState).mockResolvedValue(state([currentBinding]));
    await expect(slackIdentityResolver(env, member, "T2")("U1")).resolves.toBeNull();
    await expect(slackIdentityResolver(env, member, "T1")("U2")).resolves.toBeNull();
  });

  it("rechecks current bindings for each lookup and stops resolving after revocation", async () => {
    // The existing store excludes revoked bindings from its current state.
    vi.mocked(readSlackCoworkerState).mockResolvedValueOnce(state([currentBinding])).mockResolvedValueOnce(state([]));
    const resolve = slackIdentityResolver(env, member, "T1");
    await expect(resolve("U1")).resolves.toMatchObject({ accountId: member.accountId });
    await expect(resolve("U1")).resolves.toBeNull();
    expect(readSlackCoworkerState).toHaveBeenCalledTimes(2);
    expect(readSlackCoworkerState).toHaveBeenNthCalledWith(2, env, member);
  });

  for (const bindings of [undefined, null, {}, [], [null, {}, { teamId: "T1" }]]) {
    it(`returns no identity for absent or incomplete bindings: ${JSON.stringify(bindings)}`, async () => {
      vi.mocked(readSlackCoworkerState).mockResolvedValue(state(bindings));
      await expect(slackIdentityResolver(env, member, "T1")("U1")).resolves.toBeNull();
    });
  }

  it("does not mask a failure to revalidate current authority", async () => {
    const error = new Error("Membership changed");
    vi.mocked(readSlackCoworkerState).mockRejectedValue(error);
    await expect(slackIdentityResolver(env, member, "T1")("U1")).rejects.toBe(error);
  });
});
