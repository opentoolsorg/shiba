import { integrationLogos } from "./integration-logos.js";
import type { IntegrationProviderCatalogItem } from "./integrations-provider.js";

export type FeaturedIntegrationAuthKind = "oauth" | "api-key";

type FeaturedSeed = {
  id: string;
  name: string;
  category: string;
  description: string;
  authKind: FeaturedIntegrationAuthKind;
  /** Service id in OpenConnector; live provider rows are matched on it. */
  openConnectorProviderId: string;
  scopesSummary: string;
};

const SEEDS: FeaturedSeed[] = [
  { id: "stripe", name: "Stripe", category: "Revenue", description: "Read payments, invoices and subscriptions.", authKind: "api-key", openConnectorProviderId: "stripe", scopesSummary: "Read-only access to payments, invoices and customers." },
  { id: "hubspot", name: "HubSpot", category: "Sales", description: "Read contacts, companies and deals.", authKind: "oauth", openConnectorProviderId: "hubspot", scopesSummary: "CRM contacts, companies and deals." },
  { id: "google-ads", name: "Google Ads", category: "Marketing", description: "Read campaign spend and performance.", authKind: "oauth", openConnectorProviderId: "googleads", scopesSummary: "Campaign and ad group reporting." },
  { id: "meta-ads", name: "Meta Ads", category: "Marketing", description: "Read ad account spend and results.", authKind: "oauth", openConnectorProviderId: "meta", scopesSummary: "Ad account insights and campaigns." },
  { id: "notion", name: "Notion", category: "Docs", description: "Search and read pages and databases.", authKind: "oauth", openConnectorProviderId: "notion", scopesSummary: "Pages and databases you share with the app." },
  { id: "gmail", name: "Gmail", category: "Email", description: "Read and draft email.", authKind: "oauth", openConnectorProviderId: "gmail", scopesSummary: "Mailbox read access and drafts; sends need approval." },
  { id: "google-calendar", name: "Google Calendar", category: "Calendar", description: "Read events and availability.", authKind: "oauth", openConnectorProviderId: "googlecalendar", scopesSummary: "Calendar events and free/busy." },
  { id: "slack", name: "Slack", category: "Chat", description: "Read channels and post messages.", authKind: "oauth", openConnectorProviderId: "slack", scopesSummary: "Channel history and message posting." },
  { id: "google-drive", name: "Google Drive", category: "Files", description: "Find, read and organize shared files.", authKind: "oauth", openConnectorProviderId: "googledrive", scopesSummary: "Files and folders the account can open; changes need approval." },
  { id: "outlook", name: "Outlook", category: "Email", description: "Read and draft Outlook email.", authKind: "oauth", openConnectorProviderId: "outlook", scopesSummary: "Mailbox read access and drafts; sends need approval." },
  { id: "github", name: "GitHub", category: "Code", description: "Read repositories, issues and pull requests.", authKind: "oauth", openConnectorProviderId: "github", scopesSummary: "Repository, issue and pull request access." },
];

export type FeaturedIntegration = FeaturedSeed & {
  /** Logo path when a shipped asset exists; clients fall back to a letter avatar. */
  logo: string | null;
};

export const FEATURED_INTEGRATIONS: readonly FeaturedIntegration[] = SEEDS.map((seed) => ({
  ...seed,
  logo: integrationLogos(seed.id)[0]?.src ?? null,
}));

export const INTEGRATION_SETUP_GUIDE = {
  title: "Set up integrations",
  steps: [
    "Deploy the OpenConnector worker, or set OPEN_CONNECTOR_URL to an existing one.",
    "Add its admin and runtime tokens as secrets (OPEN_CONNECTOR_ADMIN_TOKEN, OPEN_CONNECTOR_RUNTIME_TOKEN).",
    "Reload this page.",
  ],
  docsUrl: "/docs/integrations-setup/",
} as const;

/** Catalog row that fits the provider item schema plus the featured fields. */
export type FeaturedCatalogItem = IntegrationProviderCatalogItem & {
  category: string;
  authKind: FeaturedIntegrationAuthKind;
  openConnectorProviderId: string;
  scopesSummary: string;
  logo: string | null;
  available: boolean;
  reason?: "setup_required" | "not_offered";
};

function baseItem(entry: FeaturedIntegration): FeaturedCatalogItem {
  return {
    id: entry.id,
    providerKey: entry.openConnectorProviderId,
    name: entry.name,
    description: entry.description,
    isConnected: false,
    source: "static",
    connectable: false,
    category: entry.category,
    authKind: entry.authKind,
    openConnectorProviderId: entry.openConnectorProviderId,
    scopesSummary: entry.scopesSummary,
    logo: entry.logo,
    available: false,
  };
}

/** Featured apps for an unconfigured provider: every row is flagged as needing setup. */
export function featuredSetupItems(query?: string, serviceIds?: readonly string[]): FeaturedCatalogItem[] {
  const needle = query?.trim().toLowerCase();
  return FEATURED_INTEGRATIONS
    .filter((entry) => !serviceIds || serviceIds.includes(entry.openConnectorProviderId))
    .filter((entry) => !needle || `${entry.name} ${entry.id} ${entry.category}`.toLowerCase().includes(needle))
    .map((entry) => ({ ...baseItem(entry), reason: "setup_required" as const }));
}

/** Merge live provider rows into the featured list by OpenConnector provider id. */
export function mergeFeaturedWithLive(live: readonly IntegrationProviderCatalogItem[]): FeaturedCatalogItem[] {
  const byKey = new Map(live.map((item) => [item.providerKey, item]));
  return FEATURED_INTEGRATIONS.map((entry) => {
    const base = baseItem(entry);
    const found = byKey.get(entry.openConnectorProviderId);
    if (!found) return { ...base, reason: "not_offered" as const };
    return { ...base, ...found, id: entry.id, category: base.category, authKind: base.authKind, openConnectorProviderId: base.openConnectorProviderId,
      scopesSummary: base.scopesSummary, logo: found.logoUrl ?? base.logo, available: true };
  });
}

/** Body of a catalog read when OpenConnector is not bound. */
export function setupRequiredCatalog(query?: string, serviceIds?: readonly string[]) {
  const items = featuredSetupItems(query, serviceIds);
  return {
    ok: true as const,
    provider: "openconnector" as const,
    configured: false as const,
    setup: INTEGRATION_SETUP_GUIDE,
    items,
    nextCursor: null,
    hasMore: false,
    fallbackCatalog: true,
    total: items.length,
  };
}
