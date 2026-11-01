/**
 * Viktor-style founder skill pack: installable library entries (draft on install)
 * with schedule, Slack digest, and integration requirements.
 */
import { z } from "zod";

export const founderSkillIdSchema = z.enum([
  "founder-weekly-ads-report",
  "founder-stripe-revenue-pulse",
  "founder-hubspot-stripe-reconcile",
  "founder-linear-triage",
  "founder-pr-digest",
  "founder-figma-ticket",
]);

export type FounderSkillId = z.infer<typeof founderSkillIdSchema>;

export interface FounderSkillLibraryEntry {
  id: FounderSkillId;
  name: string;
  description: string;
  author: string;
  schedule: { cron: string; timezone: string; label: string };
  integrationCatalogIds: readonly string[];
  requiresSensitiveApproval: boolean;
  workspaceName: string;
  expectedDeliverables: readonly string[];
  sourceUrl: string;
  instructions: string;
  automationPrompt: string;
  slackDigestTitle: string;
}

const LIBRARY: FounderSkillLibraryEntry[] = [
  {
    id: "founder-weekly-ads-report",
    name: "Weekly ads report (Meta + Google)",
    description: "Pull last-week spend, CPA, and ROAS from connected ad services and post a concise digest to Slack.",
    author: "Shiba",
    schedule: { cron: "0 9 * * 1", timezone: "America/Los_Angeles", label: "Mondays 09:00 PT" },
    integrationCatalogIds: ["google-ads", "meta-ads"],
    requiresSensitiveApproval: false,
    workspaceName: "Marketing metrics",
    expectedDeliverables: ["reports/weekly-ads.md"],
    sourceUrl: "https://github.com/opentoolsorg/shiba/blob/main/packages/shared/src/founder-skill-library.ts",
    instructions: [
      "Use authorized openconnector actions for Meta Ads and Google Ads.",
      "Summarize last calendar week: spend, conversions, CPA, ROAS, top campaigns.",
      "Write reports/weekly-ads.md with tables and week-over-week deltas.",
      "Never mutate ad accounts without an explicit human approval card.",
    ].join("\n"),
    automationPrompt:
      "Prepare the weekly paid ads report for leadership. Use the reviewed skill instructions and authorized integration data when present. Output reports/weekly-ads.md only.",
    slackDigestTitle: "Weekly ads pulse",
  },
  {
    id: "founder-stripe-revenue-pulse",
    name: "Stripe revenue pulse (MRR / churn)",
    description: "Daily Stripe metrics from connected accounts: MRR, net new, churn, and expansion — posted to Slack on cron.",
    author: "Shiba",
    schedule: { cron: "0 8 * * *", timezone: "America/Los_Angeles", label: "Daily 08:00 PT" },
    integrationCatalogIds: ["stripe"],
    requiresSensitiveApproval: false,
    workspaceName: "Revenue metrics",
    expectedDeliverables: ["reports/stripe-revenue-pulse.md"],
    sourceUrl: "https://github.com/opentoolsorg/shiba/blob/main/packages/shared/src/founder-skill-library.ts",
    instructions: [
      "Use authorized openconnector Stripe actions (read-only) for subscription and revenue metrics.",
      "Compute MRR, net new MRR, logo churn, and revenue churn for the last 30 days.",
      "Write reports/stripe-revenue-pulse.md with a short executive summary.",
    ].join("\n"),
    automationPrompt:
      "Prepare today's Stripe revenue pulse. Use authorized integration results when available. Output reports/stripe-revenue-pulse.md.",
    slackDigestTitle: "Stripe revenue pulse",
  },
  {
    id: "founder-hubspot-stripe-reconcile",
    name: "HubSpot ↔ Stripe reconcile",
    description: "Find paid Stripe customers missing HubSpot deals (or mismatched stages) via authorized integration actions.",
    author: "Shiba",
    schedule: { cron: "0 10 * * 2", timezone: "America/Los_Angeles", label: "Tuesdays 10:00 PT" },
    integrationCatalogIds: ["hubspot", "stripe"],
    requiresSensitiveApproval: true,
    workspaceName: "RevOps reconcile",
    expectedDeliverables: ["reports/hubspot-stripe-reconcile.md"],
    sourceUrl: "https://github.com/opentoolsorg/shiba/blob/main/packages/shared/src/founder-skill-library.ts",
    instructions: [
      "Use authorized openconnector HubSpot and Stripe actions (read-only).",
      "List Stripe customers with active subscriptions lacking an open HubSpot deal in the last 90 days.",
      "Propose CRM updates as text only — CRM writes require human approval.",
    ].join("\n"),
    automationPrompt:
      "Reconcile HubSpot deals against Stripe subscriptions. Output reports/hubspot-stripe-reconcile.md with actionable rows.",
    slackDigestTitle: "HubSpot ↔ Stripe reconcile",
  },
  {
    id: "founder-linear-triage",
    name: "Linear triage digest",
    description: "Summarize urgent Linear issues for the week; uses Shiba's native Linear binding when connected.",
    author: "Shiba",
    schedule: { cron: "0 9 * * 1", timezone: "UTC", label: "Mondays 09:00 UTC" },
    integrationCatalogIds: ["linear"],
    requiresSensitiveApproval: false,
    workspaceName: "Linear triage",
    expectedDeliverables: ["reports/linear-triage.md"],
    sourceUrl: "https://github.com/opentoolsorg/shiba/blob/main/packages/shared/src/founder-skill-library.ts",
    instructions: [
      "Prioritize Linear issues labeled urgent or blocking.",
      "Group by team; include assignee, age, and customer impact.",
      "Do not change issue state without approval.",
    ].join("\n"),
    automationPrompt: "Produce the weekly Linear triage digest as reports/linear-triage.md.",
    slackDigestTitle: "Linear triage",
  },
  {
    id: "founder-pr-digest",
    name: "PR digest",
    description: "Weekly open-PR summary from GitHub (native) with risk notes for founders.",
    author: "Shiba",
    schedule: { cron: "0 16 * * 5", timezone: "UTC", label: "Fridays 16:00 UTC" },
    integrationCatalogIds: ["github"],
    requiresSensitiveApproval: false,
    workspaceName: "Engineering digest",
    expectedDeliverables: ["reports/pr-digest.md"],
    sourceUrl: "https://github.com/opentoolsorg/shiba/blob/main/packages/shared/src/founder-skill-library.ts",
    instructions: [
      "Summarize open pull requests: age, author, checks, review state.",
      "Flag stale PRs (>7d) and those touching auth/billing paths.",
    ].join("\n"),
    automationPrompt: "Write the weekly PR digest to reports/pr-digest.md for leadership review.",
    slackDigestTitle: "PR digest",
  },
  {
    id: "founder-figma-ticket",
    name: "Figma → ticket",
    description: "Turn flagged Figma comments into Linear/Jira-ready ticket drafts via authorized integration actions.",
    author: "Shiba",
    schedule: { cron: "0 11 * * 3", timezone: "America/Los_Angeles", label: "Wednesdays 11:00 PT" },
    integrationCatalogIds: ["figma", "linear"],
    requiresSensitiveApproval: false,
    workspaceName: "Design handoff",
    expectedDeliverables: ["reports/figma-tickets.md"],
    sourceUrl: "https://github.com/opentoolsorg/shiba/blob/main/packages/shared/src/founder-skill-library.ts",
    instructions: [
      "Collect unresolved Figma comments from the linked file(s).",
      "Draft ticket titles, acceptance criteria, and priority — do not create tickets without approval.",
    ].join("\n"),
    automationPrompt: "Draft tickets from Figma comments into reports/figma-tickets.md.",
    slackDigestTitle: "Figma → ticket",
  },
];

export function listFounderSkillLibrary(): readonly FounderSkillLibraryEntry[] {
  return LIBRARY;
}

export function getFounderSkillLibraryEntry(id: string): FounderSkillLibraryEntry | null {
  const parsed = founderSkillIdSchema.safeParse(id);
  if (!parsed.success) return null;
  return LIBRARY.find((entry) => entry.id === parsed.data) ?? null;
}

export function founderSkillAutomationId(id: FounderSkillId): string {
  return id;
}
