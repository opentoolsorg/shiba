# Recurring founder review drafts

This is a storage-only scheduling slice. It creates private task drafts to review
in Skills. It does not execute a founder workflow, fetch app data, invoke a
provider, start a container, resolve an approval, publish a file or send a Slack
digest. Full scheduled connector execution remains unimplemented because the
automation path has no explicit execution-account and funding grant or supported
connected-app scheduler adapter. Adding credentials alone does not close that
product contract.

## Configure deliberately

1. Sign in with a verified native account, then select your personal scope or an
   active team workspace. Access-only identities cannot configure this scope.
   In a team, only a
   current owner or admin can configure their own private review drafts.
2. Install the founder instructions, review the exact version and activate it.
   Choose an available employee profile in the same scope. An archived profile
   is unavailable. Neither step connects an app or selects a model account.
3. Choose daily or weekly cadence, a local time in five-minute increments, an
   IANA timezone and an expiry no more than 90 days away. The only supported
   destination is your private dashboard. The provider is `null` and the allowed
   tools list is empty. Source names such as Stripe remain requirement labels.
4. Prepare the configuration, inspect its frozen profile, instructions, task,
   provenance, audience and digest, then explicitly enable review drafts. An
   unreviewed preview expires after 15 minutes. Preparing a replacement stops
   the old configuration and requires a new review.
5. Return to the same schedule panel to read receipts. Copy or otherwise review
   the proposed task before submitting it through the normal human task approval
   flow. A draft receipt cannot run that task or approve any action.

Pause or revoke cancels pending receipts. Resume requires another explicit review
of the current frozen configuration. Revocation is terminal for that reviewed
configuration; a replacement requires preparation and review again. Every change
requires the exact current version and digest. A stale request fails without
changing a newer configuration.

## Timing, retention and authority

The existing Worker cron calls `tickFounderReviewSchedules`. The module reuses
the existing automation cron matcher without entering the Automations or
CodingOrchestrator Durable Objects. Existing unrelated automations keep their
own behavior. Deployment CPU, D1 storage and cron hosting costs remain the
operator's responsibility.

The due instant is stored durably. After an outage, at most one overdue receipt
is created, labelled with its original due UTC instant; the next due time moves
past the current time. There is no backlog. An existing pending receipt prevents
overlapping receipts. The tick examines at most 100 enabled schedules, ordered
by their last check, and the store caps configurations at 1,000. Under load the
actual creation time can be later than the scheduled time. Paused schedules do
not accumulate missed drafts; resuming selects the next future occurrence.

Timezone gaps skip nonexistent wall times. Repeated daylight-saving wall times
map to distinct UTC instants, matching the existing cron matcher. The one-pending
receipt rule still applies. This is a cron-style review cadence, not a guarantee
of one receipt per local calendar day during a clock change.

The receipt key binds schedule identity, lifecycle version and exact due UTC
instant. One D1 batch checks current authority, inserts the bounded receipt and
advances due time. An interrupted request or lost committed response can be
retried without duplicating a receipt or launching uncertain work. The panel
shows up to 50 retained receipts; older non-pending receipts are pruned.

The reviewed contract freezes the creator's immutable native account ID, email,
org, exact membership role/version
for team scopes, built-in recipe digest, installed active skill version and text,
employee version and configuration, cadence, timezone, expiry and private
destination. Current membership, installation, skill activation and employee
availability are checked in the exact database statement that creates a receipt.
Recreating an account with the same email does not inherit the previous
account's review configuration or receipts. Options and stored outputs end in
a current native-account and membership fence after session revalidation.
Changed or expired sources block future drafts and cancel pending ones. Stored
instructions and receipts are hidden if current source authority is lost. A
removed team member, another creator, another org, an API key or an automation
identity cannot use this route to retrieve or enable that creator's drafts.

## Operator setup and evidence

Apply append-only D1 migration
`apps/backend/migrations/0012_founder_review_schedules.sql` using the deployment's
existing migration procedure. The store also uses idempotent DDL consistently
with the existing skill stores. The root scheduled handler must call
`tickFounderReviewSchedules(env)`. No new binding, secret, OAuth client or
model account is required for this storage-only slice. The existing cron must
be running for receipts to arrive.

Production calls `tickFounderReviewSchedules(env)` without a numeric clock
override. A numeric second argument is for deterministic fixtures only.
Review and schedule expiry are also checked against D1's transaction-time clock
so a delayed read or hash cannot enable an expired preview.

Focused regression suites are `founder-review-schedules.test.ts`,
`founder-review-routes.test.ts` and `FounderReviewSchedule.test.tsx`. They use real
SQLite behind the D1 interface and browser fixtures. They cover reviewed enable,
CAS, stop/resume/revoke, current source checks, revocation during reads and the
final occurrence write, due idempotency, overlapping ticks, process reconstruction,
lost committed responses, timezones and scope changes. They are local evidence.
Route fixtures mock authentication and use real native-account rows and SQLite
authority checks; they do not establish a live sign-in or a deployed session.
They do not establish deployed Cloudflare cron behavior, installed Slack
delivery, live provider execution or connected-app compatibility.

Scheduled app execution needs a separate reviewed server-owned account and
funding contract, attributable automation identity, allowed inference phases,
exact supported read actions, account/resource grants, destination authorization
and revocation checks at dispatch. Human-only ChatGPT subscription eligibility
must remain denied for shared or scheduled triggers. Writes must retain exact
human action approval; neither the schedule nor the employee may approve itself.
