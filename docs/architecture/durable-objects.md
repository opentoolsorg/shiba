# Durable Objects and state

## State map

| DO | Owns | Migration |
|---|---|---|
| `CodingOrchestrator` | conversation, approval, retained-run state, and additive logical task/attempt lineage; `delegate_coding_task` | v1 |
| `OpenCodeAgent` | the sandbox-side coding agent session | v1 |
| `Sandbox` | container lifecycle for one run | v1 |
| `Automations` | automation records, dedupe, daily budget | v2 |
| `Mailbox` | inbound email | v3 |
| `Memory` | banked facts (+ Vectorize embeddings) | v5 |
| `Waitlist` | signups | v6 |
| `ModelConfig` | model connections + purpose policy | v7 |
| `LocalDispatch` | local-runtime dispatch mailbox: pending/claimed/settled run envelopes | v9 |
| `ConversationRoom` | per-owner/session presence, typing, room messages, and persisted live assistant streams | v15 |

With `SHIBA_SCOPED_DO=1`, authenticated automation API calls select the
workspace's `Automations` instance. The legacy root is a directory and ingress
fan-out, not a schedule executor. It registers workspaces on first use and
lazily registers `self-hosted` for deployment-wide ingress. Only `self-hosted`
imports legacy shared records; team workspaces initialize empty. Verified
webhooks and scheduled ticks dispatch to that durable registry. Workspace and
thread name components are encoded to avoid collisions; existing private
user/session and Slack thread identities are retained.

Scheduled ticks carry a five-minute slot. Workspace instances serialize ticks
and remember completed slots across eviction; schedule occurrences also retain
stable command IDs so retried queue delivery reuses the orchestrator receipt.
The scope flag is an ownership cutover, not replication: the old root is not
kept in sync with workspace writes. Rollback after live writes requires a
deliberate state restore, not simply disabling the flag.

The flag defaults OFF. MCP run, screen, and email-approval tools and public
API-key run reads use the authenticated token's organization/workspace, never
request-body scope. Slack slash commands use the signed Slack team and command
channel scope; approval buttons resolve that same thread instance. The shared
trigger bearer and dashboard mailbox sends have no workspace identity and use
`self-hosted`. Local dispatch, cancellation, and Reason Network companion
lookups use the authenticated/frozen owner; legacy ownerless jobs retain the
default owner mailbox. Draft sweeps enumerate every team workspace through the
existing workspace store plus `self-hosted`, and report each workspace failure
without preventing the others from sweeping.

Enable `SHIBA_SCOPED_DO=1` only on new deployments or after draining pending
approvals, runs, and local dispatch claims. Existing CodingOrchestrator
`"default"` state is NOT migrated into scoped instances (the automation-root
import described above is separate). Before any scoped writes, rollback is
simply removing the flag. After scoped writes, drain scoped work and deliberately
restore/export the desired state before disabling it: disabling switches new
requests back to the old default state and does not merge scoped history.

Orchestrator state responsibilities live in `agents/orchestrator-runs.ts`,
`orchestrator-approvals.ts`, `orchestrator-slack.ts`,
`orchestrator-reviews.ts`, and `orchestrator-sessions.ts`.
`orchestrator-state-sql.ts` adapts the SDK's SQL state-row boundary: collection
members occupy separate DO SQLite rows, while the SDK row retains scalar
metadata and a collection manifest. Legacy snapshots migrate transactionally
on first read, independently of the scope flag. Memory state and SDK broadcasts
still expose the full logical projection. Writes commit collection changes and
their manifest together; missing manifests, missing collection rows, and invalid
JSON fail closed rather than resetting retained work. Interrupted review
publication recovers as unknown, without repeating the external publication.

Logical task history is an additive `tasks` projection on each existing
`CodingOrchestrator`, backed by the same collection store, not a new DO. Existing
run IDs and `/api/runs` remain canonical; unlinked retained runs are backfilled
as one-attempt legacy tasks on task-history reads. Frozen approval snapshots
stay in orchestrator state and are omitted from the authenticated history DTO.

Migration tag **v4** created `McpGateway`. T29a moved the MCP gateway to a
stateless `createMcpHandler` server (`mcp-gateway.ts` builds an SDK v2
`McpServer` per request — same tools, scopes and D1 audit trail, no DO). The
append-only **v8** migration deletes the now-unused class and namespace.

**P9 event spine** (PLAN-V2-NEXT): inside `CodingOrchestrator`, run
mutations flow `decide → appendEvents → apply` — a schema-validated
`RunEvent` log (`packages/shared/src/events.ts`) with per-DO `seq` and
`commandId`/`causationId` threading, a pure projector
(`projector.ts`), and an effect outbox (`orchestration/outbox.ts`) the
`reclaimRuns` path drains on every wake so post-backs owed survive a
restart (at-least-once — a send that landed before the crash can repost
once). `GET /api/spine` on the DO serves events + owed outbox for the
dashboard's Activity feed; agent principals see only events on runs
they queued.

**Supporting stores** (not DOs): **R2** `ARTIFACTS` (private ZIP bundles), `ATTACHMENTS` (email bodies, text deliverables, and private publication staging) ·
**KV** `AGENT_TOKENS` (bearer tokens, keyed `tok_<sha256(raw)>`) · **D1**
`AGENT_AUDIT` (MCP call audit) · **Vectorize** `MEMORY_VECTORS` (768-dim recall).

**Throughput ceiling:** `max_instances: 5` (`wrangler.jsonc`, mirrored as
`maxInstances` in `alchemy.run.ts`) is a hard cap of five concurrent sandbox
runs. It is product-visible — "how many tasks at once" is answered here, not
in marketing copy.

---
