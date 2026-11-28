# Shiba product roadmap

> **Current direction, 2026-11-28:** Shiba is an approval-first workspace for
> AI employees, not only a coding-agent runtime. Employees plan, execute inside
> bounded authority, return durable evidence, and wait for separate human
> approval before external effects. The canonical product contract is
> [`docs/product/ai-employees.md`](../product/ai-employees.md); system shape is
> [`ARCHITECTURE.md`](../../ARCHITECTURE.md).
>
> This roadmap is forward-looking. It is not evidence that a feature is live.
> Dated proof stays in [`docs/verification/verification.md`](../verification/verification.md).

## Product direction

1. **Employee-first, not harness-first.** Harnesses and sandboxes are execution lanes. The product center is a durable employee with goals, plans, permissions, outputs, and review.
2. **Shared workspace.** People and bots collaborate with explicit membership, scoped context, visible parent/child work, and no identity merging.
3. **Channel-native work.** Slack, Discord, Microsoft Teams, Telegram, email, MCP clients, and the dashboard can initiate work, but every surface enters the same approval and evidence spine.
4. **Usage-based credits.** Credits measure work done, not seats. Billing must remain understandable, capped, and separable from user-funded provider lanes.
5. **Honest verification.** A template, icon, connection, fixture, or model response is partial progress. Completion requires dated executable evidence against the real surface.

## Current proof boundary

| Foundation | Current status | Not yet proof of |
| --- | --- | --- |
| Approval and repository execution spine | Substantial local/unit/browser evidence; deterministic fixtures cover important contracts. | Live cloud model + container + GitHub execution. |
| Employee profiles and templates | Coding, Marketing, Research, and Operations templates exist; Marketing has bounded fixture-driven journey evidence. | Four complete live employee-role journeys. |
| Workspace collaboration | Team rooms, membership, context, and handoff foundations exist. | A complete multi-bot goal with scoped child work, failure, cancellation, restart, and cross-workspace denial. |
| Slack | Signed commands, mentions, approvals, thread continuity, outcome replies, file delivery, and room mirroring exist in code/docs. | P3 live workspace verification. |
| Discord | Signed command/interactions, approvals, and outcome replies exist in code/docs. | Feature parity with Slack continuation, files, and room workflows. |
| Microsoft Teams | Signed Bot Framework intake, Adaptive Card approvals, workspace connection controls, and outcome replies exist in code/docs. | Publication approvals, reactions/history/uploads, and Slack-level parity. |
| Workspace credits | Stripe top-ups, append-only debits, refunds, balance enforcement, pending spend, and portal access exist. | Plan subscriptions, monthly grants, rollover, free credits, auto-top-up, or per-user plan caps. |
| Visual system | `design.md` now describes the target neutral workspace contract. | Completed migration of every web and dashboard surface. |

## Ordered roadmap

### 1. Prove the live execution baseline

**Why first:** every employee, channel, and billing promise depends on the execution spine being real.

**Acceptance:** one dated verification entry shows an owner-approved real repository task on an operator-owned deployment: clone, execute, collect actual diff/files, run relevant checks, reject/cancel paths, honest failure exit, and optional PR publication. Record cost, memory, runtime, and remaining gaps.

**PR-sized slices:**

1. Rehearse the exact acceptance flow locally and fix blockers.
2. Run the owner-hosted cloud acceptance flow and record evidence.
3. Turn repeated manual setup into a readiness checklist or script.

### 2. Complete the shared employee workspace spine

**Why:** the product contract requires goals and collaboration, not isolated runs.

**Acceptance:** a multi-bot workspace goal has explicit membership, a lead employee, at least two child assignments, scoped context, durable returned outputs, parent/child state after restart, human review, a blocked or failed child, cancellation/retry, and denied cross-workspace access.

**PR-sized slices:**

1. Goal/task ownership ledger and read model.
2. Versioned plan and deliverable lineage.
3. Scoped employee/resource grants.
4. Parent/child state projection and reviewer controls.
5. End-to-end collaboration acceptance evidence.

### 3. Reach Slack, Discord, and Teams channel parity

**Why:** people should be able to start and review work where they already collaborate without learning three different product models.

