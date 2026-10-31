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

export const integrationKindSchema = z.enum(["native", "mcp", "grokbot-bridge", "webhook"]);
export type IntegrationKind = z.infer<typeof integrationKindSchema>;

/**
 * Product-path readiness for a catalog row — not live connection state.
 * Bridge and custom MCP rows stay `catalog_only` until PR B/C wire OAuth/runtime.
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
});

export type IntegrationCatalogEntry = z.infer<typeof integrationCatalogEntrySchema>;

export const integrationCatalogSchema = z.array(integrationCatalogEntrySchema).min(1);

/** Seeded from the 2026-11-01 Viktor + Grok Bot handover tables (+ Shiba-native webhook/MCP rows). */
export const INTEGRATION_CATALOG: IntegrationCatalogEntry[] = integrationCatalogSchema.parse([
  // Marketing
  {
    id: "google-ads",
    name: "Google Ads",
    domain: "marketing",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.x.ai/docs/guides/tools/search-plugins",
    status: "catalog_only",
    priority: "P0",
    summary: "Paid search reporting via Grok Bot Adspirer bridge (PR C).",
  },
  {
    id: "meta-ads",
    name: "Meta Ads",
    domain: "marketing",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.x.ai/docs/guides/tools/search-plugins",
    status: "catalog_only",
    priority: "P0",
    summary: "Meta campaign metrics via Grok Bot Adspirer bridge (PR C).",
  },
  {
    id: "x-twitter",
    name: "X / Twitter",
    domain: "marketing",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.x.ai/docs/guides/tools/x-api-mcp-guide",
    status: "catalog_only",
    priority: "P1",
    summary: "Social posting and analytics via Grok Bot X tools.",
  },
  {
    id: "linkedin-instagram-youtube",
    name: "LinkedIn, Instagram, YouTube",
    domain: "marketing",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.x.ai/docs/guides/tools/search-plugins",
    status: "catalog_only",
    priority: "P1",
    summary: "Bulk social publishing via Grok Bot BulkPublish bridge.",
  },
  {
    id: "posthog",
    name: "PostHog",
    domain: "marketing",
    kind: "mcp",
    mcpUrl: "https://posthog.com/docs/model-context-protocol",
    docsUrl: "https://posthog.com/docs/model-context-protocol",
    status: "catalog_only",
    priority: "P1",
    summary: "Product analytics via PostHog official MCP (custom OAuth in PR B).",
  },
  {
    id: "webflow",
    name: "Webflow",
    domain: "marketing",
    kind: "mcp",
    docsUrl: "https://developers.webflow.com/",
    status: "catalog_only",
    priority: "P2",
    summary: "Marketing site updates via vendor MCP when registered in PR B.",
  },
  {
    id: "wix",
    name: "Wix",
    domain: "marketing",
    kind: "mcp",
    docsUrl: "https://dev.wix.com/docs/rest",
    status: "catalog_only",
    priority: "P2",
    summary: "Site content via custom MCP registration (PR B).",
  },
  {
    id: "klaviyo-brevo",
    name: "Klaviyo, Brevo",
    domain: "marketing",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.x.ai/docs/guides/tools/search-plugins",
    status: "catalog_only",
    priority: "P2",
    summary: "Lifecycle email platforms via Grok Bot marketplace connectors.",
  },
  // Sales
  {
    id: "hubspot",
    name: "HubSpot",
    domain: "sales",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.x.ai/docs/guides/tools/search-plugins",
    status: "catalog_only",
    priority: "P0",
    summary: "CRM actions via Grok Bot HubSpot plugin (bridge runtime PR C).",
  },
  {
    id: "salesforce",
    name: "Salesforce",
    domain: "sales",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.x.ai/docs/guides/tools/search-plugins",
    status: "catalog_only",
    priority: "P1",
    summary: "Salesforce objects via Grok Bot marketplace connector.",
  },
  {
    id: "apollo",
    name: "Apollo",
    domain: "sales",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.x.ai/docs/guides/tools/search-plugins",
    status: "catalog_only",
    priority: "P1",
    summary: "Prospecting data via Grok Bot Apollo connector.",
  },
  {
    id: "attio",
    name: "Attio",
    domain: "sales",
    kind: "mcp",
    docsUrl: "https://attio.com/",
    status: "catalog_only",
    priority: "P2",
    summary: "Attio CRM via custom MCP URL (OAuth pairing PR B).",
  },
  {
    id: "gong-zoominfo",
    name: "Gong, ZoomInfo",
    domain: "sales",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.x.ai/docs/guides/tools/search-plugins",
    status: "catalog_only",
    priority: "P2",
    summary: "Conversation intelligence via Grok Bot connectors.",
  },
  {
    id: "gmail-calendar",
    name: "Gmail / Google Calendar",
    domain: "sales",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "live",
    priority: "P0",
    summary: "Read-only Gmail in Shiba today; Calendar via Grok Bot bridge later.",
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
    name: "Microsoft Teams",
    domain: "ops",
    kind: "native",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "catalog_only",
    priority: "P1",
    summary: "Teams chat surface planned; not wired on main yet.",
  },
  {
    id: "notion",
    name: "Notion",
    domain: "ops",
    kind: "mcp",
    mcpUrl: "https://developers.notion.com/docs/mcp",
    docsUrl: "https://developers.notion.com/docs/mcp",
    status: "catalog_only",
    priority: "P0",
    summary: "Notion official MCP with OAuth pairing (PR B).",
  },
  {
    id: "google-drive-docs-sheets",
    name: "Google Drive / Docs / Sheets",
    domain: "ops",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.x.ai/docs/guides/tools/google-docs",
    status: "catalog_only",
    priority: "P1",
    summary: "Google workspace docs via Grok Bot Google-docs connector.",
  },
  {
    id: "onedrive",
    name: "OneDrive",
    domain: "ops",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "catalog_only",
    priority: "P2",
    summary: "Microsoft files via Grok Bot bridge when enabled.",
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
    name: "Airtable",
    domain: "ops",
    kind: "mcp",
    docsUrl: "https://airtable.com/developers/web/api/introduction",
    status: "catalog_only",
    priority: "P2",
    summary: "Airtable bases via custom MCP registration (PR B).",
  },
  {
    id: "granola-meetings",
    name: "Granola / meetings",
    domain: "ops",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.x.ai/docs/guides/tools/search-plugins",
    status: "catalog_only",
    priority: "P2",
    summary: "Meeting notes via Grok Bot Granola connector (needsAuth in Grok Bot).",
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
    name: "Stripe",
    domain: "revenue",
    kind: "mcp",
    mcpUrl: "https://docs.stripe.com/mcp",
    docsUrl: "https://docs.stripe.com/mcp",
    status: "catalog_only",
    priority: "P0",
    summary: "Stripe official MCP + Grok Bot bridge; multi-account in PR B.",
  },
  {
    id: "square",
    name: "Square",
    domain: "revenue",
    kind: "mcp",
    docsUrl: "https://developer.squareup.com/",
    status: "catalog_only",
    priority: "P2",
    summary: "Square payments via custom MCP (PR B).",
  },
  {
    id: "quickbooks",
    name: "QuickBooks",
    domain: "revenue",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.x.ai/docs/guides/tools/search-plugins",
    status: "catalog_only",
    priority: "P1",
    summary: "Books data via Grok Bot QuickBooks connector.",
  },
  {
    id: "stripe-hubspot-reconcile",
    name: "Stripe ↔ HubSpot reconcile",
    domain: "revenue",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "catalog_only",
    priority: "P0",
    summary: "Founder skill on top of bridge connectors (PR C skill pack).",
  },
  // Design
  {
    id: "figma",
    name: "Figma",
    domain: "design",
    kind: "mcp",
    mcpUrl: "https://www.figma.com/developers/api#dev-mode-mcp",
    docsUrl: "https://www.figma.com/developers/api#dev-mode-mcp",
    status: "catalog_only",
    priority: "P1",
    summary: "Figma Dev Mode MCP with OAuth pairing (PR B).",
  },
  {
    id: "fal-krea",
    name: "fal / Krea (image gen)",
    domain: "design",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.x.ai/docs/guides/tools/search-plugins",
    status: "catalog_only",
    priority: "P2",
    summary: "Image generation via Grok Bot fal/Krea plugins.",
  },
  {
    id: "brand-kit-canvases",
    name: "Brand kit / Canvases",
    domain: "design",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.tryshiba.dev/",
    status: "catalog_only",
    priority: "P2",
    summary: "Viktor-style brand surfaces map to Shiba Spaces (later slice).",
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
    name: "Jira / Atlassian",
    domain: "pm",
    kind: "mcp",
    docsUrl: "https://docs.x.ai/docs/guides/tools/search-plugins",
    status: "catalog_only",
    priority: "P1",
    summary: "Atlassian MCP via Grok Bot or custom OAuth (PR B).",
  },
  {
    id: "sentry",
    name: "Sentry",
    domain: "pm",
    kind: "mcp",
    docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
    status: "catalog_only",
    priority: "P1",
    summary: "Sentry official MCP (custom OAuth PR B).",
  },
  {
    id: "monday-clickup-asana",
    name: "monday, ClickUp, Asana",
    domain: "pm",
    kind: "grokbot-bridge",
    docsUrl: "https://docs.x.ai/docs/guides/tools/search-plugins",
    status: "catalog_only",
    priority: "P2",
    summary: "Work management tools via Grok Bot marketplace.",
  },
  {
    id: "gitlab",
    name: "GitLab",
    domain: "pm",
    kind: "mcp",
    docsUrl: "https://docs.gitlab.com/",
    status: "catalog_only",
    priority: "P2",
    summary: "GitLab via custom MCP registration (PR B).",
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
