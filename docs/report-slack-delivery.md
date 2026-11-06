# One-shot report sharing to Slack

A native report creator can prepare one complete small report for one already
linked Slack thread. The creator must currently manage the team workspace, own
the room, and be the original native issuer of **every** selected app connection.
A manager's grant to use somebody else's connection does not authorize exporting
that connection's private report results.

Preparation is private and performs no Slack send. It freezes the report and
source hashes, complete neutralized message bytes and SHA-256, native creator
UUID and membership revision, room/link/team/channel/thread, authorized web-room
readers, configured source policy and original expiry. A client request UUID is
idempotent; retries do not renew the deadline. The draft expires within fifteen
minutes and never outlives its source report.

The creator explicitly consents to sharing the reviewed bytes with **everyone
who can access that exact Slack channel/thread**, including people outside the
web room. The room reader list is not a complete list of Slack recipients. No
Slack membership enumeration, guessed identity, automatic room message or fake
human authorship is used. The signed-in creator's disclosure and the separate
configured native human's **Approve and send** are distinct actions.

The recipient must already have an active immutable room link allowed by the
strict `SLACK_CANVAS_OWNERS` owner/viewer policy. Legacy delivery channels must
also equal `SLACK_APPROVALS_CHANNEL`. Approval requires a current native workspace manager
who is also a human room reader and explicitly listed in `DASHBOARD_APPROVERS`.
`SLACK_ROOM_OUTBOX_ENABLED=true`, a configured bot token and a valid policy are
prerequisites. Missing configuration fails closed. The bot's `auth.test` team
must match the selected team; the last combined D1 statement then rechecks the
report, source receipts/grants, native identities, room, audience, link, exact
approval and original expiry immediately before the fixed Slack POST.

Optional [managed installations](slack-installations.md) bind the reviewed
destination to its native-owned installation, app/team/bot identity, generation,
version and token revision. Managed channels come only from that same explicit
owner/viewer policy; the single legacy approvals channel does not stand in for
another team's destination. A managed intent never falls back to a global bot
token, including after refresh, revocation or disabling the feature.

The complete escaped message, including its stored-excerpt/completeness/business
success caveat, must fit **3,500 UTF-8 bytes**. An oversized report returns `413`;
it is not truncated, summarized or replaced with a private link. Download it
privately instead. No model runs, data refresh, schedules, business-success
inference or automatic delivery are part of this feature.

The isolated sender uses Slack's documented `chat.postMessage` parameters:
`mrkdwn:false`, `parse:none`, `link_names:false`, `reply_broadcast:false`, and all
link/media/app unfurls disabled. Angle brackets and ampersands are neutralized
before review and hashing. The exact previewed bytes are sent. See the
[official method reference](https://docs.slack.dev/reference/methods/chat.postMessage/).

A conditional claim makes a disclosed intent one-use. Room, workspace or link
changes permanently block unsent drafts, so removal followed by re-addition
cannot revive consent. A stable report-hash/destination latch also rejects a
cloned report ID or new request UUID after a pending, sent or unknown delivery.
Unknown outcomes and abandoned `sending` claims are never retried; the affected
link requires human inspection. The database retains the claim even if Slack's
receipt cannot be persisted. Cancellation can stop only a draft/disclosed
intent; it cannot retract a request already in flight or a delivered message.

Endpoints are cookie-authenticated, same-origin JSON and require an explicit
`X-Shiba-Workspace`; no bearer, agent-tool or cron approval route exists:

* `GET /api/founder-skills/:libraryId/reports/:reportId/slack`
* `POST .../slack/preview` with stable request UUID, exact report hash,
  existing room/link and expiry.
* `POST .../slack/intents/:id/disclose` with exact review digest/content hash,
  deadline and both disclosure consent literals.
* `POST .../slack/intents/:id/approve` with exact review and deadline.
* `POST .../slack/intents/:id/cancel` with exact review and deadline.

Migration `0016` establishes canonical historical runtime prerequisites before
the new table/indexes and invalidation triggers. Runtime initialization uses the
same schema. Private authority/source JSON is never included in the browser DTO.

Focused tests are `test/report-slack.test.ts` and
`src/report-slack-client.test.ts`. The former uses native SQLite, current native
auth fixtures and a private SQL report seam; fake Slack transport verifies
disclosure, authorization, source changes after bot authentication, final read
races, expiry, duplicate/clone latches, revocation, unknown outcomes, sender
parameters and fresh migration application. The actual report loader has its
separate SQLite/HTTP acceptance suite. These fixtures are **not** installed Slack
delivery evidence. Live acceptance still needs an authorized non-production
Slack installation, permitted test thread, matching bot/team/scopes and current
configured human identities. No live message, account, credential or model call
was created while implementing this path.
