/** Optional setup recipes. Installation creates draft instructions, never runtime authority. */
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
  /** Suggested cadence only; installation does not create a schedule. */
  schedule: { cron: string; timezone: string; label: string };
  integrationCatalogIds: readonly string[];
  /** Presentation metadata only. False never grants access, execution or delivery. */
  requiresSensitiveApproval: boolean;
  workspaceName: string;
  expectedDeliverables: readonly string[];
  sourceUrl: string;
  instructions: string;
  automationPrompt: string;
  /** Suggested title only; delivery needs a separately reviewed action. */
  slackDigestTitle: string;
}

const setupInstructions = (...goals: string[]): string => [
  "Setup recipe only. Installation adds draft instructions; it does not collect app data, compute metrics, install schedules or send Slack messages.",
  "Use only explicitly selected, currently authorized supplied data or stored app receipts. A catalog listing or connected badge does not prove a required operation or complete data.",
  "Keep missing, partial and unknown data labeled as such. Never invent results, replace missing values with zeros or present an evidence bundle as a complete business report.",
  "A template sensitivity label grants no authority. Do not connect accounts, invoke new app actions, approve actions, enable schedules or send messages from this recipe alone. Each needs its own current human authorization.",
  ...goals,
].join("\n");

const LIBRARY: FounderSkillLibraryEntry[] = [
  {
    id: "founder-weekly-ads-report",
    name: "Weekly ads report (Meta + Google)",
    description: "Setup recipe for a weekly ads evidence draft from supplied or separately authorized Meta and Google Ads results. Data collection, metric calculations and Slack delivery are not installed.",
    author: "Shiba",
    schedule: { cron: "0 9 * * 1", timezone: "America/Los_Angeles", label: "Mondays 09:00 PT" },
    integrationCatalogIds: ["google-ads", "meta-ads"],
    requiresSensitiveApproval: false,
    workspaceName: "Marketing metrics",
    expectedDeliverables: ["reports/weekly-ads.md"],
    sourceUrl: "https://github.com/opentoolsorg/shiba/blob/main/packages/shared/src/founder-skill-library.ts",
    instructions: setupInstructions(
      "Goal: draft a weekly ads comparison only when the selected evidence includes the required date ranges, spend, conversion data, currency and metric definitions.",
      "Do not calculate CPA, ROAS or week-over-week deltas from incomplete evidence. List available observations and missing inputs instead.",
      "Write a private reports/weekly-ads.md draft with source references and coverage limits. Do not post it to Slack or modify ad accounts.",
    ),
    automationPrompt:
      "Draft private reports/weekly-ads.md from explicitly selected authorized evidence only. Label missing inputs and coverage; do not collect data, infer unsupported metrics or deliver a digest.",
    slackDigestTitle: "Weekly ads pulse",
  },
  {
    id: "founder-stripe-revenue-pulse",
    name: "Stripe revenue pulse (MRR / churn)",
    description: "Setup recipe for a Stripe revenue evidence draft. Customer receipts alone cannot establish MRR or churn. Subscription data, validated metric definitions, recurring collection and Slack delivery need separate setup.",
    author: "Shiba",
    schedule: { cron: "0 8 * * *", timezone: "America/Los_Angeles", label: "Daily 08:00 PT" },
    integrationCatalogIds: ["stripe"],
    requiresSensitiveApproval: false,
    workspaceName: "Revenue metrics",
    expectedDeliverables: ["reports/stripe-revenue-pulse.md"],
    sourceUrl: "https://github.com/opentoolsorg/shiba/blob/main/packages/shared/src/founder-skill-library.ts",
    instructions: setupInstructions(
      "Goal: draft a Stripe revenue evidence report. Customer lists do not establish subscription state, MRR, net new MRR or churn.",
      "Keep those metrics unavailable unless complete subscription data and validated definitions for the relevant periods and currencies are explicitly supplied. Do not infer them from customer counts or a connected Stripe badge.",
      "Write a private reports/stripe-revenue-pulse.md draft that separates supported source observations from missing data. This recipe does not establish a supported subscription-read action or send a Slack digest.",
    ),
    automationPrompt:
      "Draft private reports/stripe-revenue-pulse.md from explicitly selected authorized evidence only. MRR and churn stay unavailable without complete subscription data and validated definitions; do not collect data or send a digest.",
    slackDigestTitle: "Stripe revenue pulse",
  },
  {
    id: "founder-hubspot-stripe-reconcile",
    name: "HubSpot ↔ Stripe reconcile",
    description: "Setup recipe for comparing selected HubSpot and Stripe evidence. Reconciliation needs complete records and explicit matching keys; data collection and CRM changes need separate authorization.",
    author: "Shiba",
    schedule: { cron: "0 10 * * 2", timezone: "America/Los_Angeles", label: "Tuesdays 10:00 PT" },
    integrationCatalogIds: ["hubspot", "stripe"],
    requiresSensitiveApproval: true,
    workspaceName: "RevOps reconcile",
    expectedDeliverables: ["reports/hubspot-stripe-reconcile.md"],
    sourceUrl: "https://github.com/opentoolsorg/shiba/blob/main/packages/shared/src/founder-skill-library.ts",
    instructions: setupInstructions(
      "Goal: compare supplied HubSpot deal and Stripe customer or subscription evidence using explicit stable matching keys and documented date ranges.",
      "Do not infer customer identity from display names or claim a missing deal from an incomplete result page. Label unmatched, partial and unavailable records separately.",
      "Write a private reports/hubspot-stripe-reconcile.md evidence draft. Proposed CRM changes remain text; no CRM update is authorized by this recipe.",
    ),
    automationPrompt:
      "Draft private reports/hubspot-stripe-reconcile.md from explicitly selected authorized evidence only. State missing records and matching keys; do not query accounts or update CRM data.",
    slackDigestTitle: "HubSpot ↔ Stripe reconcile",
  },
  {
    id: "founder-linear-triage",
    name: "Linear triage digest",
    description: "Setup recipe for a triage draft from selected Linear issue evidence. Collecting new issues and scheduled Slack delivery need separate setup.",
    author: "Shiba",
    schedule: { cron: "0 9 * * 1", timezone: "UTC", label: "Mondays 09:00 UTC" },
    integrationCatalogIds: ["linear"],
    requiresSensitiveApproval: false,
    workspaceName: "Linear triage",
    expectedDeliverables: ["reports/linear-triage.md"],
    sourceUrl: "https://github.com/opentoolsorg/shiba/blob/main/packages/shared/src/founder-skill-library.ts",
    instructions: setupInstructions(
      "Goal: draft a Linear triage digest from selected issue evidence. A native webhook event or acknowledgment is not proof of issue-query access.",
      "Report only supplied labels, teams, assignees, ages and customer impact. Keep missing priority or impact unknown rather than inventing it.",
      "Write a private reports/linear-triage.md draft with source references. Do not collect new issue data, change issue state or send a digest from this recipe alone.",
    ),
    automationPrompt: "Draft private reports/linear-triage.md from explicitly selected authorized issue evidence only. Label unknown fields; do not collect issues, change state or send a digest.",
    slackDigestTitle: "Linear triage",
  },
  {
    id: "founder-pr-digest",
    name: "PR digest",
    description: "Setup recipe for a PR evidence digest from supplied or separately authorized GitHub results. Complete PR data, risk analysis and recurring collection are not established by installing this template.",
    author: "Shiba",
    schedule: { cron: "0 16 * * 5", timezone: "UTC", label: "Fridays 16:00 UTC" },
    integrationCatalogIds: ["github"],
    requiresSensitiveApproval: false,
    workspaceName: "Engineering digest",
    expectedDeliverables: ["reports/pr-digest.md"],
    sourceUrl: "https://github.com/opentoolsorg/shiba/blob/main/packages/shared/src/founder-skill-library.ts",
    instructions: setupInstructions(
      "Goal: draft a PR digest using only the selected authorized PR evidence, including its observation time and coverage when available.",
      "Report age, author, checks and review state only when present. Do not infer changed-file risk, security impact or complete repository coverage without supporting evidence.",
      "Write a private reports/pr-digest.md draft. New GitHub reads, review comments, merges and publication require separate supported actions and authorization.",
    ),
    automationPrompt: "Draft private reports/pr-digest.md from explicitly selected authorized PR evidence only. State observation time and missing coverage; do not query repositories, infer unsupported risk or publish.",
    slackDigestTitle: "PR digest",
  },
  {
    id: "founder-figma-ticket",
    name: "Figma → ticket",
    description: "Setup recipe for ticket text drafts from supplied or separately authorized Figma comment evidence. Comment collection and Linear or Jira ticket creation are not installed.",
    author: "Shiba",
    schedule: { cron: "0 11 * * 3", timezone: "America/Los_Angeles", label: "Wednesdays 11:00 PT" },
    integrationCatalogIds: ["figma", "linear"],
    requiresSensitiveApproval: false,
    workspaceName: "Design handoff",
    expectedDeliverables: ["reports/figma-tickets.md"],
    sourceUrl: "https://github.com/opentoolsorg/shiba/blob/main/packages/shared/src/founder-skill-library.ts",
    instructions: setupInstructions(
      "Goal: draft ticket text from explicitly supplied Figma comment evidence with stable file and comment references.",
      "Draft titles and acceptance criteria only when requested, and label unsupported priority or missing design context. This recipe does not establish comment-query or ticket-creation operations.",
      "Write a private reports/figma-tickets.md draft. Creating or updating a Linear or Jira ticket requires a separately supported, reviewed human action.",
    ),
    automationPrompt: "Draft private reports/figma-tickets.md from explicitly selected authorized comment evidence only. Label missing context; do not query Figma or create or update tickets.",
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
