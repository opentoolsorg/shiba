import { z } from "zod";

/** Viktor-style domain buckets for the integrations directory. */
export const integrationDomainSchema = z.enum([
  "marketing",
  "sales",
  "ops",
  "revenue",
  "design",
  "pm",
]);
export type IntegrationDomain = z.infer<typeof integrationDomainSchema>;

export const integrationKindSchema = z.enum(["native", "mcp", "openconnector", "webhook"]);
export type IntegrationKind = z.infer<typeof integrationKindSchema>;

/**
 * Product-path readiness for a catalog row — not live connection state.
 * Service mappings stay `catalog_only` until the deployment connects them.
 */
export const integrationCatalogPathStatusSchema = z.enum(["live", "catalog_only"]);
export type IntegrationCatalogPathStatus = z.infer<typeof integrationCatalogPathStatusSchema>;

export const integrationPrioritySchema = z.enum(["P0", "P1", "P2"]);
export type IntegrationPriority = z.infer<typeof integrationPrioritySchema>;

/** Maps a native catalog row to a dashboard binding read (setup status, mailboxes, Gmail, MCP servers). */
export const integrationNativeBindingSchema = z.enum([
  "github",
  "linear",
  "slack",
  "telegram",
  "discord",
  "mailbox",
  "gmail",
  "external_mcp",
  "generic_webhook",
]);
export type IntegrationNativeBinding = z.infer<typeof integrationNativeBindingSchema>;

export const integrationCatalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  domain: integrationDomainSchema,
  kind: integrationKindSchema,
  mcpUrl: z.string().url().optional(),
  docsUrl: z.string().url(),
  status: integrationCatalogPathStatusSchema,
  priority: integrationPrioritySchema,
  summary: z.string().min(1),
  nativeBinding: integrationNativeBindingSchema.optional(),
  /** Exact service IDs in pinned OpenConnector; mapping alone does not imply a live connection path. */
  openConnectorServiceIds: z.array(z.string().min(1)).min(1).optional(),
});

export type IntegrationCatalogEntry = z.infer<typeof integrationCatalogEntrySchema>;

export const integrationCatalogSchema = z.array(integrationCatalogEntrySchema).min(1);

