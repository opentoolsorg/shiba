import { z } from "zod";

/** Vendor-documented remote presets; inclusion is not live compatibility verification. */
export const curatedMcpVendorSchema = z.object({
  catalogId: z.string().min(1),
  name: z.string().min(1),
  endpoint: z.string().url(),
  trustedHost: z.string().min(1),
  docsUrl: z.string().url(),
  /** Methods implemented by Shiba for this preset, not every vendor auth option. */
  connectionMethods: z.array(z.enum(["oauth", "bearer"])).min(1),
  setupNotice: z.string().min(1),
  defaultToolEffect: z.enum(["read", "approval_required"]).default("read"),
  /** When set, RFC 9728 discovery starts at this origin (defaults to endpoint origin). */
  resourceOrigin: z.string().url().optional(),
  sensitiveToolPatterns: z.array(z.string()).default([]),
});

export type CuratedMcpVendor = z.infer<typeof curatedMcpVendorSchema>;

export const CURATED_MCP_VENDORS: CuratedMcpVendor[] = curatedMcpVendorSchema.array().parse([
  {
    catalogId: "stripe",
    connectionMethods: ["oauth", "bearer"],
    setupNotice: "Stripe OAuth requires a registered client. Bearer access uses a vendor-issued Agent API key with explicit permissions.",
    name: "Stripe",
    endpoint: "https://mcp.stripe.com",
    trustedHost: "mcp.stripe.com",
    docsUrl: "https://docs.stripe.com/mcp",
    sensitiveToolPatterns: ["^create_", "^update_", "^cancel_", "^refund_", "^delete_", "^stripe_api_write$", "^convert_currency$", "^send_money$", "^setup_recipient$", "^transfer_money$", "^atlas_company_formation$", "^send_stripe_feedback$"],
  },
  {
    catalogId: "notion",
    connectionMethods: ["oauth", "bearer"],
    setupNotice: "Notion OAuth requires a registered client. Owner-generated bearer MCP tokens require a Business or Enterprise workspace; guest access is unsupported.",
    name: "Notion",
    endpoint: "https://mcp.notion.com/mcp",
    trustedHost: "mcp.notion.com",
    docsUrl: "https://developers.notion.com/docs/mcp",
    sensitiveToolPatterns: ["^create_", "^update_", "^delete_", "^archive_"],
  },
  {
    catalogId: "sentry",
    connectionMethods: ["oauth"],
    setupNotice: "Sentry documents OAuth-only connections. A static bearer fallback is unavailable here.",
    name: "Sentry",
    endpoint: "https://mcp.sentry.dev/mcp",
    trustedHost: "mcp.sentry.dev",
    docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
    sensitiveToolPatterns: ["^create_", "^update_", "^delete_", "^resolve_"],
  },
  {
    catalogId: "posthog",
    connectionMethods: ["oauth", "bearer"],
    setupNotice: "Vendor account, permissions and deployment OAuth client configuration are required. Live account compatibility has not been verified.",
    name: "PostHog",
    endpoint: "https://mcp.posthog.com/mcp",
    trustedHost: "mcp.posthog.com",
    docsUrl: "https://posthog.com/docs/model-context-protocol",
    sensitiveToolPatterns: ["^create_", "^delete_", "^update_"],
  },
  {
    catalogId: "figma",
    connectionMethods: ["oauth"],
    setupNotice: "Figma restricts access to approved MCP clients. Shiba registration and live compatibility have not been verified.",
    name: "Figma",
    endpoint: "https://mcp.figma.com/mcp",
    trustedHost: "mcp.figma.com",
    docsUrl: "https://www.figma.com/developers/api#dev-mode-mcp",
    sensitiveToolPatterns: ["^create_", "^update_", "^delete_"],
  },
  {
    catalogId: "jira-atlassian",
    connectionMethods: ["oauth", "bearer"],
    setupNotice: "Vendor account, permissions and deployment OAuth client configuration are required. Live account compatibility has not been verified.",
    name: "Atlassian",
    endpoint: "https://mcp.atlassian.com/v2/mcp",
    trustedHost: "mcp.atlassian.com",
    docsUrl: "https://github.com/atlassian/atlassian-mcp-server",
    sensitiveToolPatterns: ["^create_", "^update_", "^delete_", "^transition_"],
  },
  {
    catalogId: "github-readonly",
    name: "GitHub (read-only)",
    endpoint: "https://api.githubcopilot.com/mcp/readonly",
    trustedHost: "api.githubcopilot.com",
    docsUrl: "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md",
    connectionMethods: ["bearer"],
    setupNotice: "Use a fine-grained GitHub personal access token limited to selected repositories and read permissions. This preset uses GitHub's read-only endpoint. GitHub OAuth client-secret flows are not supported here; live account compatibility has not been verified.",
    defaultToolEffect: "approval_required",
  },
  {
    catalogId: "linear-readonly",
    name: "Linear (read-only)",
    endpoint: "https://mcp.linear.app/mcp/readonly",
    trustedHost: "mcp.linear.app",
    docsUrl: "https://linear.app/docs/mcp",
    connectionMethods: ["bearer"],
    setupNotice: "Use a Linear API key with only Read permission and access limited to the intended teams. This preset uses Linear's read-only endpoint. Dynamic OAuth client registration is not supported here; live account compatibility has not been verified.",
    defaultToolEffect: "approval_required",
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
    : curatedMcpVendorByCatalogId(catalogId)?.defaultToolEffect ?? "read";
}

export type ExternalMcpVisibility = "private" | "workspace";
export type ExternalMcpAuthMode = "oauth" | "bearer_ref" | "none";
