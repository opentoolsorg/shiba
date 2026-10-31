# Employee tool policy

The dashboard's **Tool policy** page configures registered MCP tool calls for an existing bot profile. It reads the employee directory, active `/api/agents` MCP principals, versioned `/api/employee-tools/:id/policy` grants, and the pending approval queue from the authenticated Worker API.

Available actions are intentionally limited to:

- `gmail_read`: read only exact Gmail message IDs selected by an authenticated owner in the policy UI. The owner searches the connected account, sees message metadata, and selects IDs; each selection is bound to that Gmail connection and expires if not saved before discovery expires. A message grant does not grant a thread or mailbox search. Disconnection or a changed grant blocks future reads.
- `run_status`: read the status of a listed run ID.
- `queue_run`: request a coding run for a listed repository URL; each exact argument payload requires approval.
- `send_email`: request a send from a listed mailbox; each exact argument payload requires approval.

Grants are replaced as one version-checked set and are scoped to the selected employee profile, actor, role, capability and exact resource values. The actor selector includes the authenticated dashboard identity for normal employee chats and active MCP principals for token-authenticated calls. Normal chat execution binds to the user encoded in the verified web-session name and refuses a grant configured for a different actor. Clear all actions and save to revoke the current grants; an explicitly managed empty policy stays deny-all and does not restore broad legacy Code Mode. Profiles that have never had a managed policy retain their legacy workflow. A changed payload, employee version, resource grant, or connection generation does not reuse an earlier approval. The approval page displays the stored payload so the operator can inspect it before deciding.

For a selected custom-agent employee in a normal orchestrator thread, the Worker exposes `employee_tool_catalog` and `employee_tool_call` in place of broad Code Mode. The catalog projects only currently selected actions and exact resources; every call reloads profile version, the thread owner's actor membership, role, grants and registry scopes. The external MCP `/api/employee-tools/:id/call` uses the same dispatch boundary and continues to require the caller's verified bearer token.

This policy governs only those Worker-side app tools (`gmail_read`, `run_status`, `queue_run`, `send_email`). The selected-resource UI currently supports Gmail only; Slack, GitHub, Linear, and other integrations do not receive new employee read grants from this work. Existing direct Gmail MCP grants remain separately owner-authorized account-level grants. This policy does **not** constrain shell or CLI tools inside a coding harness, add an MCP bearer token or provider credential to a sandbox, or narrow arbitrary code executed by the harness. Those harness capabilities remain governed by the existing sandbox and egress controls. Unsupported Shiba app actions remain unavailable through employee dispatch.

Write approvals are bound to employee ID/version, actor, exact payload, resource, connection generation and, for normal employee-thread calls, the orchestrator session name. An approved write that expires before dispatch can be requested again for fresh consent. Once a durable invocation receipt exists, the old call only returns that receipt (including in-progress or unknown outcomes) and is never dispatched again. A profile-policy version change invalidates a queued coding-run approval and requires requeueing.

## Local verification

`apps/frontend/src/components/EmployeeToolPolicyView.test.tsx` covers dashboard request shapes and selected Gmail IDs using a deterministic local fetch adapter. Backend tests use local D1 and deterministic handlers to cover the normal `beforeTurn` selection after grant setup and revoke, unused-approval reconsent past TTL, and consumed/unknown receipt replay fences. Gmail tests use mocked Google responses for metadata-only discovery, owner/connection scoping, exact selected-message reads, denied grants, revocation checks before and after a provider read, and disconnected connections. These tests do not read a live inbox, send email, call a live MCP client, invoke a model/provider, start a sandbox or create a real coding run.
