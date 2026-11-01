For dependency upgrades, optimize for safe, reviewable diffs:

1. Identify why the upgrade is needed (security advisory, compatibility, feature).
2. Upgrade one logical dependency group at a time when feasible.
3. Read upstream release notes; adjust lockfile and any pinned patches together.
4. Run typecheck, lint, and tests for affected packages.
5. Note breaking API changes in the PR description for reviewers.

Do not bump unrelated packages in the same commit unless required for resolution.
