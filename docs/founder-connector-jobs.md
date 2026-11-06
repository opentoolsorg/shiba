# Founder connector action reviews

This workflow schedules **one fixed app action for human review** in a selected
workspace. It does not run an employee or model, interpolate arguments, generate
a founder report, calculate MRR, combine multiple apps, or send a Slack digest.
The six founder templates remain instructions and setup suggestions; this
contract does not establish that their complete workflows are operational.

A verified native workspace owner or admin selects an active owned founder
skill, current employee version, explicitly shared app account, registered
action, fixed JSON arguments, cadence, timezone and expiry. Account connection,
upstream authorization and exact employee/member grants are separate
prerequisites. No personal account or deployment credential is inherited.

The flow is:

1. Prepare and review the frozen action plan, then explicitly enable its cadence.
2. The scheduler creates a bounded D1 occurrence only. Delays coalesce; there is
   no automatic execution or catch-up batch.
3. The original requester explicitly prepares that occurrence's action request.
4. A current native workspace manager reviews and decides its exact frozen
   arguments. Other managers can review it in workspace Apps.
5. The original requester separately executes the approved action once.
6. The completion receipt is private to that requester. Unknown or in-flight
   outcomes require inspection and cannot trigger automatic retries.

Pausing, revoking or replacing a plan prevents new work. It cannot retract an
external effect already sent. An unconfirmed transfer is not evidence that an
action did or did not execute.

## Authority and source binding

The frozen plan binds the native account and membership, recipe digest, active
skill and employee versions, account/consent generation, exact grant and action
schema, arguments, cadence and expiry. The action binding retains the founder
plan and occurrence context, so using a generic workspace action endpoint cannot
bypass its source checks or private result audience.

Configuration and decisions require authenticated humans. A catalog entry,
template, model, scheduled alarm, API token or employee persona grants no
approval authority. The requester and manager must retain their exact current
permissions. Source, approval, expiry and cancellation checks run again before
dispatch; source changes during asynchronous metadata checks fail closed.
Read responses end with a guarded D1 snapshot after other awaited reads. Changed
or expired occurrences cannot reuse cached approval arguments, permissions or
private completion output from an earlier read.

The panel uses server-provided permission flags and validates the exact returned
plan and approval identities. It refreshes on focus and every 20 seconds while
visible and idle, clears protected content on access failures, and locally hides
expired leases. These UI checks supplement the backend; they do not authorize
execution. A missing or uncertain response is never treated as success.

## API and implementation

The native dashboard surface is
`/api/founder-skills/:libraryId/connector-job`, selected with
`X-Shiba-Workspace`. Reads expose current state, `/options`, and `/actions`.
Explicit POST actions configure the draft, `/enable`, `/pause`, `/resume`, and
`/revoke`. Each `/occurrences/:id/prepare`, `/decision`, and `/execute` operation
binds the current plan version/digest and occurrence digest; decisions and
execution additionally bind the exact approval identity and input hash.

Wire validation lives in
[`founder-connector-jobs.ts`](../packages/shared/src/founder-connector-jobs.ts).
The backend owns authentication, source SQL fences and the canonical workspace
action runtime. The frontend client and panel neither store credentials nor
call provider endpoints directly.

## Why autonomous reads remain unavailable

Shiba preserves the provider-declared `operationType` as advisory `read`, `write`
or `destructive` metadata. Missing or unknown upstream values become
`unclassified`; older Shiba wire responses may omit the field, which also means
unclassified. This classification never removes exact-action human approval,
changes grants or authorizes a scheduled call.

The pinned upstream illustrates why that boundary matters. Linear's
[`run_query` declaration](https://github.com/oomol-lab/open-connector/blob/d89dc9f24f5a057bb500272d7dbf333837c77c68/src/providers/linear/actions.ts#L381)
calls it a read, while its
[`executor`](https://github.com/oomol-lab/open-connector/blob/d89dc9f24f5a057bb500272d7dbf333837c77c68/src/providers/linear/executors.ts#L1160)
forwards the supplied GraphQL document without rejecting mutations. The common
transport posts that document to Linear. With sufficient upstream credentials,
the label alone therefore cannot establish read-only behavior. This is source
inspection, not a live mutation test. A fixture regression proves Shiba still
requests human approval when a read-labelled action receives mutation text.

There is no audited manifest binding exact action IDs, argument restrictions,
schemas and executors to read-only behavior, nor authenticated proof of the
active sibling deployment revision. Upstream action policy checks action IDs;
its declaration is not an enforcement boundary for arbitrary query bodies.
A checked-out source pin and successful metadata health check do not attest to
the live deployment's code or configuration.

There is also no scheduler-attributed standing read grant with exact source
scope, expiry, revocation, funding authority and call budget. A connected app
and a manual action grant cannot substitute for that contract. Until those
boundaries exist, every occurrence needs the human request, review and execution
steps above. No amount-aware spend permission is inferred.

## Verification limits

Frontend tests exercise real components, native fetch handling and shared wire
validation using intercepted HTTP fixtures. They cover exact receipts, separate
human steps, duplicate clicks, uncertain outcomes, permission flags, expiry,
revoked reads and late responses after a workspace switch. The bounded Chromium
fixture uses the actual panel and product CSS with external traffic blocked;
it replaces authentication, Worker/D1, scheduling, OpenConnector and vendor
effects. Neither fixture proves a live account integration.

The [Chromium report](verification/founder-connector-browser-20261105.json)
records 12 assertions, source hashes and synthetic HTTP traffic. Screenshots
cover [desktop dark](verification/founder-connector-browser-20261105-desktop-dark.png),
[390-pixel light](verification/founder-connector-browser-20261105-390-light.png)
and [320-pixel light](verification/founder-connector-browser-20261105-320-light.png)
layouts. Its two HTTP 403 console entries are the deliberate access-revocation
fixture; there were no browser page exceptions.

Actual provider calls require configured, authorized workspace accounts and the
deployed sibling service. No live model, OAuth, vendor mutation, Slack delivery,
production deployment or credential creation is implied by these local checks.
