Treat the repository AGENTS.md (and CLAUDE.md tradeoffs) as binding constraints for every change.

1. Fetch and read AGENTS.md for the target repo before planning work.
2. Map the task to explicit invariants (credentials never in container, approval before sandbox, repo-scoped GitHub, etc.).
3. If the task conflicts with an invariant, stop and ask for a product/security decision — do not workaround in code.
4. Cite the relevant rule in review notes when you touch load-bearing paths.

This skill complements human review; it does not replace the review/activate gate on stored skills.
