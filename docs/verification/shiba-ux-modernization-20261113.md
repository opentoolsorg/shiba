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
It does not contact a Worker, execute a sandbox, or decide an approval. All
other mutations fail closed. The resulting approval must remain pending and
its displayed frozen JSON must exactly match the recorded request.

The initial 11-check dev-browser baseline passes aliases, reloads, mobile
document width, and absence of unhandled/hydration errors. React's development
script-tag warning remains recorded; it is not silently called console-clean.
Expanded production-byte checks and final integration evidence are pending.

## Final integration

Worker slices, final combined SHA, final check outcomes, screenshots, CI link,
and remaining gaps will be recorded here after integration. No merge or deploy
is part of this task.
