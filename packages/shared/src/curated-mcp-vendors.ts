import { z } from "zod";

/** Vendor-official remote MCP presets wired in PR B (OAuth + bearer fallback). */
export const curatedMcpVendorSchema = z.object({
  catalogId: z.string().min(1),
  name: z.string().min(1),
  endpoint: z.string().url(),
  trustedHost: z.string().min(1),
  docsUrl: z.string().url(),
  /** When set, RFC 9728 discovery starts at this origin (defaults to endpoint origin). */
  resourceOrigin: z.string().url().optional(),
  sensitiveToolPatterns: z.array(z.string()).default([]),
});

export type CuratedMcpVendor = z.infer<typeof curatedMcpVendorSchema>;

export const CURATED_MCP_VENDORS: CuratedMcpVendor[] = curatedMcpVendorSchema.array().parse([
  {
    catalogId: "stripe",
    name: "Stripe",
    endpoint: "https://mcp.stripe.com",
    trustedHost: "mcp.stripe.com",
    docsUrl: "https://docs.stripe.com/mcp",
    sensitiveToolPatterns: ["^create_", "^update_", "^cancel_", "^refund_", "^delete_"],
  },
  {
    catalogId: "notion",
    name: "Notion",
    endpoint: "https://mcp.notion.com/mcp",
    trustedHost: "mcp.notion.com",
    docsUrl: "https://developers.notion.com/docs/mcp",
    sensitiveToolPatterns: ["^create_", "^update_", "^delete_", "^archive_"],
  },
  {
    catalogId: "sentry",
    name: "Sentry",
    endpoint: "https://mcp.sentry.dev/mcp",
    trustedHost: "mcp.sentry.dev",
    docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
    sensitiveToolPatterns: ["^create_", "^update_", "^delete_", "^resolve_"],
  },
  {
    catalogId: "posthog",
    name: "PostHog",
    endpoint: "https://mcp.posthog.com/mcp",
    trustedHost: "mcp.posthog.com",
    docsUrl: "https://posthog.com/docs/model-context-protocol",
    sensitiveToolPatterns: ["^create_", "^delete_", "^update_"],
  },
  {
    catalogId: "figma",
    name: "Figma",
    endpoint: "https://mcp.figma.com/mcp",
    trustedHost: "mcp.figma.com",
    docsUrl: "https://www.figma.com/developers/api#dev-mode-mcp",
    sensitiveToolPatterns: ["^create_", "^update_", "^delete_"],
  },
  {
    catalogId: "jira-atlassian",
    name: "Atlassian",
    endpoint: "https://mcp.atlassian.com/mcp",
    trustedHost: "mcp.atlassian.com",
    docsUrl: "https://developer.atlassian.com/cloud/mcp/",
    sensitiveToolPatterns: ["^create_", "^update_", "^delete_", "^transition_"],
  },
]);

export function curatedMcpVendorByCatalogId(catalogId: string): CuratedMcpVendor | undefined {
  return CURATED_MCP_VENDORS.find((vendor) => vendor.catalogId === catalogId);
}

export function curatedMcpTrustedHosts(): string[] {
  return [...new Set(CURATED_MCP_VENDORS.map((vendor) => vendor.trustedHost))];
}

const compiledPatterns = new Map<string, RegExp[]>();

function patternsForVendor(catalogId: string): RegExp[] {
  let compiled = compiledPatterns.get(catalogId);
  if (compiled) return compiled;
  const vendor = curatedMcpVendorByCatalogId(catalogId);
  compiled = (vendor?.sensitiveToolPatterns ?? []).map((source) => new RegExp(source));
  compiledPatterns.set(catalogId, compiled);
  return compiled;
}

/** Suggested owner review effect for a discovered remote tool name. */
export function recommendedExternalMcpToolEffect(
  catalogId: string | null | undefined,
  remoteName: string,
): "read" | "approval_required" {
  if (!catalogId) return "read";
  return patternsForVendor(catalogId).some((pattern) => pattern.test(remoteName))
    ? "approval_required"
    : "read";
}

export type ExternalMcpVisibility = "private" | "workspace";
export type ExternalMcpAuthMode = "oauth" | "bearer_ref" | "none";
