import { validateEmployeeBundle, type EmployeeBundle, type FounderSkillLibraryEntry } from "@shiba/shared";

export const FOUNDER_SKILL_LIBRARY_VERSION = "1.0.0";

/** Portable setup prose only: preview/import still requires a separately reviewed human action. */
export function founderSkillSetup(entry: FounderSkillLibraryEntry): EmployeeBundle {
  return validateEmployeeBundle({
    format: "shiba.employee-bundle.v1",
    audience: "personal",
    profile: {
      name: entry.name,
      instructions: `${entry.instructions}\n\n${entry.automationPrompt}\n\nUse only explicitly supplied sources and currently authorized tools. If a required connection or action is unavailable, explain the missing setup or request supplied data. Never invent results. Prepare drafts for human review; do not connect accounts, approve actions, schedule work or publish a Slack digest yourself.`,
      harness: "opencode",
      expectedDeliverables: [...entry.expectedDeliverables],
      provenance: { kind: "catalog", id: entry.id, revision: FOUNDER_SKILL_LIBRARY_VERSION },
    },
    skills: [{ name: entry.name, instructions: entry.instructions,
      provenance: { kind: "catalog", id: entry.id, revision: FOUNDER_SKILL_LIBRARY_VERSION } }],
    requirements: entry.integrationCatalogIds.map((name) => ({
      kind: "app", name,
      description: "Required source recommendation. Catalog presence does not prove a supported or connected action.",
      configurationRequired: ["Verify supported connector actions", "Connect your own account or supply data manually", "Review exact resources and action grants"],
    })),
    routines: [{
      name: entry.slackDigestTitle,
      description: `${entry.schedule.label} (${entry.schedule.timezone}; ${entry.schedule.cron}). ${entry.automationPrompt}`,
      configurationRequired: ["Choose a supported schedule and timezone", "Review exact connected accounts and resources", "Choose a delivery destination", "Approve each external action as required"],
      enabled: false,
    }],
  });
}
