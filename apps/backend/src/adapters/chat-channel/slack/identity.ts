/* eslint-disable no-restricted-imports -- Adapters sit three levels deep but stay inside the backend app. */
import type { ChannelIdentity } from "../../../ports/chat-channel/types.js";
import { readSlackCoworkerState } from "../../../slack-coworker-store.js";
import type { SlackInstallationEnv } from "../../../slack-installations-store.js";
import type { WorkspaceNativeMember } from "../../../workspace-native-authority.js";

/** Reuses current membership, account, installation and generation checks on every lookup. */
export function slackIdentityResolver(env: SlackInstallationEnv, member: WorkspaceNativeMember, teamId: string) {
  return async (channelUserId: string): Promise<ChannelIdentity | null> => {
    const state = await readSlackCoworkerState(env, member);
    const bindings: unknown = state.bindings;
    if (!Array.isArray(bindings) || !bindings.some((binding: unknown) => {
      if (typeof binding !== "object" || binding === null) return false;
      const value = binding as Record<string, unknown>;
      return value.teamId === teamId && value.slackUserId === channelUserId;
    })) return null;
    return { workspaceId: member.workspaceId, userId: member.userId, accountId: member.accountId };
  };
}
