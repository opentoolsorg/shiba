When reviewing a pull request, work through this checklist in order:

1. Read the PR description and linked issue for intent and scope.
2. Scan the diff for security-sensitive paths (auth, egress, secrets, sandbox boundaries).
3. Confirm tests cover behavior changes; flag missing negative cases.
4. Check AGENTS.md and project conventions for tradeoffs that must not regress.
5. Leave actionable comments; summarize blockers vs nits in a final review note.

Do not approve until human-required gates (approval-gated sandbox, repo-scoped GitHub) remain intact.
