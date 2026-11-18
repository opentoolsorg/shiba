import { z } from "zod";

/** Curated browse shelves over the provider catalog; a shelf never implies setup or permission. */
export const integrationCollectionIdSchema = z.enum([
  "popular",
  "sales",
  "marketing",
  "finance",
  "projects",
  "developer",
  "meetings",
  "files",
]);
export type IntegrationCollectionId = z.infer<typeof integrationCollectionIdSchema>;

export interface IntegrationCollection {
  id: IntegrationCollectionId;
  title: string;
  description: string;
  /** Exact service IDs in pinned OpenConnector, in display order. */
  serviceIds: readonly string[];
}

export const INTEGRATION_COLLECTIONS: readonly IntegrationCollection[] = [
  { id: "popular", title: "Popular", description: "Apps most teams connect first.", serviceIds: ["gmail", "googlecalendar", "slack", "github", "notion", "linear", "googledrive", "outlook"] },
  { id: "sales", title: "Sales & CRM", description: "Customer records, deals and prospecting.", serviceIds: ["hubspot", "salesforce", "pipedrive", "attio", "close", "affinity", "apollo"] },
  { id: "marketing", title: "Marketing", description: "Ads, social posts, email campaigns and analytics.", serviceIds: ["googleads", "meta", "linkedin", "twitter", "youtube", "instagram", "klaviyo", "posthog"] },
  { id: "finance", title: "Payments & finance", description: "Payments, invoices, bookkeeping and online stores.", serviceIds: ["stripe", "quickbooks", "xero", "square", "shopify"] },
  { id: "projects", title: "Projects & tasks", description: "Plans, boards and task tracking.", serviceIds: ["asana", "jira", "linear", "monday", "clickup", "trello", "airtable", "notion"] },
  { id: "developer", title: "Developer tools", description: "Code, errors, hosting and databases.", serviceIds: ["github", "gitlab", "sentry", "linear", "vercel", "supabase"] },
  { id: "meetings", title: "Meetings & scheduling", description: "Calendars, bookings, calls and meeting notes.", serviceIds: ["googlecalendar", "outlook_calendar", "calendly", "cal", "zoom", "granola"] },
  { id: "files", title: "Docs & files", description: "Documents, spreadsheets and shared files.", serviceIds: ["googledrive", "googledocs", "googlesheets", "dropbox", "notion", "confluence"] },
];

/** Resolve a `collection` query value: undefined when absent, null when unknown. */
export function parseIntegrationCollection(raw: string | null | undefined): IntegrationCollection | undefined | null {
  if (!raw) return undefined;
  const parsed = integrationCollectionIdSchema.safeParse(raw);
  return parsed.success ? (INTEGRATION_COLLECTIONS.find((entry) => entry.id === parsed.data) ?? null) : null;
}
