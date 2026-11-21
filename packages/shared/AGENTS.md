# `packages/shared`

Browser-safe wire contracts: run event types, Zod schemas, MCP and tool
payload shapes, `SHARED_COMPUTER_LIMITS`. Everything here is a contract that
backend, frontend, and the sandbox image already implement — a change is paid
for by code you may not be editing.

## Rules (the OpenBot contracts rule, applied here)

- Put a type here only when it crosses a package boundary: Worker ↔
  dashboard, Worker ↔ sandbox, Worker ↔ MCP client. Internal types stay in
  the app that owns them.
- Validation lives beside the schema it validates; keep it pure — no Worker
  bindings, provider clients, credentials, or application source imports.
- Released wire shapes are frozen. Add fields, don't repurpose them; a
  semantic change to a shape a shipped client parses is a protocol change —
  version it.
- New limits/capabilities that both sides must agree on land here (that is
  why `SHARED_COMPUTER_LIMITS` is here, not in the backend).
