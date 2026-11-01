import { z } from "zod";

const LIBRARY_SEED_BASE =
  "https://github.com/opentoolsorg/shiba/blob/main/apps/backend/src/skill-library/seeds";

export const librarySkillSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
  summary: z.string().min(1).max(500),
  instructions: z.string().min(1).max(16_000),
  sourceUrl: z.string().url().max(512),
  tags: z.array(z.string().min(1).max(40)).max(12),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});

export type LibrarySkill = z.infer<typeof librarySkillSchema>;

const RAW_LIBRARY: LibrarySkill[] = [
  {
    slug: "pr-review-checklist",
    name: "PR review checklist",
    summary: "Structured review pass for security, tests, and scope before you approve.",
    instructions: `When reviewing a pull request, work through this checklist in order:

1. Read the PR description and linked issue for intent and scope.
2. Scan the diff for security-sensitive paths (auth, egress, secrets, sandbox boundaries).
3. Confirm tests cover behavior changes; flag missing negative cases.
4. Check AGENTS.md and project conventions for tradeoffs that must not regress.
5. Leave actionable comments; summarize blockers vs nits in a final review note.

Do not approve until human-required gates (approval-gated sandbox, repo-scoped GitHub) remain intact.`,
    sourceUrl: `${LIBRARY_SEED_BASE}/pr-review-checklist.md`,
    tags: ["review", "github"],
    version: "1.0.0",
  },
  {
    slug: "write-tests-first",
    name: "Write tests first",
    summary: "Red/green workflow for bugfixes and new behavior before implementation lands.",
    instructions: `Before changing production code, add or extend tests that fail for the bug or missing behavior.

1. Reproduce the failure with the smallest test that proves the gap.
2. Implement the fix while keeping the test red/green cycle honest.
3. Prefer behavior assertions over implementation details.
4. Run the narrowest suite first, then the package gate relevant to the touched app.

Never weaken security or approval tests to make a change pass.`,
    sourceUrl: `${LIBRARY_SEED_BASE}/write-tests-first.md`,
    tags: ["testing", "quality"],
    version: "1.0.0",
  },
  {
    slug: "fix-ci-failure",
    name: "Fix CI failure",
    summary: "Triage failing workflows from the root error and verify locally when possible.",
    instructions: `When CI fails on a branch, diagnose from the failing job outward:

1. Open the latest failed workflow run and capture the first root error (not cascading noise).
2. Reproduce locally with the same command the workflow uses when possible.
3. Fix the underlying cause; avoid retry-only flakiness unless backed by a stabilization change.
4. Summarize what broke, what you changed, and how you verified before pushing.

If the failure is environmental or off-repo, say so explicitly instead of guessing.`,
    sourceUrl: `${LIBRARY_SEED_BASE}/fix-ci-failure.md`,
    tags: ["ci", "debugging"],
    version: "1.0.0",
  },
  {
    slug: "dependency-upgrade",
    name: "Dependency upgrade",
    summary: "Safe, reviewable dependency bumps with release notes and targeted verification.",
    instructions: `For dependency upgrades, optimize for safe, reviewable diffs:

1. Identify why the upgrade is needed (security advisory, compatibility, feature).
2. Upgrade one logical dependency group at a time when feasible.
3. Read upstream release notes; adjust lockfile and any pinned patches together.
4. Run typecheck, lint, and tests for affected packages.
5. Note breaking API changes in the PR description for reviewers.

Do not bump unrelated packages in the same commit unless required for resolution.`,
    sourceUrl: `${LIBRARY_SEED_BASE}/dependency-upgrade.md`,
    tags: ["dependencies", "maintenance"],
    version: "1.0.0",
  },
  {
    slug: "agents-md-conventions",
    name: "AGENTS.md conventions",
    summary: "Load repo AGENTS.md tradeoffs and refuse work that breaks invariants.",
    instructions: `Treat the repository AGENTS.md (and CLAUDE.md tradeoffs) as binding constraints for every change.

1. Fetch and read AGENTS.md for the target repo before planning work.
2. Map the task to explicit invariants (credentials never in container, approval before sandbox, repo-scoped GitHub, etc.).
3. If the task conflicts with an invariant, stop and ask for a product/security decision — do not workaround in code.
4. Cite the relevant rule in review notes when you touch load-bearing paths.

This skill complements human review; it does not replace the review/activate gate on stored skills.`,
    sourceUrl: `${LIBRARY_SEED_BASE}/agents-md-conventions.md`,
    tags: ["agents-md", "governance"],
    version: "1.0.0",
  },
];

export const SKILL_LIBRARY: LibrarySkill[] = z.array(librarySkillSchema).parse(RAW_LIBRARY);

const bySlug = new Map(SKILL_LIBRARY.map((skill) => [skill.slug, skill]));

export function getLibrarySkill(slug: string): LibrarySkill | undefined {
  return bySlug.get(slug);
}

export function listLibrarySkills(): LibrarySkill[] {
  return [...SKILL_LIBRARY];
}
