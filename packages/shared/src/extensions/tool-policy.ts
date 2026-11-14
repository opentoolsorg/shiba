import { z } from "zod";

export const toolPolicySchema = z.enum(["allow", "approval_required", "deny"]);
export type ToolPolicy = z.infer<typeof toolPolicySchema>;

export const policyDecisionSchema = toolPolicySchema;
export type PolicyDecision = ToolPolicy;

export const mcpToolCatalogEntrySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
});
export type McpToolCatalogEntry = z.infer<typeof mcpToolCatalogEntrySchema>;

/** Legacy reviewed effect labels stored alongside `policy` during transition. */
export type ExternalMcpLegacyEffect = "unreviewed" | "read" | "approval_required";

export function legacyEffectToToolPolicy(effect: ExternalMcpLegacyEffect): ToolPolicy {
  if (effect === "read") return "allow";
  if (effect === "approval_required") return "approval_required";
  return "deny";
}

export function toolPolicyToLegacyEffect(policy: ToolPolicy): ExternalMcpLegacyEffect {
  if (policy === "allow") return "read";
  if (policy === "approval_required") return "approval_required";
  return "unreviewed";
}
