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
