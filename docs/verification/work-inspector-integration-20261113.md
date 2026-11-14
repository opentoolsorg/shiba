# Work inspector integration — November 13, 2026

This slice starts from origin/main `f363e798` and changes Work components and their tests. It preserves the existing shell, routes, app state, backend, auth, approval handlers, and workspace task editor.

## Result

Personal List, Board, Timeline, and Work sidebar items open a modal Work inspector in place. The full thread/approval queue remains reachable through an explicit action using the existing `onSelectTask` callback. A selected item is encoded as `task`, `taskKind`, and `tab`; `view` remains the existing layout parameter. The parser and serializer preserve unrelated parameters and URL fragments. Task-kind qualification prevents an approval, run, and session with the same id from opening each other's content. Browser back/forward restores layout, selection, and inspector tab. Initial rendering does not read browser URL state.

Workspace task details retain the existing editor and mutations, wrapped in the same native modal boundary. Close receives initial focus; the background is inert; Escape, cancellation, backdrop dismissal, Tab containment, and focus restoration are supported.

Personal execution columns retain the underlying state: ready threads, queued/pending runs, running work, pending approvals, attention, PR links, and completed runs. A PR URL is labeled “PR linked”; it establishes no merge, open/closed, or test result. Failure and cancellation stay out of completed. Workspace tasks retain their existing editable planning columns. Personal Timeline bars use recorded creation/update dates; undated requests remain undated. They represent activity dates, not scheduled duration or percentage progress.

## Minimal app integration (owned by the integrator)

`app.tsx`, shell, and route files were deliberately not edited.

Pass the existing handlers and session scope to `WorkView`:

```tsx
onDecideApproval={decideApproval}
onDecideStoredApproval={decideStoredApproval}
approvalDecisions={{ ...decisions, ...storedDecisions }}
peekSessionId={selectedSessionId}
peekNotice={notice}
```

These props mount the existing `ApprovalCard` and `StoredApprovalCard` with their original frozen inputs and callbacks. No new approval endpoint or action handler is implemented. If omitted, the inspector presents the frozen payload and existing full-review navigation, with no invented executable action. When session scope is supplied, run Steps also reuse `RunLivePanel` with that exact scope.

For rich retained Steps, Diff, and Output data, use the existing full-detail run load while inspecting Work (the current main loads full detail only for `mainView === "diff"`). The smallest integration is `mainView === "diff" || mainView === "work"` in the existing `useRetainedRuns` call. A future optimization can trigger full detail only while a run is selected. Summary rows are never represented as proof of an empty diff or successful tests.

`renderPeekContent(task, tab)` optionally embeds existing selected-thread content. Return the existing `StepTimeline` only when its messages belong to the selected task's exact session. Return `undefined` for the default retained signal/live panel, diff, and deliverable rendering. Do not change the active session, composer profile, or approval payload just to inspect a card. The existing explicit “Open full thread” callback still handles navigation to a different thread.

For router-owned search updates, pass `onSearchChange(state)`. The exported `parseWorkSearch` / `updateWorkSearch` helpers support validation and serialization. Parsing projects Work state only; keep the complete original query and serialize into it rather than replacing all route search fields with the parsed projection. For example:

```tsx
onSearchChange={(state) => {
  const query = updateWorkSearch(new URLSearchParams(window.location.search), state).toString();
  router.history.replace(`${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
}}
```

The standalone fallback preserves the existing Work `replaceState` behavior and the router's current history state. Keep canonical current single-segment view paths; this slice introduces no nested route or basepath.

## Verification

- Focused component/URL tests cover modal focus and restoration, keyboard tab navigation, exact frozen approval forwarding, recorded milestones, scoped live output, missing diff details, uncaptured outputs, browser history, preserved query/hash data, SSR-safe initial rendering, task-kind collisions, and workspace scope changes.
- Chromium component fixture (explicitly synthetic, no backend or vendor actions): native `:modal` confirmed; Close focused on open; Shift-Tab and Tab wrapped; Escape restored the exact opening card; URL selection removed while the board layout remained.
- Chromium at 1440 × 1000 and 390 × 844, with light/dark and reduced-motion checks: 390px page and dialog width, no horizontal page overflow, no page errors. This verifies the components, not live execution, vendor integrations, or backend authorization.
- All fixture source files were removed after verification. No backend run was approved or started.

Repository-wide check results are reported with the final branch handoff.

### Check results

- Repository type checks passed for all 11 packages, root project references, and SDK generated types. Astro telemetry and config cache were directed to the sandbox using `--env-mode=loose` and `/tmp`; the initial unadapted command failed trying to create `/home/agent/.config/astro`.
- Repository lint and import-boundary checks passed. Existing lint warnings remain.
- Full repository tests passed across all 10 test targets, including 6,235 backend tests (6 skipped) and the frontend suite. A subsequent complete frontend run passed 200 files / 1,697 tests.
- Final focused Work / approval / deliverable suite passed 8 files / 94 tests, including the final removed-trigger focus fallback. Final frontend type check and build passed.
- Production frontend/web/package builds, public assembly, docs verification, built-output tests, `check:ci`, and secret scan passed.
- `env:load` failed because required deployment environment values (including `CLOUDFLARE_ACCOUNT_ID`) are absent. No environment variables, secrets, deployment files, or backend files were changed to bypass that check.
- No live backend execution, vendor writes, merge, PR creation, or deployment was performed.
