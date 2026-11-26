# 0008 — One approval service on D1 with a CAS resolve

## Context

Seven approval code paths exist today: `apps/backend/src/approvals-routes.ts`,
`apps/backend/src/collaboration-approval-routes.ts`,
`apps/backend/src/slack-approval.ts`, `apps/backend/src/email-approvals.ts`,
`apps/backend/src/pr-publish-approval.ts`,
`apps/backend/src/pending-approvals.ts` and
`apps/backend/src/approval-resolve-auth.ts`, plus
`OrchestratorState.pendingApprovals`
(`apps/backend/src/agents/orchestrator.ts` line 287). The D1 table
`workspace_app_approvals` (`apps/backend/migrations/0010_workspace_integrations.sql`)
already carries `input_hash`, `expires_at` and `decision_role`, proving the
shape works. Approval is invariant 1 of the product contract — it cannot fork.

## Options

- **(a) Approvals in DO SQLite per thread** — loses: cross-surface "my
  approvals" lists and `(kind, risk)` → role policy checks are relational.
- **(b) D1** — chosen: a single-row CAS is atomic in D1 and in any SQL store.

## Decision

(b). `apps/backend/src/approvals/` (planned: service, policy, repo, renderers).
The `approvals` table stores the frozen `payload_json` (canonical, sorted keys)
with `payload_sha256` computed at creation; the card renders exactly that
payload. Resolve is
`UPDATE approvals SET status=?, decided_by=?, … WHERE id=? AND status='pending' AND expires_at > now` —
atomic across surfaces, so a double click in Slack and on web at the same
moment is safe. At dispatch the hash is *recomputed* from the actual tool
input, the row re-read, and status/role/connection/expiry re-checked before a
`consumed` CAS marks it single-use. `policy.ts` maps `(kind, risk)` to a
minimum role plus an optional four-eyes rule; unlinked external identities
cannot approve. From the first release, **D1 is the only store that decides** —
the seven files become thin surface handlers, and the orchestrator blob's
`pendingApprovals` is written only as an audit mirror until the split
(ADR-0006), never read for a decision again.

## Consequences

- One D1 round trip per decision.
- Reversal cost: low for rendering/handlers (flag restores legacy code that
  still calls the service); there is deliberately no path that makes the blob
  authoritative again — two deciding stores is how you get double dispatch.
