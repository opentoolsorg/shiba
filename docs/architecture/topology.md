# Topology

## Worker topology

```
                        ┌───────────── ingress (one Worker) ─────────────┐
   Dashboard  ────────► │  /api/*  authenticated (Cloudflare Access, or  │
                       │  built-in email+password lane at /api/auth/*)  │
   Slack / Discord  ──► │  /api/slack/*, /api/discord/*  signature-verified│
   Microsoft Teams  ──► │  /api/teams/messages  Bot Connector JWT        │
   Telegram  ─────────► │  /api/telegram/*  header-secret                 │
   Email  ───────────► │  /api/emails, /api/drafts  provider-verified    │
   Cron (5 min)  ────► │  automations trigger sweep                      │
   GitHub  ──────────► │  /api/github/webhook  signature-verified        │
   MCP clients  ─────► │  /mcp  bearer token  (OAuth: planned, T29)      │
   Agents (WS)  ─────► │  /agents/*, /internal/*                         │
                        └────────────────────┬───────────────────────────┘
                                             ▼
   ┌──────────────────── Durable Objects (all state) ───────────────────────┐
   │  Employee Orchestrator — plans and delegates; never edits              │
   │  OpenCodeAgent       AIChatAgent — sandbox-side execution sub-agent    │
   │  Sandbox             container lifecycle per run                       │
   │  Automations         cron/webhook/event triggers, budget, kill switch  │
   │  Mailbox             inbound email       Memory  banked facts          │
   │  ModelConfig         model conns         Waitlist  signups             │
   │  ConversationRoom    session presence and live chat streams            │
   └──────────────────────────────┬─────────────────────────────────────────┘
                                          ▼  delegate_coding_task (approved)
   ┌─────────────────── Sandbox container — ephemeral, 1 per run ──────────┐
   │  clone (scoped token) → run ONE harness CLI → collect diff → push → PR│
   │  egress: deny-by-default allowlist = that harness's provider host + git│
   │  image pins 6 CLIs; real keys injected at AI Gateway egress, not here  │
   └───────────────────────────────────────────────────────────────────────┘
                                          ▼
   AI Gateway (BYOK) ← Workers AI (planning) ← TypeSafe (run_when)
   GitHub API (PR)   ← R2 (attachments) ← D1 (audit) ← KV (agent tokens)
```



### Integration sibling

`openconnector` is Shiba's sole integrations provider, backed by a separately
deployed, unmodified upstream open-connector Worker. The backend prefers
the `OPEN_CONNECTOR` service binding, with `OPEN_CONNECTOR_URL`
as the HTTP alternative. Admin and runtime tokens stay in backend Worker secrets.
Connection names are `u_` plus the first 16 hexadecimal characters of SHA-256 of
the authenticated owner ID; request-supplied account IDs cannot select another
owner's connection. The sibling owns its own D1 and temporary-file R2 bucket or KV namespace.
Its source and upstream license stay outside Shiba's AGPL source tree.
See [the deployment guide](../OPENCONNECTOR.md) for the separate migration,
secrets, and deployment sequence. The [integration package boundaries](../integrations-architecture.md) describe shared contracts, backend adapters, canonical registries and the separate provisioning boundary.

### Bounded automatic reads and isolated computers

`packages/openconnector-read-gateway` is a Worker-only policy/transport package with no external runtime dependencies. The backend owns native authorization, standing consent, quotas and durable receipts. The optional pinned upstream entry owns its existing encrypted OAuth database and fixed read executors. A separate least-privilege `OPEN_CONNECTOR_READ_RUNTIME_TOKEN` authenticates only the read service binding; it never replaces the existing manual integration runtime token. The reverse binding receives one-purpose signed permits and cannot read Shiba's auth/audit database or signing key. Shared browser-safe contracts stay in `packages/shared`. See [the adapter boundaries and setup](../openconnector-read-adapter.md).

The optional `ComputerSession` class owns a separately approved, offline human desktop; it never attaches to a coding sandbox. Its resource reservation, native audience, scoped one-shot RPC operations and private frames are independent of employee/provider billing. The default stack does not provision its optional namespace/image. [Computer limits and verification](../shared-computers.md) distinguish source/fixture checks from an actual image and Cloudflare run.

[Output archives](../container-replacement-journal-proposal.md) retain an approved native owner's sanitized, externally acknowledged output in room SQLite, with a separate D1 quota/lease reservation. They do not restore destroyed processes, unacknowledged output or uncommitted files, and do not authorize replacement execution.

The BrowserSession DO serializes agent and dashboard operations for one authenticated Chat thread and stores the Cloudflare Browser Rendering session ID for reconnects. Browser access is separate from both local computers and coding containers. Saved browser logins are purpose-bound ciphertext in D1; only an approved Worker-side sign-in on the exact saved HTTPS origin can decrypt them.