/** Integration directory with open-connector service mappings and native Shiba channels. */
export const INTEGRATION_CATALOG: IntegrationCatalogEntry[] = integrationCatalogSchema.parse([
  // Marketing
  {
    id: "google-ads",
    openConnectorServiceIds: ["googleads"],
    name: "Google Ads",
    domain: "marketing",
    kind: "openconnector",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P0",
    summary: "Google Ads via open-connector when the service is available and connected.",
  },
  {
    id: "meta-ads",
    openConnectorServiceIds: ["meta"],
    name: "Meta Ads",
    domain: "marketing",
    kind: "openconnector",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P0",
    summary: "Meta Ads via open-connector when the service is available and connected.",
  },
  {
    id: "x-twitter",
    openConnectorServiceIds: ["twitter"],
    name: "X / Twitter",
    domain: "marketing",
    kind: "openconnector",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P1",
    summary: "X / Twitter via open-connector when the service is available and connected.",
  },
  {
    id: "linkedin-instagram-youtube",
    name: "LinkedIn, Instagram, YouTube",
    domain: "marketing",
    kind: "openconnector",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P1",
    summary: "LinkedIn, Instagram, YouTube via open-connector when the service is available and connected.",
  },
  {
    id: "posthog",
    openConnectorServiceIds: ["posthog"],
    name: "PostHog",
    domain: "marketing",
    kind: "mcp",
    mcpUrl: "https://posthog.com/docs/model-context-protocol",
    docsUrl: "https://posthog.com/docs/model-context-protocol",
    status: "catalog_only",
    priority: "P1",
    summary: "PostHog via open-connector when the service is available and connected.",
  },
  {
    id: "webflow",
    openConnectorServiceIds: ["webflow"],
    name: "Webflow",
    domain: "marketing",
    kind: "mcp",
    docsUrl: "https://developers.webflow.com/",
    status: "catalog_only",
    priority: "P2",
    summary: "Webflow via open-connector when the service is available and connected.",
  },
  {
    id: "wix",
    name: "Wix",
    domain: "marketing",
    kind: "mcp",
    docsUrl: "https://dev.wix.com/docs/rest",
    status: "catalog_only",
    priority: "P2",
    summary: "Wix via open-connector when the service is available and connected.",
  },
  {
    id: "klaviyo-brevo",
    openConnectorServiceIds: ["klaviyo", "brevo"],
    name: "Klaviyo, Brevo",
    domain: "marketing",
    kind: "openconnector",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P2",
    summary: "Klaviyo, Brevo via open-connector when the service is available and connected.",
  },
  // Sales
  {
    id: "hubspot",
    openConnectorServiceIds: ["hubspot"],
    name: "HubSpot",
    domain: "sales",
    kind: "openconnector",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P0",
    summary: "HubSpot via open-connector when the service is available and connected.",
  },
  {
    id: "salesforce",
    openConnectorServiceIds: ["salesforce"],
    name: "Salesforce",
    domain: "sales",
    kind: "openconnector",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P1",
    summary: "Salesforce via open-connector when the service is available and connected.",
  },
  {
    id: "apollo",
    openConnectorServiceIds: ["apollo"],
    name: "Apollo",
    domain: "sales",
    kind: "openconnector",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P1",
    summary: "Apollo via open-connector when the service is available and connected.",
  },
  {
    id: "attio",
    openConnectorServiceIds: ["attio"],
    name: "Attio",
    domain: "sales",
    kind: "mcp",
    docsUrl: "https://attio.com/",
    status: "catalog_only",
    priority: "P2",
    summary: "Attio via open-connector when the service is available and connected.",
  },
  {
    id: "gong-zoominfo",
    name: "Gong, ZoomInfo",
    domain: "sales",
    kind: "openconnector",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P2",
    summary: "Gong, ZoomInfo via open-connector when the service is available and connected.",
  },
  {
    id: "gmail-calendar",
    name: "Gmail / Google Calendar",
    domain: "sales",
    kind: "openconnector",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "live",
    priority: "P0",
    summary: "Read-only Gmail in Shiba; Calendar requires a connected integration.",
    nativeBinding: "gmail",
  },
  // Operations
  {
    id: "slack",
    name: "Slack",
    domain: "ops",
    kind: "native",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "live",
    priority: "P0",
    summary: "Queue tasks and approve runs from Slack.",
    nativeBinding: "slack",
  },
  {
    id: "microsoft-teams",
    openConnectorServiceIds: ["microsoft_teams"],
    name: "Microsoft Teams",
    domain: "ops",
    kind: "native",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "catalog_only",
    priority: "P1",
    summary: "Microsoft Teams via open-connector when the service is available and connected.",
  },
  {
    id: "notion",
    openConnectorServiceIds: ["notion"],
    name: "Notion",
    domain: "ops",
    kind: "mcp",
    mcpUrl: "https://developers.notion.com/docs/mcp",
    docsUrl: "https://developers.notion.com/docs/mcp",
    status: "catalog_only",
    priority: "P0",
    summary: "Notion via open-connector when the service is available and connected.",
  },
  {
    id: "google-drive-docs-sheets",
    openConnectorServiceIds: ["googledrive", "googledocs", "googlesheets"],
    name: "Google Drive / Docs / Sheets",
    domain: "ops",
    kind: "openconnector",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P1",
    summary: "Google Drive / Docs / Sheets via open-connector when the service is available and connected.",
  },
  {
    id: "onedrive",
    name: "OneDrive",
    domain: "ops",
    kind: "openconnector",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "catalog_only",
    priority: "P2",
    summary: "OneDrive via open-connector when the service is available and connected.",
  },
  {
    id: "telegram",
    name: "Telegram",
    domain: "ops",
    kind: "native",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "live",
    priority: "P2",
    summary: "Bot webhook channel configured by the deployment operator.",
    nativeBinding: "telegram",
  },
  {
    id: "discord",
    name: "Discord",
    domain: "ops",
    kind: "native",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "live",
    priority: "P2",
    summary: "Discord bot channel configured by the deployment operator.",
    nativeBinding: "discord",
  },
  {
    id: "airtable",
    openConnectorServiceIds: ["airtable"],
    name: "Airtable",
    domain: "ops",
    kind: "mcp",
    docsUrl: "https://airtable.com/developers/web/api/introduction",
    status: "catalog_only",
    priority: "P2",
    summary: "Airtable via open-connector when the service is available and connected.",
  },
  {
    id: "granola-meetings",
    openConnectorServiceIds: ["granola"],
    name: "Granola / meetings",
    domain: "ops",
    kind: "openconnector",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P2",
    summary: "Granola / meetings via open-connector when the service is available and connected.",
  },
  {
    id: "shiba-mailbox",
    name: "Mailbox (inbound email)",
    domain: "ops",
    kind: "native",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "live",
    priority: "P0",
    summary: "Deployment mailboxes for inbound triage and drafts.",
    nativeBinding: "mailbox",
  },
  {
    id: "generic-webhook",
    name: "Inbound webhook",
    domain: "ops",
    kind: "webhook",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "live",
    priority: "P2",
    summary: "Signed HTTP ingress for automations; verified only at runtime.",
    nativeBinding: "generic_webhook",
  },
  {
    id: "external-mcp",
    name: "External MCP servers",
    domain: "ops",
    kind: "mcp",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "live",
    priority: "P0",
    summary: "Operator-registered remote MCP servers on Agents & MCP.",
    nativeBinding: "external_mcp",
  },
  // Revenue
  {
    id: "stripe",
    openConnectorServiceIds: ["stripe"],
    name: "Stripe",
    domain: "revenue",
    kind: "mcp",
    mcpUrl: "https://docs.stripe.com/mcp",
    docsUrl: "https://docs.stripe.com/mcp",
    status: "catalog_only",
    priority: "P0",
    summary: "Stripe via open-connector when the service is available and connected.",
  },
  {
    id: "square",
    openConnectorServiceIds: ["square"],
    name: "Square",
    domain: "revenue",
    kind: "mcp",
    docsUrl: "https://developer.squareup.com/",
    status: "catalog_only",
    priority: "P2",
    summary: "Square via open-connector when the service is available and connected.",
  },
  {
    id: "quickbooks",
    openConnectorServiceIds: ["quickbooks"],
    name: "QuickBooks",
    domain: "revenue",
    kind: "openconnector",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P1",
    summary: "QuickBooks via open-connector when the service is available and connected.",
  },
  {
    id: "stripe-hubspot-reconcile",
    name: "Stripe ↔ HubSpot reconcile",
    domain: "revenue",
    kind: "openconnector",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "catalog_only",
    priority: "P0",
    summary: "Stripe ↔ HubSpot reconcile via open-connector when the service is available and connected.",
  },
  // Design
  {
    id: "figma",
    openConnectorServiceIds: ["figma"],
    name: "Figma",
    domain: "design",
    kind: "mcp",
    mcpUrl: "https://www.figma.com/developers/api#dev-mode-mcp",
    docsUrl: "https://www.figma.com/developers/api#dev-mode-mcp",
    status: "catalog_only",
    priority: "P1",
    summary: "Figma via open-connector when the service is available and connected.",
  },
  {
    id: "fal-krea",
    name: "fal / Krea (image gen)",
    domain: "design",
    kind: "openconnector",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P2",
    summary: "fal / Krea (image gen) via open-connector when the service is available and connected.",
  },
  {
    id: "brand-kit-canvases",
    name: "Brand kit / Canvases",
    domain: "design",
    kind: "openconnector",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "catalog_only",
    priority: "P2",
    summary: "Brand kit / Canvases via open-connector when the service is available and connected.",
  },
  // Product / engineering
  {
    id: "github",
    name: "GitHub",
    domain: "pm",
    kind: "native",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "live",
    priority: "P0",
    summary: "Pull requests and repository webhooks.",
    nativeBinding: "github",
  },
  {
    id: "linear",
    name: "Linear",
    domain: "pm",
    kind: "native",
    docsUrl: "https://docs.tryshiba.dev/linear-agent-session/",
    status: "live",
    priority: "P0",
    summary: "Linear agent sessions for issue delegation.",
    nativeBinding: "linear",
  },
  {
    id: "jira-atlassian",
    openConnectorServiceIds: ["jira"],
    name: "Jira / Atlassian",
    domain: "pm",
    kind: "mcp",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P1",
    summary: "Jira / Atlassian via open-connector when the service is available and connected.",
  },
  {
    id: "sentry",
    openConnectorServiceIds: ["sentry"],
    name: "Sentry",
    domain: "pm",
    kind: "mcp",
    docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
    status: "catalog_only",
    priority: "P1",
    summary: "Sentry via open-connector when the service is available and connected.",
  },
  {
    id: "monday-clickup-asana",
    openConnectorServiceIds: ["monday", "clickup", "asana"],
    name: "monday, ClickUp, Asana",
    domain: "pm",
    kind: "openconnector",
    docsUrl: "https://github.com/oomol-lab/open-connector",
    status: "catalog_only",
    priority: "P2",
    summary: "monday, ClickUp, Asana via open-connector when the service is available and connected.",
  },
  {
    id: "gitlab",
    openConnectorServiceIds: ["gitlab"],
    name: "GitLab",
    domain: "pm",
    kind: "mcp",
    docsUrl: "https://docs.gitlab.com/",
    status: "catalog_only",
    priority: "P2",
    summary: "GitLab via open-connector when the service is available and connected.",
  },
]);

