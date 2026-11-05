# Funded team text sessions

This optional lane provides interactive text responses through the deployment's
Workers AI binding. It has no tools, app execution, MCP, coding CLI, specialists,
Think orchestration, schedules, subscriptions or external provider fallback.
The feature is off unless `SHIBA_TEAM_MODEL_SESSIONS=1`. The only supported
`SHIBA_TEAM_MODEL_MODEL` value is `@cf/zai-org/glm-4.7-flash`, which is also the
pinned default. Other values fail closed.

## Funding and human decisions

A funding issuer must be both the verified native bootstrap deployment account
and a current owner or admin of the selected workspace. Workspace administration
alone does not authorize deployment billing. Access-only accounts, API tokens,
automation identities and models cannot issue or approve funding.

The issuer selects a real native member, an active room employee at its exact
profile revision, and explicit limits. The server freezes the native UUIDs,
verified emails, workspace membership roles and revisions, room participants,
employee configuration, model policy and limits into a digest. The funding
preview grants no inference. Its original issuer must separately review that
exact digest and explicitly consent to deployment billing before activation.
The preview expires after 15 minutes or the earlier funding expiry.

Limits are one to ten requests, one to 16,384 UTF-8 input bytes per request, one
to 1,024 maximum completion tokens per request, and a funding lifetime no longer
than 24 hours. These are request, byte and token limits. They are not a hard
currency ceiling or a live price quote. The input byte count includes the whole
serialized model input, including system instructions, the employee profile,
source attribution and selected context. Oversized input is rejected rather
than silently shortened.

Only the selected member can prepare a turn. Every turn has a frozen prompt,
complete model messages, source provenance, input digest and deadline. Preparing
it does not invoke a model. That same native human must explicitly approve the
exact turn and then click Execute separately. Replayed execution cannot make
another inference call. The member cannot change arguments under the same
request ID or use another member's funding.

## Selected context and privacy

Context starts empty. A member may explicitly select human-authored web room
messages and immutable shared notes. The preview displays the exact model
messages before approval. Private owner memory, parent transcripts, Slack
imports and employee-result provenance are not inherited. Rooms with an active
Slack source link are unavailable in this first slice; a deployment bot's
visibility does not become a member's model permission.

The requester alone can read their turn prompts and outputs. A same-room
manager or the funding issuer does not automatically gain access. Reads recheck
the current native identities, funding, room, profile and selected sources in a
final database snapshot after authentication. A revoked note, changed profile,
removed participant, account replacement or expired/revoked funding hides
protected prompts, context and outputs. There is no promise of permanent chat
memory. Turn review deadlines limit approval and dispatch; completed output is
readable only while its funding and source authority remain current.

Append-only migration `0013_team_model_sessions.sql` adds funding and turn
receipts plus triggers scoped to these new funding records. Relevant room
membership changes or deletion permanently block existing funding. Removing
and re-adding a participant cannot revive a previously approved grant.

## Reservation, cancellation and uncertainty

One D1 transaction reserves the request, full input byte count and maximum
completion tokens and claims the approved turn. The runtime then makes at most
one application-level `AI.run` call using the exact model, `stream:false`, one
text choice, `tool_choice:none`, `store:false` and thinking disabled. No tools,
functions, web search or gateway retry configuration is passed.

The final native, funding, source and expiry checks precede the call. Model
policy, deadline and abort state are checked synchronously immediately before
invocation. A durable Stop request prevents future dispatch and result
publication. During an active call, bounded polling observes cancellation or
revocation and aborts the local inference signal. The dispatch deadline is at
most 30 seconds. A stalled polling read cannot hold cleanup open indefinitely.

Aborting a request does not prove remote computation stopped or billing was
refunded. Stop after dispatch retains an unknown outcome and blocks further
calls under that funding. Lost responses, failed inference and expired running
leases retain their reservation. Reads reconcile expired running receipts to
unknown. Unknown work is never automatically relaunched or refunded. Browser
disconnect alone is not a reliable durable Stop signal under the current
Worker compatibility settings; use the explicit Stop operation.

Storage and listing are bounded: at most 100 funding records per workspace and
20 prepared turn records per grant. Room state lists the most recent 30 funding
records and the requester's most recent 20 turns, plus their referenced funding.
There is no automatic deletion or capacity-recycling policy in this slice;
reaching a storage bound fails closed. This is not an unlimited chat-history
service.

## Routes and evidence

`/api/team-model-sessions` uses a verified native session and the authoritative
`X-Shiba-Workspace` header. Scope overrides and bearer identities are denied.
The namespace provides room state, funding prepare/activate/revoke, and turn
prepare/approve/execute/cancel. Shared schemas are browser-safe wire contracts;
credentials and provider clients do not enter the shared package or containers.

`apps/backend/test/team-model-sessions.test.ts` uses actual route, store,
transaction and runtime code with real SQLite and a fixture AI binding. It
covers positive decisions, disabled/unsupported policies, native and source
revocation, remove/re-add, concurrency, bounded full input, unknown outcomes,
stalled reads, cancellation, late responses, private reads and lost committed
receipts. Native sessions and inference are fixtures, not live certification.

The API behavior and model fields were checked against the current official
[Workers AI binding documentation](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
and [GLM model schema](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/).
Live acceptance still requires the exact deployed revision, an authorized
verified bootstrap account, two native workspace members, an explicitly enabled
model policy, reviewed funding and permission to make a harmless billed call.
No such live funding, inference, credentials or deployment is created by these
fixture tests.