**Current fit:** the channel port already exposes explicit capabilities instead of pretending every platform supports the same actions. Slack is the richest surface; Discord and Teams are narrower.

**Acceptance:** one shared channel contract covers intake, clarification, exact approval, progress, result, files where supported, thread/conversation continuity, rejection, duplicate-click safety, revoked access, and unsupported-capability messaging. Each channel either passes the behavior or explicitly reports why the platform cannot support it.

Detailed phasing lives in [`docs/plans/credits-and-chat-channels.md`](./credits-and-chat-channels.md).

### 4. Add plan-based workspace credits

**Why:** prepaid top-ups are useful but do not answer the product question people expect from an AI employee workspace: what do I get each month, what rolls over, what happens when work spikes, and how do I cap spend?

**Target direction, adapted rather than copied:** starter credits for evaluation, shared workspace plan credits, paid credits that do not expire unexpectedly, clear rollover rules, on-demand top-ups, monthly spend caps, and enterprise controls such as invoicing, security review support, and per-user caps. Do not copy another vendor's exact prices or integration claims.

**Acceptance:** the ledger distinguishes purchased top-ups, included plan grants, rollover, refunds, pending holds, and debits; Stripe subscription state cannot double-credit a redelivered webhook; the dashboard explains the balance in plain language; run enforcement remains fail-closed.

Detailed phasing lives in [`docs/plans/credits-and-chat-channels.md`](./credits-and-chat-channels.md).

### 5. Complete the four employee-role journeys

**Why:** role names are not product completion.

**Acceptance:** Coding, Marketing, Research, and Operations each pass goal → plan → approval → execution/delegation → durable deliverables → verification → review → follow-up. Research and Operations must use their own permitted sources and action receipts, not relabeled coding prompts.

**PR-sized slices:**

1. Behavior-level acceptance matrix per role.
2. Research source/citation verification journey.
3. Operations mailbox/event triage journey.
4. Coding live-model journey.
5. Follow-up/recurrence controls tied to the originating goal.

### 6. Migrate the interface to the neutral workspace design

**Why:** `design.md` now selects the Overlay-inspired neutral workspace direction. The older cream/navy paper-OS language is migration debt, not the target product identity.

**Acceptance:** dashboard, docs, and marketing surfaces use the same token contract, with no hard offset shadows, pixel chrome, dot-grid default background, or navy accent as the default product language. Visual changes carry screenshots in QA.

**PR-sized slices:**

1. Token alignment in `apps/frontend`.
2. Docs/marketing token migration in `apps/web`.
3. High-traffic screen polish: agents, work, approvals, integrations, billing.
4. README/screenshots refresh after the UI settles.

### 7. Revisit desktop after the web workspace is proven

**Why:** desktop amplifies the product only after the workspace contract and live execution baseline are stable.

**Acceptance:** a signed desktop shell can log in, show the same workspace state, hand off browser/computer control safely, and survive update/restart without widening authority.

## Explicitly not live-verified

Keep these statements in sales, docs, and investor/user conversations until dated evidence says otherwise:

- End-to-end real sandbox container + live model + live GitHub on an operator-owned Cloudflare deployment.
- Slack P3 live workspace verification.
- Discord and Teams live workspace verification beyond local/unit/fixture evidence.
- ComputeSDK providers such as E2B, Daytona, and Modal for production egress invariants.
- Shiba Desktop signed-app execution.
- Multi-round review loop endpoint behavior.
- Plan subscriptions, monthly credit grants, rollover, auto-top-up, and enterprise billing controls.

## Where to look

| Question | Document |
| --- | --- |
| Product acceptance contract | [`docs/product/ai-employees.md`](../product/ai-employees.md) |
| Chat/credits implementation sequence | [`docs/plans/credits-and-chat-channels.md`](./credits-and-chat-channels.md) |
| Historical task tracker | [`docs/plans/plan.md`](./plan.md) |
| Dated evidence | [`docs/verification/verification.md`](../verification/verification.md) |
| Open verification gaps | [`docs/verification/verification-plan.md`](../verification/verification-plan.md) |
| Visual target | [`design.md`](../../design.md) |
| Feature-plan format | [`docs/plans/README.md`](./README.md) |
