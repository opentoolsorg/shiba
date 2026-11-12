# UI handoff implementation checkpoint — 2026-11-12

Source: the user's “Part 4 — UI handoff for Shiba (agent dashboard)”. Base: PR #203, `131666f988b1864b331cdff9547ffdd49fcf855b`. This is a code/fixture checkpoint, not a production or live-provider end-to-end certification.

## Observed issues

| Issue | Implementation | Regression coverage |
| --- | --- | --- |
| Work opens legacy home; explicit tasks is overridden | Personal Work/Home opens `/tasks/`. `/work/` remains an explicit Board & timeline destination. Team Work remains team-scoped rather than entering the personal task inbox. Delayed first-run reads do not replace explicit routes. | `app.test.tsx`, `AppNavRail.test.tsx` |
| New bot form stays offscreen | Creation, template load/edit and starter selection scroll and focus the form. Keyboard look navigation does not steal focus. | `CustomAgentsView.test.tsx` |
| False empty Agents panel | Built-in Shiba remains visible even without threaded custom agents. | `AgentsPanel.test.tsx`, `work-agents.integration.test.tsx` |
| Session looks stalled | Router and auth share structural loading shell with one busy announcement; existing real timeout/retry remains authoritative. | `SessionPending.test.tsx`, app auth tests |
| Photo mascot and missing built-in picker | Built-in Shiba uses SVG mascot and appears as an explicit task agent. Sidebar/custom directory/task avatar identity uses stable record IDs. | `ShibaMark.test.tsx`, `AgentExperience.test.tsx`, `TaskComposer.test.tsx`, integration tests |
| Repository shorthand rejected | Accept `owner/repo` and canonical GitHub HTTPS URLs; reject foreign hosts, credentials, queries, fragments, and extra path segments. Normalize before API submission. Server validation remains authoritative. | `repository-input.test.ts`, `TaskComposer.test.tsx` |
| Missing setup only discovered after handoff | Composer checks the selected provider route, shows diagnostics next to the action, offers retry and Models. Local routes are explicitly unverified by cloud diagnostics. Unknown overrides defer to server validation with truthful copy. Duplicate clicks are locked while the promise is pending. | `task-readiness.test.ts`, `TasksHomeView.test.tsx`, `TaskComposer.test.tsx`, app integration tests |
| Landing CTA only self-hosting | Primary “Open the app” points to the Worker app's `/tasks/`; self-host guide is secondary. | Astro build and local link validation |

**Important:** ChatGPT subscriptions, opted-in Claude subscription routes and paired local Claude routes are not blanket-gated on `AI_GATEWAY_TOKEN`. This supersedes the handoff's simplified gateway example. No new credentials, live accounts, payments, merge, or production deployment are part of this change.

## Additional fixes

- Native modal command palette provides top-layer focus containment, Escape/backdrop/close dismissal and trigger focus restoration.
- Fur selection has roving tab stop, arrows, Home/End and labelled groups.
- Templates no longer reintroduce stale mascot presets.
- “In review” is not incorrectly labelled as an approval request.
- Review caught and corrected custom bot selection/profile leakage and Work handoff feedback visibility.

## Boundaries and remaining design recommendations

The handoff explicitly lists palette expansions, promise toasts, question/approval card redesign, remembered split panes and broader motion as follow-up once the loop is trustworthy. This checkpoint does not invent backend clarification events, durable streamed execution state, or a new diff protocol. Existing task opening and run approvals remain in place. A complete live-provider journey still requires authorized configured accounts and a browser-capable environment. Successful fixture tests are not evidence of a completed real agent run.

## Validation

See PR checkpoint report for exact final SHA and command results. Local package build, typecheck, import lint and docs verification are run against this checkout. UI fixture evidence must be labelled as fixture-only. No browser screenshot should be claimed when Chromium cannot launch.

## Added fix-brief scope

The later `fix-briefs.md` adds backend issues to the UI handoff. PR-8–15 map to the table above. PR-13 additionally accepts bare `github.com/owner/repo` in both handoff and Settings → Repositories. PR-11 explains slow identity checks after one second and offers a retry only where a real identity retry callback exists.

- PR-4: `/signin` and `/login`, including slash variants and HEAD, serve the dashboard shell.
- PR-5: oversized waitlist requests use a bounded 4KB buffer and do not await potentially never-settling stream cancellation before returning 400.
- PR-7: unmatched org API paths authenticate before 404; spaces/model-key/reason routes authenticate before missing-binding responses. Existing API-key and internal employee-token paths are preserved.
- PR-16 (routing portion): missing webhook secrets still fail closed with 503 but no public env-variable names; denied internal capability requests expose only generic denial. Regression tests cover guessed headers and encoded traversal. This does not claim live HMAC or replay testing.
- PR-1/3: signup admission runs before account lookup; closed-shop responses match for owner, case/padded variants and unknown email, including trailing-slash routes. Timeouts remain fail-closed with generic public copy. The authoritative bootstrap uniqueness and invitation creation hooks remain.
- PR-2: automation webhook IDs and missing/wrong header secrets share the same 401; nonexistent IDs perform a dummy comparison and query-string secrets remain unsupported.
- PR-6/16: public invitation policy omits configuration names, and disabled social callbacks return generic 404, including slash variants.

Verified UI checkpoint: 196 frontend test files / 1614 tests passed. Subsequent slow-session and repository-settings refinements passed their focused suites (37 and 24 tests). Backend waitlist suite passed 9 tests; routing/error suite passed 132 tests. Browser screenshot capture remains blocked by the available execution/browser security policies; no screenshot or live end-to-end success is asserted.

Final integrated package gate: 24 build/typecheck/import-lint tasks passed at concurrency 2. Auth/enrollment/automation/webhook focused suites: 75 tests passed. All four failing suites from the in-flight older backend run were rerun after corrections: 71 tests passed. Clean-base reproduction confirmed the local-artifact 400-vs-403 test mismatch and missing OAuth example placeholders existed at `131666f`; only test expectations and empty comments were changed, never runtime authorization. Full-suite completion and hosted CI status must be reported separately.
