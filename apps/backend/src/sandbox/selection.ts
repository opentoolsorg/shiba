import { parseSandboxProviderId, type SandboxProviderId } from "@shiba/sandbox";
import type { Env } from "../env.js";
import { getOrgSandboxProvider, type OrgSandboxSettings } from "../org-sandbox-store.js";

export interface SandboxSelectionContext {
  orgId?: string;
  initiatorUserId?: string;
  /** Per-task override (composer / API body). */
  taskProviderId?: string;
  /** Resolved custom agent sandbox provider. */
  customAgentProviderId?: string;
}

export interface ResolvedSandboxSelection {
  providerId: SandboxProviderId;
  source: "task" | "custom_agent" | "org" | "deployment";
  orgSettings?: OrgSandboxSettings;
}

/**
 * Precedence: task → custom agent → org (D1) → deployment env (`SHIBA_SANDBOX_PROVIDER`).
 */
export async function resolveSandboxSelection(
  env: Env,
  ctx: SandboxSelectionContext = {},
): Promise<ResolvedSandboxSelection> {
  const tryId = (raw: string | undefined, source: ResolvedSandboxSelection["source"], orgSettings?: OrgSandboxSettings) => {
    if (!raw?.trim()) return null;
    const providerId = parseSandboxProviderId(raw.trim());
    return { providerId, source, ...(orgSettings ? { orgSettings } : {}) };
  };

  const fromTask = tryId(ctx.taskProviderId, "task");
  if (fromTask) return fromTask;

  const fromAgent = tryId(ctx.customAgentProviderId, "custom_agent");
  if (fromAgent) return fromAgent;

  if (ctx.orgId && env.AGENT_AUDIT) {
    const orgRow = await getOrgSandboxProvider(env, ctx.orgId);
    const fromOrg = tryId(orgRow?.providerId, "org", orgRow ?? undefined);
    if (fromOrg) return fromOrg;
  }

  const fromDeploy = tryId(env.SHIBA_SANDBOX_PROVIDER, "deployment");
  if (fromDeploy) return fromDeploy;

  return { providerId: "cloudflare", source: "deployment" };
}
