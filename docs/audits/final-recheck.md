# Final working-state recheck

Rechecked on 2026-10-28 in `/workspace/shiba`, branch
`codex/overlay-parity-audit`. The repository gate counts below supersede earlier
unit totals. Current employee deliverable acceptance and its fresh
browser/Electron results are tracked in
[employee-deliverables.md](employee-deliverables.md). Rows marked “prior” are
from the earlier source snapshot.

## Fixes found during the recheck

- The verification helpers now honor the same `VERIFY_DIR`. Cleanup stops only
  recorded processes and containers. A real-process regression proves that an
  unrelated listener and another invocation's state survive cleanup.
- The live permission panel renders every active session. An older empty run
  can no longer hide the current Bot's tool permission request. Decisions and
  interrupts retain the chosen sandbox ID, including overlapping request IDs.
- Local run cleanup uses the local mailbox rather than a Cloudflare container.
  Completion preserves settled results; cancellation, restart, and stale-run
  cleanup revoke claims and fence late results.
- Historical local leaks had been copied across session actors. Trusted local
  mailbox records now positively identify those entries for removal. Unknown
  entries retain cloud cleanup retries. Dashboard reads schedule those retries
  in the background, with one in-flight cleanup per actor and recovery after
  failure. The focused cleanup/runtime regression suite passed **152 tests**.
- Ignored Morph vendor skills can now be restored with the tracked
  `scripts/setup-morph-skills.mjs`. Five manual checks cover fresh/repeated
  restoration, archive integrity failure, preservation of customized skills,
  and symlink refusal. The restored provenance is valid JSON.
- Independent review fixed v1 approval ownership and dashboard organization
  scoping; sandbox Git blob capture now uses binary-safe transport, validates
  the Git object and strictly decodes UTF-8, including a valid U+FFFD character.
  Daemon cancellation and deadlines now fence result capture and test phases,
  with termination escalation for owned child processes. Concurrent review
  triage now rolls back cleanly when updates race.

## Executed acceptance

| Verification | Result and boundary |
| --- | --- |
| Full repository suite | **3,342 passed, 3 skipped**, across 8 packages; the skips require live TypeSafe credentials. See `.verify/employee/unit-summary.json`. |
| Typechecks, CI and import checks | Passed. CI retains lint warnings and Knip findings within the existing threshold. |
| Build and documentation | All 6 build tasks passed; output/doc verification passed. |
| Built-output and deployment drift checks | Passed; generated SDK/OpenAPI types are synchronized. |
| Worker deployment bundle | Dry-run only, with container rollout disabled; no upload or image execution. |
| Mock core loop | 11 checks passed; mock GitHub and synthetic execution, containers disabled. |
| Bot threads | 9 checks passed against the real local Worker/D1; no model, GitHub or container execution. |
| Bot lifecycle, web and Electron | 11 checks passed per target; real UI/API and human approval, synthetic execution and mock GitHub. |
| Actual Worker + local daemon, web and Electron | Fresh isolated-state runs passed **14 UI steps and 18 protocol checks per target** after the final authorization/capture/cancellation fixes. The model CLI was a deterministic fixture; `liveInference: false`. |
| Linux Electron shell | 5 tests passed across 3 files; fixture services. macOS is untested. |
| Restored development services | Worker/Vite setup, dashboard HTML/JavaScript, computers and models return 200; both OAuth callbacks listen, but provider login is unverified. |

The mock core loop, thread and lifecycle checks total **42 passed**: 11 mock
core, 9 thread, 11 web lifecycle and 11 Electron lifecycle checks.

The development workflow is running again. The main development configuration
has **zero paired computers and zero model connections**; the acceptance
machine/account belong only to the isolated fixture. Pair the user's Mac and
authenticate a supported CLI/provider before claiming live Bot execution. The
OAuth callback listeners are ready, but provider login is unverified. Isolated
test services on 8790, 8794 and 8799 were stopped and checked closed.

