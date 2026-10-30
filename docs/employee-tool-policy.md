# Employee tool policy

The dashboard's **Tool policy** page configures registered MCP tool calls for an existing bot profile. It reads the employee directory, active `/api/agents` MCP principals, versioned `/api/employee-tools/:id/policy` grants, and the pending approval queue from the authenticated Worker API.

Available actions are intentionally limited to:

- `run_status`: read the status of a listed run ID.
- `queue_run`: request a coding run for a listed repository URL; each exact argument payload requires approval.
- `send_email`: request a send from a listed mailbox; each exact argument payload requires approval.

Grants are replaced as one version-checked set and are scoped to the selected employee profile, active MCP actor, role, capability and exact resource values. Clear all actions and save to revoke the current grants. A changed payload, employee version, resource grant, or connection generation does not reuse an earlier approval. The approval page displays the stored payload so the operator can inspect it before deciding.

This policy governs calls through employee MCP dispatch only. It does **not** add or broaden the tools, provider credentials, or scopes available to coding-run agents. Unsupported tool actions remain rejected. The dashboard does not contain a direct call runner or store bearer tokens; the requesting MCP client retries the unchanged call after approval.

## Local verification

`apps/frontend/src/components/EmployeeToolPolicyView.test.tsx` covers the real dashboard request shapes using a deterministic local fetch adapter: load principals and employees, save exact-resource grants, load a pending approval, and approve its exact payload. `apps/backend/test/employee-tool-routes.test.ts` exercises the Worker routes end to end with deterministic registered tools and local D1 bindings: configure grants, request approval through the employee call route, decide it through the dashboard approval route, reject a changed payload, dispatch the approved payload and verify the dispatch receipt. These tests do not send email, call a live MCP client, or create a real coding run.
