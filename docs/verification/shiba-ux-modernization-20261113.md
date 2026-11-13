# Shiba UX modernization verification — November 13, 2026

This is the integration record for `codex/shiba-ux-modernization`. It is a review
checkpoint, not a deployment or live-provider acceptance claim.

## Deployment and preservation contract

The fresh baseline is `f363e79825b6c1e481bf5a9dfa4b5f561d83d819` on
`origin/main`; it includes PRs #203 and #205. `origin` is
`https://github.com/opentoolsorg/shiba.git`, and its default branch is `main`.

The implementation follows the existing deployed route contract rather than
the illustrative nested paths in the attached brief. The TanStack router has
no basepath and uses trailing slashes; its generated SPA shell lives at
`/app/index.html`. The Worker recognizes the existing single-segment views.
Changing only the frontend to `/work/approvals/`, for example, would break
reloads. Backend and deployment definitions are outside this change.

All 23 existing view IDs must remain accessible:

| Area | Existing canonical paths |
| --- | --- |
| Work | `/work/`, `/tasks/`, `/approvals/`, `/diff/`, `/swarm/`, `/dashboard/` |
| Chat | `/threads/`, `/collaboration/` |
| Team | `/custom-agents/`, `/employee-tools/`, `/providers/`, `/skills/`, `/agents/`, `/team/` |
| Knowledge | `/memory/`, `/spaces/` |
| Settings | `/settings/`, `/inbox/`, `/automations/`, `/activity/`, `/analytics/`, `/remote/`, `/integrations/` |

Legacy `?tab=` and `?view=` entry links, `run-registry → analytics`,
`orchestrator → activity`, and `mailbox → inbox` remain supported. Run and
prompt links still select Threads. Room links keep their existing workspace
membership verification. Settings retains its `section` search parameter.
OAuth `next`, invitation fragments, bootstrap verification, and Slack Canvas
retain their dedicated existing handlers.

No approval payload may be edited in place. Completed, failed, unknown,
PR-open, and approval states must retain their actual meaning; a PR link is
not evidence of passed tests or a merge.

## Baseline results

| Check | Result |
| --- | --- |
| Frontend typecheck | PASS |
| Root typecheck | PASS with `TURBO_ENV_MODE=loose` and writable XDG cache/config directories |
| Root lint | PASS with existing warnings |
| Import lint | PASS, 7 tasks |
| `check:ci` | PASS with existing Biome/Knip findings |
| Root build | PASS; 99 HTML pages and 7,798 local links/assets/anchors verified |
| `test:built` | PASS, 2 files / 7 tests |
| Frontend suite | 197 files pass, 1 fails; 1,676 tests pass, 1 fails |
| Lease-expiry test alone | PASS, 1 test (45 excluded) |
| Added alias/Settings regression cases | PASS, 6 tests |

The frontend baseline failure is `CollaborationView.test.tsx > Slack draft room
review > hides the saved task preview when its review lease expires`. A later
app test run under concurrent checks also timed out finding the Research bot
thread button; this must not be presented as a green full suite.

Baseline frontend build output: `dist/client` is 7,273,243 bytes, with the
largest JavaScript chunk 2,294,778 bytes. This is a browser bundle measurement,
not a Durable Object memory measurement.

## Reproducing browser fixture checks

Install the repository dependencies and the pinned Playwright from
`.cursor/skills/verify-shiba/package.json` in an appropriate local tooling
directory, then run:

```sh
pnpm -C apps/frontend build
SHIBA_PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
  node scripts/verify-ux-fixtures.mjs --built
```

The harness runs real local Chromium against production dashboard bytes. It
intercepts every API and application socket, blocks unexpected mutations and
external HTTP requests, and writes per-check true/false results plus screenshots under
`.verify/ux-modernization/`. Activity and token-usage report endpoints explicitly
return fixture-unavailable errors; those checks prove route access and error
rendering, not report data correctness. The local static host does not replace
the Worker's route tests (`apps/backend/test/app-host-routing.test.ts`).

One deliberate queue check permits a canned fixture-only `POST /api/runs`,
records the exact request, and presents it through the existing approval card.
Its displayed frozen JSON must exactly match the recorded request. Only after
an explicit browser click does the harness accept a canned approval decision
and return a linked fixture run. Reload, Diff and Output inspect that fixture;
no Worker, model or sandbox executes. All other mutations fail closed.

The initial 11-check dev-browser baseline passes aliases, reloads, mobile
document width, and absence of unhandled/hydration errors. React's development
script-tag warning remains recorded; it is not silently called console-clean.
Expanded production-byte checks are recorded separately with their source SHA
and tracked-change status. A passing dirty-tree development run is not a final
combined-SHA validation result.

## Final integration

The following worker slices are integrated:

- Shell: `9886b103` plus its verification update `5f0710cd`. All five areas and
  23 flat destinations remain available. The two-line WorkLeftPanel adapter is
  retained. Three backend test files follow the relocated navigation metadata
  and labels; backend production code is unchanged.
- Work: `d1dd7add`. Personal execution statuses, native modal inspection, scoped
  workspace details, keyboard navigation, and typed Work URL state are included.
- Chat/team/Knowledge: `efe031f0`. Draft review, saved employee search and
  inspection, and Knowledge shortcuts retain the existing handlers.

Integration adapters pass the existing approval callbacks and decisions into
WorkPeek, scope live output and deliverables to the active session, load retained
details for Work, and embed StepTimeline only for the selected session with the
matching identified agent and registry owner. Other threads use the explicit
full-thread action. Work layout, selection and tab transitions use TanStack
history entries while preserving unrelated query parameters and fragments.

