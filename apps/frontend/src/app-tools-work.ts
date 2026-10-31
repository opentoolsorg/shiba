import { threadAgentId, type WebThread } from "./agent-threads";
import type { CustomAgentWire } from "./components/CustomAgentsView";

export interface AppToolsWorkContext {
  sessionId: string;
  session?: WebThread;
  sessionAvailable: boolean;
  employeeId: string;
  profile?: CustomAgentWire;
  profilesUnavailable: boolean;
  socketName: string;
  connected: boolean;
}

export function appToolsWorkIssue(context: AppToolsWorkContext): string | null {
  if (context.profilesUnavailable) return "Wait for the bot directory to reconnect before sending.";
  if (!context.employeeId || context.profile?.id !== context.employeeId || context.profile.archivedAt !== undefined) return "Choose an available bot before using connected app tools.";
  if (!Array.isArray(context.profile.config.toolScopes) || context.profile.config.toolScopes.length === 0) return "Configure this bot’s app tool permissions in Employee tools first.";
  if (!context.sessionAvailable || context.sessionId === "default" || context.session?.id !== context.sessionId || threadAgentId(context.session) !== context.employeeId) return "Launch this bot from Bots to open its own conversation before using connected app tools.";
  if (!context.connected || context.socketName !== context.session.agentName) return "Wait for this bot’s conversation to connect before sending.";
  return null;
}

/** Send to the server-bound employee conversation; never queue a computer run. */
export async function sendAppToolsWork(
  context: AppToolsWorkContext,
  text: string,
  sendMessage: (message: { text: string; metadata: { shibaMode: "work"; shibaWorkTarget: "app-tools" } }) => Promise<unknown>,
): Promise<void> {
  const issue = appToolsWorkIssue(context);
  if (issue) throw new Error(issue);
  if (!text.trim()) throw new Error("Enter a task first.");
  await sendMessage({ text: text.trim(), metadata: { shibaMode: "work", shibaWorkTarget: "app-tools" } });
}
