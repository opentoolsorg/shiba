import type { CustomAgentApprovalPolicy, CustomAgentRecord } from "@shiba/shared";
import {
  getCustomAgentById,
  getCustomAgentBySlug,
  getCustomAgentVersion,
} from "./custom-agents-store.js";
import type { Env } from "./env.js";

export interface CustomAgentRunOverrides {
  harness?: string;
  codingModel?: string;
  connectionId?: string;
  repoUrl?: string;
  sandboxProvider?: string;
  instructions?: string;
  expectedDeliverables?: string[];
  customAgentId: string;
  customAgentVersion: number;
  approvalPolicy?: CustomAgentApprovalPolicy;
}

export async function resolveCustomAgentForRun(
  env: Pick<Env, "AGENT_AUDIT">,
  orgId: string,
  agentRef: string,
  profileVersion?: number,
): Promise<CustomAgentRecord | null> {
  if (!env.AGENT_AUDIT) return null;
  if (profileVersion !== undefined) {
    return getCustomAgentVersion(env, orgId, agentRef, profileVersion);
  }
  const byId = await getCustomAgentById(env, orgId, agentRef);
  if (byId) return byId;
  return getCustomAgentBySlug(env, orgId, agentRef);
}

export function overridesFromCustomAgent(agent: CustomAgentRecord): CustomAgentRunOverrides {
  const cfg = agent.config;
  return {
    customAgentId: agent.id,
    customAgentVersion: agent.version,
    harness: cfg.harness,
    ...(cfg.codingModel ? { codingModel: cfg.codingModel } : {}),
    ...(cfg.connectionId ? { connectionId: cfg.connectionId } : {}),
    ...(cfg.defaultRepoUrl ? { repoUrl: cfg.defaultRepoUrl } : {}),
    ...(cfg.sandboxProvider ? { sandboxProvider: cfg.sandboxProvider } : {}),
    ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
    ...(cfg.expectedDeliverables !== undefined
      ? { expectedDeliverables: [...cfg.expectedDeliverables] }
      : {}),
    ...(cfg.approvalPolicy ? { approvalPolicy: cfg.approvalPolicy } : {}),
  };
}
