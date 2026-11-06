# PR #188: explicit paired-local artifact completion

## Scope

Repository-free artifact tasks can explicitly select a paired local computer from
both the task composer and a room employee handoff. Artifact work still defaults
to the cloud sandbox, even on a deployment whose repository runtime is local.
The app no longer silently overwrites the explicit Local selection, and the
conversation heading describes the selected runtime accurately.

The local daemon skips Git checkpoints for repository-free work. Regression
coverage exercises native Claude and the generic local session, including a
provider success that failed to produce the approved files.

## Boundaries retained

- Dashboard authority, `SHIBA_LOCAL_RUNTIME=1`, supported harness, exact paired
  computer selection, and a separate human run approval remain required.
- Local artifacts require nonempty explicit safe output paths: at most eight
  UTF-8 files, 16 KiB each and 64 KiB total. Only approved outputs are captured.
- Repository grants do not authorize artifacts. Repository publication, setup,
  injected environment, attachments, unexpected Git state and unapproved output
  files remain rejected by the local artifact adapter.
- Private ZIP export still needs the configured artifact/attachment storage and
  signing key. Source revocation and existing approval checks are not bypassed.
- Funding remains bounded model usage, not payment processing. Shared computers
  remain offline and human-controlled; no online/agent-control scope was added.

## Verification

- Task composer/app/route focused tests: 49 passed.
- Room composer and conversation heading focused tests: 47 passed.
- Provider route description tests: nine passed after updating the old
  repository-only assertion to the intentionally expanded bounded-artifact route.
- Six previously affected backend suites: 166 passed on a bounded rerun.
- Backend routing/integration focused run: 121 passed; two existing local-runtime
  Worker tests exceeded their five-second timeout under concurrent verification.
  The unchanged isolated local-runtime suite subsequently passed all 75 tests.
  No assertion or timeout was weakened; final full-suite status is recorded below.
- Browser checks use the actual React components on the local Vite server with
  fixture props and intercepted API responses. They verify explicit Local
  selection, missing/unsafe-path refusal, valid-path submission, no mobile
  horizontal overflow, room runtime retention, exact local handoff request, and
  the local-artifact heading. Desktop/mobile screenshots were visually inspected.
  These checks do not execute a provider or prove live backend acceptance.
- `pnpm typecheck`, `pnpm lint`, `pnpm lint:imports`, `pnpm build`, and
  `pnpm test:built` and `pnpm check:ci` passed. Lint reports existing warnings.
- `pnpm test` failed on the old repository-only provider-copy assertion
  (1,499 frontend tests passed, one failed) and interrupted the backend run. The
  corrected provider suite passes as recorded above; this is not a green full
  workspace result. Exact-head GitHub CI remains the full-suite gate.

Earlier parallel audits also passed focused Slack, archive/reporting,
funded-model and offline-computer tests. Those results are not live acceptance
or exact-head GitHub CI certification.

## User-owned live acceptance

1. In the authorized Slack workspace, use a verified native identity, review the
   exact task/audience/employee/grant, submit once, and confirm nothing runs
   before human approval. Verify source revocation blocks queued work. If private
   status is explicitly enabled and consented, confirm status contains no task,
   result, file, artifact link or room content; full results stay in Shiba.
2. On a configured deployment with a paired computer and an independently logged
   in supported CLI, choose Artifact workspace → Local → the exact computer.
   Enter `out/brief.md`, queue, inspect the frozen runtime and paths, then approve.
   Confirm no repository clone/PR occurs and the private ZIP contains only the
   complete approved file. Repeat through a room employee handoff.
3. Confirm empty/traversal paths are blocked, and a missing output fails even when
   the CLI exits successfully. An offline/unpaired computer must not silently
   fall back to cloud. Check the CLI account and billing on that computer.
4. Exercise retained-output recovery and rolling reports with authorized owned
   data; distinguish retained content from explicitly reported gaps and captured
   comparison windows from fresh provider reads.
5. Test funded-model usage only with explicit operator/member consent and caps;
   do not infer permission to charge cards or process payments. Verify shared
   computers remain offline and human-controlled.

No live provider, Slack, payment, deployment or merge was performed for this
increment. GitHub review and exact-head CI remain separate gates.
