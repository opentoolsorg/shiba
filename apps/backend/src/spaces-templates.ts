export type SpaceTemplateId = "blank" | "repo-maintenance" | "code-review";

export interface SpaceTemplateDefinition {
  id: SpaceTemplateId;
  label: string;
  description: string;
  skillSlugs: string[];
  /** Stub item only — automations stay disabled until a later slice wires creation. */
  automationDraftRef?: string;
}

export const SPACE_TEMPLATES: SpaceTemplateDefinition[] = [
  {
    id: "blank",
    label: "Blank",
    description: "Empty space — add skills, repos, and automations manually later.",
    skillSlugs: [],
  },
  {
    id: "repo-maintenance",
    label: "Repo maintenance",
    description: "CI fix + dependency skills and a weekly automation draft (not enabled).",
    skillSlugs: ["fix-ci-failure", "dependency-upgrade"],
    automationDraftRef: "template:repo-maintenance-weekly",
  },
  {
    id: "code-review",
    label: "Code review",
    description: "PR checklist and AGENTS.md convention skills for review-heavy work.",
    skillSlugs: ["pr-review-checklist", "agents-md-conventions"],
  },
];

const byId = new Map(SPACE_TEMPLATES.map((template) => [template.id, template]));

export function getSpaceTemplate(id: string): SpaceTemplateDefinition | undefined {
  return byId.get(id as SpaceTemplateId);
}

export function listSpaceTemplates(): SpaceTemplateDefinition[] {
  return [...SPACE_TEMPLATES];
}
