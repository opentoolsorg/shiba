# Repository structure

```text
apps/
  backend/           Cloudflare Worker: API + static host, DOs, sandbox control
  frontend/          React dashboard (TanStack Start SPA at /app)
  web/               Astro docs and marketing site
packages/
  shared/            Boundary contracts: run events, schemas, MCP types
  openconnector-read-gateway/
                     Worker-only policy/transport for bounded integration reads
  sdk/               Generated SDK + OpenAPI surface
scripts/             Deployment, image, and daemon entry points
.agents/skills/      Task instructions for coding agents (e.g. shiba-ui-polish)
docs/                Topic docs; architecture notes live under docs/architecture/
spec/                Product contract (GOAL.md)
```

`apps/backend` owns every runtime surface: ingress routes, the DO classes,
sandbox lifecycle and the egress proxy. `apps/frontend` renders the dashboard
and cannot call provider APIs directly; the Worker proxies every model and
integration call so credentials stay at the egress boundary. `packages/shared`
holds only types that cross a Worker/package boundary — the same rule OpenBot
applies to its contracts package. Backend domain ownership is mapped file by
file in [SOURCE-LAYOUT.md](../SOURCE-LAYOUT.md).

## The one-paragraph version

A single Cloudflare Worker is both the **API** and the **static host** for the
React dashboard. **Durable Objects** hold coordinated state — the orchestrator
conversation, coding sub-agent, per-run sandbox control, automations, mailbox,
memory, model config, session chat rooms, and other per-user services. The MCP
gateway is stateless (`createMcpHandler` per request), not a DO. Work happens in an
**ephemeral Sandbox container** (one per run, destroyed at the end) that either clones a GitHub repository or initializes an empty artifact workspace. It executes one selected harness. Nothing starts until a human approves it, and the container's outbound network is allowlisted per run. Read-only Explorer and Reviewer facets inspect explicit snapshots without starting a sandbox. Publication requires a separate human approval of the completed immutable file snapshot.

---

## Layer breakdown

| Layer | Lives in | Responsibility |
|---|---|---|
| **Ingress** | `index.ts` (router), `slack-routes.ts`, `public-routes.ts`, `sandbox-routes.ts` | Auth per surface, then dispatch. Auth is **per-surface by design** — see §5. |
| **Orchestration** | `agents/orchestrator.ts`, `automation-runner.ts` | Plans, exposes `delegate_coding_task`, queues approvals. Never touches a repo. |
| **Execution** | `agents/opencode-agent.ts`, `harness/*`, `sandbox.ts`, `sandbox/lifecycle.ts` | Clone → exec harness → collect. Exactly one harness per run. |
| **Egress control** | `egress.ts`, `sandbox.ts` (`allowedHosts`) | Deny-by-default; per-harness host list; TLS interception; scoped GitHub token. |
| **State** | DO classes, D1 stores, private R2 objects | DOs coordinate agent/runtime state. D1 owns native membership, versioned policy, source bindings and action receipts. R2 holds private artifacts. |
| **Presentation** | `apps/frontend` (dashboard), `apps/web` (docs/marketing) | React dashboard; Astro docs. Both served via the Worker's `ASSETS` binding. |
| **Deploy** | `alchemy.run.ts` (primary), `wrangler.jsonc` (rollback) | Both declare the same stack; wrangler remains a working rollback path. |

The Teams bot binds a single Azure tenant to one native workspace. The
Connector JWT gates installation and activity intake; D1 retains the active
connection generation and the exact reply destination per task. The Worker
obtains and attaches the Connector token for status, card, and result delivery.

**Three deployment facts that matter:**

1. **Two deploy paths, one stack.** `alchemy.run.ts` and `wrangler.jsonc`
   declare identical bindings. Live stages pin resource names so the first
   alchemy deploy *adopts* wrangler-managed resources in place rather than
   replacing them.
2. **Static assets come from the Worker.** One host serves API and UI; there is
   no second deployment target.
3. **Secrets never enter the container.** The container gets a dummy key; real
   provider credentials are injected at AI Gateway egress only.

