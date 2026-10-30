# Employee-scoped MCP tool policy

The backend provides a fail-closed selection, bounded discovery, and
pre-dispatch policy adapter for registered Shiba MCP tools. Capability IDs use
the exact form `mcp:shiba:<registered_tool_name>`. A selection is an
intersection of registered handlers, the current workspace grant, the current
actor grant, the employee role grant, the versioned employee selection, and
the authenticated principal's existing MCP scopes. Discovery is capped at 50
entries and reuses the existing 12 KB / 64-field schema limits and schema
fingerprints.

At dispatch, `dispatchEmployeeTool` recomputes the intersection and requires
the current employee version and exact current connection/resource grant for
the capability, action, account and resource. Provider actions also require
live verification and provider scopes; reviewed internal adapters use stored
Shiba grants. External writes require (for
external writes) a fresh approval whose employee ID/version still match and
whose SHA-256 digest matches the canonical arguments passed to the registry.
Revoked or stale grants and unsupported
actions fail closed. The adapter then delegates to `ToolRegistry.invoke`,
which performs its existing principal scope check, durable receipt handling
and audit.

## Authenticated local workflow

`GET /api/employee-tools/:employeeId/policy` reads the versioned selection and
resource grants for the authenticated workspace. `PUT
/api/employee-tools/:employeeId/policy` stores a versioned employee
selection, actor membership/role, and exact resource grants in D1. This is an
internal Shiba policy setup endpoint; it stores no provider credentials and
only accepts actions with an explicit reviewed policy (`run_status`,
`queue_run`, `send_email`). Empty `resourcesByCapability` revokes every grant
for that actor by advancing the employee version. Workspace, actor, and role
rows all need to name the same resource before dispatch.

`POST /api/employee-tools/:employeeId/call` requires a verified MCP agent
bearer. `run_status` is dispatched as a resource-bound, read-only tool.
`queue_run` and `send_email` create a persisted action approval before calling
their existing registered handlers. `GET /api/employee-tools/approvals`
returns the frozen payload for review; `POST
/api/employee-tools/approvals/:approvalId` records the authenticated human
decision. Repeating the exact approved call goes through the existing durable
capability invocation fence; altered payloads need a separate approval. For
`queue_run`, the existing orchestrator still creates its own pending run
approval, so the coding job cannot start from this employee-tool approval
alone.

No provider connection or credentials are provisioned by this workflow. The
two write-capable adapters only queue the existing Shiba approval flows; no
third-party write was run as part of validation.

## Orchestrator / gateway integration contract

The authenticated call endpoint resolves the current verified `TokenRecord`,
employee version, membership, role grants, resource grant and approval from
trusted stores. No policy object is accepted from tool-call JSON. The general
`/mcp` registry and coding-run harness do not yet automatically inherit an
employee selection; callers use the explicit employee call endpoint until an
orchestrator-owned employee session is added:

1. Resolve the authenticated principal and workspace membership.
2. Load the current employee config/version and role grants from trusted
   storage; interpret `toolScopes` as namespaced IDs, never as provider scopes.
3. Resolve current workspace/actor/role capability grants and the exact live
   provider connection/resource grant.
4. Build discovery with `buildEmployeeToolCatalog(authority)`.
5. For a tool call, pass the registered registry, current authority, selection,
   connection policy/grant and stored exact-payload approval to
   `dispatchEmployeeTool` immediately before dispatch.

The standard custom-agent create/update routes still reject nonempty
`toolScopes`; configure them through the employee policy endpoint so the
versioned selection and D1 grants change together. The policy and approval
stores are tested against local SQLite fixtures, and the route workflow uses a
deterministic orchestrator stub. No live provider connection or third-party
write is configured by this path.
