import type { Connection } from "./model-connections.js";
import { ORCHESTRATOR_NAME } from "./slack-routes.js";
import { OPENAI_SUBSCRIPTION_KIND } from "./subscription-credentials.js";
import { parseSessionAgentName } from "./web-sessions.js";

export interface RunInitiatorContext {
  initiatorUserId?: string | null;
}

/** Automation and shared ingress runs must not bill a user's ChatGPT plan. */
export function connectionEligibleForRun(connection: Pick<Connection, "service">, ctx: RunInitiatorContext): boolean {
  if (connection.service !== OPENAI_SUBSCRIPTION_KIND) return true;
  return typeof ctx.initiatorUserId === "string" && ctx.initiatorUserId.trim() !== "";
}

/** Derive the human initiator from the orchestrator DO name (automation → undefined). */
export function initiatorUserIdFromOrchestratorName(agentName: string | undefined): string | undefined {
  if (agentName === undefined || agentName === "") return undefined;
  if (agentName === ORCHESTRATOR_NAME) return undefined;
  const web = parseSessionAgentName(agentName);
  if (web) return web.userId;
  if (agentName.startsWith("slack:") || agentName.startsWith("captain:")) return undefined;
  return agentName;
}

export function assertConnectionEligibleForRun(connection: Pick<Connection, "service">, ctx: RunInitiatorContext): void {
  if (!connectionEligibleForRun(connection, ctx)) {
    throw new Error(
      "ChatGPT subscription connections require a signed-in user. Automations and shared triggers cannot use openai-subscription.",
    );
  }
}
