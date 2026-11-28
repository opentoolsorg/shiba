# Change rules and known gaps


New capability lands in one of four places, and the choice is not arbitrary:

| If the change is… | It belongs in | Because |
|---|---|---|
| A new way in (Slack, Teams, a webhook) | ingress + a lane module | every surface authenticates independently |
| A new agent CLI | `harness/` + Dockerfile + catalog | one image, per-run selection, per-harness egress |
| A new live coordination object | a new DO + a migration tag | DOs serialize live conversations, runs, sessions, and dispatch |
| A new model/provider | `model-connections` / AI Gateway | credentials stay at the egress boundary |
| A new shared workspace/domain record | D1 migration + owning control-plane module | shared durable facts need relational ownership and queries |
| A new execution lane | runtime adapter + approval/evidence contract | lanes differ in runtime, not in authority |

**The cost of adding harnesses is real and ongoing:** each one multiplies the
"a CLI changed its stream format" risk (`docs/plans/plan.md` §16). Treat format changes as
breaking, and pin versions. That is the real marginal cost of the
bring-your-own-agent differentiator, not the first adapter.

---

### Cron job queue rollout

The five-minute cron sends one message per queue-safe task to `shiba-jobs`; consumers run independently with five retries delayed by 60 seconds and a `shiba-jobs-dlq`. Batch size is one so jobs do not share an invocation's CPU budget. The registry is `apps/backend/src/scheduled-jobs.ts`; existing claims and occurrence keys prevent duplicate provider reads and Slack sends. `automations.tick` stays inline: its load/dispatch/merge sequence has no tick-wide claim, so stable command IDs alone do not prove concurrent budget accounting safe.

For an existing Wrangler install, run `pnpm exec wrangler queues create shiba-jobs` and `pnpm exec wrangler queues create shiba-jobs-dlq` in the deployment account before deploying the updated config. Alchemy provisions both queues and the consumer, using the same stage suffix as other resources. No D1 migration is needed.

Queues are optional at runtime: deployments without `JOBS_QUEUE` run each task inline, catching failures independently. To keep that mode on a non-Queues host, omit the jobs producer and consumer entries from its deploy config. A failed queue send is surfaced, not replayed inline, because a partial send may already have accepted jobs.

Rollback: pause the jobs consumer and let active invocations finish; drain or explicitly discard pending jobs before removing the producer/consumer config and `JOBS_QUEUE` binding (or reverting this change). The next cron resumes inline execution. Keep the queues and DLQ until outstanding messages have been inspected; do not replay stale DLQ messages blindly.



Optional operator observability lives in `apps/backend/src/observability.ts`:
Sentry envelopes, anonymous PostHog lifecycle events and OTLP/HTTP JSON delta
counters. All are default-off and explicitly configured through Worker env vars.
The authenticated dashboard relay accepts only enumerated events, never raw
errors or request context. No collector credentials enter browser bundles or
sandboxes. See [configuration](../../apps/web/src/content/docs/docs/configuration.md#optional-monitoring)
for the privacy contract, opt-ins and delivery limits. The inbound Sentry
automation webhook remains separate.

Not bugs — deliberate or inherited, recorded so they are not rediscovered:

- **`/mcp` OAuth is shipped but young.** `oauth-mcp.ts` serves RFC 8414 +
  RFC 9728 discovery, RFC 7591 dynamic registration, `authorize`+PKCE
  (S256 only), `token` exchange with rotating refresh, and `revoke` —
  static bearer tokens still work. The consent surface is new code, so
  treat its edge cases as under-probed rather than settled.
- **Live output has bounded replay.** Rooms persist accepted terminal, status, diff, and child frames. Expired cursors and lost container transport produce explicit gap or uncertainty indicators. Browser reconnect does not resume a lost CLI process.
- **GitHub is the only repo provider — by decision.** The approval gate is
  already provider-agnostic, so adding one later is a provider layer, not a
  redesign. Deferred until GitHub itself is proven live (`docs/plans/plan.md` §17.6).
- **Single deployment owner, not single-person use.** One installation is
  account-owned/self-hosted, while a workspace can have multiple members and
  employees. Do not confuse deployment tenancy with workspace collaboration.
  Changing deployment tenancy is a product decision before any code.
- **Historical specs are not current boundaries.** `spec/GOAL.md` describes the
  original coding-agent spine and is now marked historical. Use it for lane
  history, not for current product scope. `ARCHITECTURE.md` and
  `docs/product/ai-employees.md` own the current boundary.
- **`WORKER_HOSTNAME` empty disables PR screenshots.** Capture fails safe and
  never fails the run — correct failure mode, but T33 is silently dark on any
  deploy that has not set it.
- **`wrangler deploy --dry-run` needs a Docker daemon.** The `CLAUDE.md` gate
  is two-tier: typecheck/lint/test/build runs anywhere; the dry-run tier only
  where Docker is up.
- **No dated live acceptance.** Every capability above is verified by unit
  tests and a dry run, not a recorded cloud run. Until T10's acceptance — and
  the GitHub-specific T37–T39 — are in `docs/verification/verification.md`, the honest status
  stays "local prototype" (§17.9).

---


| To understand… | Read |
|---|---|
| the request pipeline | `apps/backend/src/index.ts` → `agents/orchestrator.ts` |
| how a run executes | `agents/opencode-agent.ts` → `harness/index.ts` → `harness/types.ts` |
| the security boundary | `egress.ts`, `sandbox.ts`, `security.ts` |
| state and persistence | the nine DO classes in §4 (`*-do.ts` plus the agent classes) |
| every ingress surface | `slack-routes.ts`, `chat-lane.ts`, `telegram.ts`, `discord.ts`, `email-handler.ts`, `email-tasks.ts` |
| what is planned and why | `docs/plans/plan.md` (§17 for parity roadmap, §4 for what was cut and why) |

**Do not enable `SHIBA_SCOPED_DO` for personal desktop pairing yet.** Several LocalDispatch callers still resolve the default owner mailbox (`local-routes.ts`, `computers-routes.ts`, `provider-sign-in.ts`) while scoped personal dispatch resolves the account owner, so flag-on daemon routing needs its own review first.
