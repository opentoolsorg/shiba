# 0013 — A declarative route table with one auth mode per route

## Context

`apps/backend/src/index.ts` (764 LOC) chains `handle*` modules; each module
re-derives identity and re-checks auth its own way. Identity resolution is
spread across ~48 files, with `apps/backend/src/request-auth.ts` holding the
exemptions (`OPEN_DASHBOARD` at line 107), plus `org-request-auth.ts` and
`approval-resolve-auth.ts`. Invariant 5 requires per-surface authentication —
a concentration point for auth logic is exactly what must not drift.

## Options

- **(a) Keep the handler chain** — loses: auth is re-checked per handler and
  there is no single place to audit which mode a route runs under.
- **(b) Adopt Hono** — loses: a new dependency for something `URLPattern`
  already does natively in Workers.
- **(c) Our own `URLPattern` table** — chosen.

## Decision

(c). `apps/backend/src/http/routes.ts` (planned) is one array of
`{ method, pattern: URLPattern, auth: AuthMode, rateLimit?, handler }`.
`AuthMode` is one of `"public" | "session" | "access-jwt" | "session-or-access"
| "bearer:mcp" | "bearer:local" | "oauth:mcp" | "webhook:slack" |
"webhook:teams" | "webhook:github" | "webhook:linear" | "webhook:discord" |
"webhook:telegram" | "webhook:sentry" | "internal-signed" | "legacy"`. The
principal is resolved once in `http/auth.ts` (planned, built out of
`request-auth.ts`) and passed as `ctx.principal`. A request matching no route
gets a 404; exempt paths get an explicit `public` mode instead of counting as
"authenticated". A test asserts every route has a mode and that no `public`
route reaches the vault, approvals or the OpenConnector gateway.
`OPEN_DASHBOARD=1` becomes one `public` static route allowed only when
`stage !== "prod"`. Migration is order-preserving: all handlers are first
wrapped as `{ auth: "legacy" }` in their current order (no behavior change),
then converted group by group; `legacy` is deleted when the count reaches zero
and CI fails if the count goes up.

## Consequences

- We own the matching, which is small; no new dependency; adoption is gradual
  and each group reverts independently.
- Reversal cost: low.
