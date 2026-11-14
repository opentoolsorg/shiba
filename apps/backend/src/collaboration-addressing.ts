/** Who may speak for an agent. Default listen mode is mentions only. */
export type AgentListenMode = "mentions" | "all";

export interface AgentReplyContext {
  mentioned: boolean;
  ownsThread: boolean;
  soleAgentInDm: boolean;
  receivedHandoff: boolean;
  listenMode: AgentListenMode;
}

/** An agent posts only when addressed, when it owns the thread, in a 1:1 DM, or on a handoff. */
export function agentMayReply(context: AgentReplyContext): boolean {
  if (context.mentioned || context.ownsThread || context.soleAgentInDm || context.receivedHandoff) return true;
  return context.listenMode === "all";
}

const AGENT_MENTION = /@agent:([A-Za-z0-9_-]{1,80})/gi;

export function mentionedAgentIds(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(AGENT_MENTION)) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids];
}
