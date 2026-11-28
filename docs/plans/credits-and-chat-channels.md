# Plan: workspace credit plans and chat-channel parity

**Status:** planned, not started  
**Owner decision date:** 2026-11-28  
**Living docs after implementation:** `apps/web/src/content/docs/docs/costs.md`, channel guides under `apps/web/src/content/docs/docs/`, and the relevant architecture notes

## Problem

Shiba already has two strong foundations:

- prepaid workspace credits through Stripe, with an append-only debit ledger;
- signed Slack, Discord, and Microsoft Teams ingress with approval-first execution.

They do not yet feel like one product. Credits are manual top-ups rather than a clear workspace plan, and each chat surface exposes a different level of task intake, continuation, file delivery, and approval behavior. A user should understand what their workspace includes, what a credit buys, what happens when usage spikes, and what behavior to expect in Slack, Discord, or Teams.

## Non-goals

- Do not copy another vendor's exact prices, credit numbers, integration count, brand, or product copy.
- Do not charge per seat by default. Credits measure work done, not headcount.
- Do not make user-funded provider lanes look like deployment-funded credits.
- Do not pretend Slack, Discord, and Teams support identical platform capabilities.
- Do not add billing or channel implementation in the documentation-only cleanup PR.
- Do not let a plan or subscription bypass existing execution approval, repository scope, publication approval, or credential-boundary rules.

## Current fit

- `apps/backend/src/workspace-billing.ts` owns prepaid top-ups, Stripe webhook settlement, refunds, pending spend, debit insertion, and balance enforcement.
- `packages/shared/src/workspace-billing.ts` owns the Worker ↔ dashboard billing wire contract.
- `apps/frontend/src/components/WorkspaceBillingCard.tsx` presents balance, in-flight spend, top-ups, Stripe Checkout, and the billing portal.
- `apps/backend/src/channels/*/index.ts` owns channel adapters and capabilities. Slack and Discord expose broad post/edit/react/upload/download/history capabilities; Teams intentionally supports a smaller set.
- Channel guides already say what users can do today. New behavior must update those living docs in the same PR.

## Decisions

1. **Credits measure work, not seats.** A workspace balance funds execution and deployment-paid model usage. User-owned provider keys, plan subscriptions, and paired local machines remain visibly separate.
2. **Plans are a layer on the existing ledger.** Do not replace the append-only ledger. Add grant/credit-source semantics so included monthly credits, rollover, top-ups, refunds, and debits remain auditable.
3. **The free evaluation layer is a bounded grant, not unlimited use.** It should let a workspace evaluate real work without sales friction while preserving cost controls.
4. **Paid workspace credits are shared.** A workspace plan pool is the default; per-user or per-run caps are controls on top of that pool.
5. **Rollover must be explicit.** If credits roll over, the ledger records the expiry window. If they do not, the UI says so before purchase.
6. **Channel parity means product parity, not impossible platform parity.** Every surface must support the same intake → approval → progress → result contract where the platform allows it, and must explicitly say when it cannot support a capability.
7. **Slack is the reference implementation only because it is currently deepest.** Discord and Teams should not become Slack clones; they should expose the same product contract through native interactions.

## Phases

### Phase 1 — Credit-plan wire and ledger design

**Scope:** extend shared contracts and backend schema design for credit sources: `included_plan`, `rollover`, `topup`, `refund`, `run`, and `adjustment` or the minimum equivalent model.

**Acceptance check:** migration tests prove webhook redelivery, partial refund, rollover expiry, and concurrent holds cannot double-credit or double-debit a workspace.

### Phase 2 — Stripe subscription checkout and plan state

**Scope:** add plan selection, subscription checkout, webhook settlement, cancellation/downgrade handling, and customer portal deep links. Keep Stripe identifiers Worker-side.

**Acceptance check:** backend tests cover checkout completion, renewal, failed payment, cancellation, downgrade, redelivery, and clock-boundary grant calculation without exposing Stripe ids to the dashboard.

### Phase 3 — Workspace billing UI that explains the plan

**Scope:** update Analytics → Workspace credits to show plan credits, rollover, purchased credits, pending spend, next reset/expiry, spend cap, top-up, and invoice/portal actions in plain language.

**Acceptance check:** frontend tests cover empty, free-grant, active-plan, exhausted, negative-after-refund, and pending-spend states using the shared wire contract.

### Phase 4 — Spend caps and top-up controls

**Scope:** add workspace monthly spend cap, optional per-user cap, optional auto-top-up, and clear kill-switch interaction. Caps are product controls, not a claim that provider invoices cannot exist outside Shiba.

**Acceptance check:** approval/execution tests prove a cap blocks new work before a sandbox starts, does not cancel already settled history, and cannot be bypassed by channel, automation, MCP, or dashboard ingress.

### Phase 5 — Shared channel capability contract

**Scope:** define the product-level channel contract in one place: intake, clarify, exact approval, reject, duplicate decision, progress, final result, files, continuation, room handoff, publication approval, and unsupported-capability notice.

**Acceptance check:** contract tests enumerate Slack, Discord, and Teams capabilities from the real adapters rather than maintaining a separate handwritten matrix.

### Phase 6 — Discord parity slices

**Scope:** close the highest-value Discord gaps first: thread/conversation continuation, result-file delivery where Discord supports it, progress editing, and consistent approval outcome copy.

**Acceptance check:** signed-interaction tests cover approve, reject, duplicate click, non-approver, continuation, file too large, upload failure, and revoked/missing bot permission.

### Phase 7 — Teams parity slices

**Scope:** close the highest-value Teams gaps first: clearer outcome cards, conversation continuity, explicit unsupported publication approval, and file/download alternatives within Bot Framework constraints.

**Acceptance check:** Bot Framework tests cover mention and direct-message intake, Adaptive Card approve/reject, duplicate submit, non-approver, disabled connection, serviceUrl validation, and unsupported-capability messaging.

### Phase 8 — Slack regression consolidation

**Scope:** keep Slack behavior stable while extracting shared channel logic. Do not regress thread continuity, file delivery, room mirroring, or approval semantics.

**Acceptance check:** existing Slack tests plus a cross-channel golden journey prove the same user-visible states and receipts are preserved.

### Phase 9 — Live channel verification

**Scope:** verify one small repository task end to end in each configured channel against a real workspace, with sanitized evidence.

**Acceptance check:** dated verification entries show signed ingress, non-approver refusal, rejection without execution, approval execution, outcome delivery, duplicate-click safety, and redaction. Any platform limitation is recorded as such, not hidden.

## Status

| Phase | State |
| --- | --- |
| 1. Credit-plan wire and ledger design | Not started |
| 2. Stripe subscription checkout and plan state | Not started |
| 3. Workspace billing UI | Not started |
| 4. Spend caps and top-up controls | Not started |
| 5. Shared channel capability contract | Not started |
| 6. Discord parity slices | Not started |
| 7. Teams parity slices | Not started |
| 8. Slack regression consolidation | Not started |
| 9. Live channel verification | Not started |

## References

- [`docs/plans/roadmap.md`](./roadmap.md)
- [`docs/product/ai-employees.md`](../product/ai-employees.md)
- [`apps/web/src/content/docs/docs/costs.md`](../../apps/web/src/content/docs/docs/costs.md)
- [`apps/web/src/content/docs/docs/slack.mdx`](../../apps/web/src/content/docs/docs/slack.mdx)
- [`apps/web/src/content/docs/docs/discord.mdx`](../../apps/web/src/content/docs/docs/discord.mdx)
- [`apps/web/src/content/docs/docs/teams-setup.md`](../../apps/web/src/content/docs/docs/teams-setup.md)
