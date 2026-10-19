/**
 * Org-scoped custom agent definitions (dashboard + /api/v1).
 * Validation at the Worker boundary uses Effect Schema in apps/backend.
 */

export const CUSTOM_AGENT_APPROVAL_POLICIES = ["standard", "auto_approve"] as const;
export type CustomAgentApprovalPolicy = (typeof CUSTOM_AGENT_APPROVAL_POLICIES)[number];

export const CUSTOM_AGENT_SANDBOX_PROVIDERS = [
  "cloudflare",
  "docker-local",
  "computesdk",
  "e2b",
] as const;
export type CustomAgentSandboxProvider = (typeof CUSTOM_AGENT_SANDBOX_PROVIDERS)[number];

/** Versioned config blob stored in D1 (JSON). */
export interface CustomAgentConfig {
  name: string;
  emoji?: string;
  instructions: string;
  harness: string;
  codingModel?: string;
  connectionId?: string;
  sandboxProvider?: CustomAgentSandboxProvider;
  defaultRepoUrl?: string;
  approvalPolicy?: CustomAgentApprovalPolicy;
  /** MCP tool scope ids the agent may use (empty = deployment default). */
  toolScopes?: readonly string[];
}

export interface CustomAgentRecord {
  id: string;
  orgId: string;
  slug: string;
  version: number;
  config: CustomAgentConfig;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface CustomAgentVersionRow {
  agentId: string;
  orgId: string;
  version: number;
  config: CustomAgentConfig;
  savedAt: number;
}

export function sanitizeCustomAgentSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || slug.length > 48) return null;
  return slug;
}