Integration also fixes two browser-observed problems: prompt URL cleanup now
runs after commit so render retries retain entry intent, and Knowledge section
navigation remains available below the desktop breakpoint or with its sidebar
collapsed. The draft review callback switches the existing composer to Work;
it does not synthesize a command, decide an approval, or start execution.

Preliminary combined checks pass 154 focused tests, the additional frozen-gate
app integration test, and 53 real-browser fixture checks. The earlier checkpoint
`600dae2b` passes all 10 repository test tasks (1,692 frontend tests and 6,238
backend tests; 3 backend live tests skipped). These are distinct checkpoints.
The final combined-SHA gate results and screenshots are delivered as generated
evidence alongside this source report. They must be assessed by their recorded
SHA, clean-tree status, explicit fixture boundary, and individual outcomes.

The initial draft PR attempt was denied for missing human authorization. The
user explicitly authorized PR creation at 18:09 UTC; the subsequent attempt
created [draft PR #206](https://github.com/opentoolsorg/shiba/pull/206).
No merge or production deployment is part of this task.

## Follow-up implementation and local backend boundary

Chat's existing Work submit now consumes the server's approval receipt and
opens that exact frozen approval in Work. After an explicit successful approval
decision, Work follows a retained run only when its server-provided approval ID
matches. It never derives a run ID or assumes completion. A new Work selection
can update the mounted inspector; subsequent browser history remains usable.
Scope changes clear pending handoffs. Missing receipts retain the original
idempotent command for recovery. A real local browser exposed a deferred-router
flush race; Work search writes now always use the canonical `/work/` path.

The repository's browser helpers now use the five-area shell, including closing
the inspector before navigating. App and inspector regression tests cover the
receipt handoff, linked run, history and uncertain-response retry behavior.

`scripts/verify-ux-local-backend.mjs` exercises actual local Worker APIs without
API interception. An empty env file, `wrangler dev --local`, disabled containers,
and an ephemeral Vite proxy avoid production configuration changes. The normal
no-secret Worker correctly rejects intake because no provider route exists.
The built-in loopback-only `SHIBA_VERIFY_STANDIN=1` environment with the local
GitHub stub queues and persists the actual approval, opens its frozen inspector
and survives reload. Approval returns HTTP 403 without `DASHBOARD_APPROVERS`;
no run is created for it. Access settings remain unchanged. This is real local
storage/routing evidence, not completed provider execution. Example drivers:

```sh
SHIBA_PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
  SHIBA_UX_ORIGIN=http://127.0.0.1:5173 \
  node scripts/verify-ux-local-backend.mjs
SHIBA_PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
  SHIBA_UX_ORIGIN=http://127.0.0.1:5174 \
  SHIBA_UX_OUTPUT=.verify/ux-local-standin \
  node scripts/verify-ux-local-backend.mjs --standin-unconfigured
SHIBA_PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
  SHIBA_UX_ORIGIN=http://127.0.0.1:5174 \
  SHIBA_UX_OUTPUT=.verify/ux-local-owned \
  node scripts/verify-ux-local-backend.mjs --owned-standin
```

The normal owned-thread path was also exercised through the UI: create a named
thread, review its Chat draft as Work, queue, reload its frozen approval, click
Approve and automatically follow the server-linked run. Existing owner
authorization accepts this separate request without an allowlist change; the
earlier shared request remains denied. The actual run terminates with
`Child dispatch signing is not configured (INTERNAL_SIGNING_KEY or MODEL_CREDENTIAL_KEY).`
Reloaded Diff/Output show the real error and README.md as not captured. No
signing key was generated and no synthetic success was substituted. Full
completed-run content remains fixture evidence until an already authorized,
configured runtime is available.

Container packaging remains blocked by the managed proxy CA missing inside the
existing Docker build. A one-off probe in the repository's pinned official
Cloudflare image, with the existing public proxy CA mounted read-only and
`CURL_CA_BUNDLE` pointing to it, successfully fetched the exact pinned codeload
URL with TLS verification enabled. The unchanged full Dockerfile still fails;
adding per-build CA mounts there would exceed this frontend-only scope.

The preview workflow was inspected. It provisions a new stack with live provider
secrets, so it has not been triggered under the current credential restrictions.
The existing `build:validate` workflow performs CI and fixture verification.
Its first follow-up browser job exposed one more retired Chats rail selector
in `drive.mjs`; that driver and the local-runtime driver now use the same
five-area navigation helper. Its next attempt exposed a stale `type=url`
assumption for the Repository text field; the driver now uses its accessible
label, and the fixture browser checks repository selection. A full-suite run
also exceeded the new receipt test's default one-second query wait; that
asynchronous query now allows five seconds. Failed attempts remain recorded.
The thread-profile driver also follows the saved default profile's current
Shiba label. Browser helper checks restore Chat mode after repository selection
so the next draft check starts in its declared mode.
The authenticated Marketing fixture starts at `/threads/`, the existing entry
that opens account setup, rather than expecting its Skip setup button on Work.
The native onboarding acceptance test uses the same Threads entry when starting
or resuming account setup and the current five-area navigation labels. Its
production Desktop code is unchanged; native Electron results are recorded by CI.
The local daemon driver waits for each server receipt's Work inspector before
starting its next navigation, preventing a delayed submit handoff from racing
the next test click.
Generated follow-up evidence records each gate's exact SHA and outcome; the
earlier 995d2e7d evidence bundle is retained separately in Library as
`libfile_fde3_f-da49bc95a8108191874f41e2e303386a_4a33f81638ec8191bd57410f2e202f67`.
