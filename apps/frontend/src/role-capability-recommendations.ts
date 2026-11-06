import {
  INTEGRATION_CATALOG,
  type CustomAgentRoleTemplateId,
  type IntegrationProviderCatalogItem,
} from "@shiba/shared";

/** Discovery suggestions only. A role never installs an app or grants access. */
const ROLE_CAPABILITIES: Record<CustomAgentRoleTemplateId, {
  integrationIds: readonly string[];
  mcpCatalogIds: readonly string[];
}> = {
  qa: { integrationIds: ["github", "sentry", "jira-atlassian"], mcpCatalogIds: ["sentry", "jira-atlassian"] },
  engineering: { integrationIds: ["github", "linear", "sentry", "jira-atlassian", "slack"], mcpCatalogIds: ["sentry", "jira-atlassian", "notion"] },
  design: { integrationIds: ["figma", "notion", "google-drive-docs-sheets", "slack"], mcpCatalogIds: ["figma", "notion"] },
  marketing: { integrationIds: ["posthog", "google-ads", "meta-ads", "hubspot", "webflow", "gmail-calendar"], mcpCatalogIds: ["posthog", "notion", "figma"] },
  gtm: { integrationIds: ["hubspot", "salesforce", "posthog", "gmail-calendar", "slack"], mcpCatalogIds: ["posthog", "notion"] },
  sales: { integrationIds: ["hubspot", "salesforce", "apollo", "attio", "gmail-calendar"], mcpCatalogIds: ["notion"] },
  operations: { integrationIds: ["slack", "notion", "google-drive-docs-sheets", "airtable", "monday-clickup-asana"], mcpCatalogIds: ["notion", "jira-atlassian"] },
  hr: { integrationIds: ["notion", "google-drive-docs-sheets", "gmail-calendar", "slack"], mcpCatalogIds: ["notion"] },
  finance: { integrationIds: ["stripe", "quickbooks", "google-drive-docs-sheets", "gmail-calendar"], mcpCatalogIds: ["stripe", "notion"] },
  product: { integrationIds: ["linear", "posthog", "figma", "notion", "github"], mcpCatalogIds: ["posthog", "figma", "notion", "jira-atlassian"] },
  research: { integrationIds: ["notion", "google-drive-docs-sheets", "gmail-calendar"], mcpCatalogIds: ["notion"] },
};

export type CapabilityRoleFilter = CustomAgentRoleTemplateId | "all";

export function roleCapabilityRecommendations(role: CustomAgentRoleTemplateId) {
  return {
    ...ROLE_CAPABILITIES[role],
    setup: {
      appsHref: "/integrations/?tab=connectors",
      mcpHref: "/integrations/?tab=mcp",
      reviewHref: "/agents/",
      policyHref: "/employee-tools/",
      skillsHref: "/skills/",
    },
  } as const;
}

export function integrationRecommendedForRole(
  role: CapabilityRoleFilter,
  catalogId?: string,
  item?: IntegrationProviderCatalogItem,
): boolean {
  if (role === "all") return true;
  const recommended = ROLE_CAPABILITIES[role].integrationIds;
  if (catalogId && recommended.includes(catalogId)) return true;
  if (!item) return false;
  return INTEGRATION_CATALOG.some((entry) => recommended.includes(entry.id) &&
    (entry.id === item.id || entry.id === item.providerKey || entry.openConnectorServiceIds?.includes(item.providerKey)));
}
