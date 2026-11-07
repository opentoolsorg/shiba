# Team onboarding and coordination verification, 2026-11-07

Source under test: PR #199, `22edd8b709a9f14176bc5a5ee6a5463eb1bdf256`, plus the new native team acceptance test and fixture-only metadata-fetch setting in this checkpoint. No production code, configuration flag, credential, deployment or external account was changed.

## Result and boundaries

The saved-goal-to-team-employee path passes through actual local Worker HTTP ingress, Better Auth signed cookies, D1 and Durable Objects. Execution is a deterministic paired-adapter fixture: it writes no repository, starts no model, provider, coding CLI or Cloudflare Container, and returns explicitly synthetic output. This is not live end-to-end acceptance or browser visual QA.

The new `apps/backend/test/acceptance/team-onboarding-dispatch.test.mjs` verifies one continuous flow:

1. Create the native bootstrap owner, pair a synthetic local adapter, create a team workspace and its employee.
2. Save the owner's goal, audience, acceptance criteria and supplied context in that workspace.
3. Refuse staging while the bootstrap email is unverified. Seed **only the synthetic local owner's verification bit** for the remaining fixture; real email delivery/verification is not tested.
4. Read the exact saved task using its draft ID, version and progress revision. Reject a stale revision. Saving/staging creates no runnable job.
5. Add the selected employee to a room and request a repository-free artifact handoff.
6. Keep the adapter idle before approval and after an incorrect approval hash. Approve the exact current frozen input through the room's requester-only approval route.
7. Claim once with the pinned employee/version and approved artifact destination. The adapter receives the approved task plus the runtime's existing artifact-output constraint.
8. Return synthetic artifact bytes, observe the completed employee reply, reload without duplicate replies, and prove no redispatch or false onboarding activation update.

## Additional verification

- 44 backend onboarding/team/collaboration/approval suites: **675 passed, 1 failed**.
- 13 additional employee/delegation/personal-execution suites: **141 passed**.
- 13 frontend onboarding/team suites: **164 passed**.
- 7 frontend first-run/employee/task-launch suites: **94 passed**.
- Existing native Worker dispatch fixture: **1 passed**.
- New native team onboarding fixture: **1 passed**.
- Fixture startup unit checks: **4 passed**.
- Changed-file Biome, Node syntax check and `git diff --check`: passed.
- Root Biome CI and Knip aggregate checks: passed, with existing warning/info output.
- Dashboard production build completed as part of both native fixtures.

The one backend failure is the previously documented `phase1-core-loop.integration.test.ts:612` assertion expecting HTTP 400 while protected direct execution returns HTTP 403. The test and protection were not changed here; its fix is tracked separately in PR #196. The selected backend suites are therefore **not fully green**. No full repository suite, full typecheck or live provider acceptance is claimed by this checkpoint.

## Product setup and scope still matter

- A fresh bootstrap owner can save a team draft but staging requires a current verified native session. Production email verification needs the documented verified sender, email binding and canonical HTTPS auth origin. This fixture does not establish those are configured.
- Ordinary invited-member employee queueing is denied without explicit personal execution authority. A separate personal local execution grant path exists and its fixtures passed; `SHIBA_PERSONAL_LOCAL_EXECUTION` remains `0` in deployment configuration.
- Funded team text has separate consent/approval/accounting safeguards and fixture coverage; `SHIBA_TEAM_MODEL_SESSIONS` remains `0`.
- Team Spaces intentionally returns `team_spaces_unavailable` (HTTP 501). Shared work uses team rooms.
- Chromium was not launched or retried here. Component tests do not establish current rendered desktop/mobile behavior.

## Reproduce

Use the repository-pinned **pnpm 10.34.4** on `PATH`, then install the locked dependencies. A host pnpm 11 caused the first native fixture attempt to time out during its build; rerunning with the pinned tool passed. This was an environment/toolchain issue, not a product execution failure.

```sh
pnpm --version # must be 10.34.4
pnpm install --frozen-lockfile
node --test apps/backend/test/acceptance/team-onboarding-dispatch.test.mjs
node --test apps/backend/test/acceptance/worker-dispatch.test.mjs
node --test apps/backend/test/acceptance/worker-fixture-startup.node-check.mjs
```

The isolated Worker fixture now sets `CLOUDFLARE_CF_FETCH_ENABLED=false`, preventing Miniflare's optional host-metadata lookup. Before this setting, local startup logged failed DNS attempts to `workers.cloudflare.com`; no provider call or external write was made. Fixtures retain their existing whitelist of local bindings, synthetic credentials and owned temporary-state cleanup.
