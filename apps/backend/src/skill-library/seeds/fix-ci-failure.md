When CI fails on a branch, diagnose from the failing job outward:

1. Open the latest failed workflow run and capture the first root error (not cascading noise).
2. Reproduce locally with the same command the workflow uses when possible.
3. Fix the underlying cause; avoid retry-only flakiness unless backed by a stabilization change.
4. Summarize what broke, what you changed, and how you verified before pushing.

If the failure is environmental or off-repo, say so explicitly instead of guessing.
