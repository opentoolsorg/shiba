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
    sensitiveToolPatterns: ["^create_", "^update_", "^cancel_", "^refund_", "^delete_", "^stripe_api_write$", "^convert_currency$", "^send_money$", "^setup_recipient$", "^transfer_money$", "^atlas_company_formation$", "^send_stripe_feedback$"],
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
    endpoint: "https://mcp.atlassian.com/v2/mcp",
    trustedHost: "mcp.atlassian.com",
    docsUrl: "https://github.com/atlassian/atlassian-mcp-server",
    sensitiveToolPatterns: ["^create_", "^update_", "^delete_", "^transition_"],
  },
  {
    catalogId: "linear",
    name: "Linear",
    endpoint: "https://mcp.linear.app/mcp",
    trustedHost: "mcp.linear.app",
    docsUrl: "https://linear.app/docs/mcp",
    sensitiveToolPatterns: ["^create_", "^update_", "^delete_", "^save_"],
  },
  {
    catalogId: "github",
    name: "GitHub",
    endpoint: "https://api.githubcopilot.com/mcp/",
    trustedHost: "api.githubcopilot.com",
    docsUrl: "https://github.com/github/github-mcp-server",
    sensitiveToolPatterns: ["^create_", "^update_", "^delete_", "^merge_", "^push_", "^add_", "^request_", "^assign_", "^dismiss_", "^rerun_", "^cancel_", "^run_"],
  },
  {
    catalogId: "asana",
    name: "Asana",
    endpoint: "https://mcp.asana.com/v2/mcp",
    trustedHost: "mcp.asana.com",
    docsUrl: "https://developers.asana.com/docs/using-asanas-mcp-server",
    sensitiveToolPatterns: ["create", "update", "delete", "add_", "remove_"],
  },
  {
    catalogId: "intercom",
    name: "Intercom",
    endpoint: "https://mcp.intercom.com/mcp",
    trustedHost: "mcp.intercom.com",
    docsUrl: "https://developers.intercom.com/docs/guides/mcp",
    sensitiveToolPatterns: ["^create_", "^update_", "^delete_", "^reply_", "^close_"],
  },
  {
    catalogId: "vercel",
    name: "Vercel",
    endpoint: "https://mcp.vercel.com",
    trustedHost: "mcp.vercel.com",
    docsUrl: "https://vercel.com/docs/agent-resources/vercel-mcp",
    sensitiveToolPatterns: ["^deploy", "^create_", "^update_", "^delete_", "^buy_", "^purchase_", "^use_vercel_cli$"],
  },
  {
    catalogId: "supabase",
    name: "Supabase",
    endpoint: "https://mcp.supabase.com/mcp",
    trustedHost: "mcp.supabase.com",
    docsUrl: "https://supabase.com/docs/guides/ai-tools/mcp",
    sensitiveToolPatterns: ["^execute_sql$", "^apply_migration$", "^deploy_", "^create_", "^delete_", "^merge_", "^reset_", "^rebase_", "^pause_", "^restore_", "^confirm_cost$"],
  },
  {
    catalogId: "neon",
    name: "Neon",
    endpoint: "https://mcp.neon.tech/mcp",
    trustedHost: "mcp.neon.tech",
    docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
    sensitiveToolPatterns: ["^run_sql", "^create_", "^delete_", "^prepare_", "^complete_", "^reset_", "^provision_"],
  },
  {
    catalogId: "canva",
    name: "Canva",
    endpoint: "https://mcp.canva.com/mcp",
    trustedHost: "mcp.canva.com",
    docsUrl: "https://www.canva.dev/docs/mcp/",
    sensitiveToolPatterns: ["^generate-", "^create-", "^upload-", "^commit-", "^perform-", "^comment-", "^reply-", "^move-", "^resize-", "^import-"],
  },
  {
    catalogId: "hubspot",
    name: "HubSpot",
    endpoint: "https://mcp.hubspot.com",
    trustedHost: "mcp.hubspot.com",
    docsUrl: "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
    sensitiveToolPatterns: ["create", "update", "delete", "manage_"],
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
