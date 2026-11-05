# Desktop validation follow-up

Baseline: `7ec01dfe437dccbb6177d9e22bd89d3dd97c299a`.
[CI #530](https://github.com/opentoolsorg/shiba/actions/runs/42040050543)
passed 7,271 workspace tests and its build/browser/configuration gates.
[Desktop #103](https://github.com/opentoolsorg/shiba/actions/runs/42040050226)
had two different failures:

- Attempt 1 passed all nine Electron cases, configured-agent and Marketing
  lifecycle checks, and both images. Unsigned DMG/ZIP packaging then failed with
  two HTTP 504 errors. The raw errors did not identify their request URLs.
- Its single failed-job retry passed eight Electron cases but native onboarding
  failed before packaging: the isolated Worker did not become ready within the
  existing 45-second readiness window. Its last log was Miniflare startup.

These are observed failures, not a demonstrated common root cause. No permanent
macOS startup repair is claimed from the available logs.

## Changes

The Worker fixture now reports elapsed readiness time, attempts, last HTTP status
or sanitized request error category, child exit details, and spawn failures. It
keeps the 45-second readiness budget, caps each probe/sleep to the remaining
budget and never includes bootstrap response bodies. The existing sanitized
environment, local-only bindings and process cleanup remain in place. No startup
retry, timeout expansion or test skip was added.

The Desktop job now prepares the exact host 7zip and dmgbuild tools serially
before parallel package targets. The metadata and API are checked against the
installed electron-builder/app-builder-lib/dmg-builder 26.15.7 sources. It uses
the ordinary checksum-verifying downloader and cache, fixed official release
URLs, and the same cache keys as packaging in the workflow's default environment.
The CLI has a five-minute outer budget. Failures identify the fixed artifact and
HTTP status or bounded error category; raw responses, headers and signed redirect
queries are omitted. The official `7za` symlink to `7zz` is accepted only when
its canonical target stays within the extracted toolset and is a nonempty file.
No TLS/checksum checks are disabled, no new download retry is added, and the
normal unsigned packaging command still has to succeed.

This moves download failures to an identifiable stage and prewarms the pinned
tools. It cannot make an unavailable upstream service available. The original
504's exact endpoint remains unconfirmed. Custom binary mirrors are outside
this workflow's fixed-URL prewarming contract and may use another cache key.

## Focused evidence

- Ten Node cases passed: readiness success/error/exit/spawn reporting; pinned
  metadata, supported host selection, checksum-bound download arguments,
  safe failure reporting, valid symlink versus escape, and missing executable.
- An isolated Linux Worker fixture returned bootstrap HTTP 200 and cleaned up;
  65.397 seconds total included migrations. This is not a measured 65-second
  readiness wait and does not reproduce the macOS stall.
- A real public download/cache probe verified both macOS x64 tool archives and
  their extracted executable paths in 9.504 seconds. It ran on Linux and did
  not execute a macOS binary or produce a macOS installer.
- Scoped lint and independent source review passed. The default-environment
  cache key and API compatibility were checked against the pinned source.

Logs: `/tmp/shiba-desktop-reliability-focused.log`,
`/tmp/shiba-desktop-reliability-lint.log`,
`/tmp/shiba-packaging-public-cache-probe.log`. The Desktop workflow runs the new
focused checks before using the fixture/preflight. Final-head CI/Desktop results
are recorded on PR #188. Preview and production deployment remain excluded.
