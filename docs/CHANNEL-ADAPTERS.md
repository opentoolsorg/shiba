# Chat channel adapters

`apps/backend/src/ports/chat-channel/types.ts` defines `ChatChannel`, thread and
message references, normalized inbound events, approval pointers and safe error
messages. A thread reference names the adapter, tenant, conversation and root
message; a message reference adds the individual message id. The core receives a
registry or adapter through its context rather than keeping a global client.

`ports/channel` (transports and full adapters for Slack, Discord, Telegram, Teams
and email) is a separate, wider port that the chat lanes already use. `ChatChannel`
is the narrower approval-aware port the orchestrator posts Slack messages through;
the two coexist until their callers converge.

The extraction preserves existing Slack routes, signature checks, immediate
acknowledgments, deduplication and approval authorization. The new parser also
verifies signatures independently and shares the existing interaction parser's
origin checks. Parsing an action grants no authority: the approval domain must
still authorize the actor, re-resolve the pending pointer and dispatch it.
Resolving an approval through the port updates its presentation only.

## Add an adapter

1. Add `apps/backend/src/adapters/chat-channel/<vendor>/` implementing `ChatChannel`.
2. Add one registration in `ports/chat-channel/registry.ts`. Supply a factory
   scoped to the current request/context, and an enable predicate checking its
   required secrets. Select it by id with `registry.get(id)`; disabled or unknown
   ids return `undefined`. `listEnabled()` lists usable adapters.
3. Run the reusable suite in `ports/chat-channel/contract.ts` with signed inbound
   fixtures and fake transport dependencies, then add vendor-specific tests.
4. Document secret names, identity binding scope and unsupported capabilities.

## Slack

Outbound registration requires `SLACK_BOT_TOKEN`. Inbound verification separately
requires `SLACK_SIGNING_SECRET`; omitting it rejects every inbound request without
turning off existing outbound sends. No new configuration or secrets are added.
The registry wraps the existing single-token Slack lane. Managed OAuth installation
routing, token fencing and revocation remain in the existing installation modules.
Do not substitute a global bot token into a managed installation path.

The adapter supports threads, message edits and approval buttons. Reactions, files,
modals, typing and streaming are false until their port operations are implemented.
`postFile` and `setTyping` reject with `invalid_request`. These declarations describe
this adapter's implemented operations, rather than every feature Slack offers.
Message presentation can carry existing rich blocks and persona hints while the
legacy callers migrate. The special email-card transport remains a compatibility
helper in the adapter folder, reached through the neutral
`postApprovalNotification` operation, because its delivery semantics differ.

For identity, inject `slackIdentityResolver(env, nativeMember, teamId)` as the
adapter's `resolveUser` dependency. It reuses existing current coworker bindings
and membership checks on each lookup, matches the exact Slack team and user, and
returns the native workspace/user/account. Without that scoped resolver, lookup
returns null. Identity is a lookup, never an execution or approval grant.

The inbound union includes install/uninstall for future adapters. Slack uninstall
callbacks are normalized; OAuth installation completion remains owned by the
existing native installation flow and does not fabricate an inbound callback.

## Follow-up checklist

For Discord and Telegram, each adapter needs:

- Its own signature or webhook-secret verification before parsing any content.
- Tenant/conversation/thread mapping that preserves exact source scope.
- Current native identity bindings and independent approval actor authorization.
- Message receipts, edit behavior, approval pointer round trips and error mapping.
- Honest capability flags and documented required secrets.
- A passing contract suite and vendor route tests preserving acknowledgment codes.

Separate work can migrate canvas, buffer, collaboration persistence and managed
installation paths through additional domain ports. This extraction keeps their
existing source and authorization contracts intact.
