# PR188 Slack native submission bridge — fixture acceptance

Source: fetched PR188 head `7a96effab47d56820ae24f2c869d7d70eb1709f2`.
Dedicated branch: `feat/prince-multi-agent-control-plane--slack-execution`.
No shared branch publication, competing PR, deployment or live transport use.

## Increment

- A pending managed Slack draft can stage its original source ID without adoption.
- The authorized native room presents a separate immutable statement review,
  room-agent selector, current personal grant setup/selection and explicit consent.
- The strict client submits only draft/room/agent/grant selectors, never composer
  context, credentials, private thread history or execution approval.
- Server one-shot receipts and existing source/identity/installation fences remain
  unchanged. The client validates receipt identity even for non-2xx blocked/unknown
  outcomes, disables repeated submission and discards late unmounted responses.
- The editable-copy action remains explicitly separate and does not preserve the
  Slack source fence. No collaboration runtime contract changed.

## Confirmed checks

- Backend: 50 tests across `slack-coworker.test.ts`,
  `slack-coworker.security-v3.test.ts` and
  `slack-coworker-collaboration-fence.test.ts` passed.
- Frontend: 40 CollaborationView tests and nine Slack panel/submission tests passed.
- Frontend typecheck and scoped production-source ESLint passed; diff whitespace
  check passed. A frozen-lockfile install restored missing workspace dependencies
  without tracked lockfile changes.
- Independent read-only review found non-2xx receipts were initially discarded.
  Fixed and independently rechecked with seven passing submission tests.
- Local browser interaction used the real submission component and personal grant
  UI in a temporary local Vite fixture harness, with all fetches replaced by an
  allowlisted fixture transport. Selected agent/grant, checked explicit review,
  submitted, inspected the exact selector-only payload and disabled receipt UI.
  This was not the full authenticated dashboard/backend journey.
- Inspected safe screenshot:
  https://api.hoplite.sh/api/attachments/262887a4ab704d8ea453048b751dde41

Security fixtures cover concurrent duplicates, 400/403/409/202/500/503 replies,
installation generation/revocation, identity/intake/membership changes,
unauthorized coworkers and replacement account UUIDs. A composed fixture uses real
pending-approval transforms and collaboration source fences with a test-owned
executor adapter: pending approval cannot dispatch; explicit approval delivers
the frozen task; later intake revocation blocks delivery.

## Boundaries and integration

The route fixture mocks collaboration transport; the approval fixture does not
exercise the production orchestrator HTTP approval handler or agent-tool executor.
No live Slack installation, OAuth, private-channel membership proof, Slack send,
provider call, paid inference, sandbox, payment or managed preview was used.
The coordinator owns integrated CI and shared PR188 publication. Existing Desktop
readiness failures are not reclassified as success by this increment.