export type IntegrationCatalogTab = "recommended" | "needs_attention" | "connected" | "all";

export type IntegrationConnectionPhase =
  | "loading"
  | "catalog_only"
  | "not_set_up"
  | "partial"
  | "configured"
  | "available_via_deployment";

export type IntegrationConnectionSnapshot = Record<string, IntegrationConnectionPhase>;

export function integrationCatalogDomains(): IntegrationDomain[] {
  return integrationDomainSchema.options;
}

export function searchIntegrationCatalog(
  entries: IntegrationCatalogEntry[],
  query: string,
): IntegrationCatalogEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return entries;
  return entries.filter((entry) => {
    const haystack = `${entry.name} ${entry.summary} ${entry.domain} ${entry.kind}`.toLowerCase();
    return haystack.includes(normalized);
  });
}

export function filterIntegrationCatalogByDomain(
  entries: IntegrationCatalogEntry[],
  domain: IntegrationDomain | "all",
): IntegrationCatalogEntry[] {
  if (domain === "all") return entries;
  return entries.filter((entry) => entry.domain === domain);
}

export function integrationMatchesTab(
  entry: IntegrationCatalogEntry,
  tab: IntegrationCatalogTab,
  connection: IntegrationConnectionPhase,
): boolean {
  if (tab === "all") return true;
  if (tab === "recommended") return entry.priority === "P0";
  if (tab === "connected") {
    return connection === "configured" || connection === "available_via_deployment";
  }
  if (tab === "needs_attention") {
    if (entry.status === "catalog_only" && entry.priority === "P0") return true;
    if (entry.nativeBinding && (connection === "partial" || connection === "not_set_up")) return true;
    return false;
  }
  return true;
}

export function filterIntegrationCatalogView(
  entries: IntegrationCatalogEntry[],
  opts: {
    search: string;
    domain: IntegrationDomain | "all";
    tab: IntegrationCatalogTab;
    connections: IntegrationConnectionSnapshot;
  },
): IntegrationCatalogEntry[] {
  let result = searchIntegrationCatalog(entries, opts.search);
  result = filterIntegrationCatalogByDomain(result, opts.domain);
  return result.filter((entry) =>
    integrationMatchesTab(entry, opts.tab, opts.connections[entry.id] ?? "catalog_only"),
  );
}