Prior daemon journeys exercised the actual Bot form, bound thread, paired-machine
selection, composer submission, human task approval, tool Allow button, native
Git clone, file edit, retained diff, named-session review, thread reopening and
cancellation of the CLI and its tool subprocess. The web journey also verified
that the downloaded patch matched the retained Git diff byte for byte.
**Only the model CLI was a deterministic fixture; live inference was false.**
These prior journeys are superseded by the current employee deliverable
acceptance recorded in [employee-deliverables.md](employee-deliverables.md).

Those earlier journeys kept the existing Worker persistence, including the
records that exposed the cleanup defect. They did not reset state, raise
timeouts, disable assertions, or bypass human approval. Both targets passed,
with **zero container-attachment errors and zero failed sandbox destroys** in
the captured Worker log. Electron 44.7.0 recorded `sandbox: true`,
`contextIsolation: true`, `nodeIntegration: false`, a working desktop bridge,
and no renderer `require`.

## Evidence

- `.verify/employee/unit-summary.json`: current package test totals.
- `.verify/employee/dev-readiness.json`: restored local service status and
  closed test-service ports.
- `.verify/employee/fresh-acceptance-summary.json` and
  `.verify/employee/{web,desktop}-fresh-result.json`: latest fresh UI runs.
- `.verify/employee-ci-gWkc9D/result.json` and
  `.verify/employee-ci-ZrjEJ9/result.json`: full web/Electron runner results.
- `.verify/employee-ci-7dCOc2/result.json`: initial allowlist fixture failure,
  retained before the authenticated rerun.
- `/tmp/shiba-employee-shell.log`: Linux Electron shell tests.
- `.verify/recheck/unit-summary.json`: earlier package test totals, superseded by the current suite.
- `.verify/recheck/morph-restoration.json` and `morph-readiness.json`.
- `.verify/recheck/local-cleanup-migration.json`: same-state migration evidence.
- `.verify/recheck/dev-readiness.json`: restored development service responses
  and closed test-service ports.
- `.verify/employee-mock-runtime/evidence/recheck-20261028T130050Z/`: current
  mock-core evidence; mock GitHub and containers disabled.
- `.verify/{agent-threads,agent-lifecycle,desktop-agent-lifecycle}/result.json`:
  final thread and lifecycle results.
- `.verify/local-daemon-e2e/ui-employee-{web,desktop}/evidence.json`, screenshots
  and web attachments: current post-fix Marketing journeys, with the model
  fixture explicitly labeled.
- `/tmp/shiba-recheck-{build,typecheck,ci,imports,tests,built,deploy,cloud-bundle,desktop-shell,browsers,local-web,local-desktop,local-worker}.log`.

Evidence under `.verify/` and `/tmp/` is local, ignored test output. It is
retained for this workspace and is not a published artifact.

## Remaining external acceptance

Native macOS execution, installation, signing and notarization require a Mac
runner/device. The prepared macOS workflow has not been pushed or executed.
The Linux Electron tests do not certify those behaviors.

Cloudflare deployment and preview testing were not available from this runtime:
`wrangler whoami` is unauthenticated and the API host returns proxy CONNECT 403.
The runtime CLI cannot access the user's reported Cloudflare connection, and no
preview URL was created. GitHub diagnostics also report invalid CLI auth and
the API host returns proxy CONNECT 403, so no verified pull request or live
publication is recorded here. These checks describe runtime CLI access, not the
user's connection status in other interfaces. Real container execution,
production OAuth and production readiness are not established. See
[deployment status](cloud-preview-deployment.md).

Morph's five upstream skills and pinned MCP configuration are prepared. The
stdio handshake works but exposes zero tools without `MORPH_API_KEY`; this host
does not automatically load the project MCP definition. The API and students
page are blocked by the proxy. No live Morph call, student eligibility, credits,
or speed/quality claim was verified. See [Morph tooling](morph-tooling.md).

The Reason Machines site was also blocked, so exact feature parity against it
was not established. The earlier [reference comparison](overlay-reference.md)
records the available comparison evidence and remaining gaps.

The saved environment draft includes reproducible installation/startup,
desktop tools, Morph skill restoration, and requested network/credential
requirements. Review/save the settings and publish the environment to activate
the draft; saving it does not change this instance's network policy.
