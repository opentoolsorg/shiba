# Employee-scoped MCP tool policy

The backend now provides a fail-closed selection, bounded discovery, and
pre-dispatch policy adapter for registered Shiba MCP tools. Capability IDs use
the exact form `mcp:shiba:<registered_tool_name>`. A selection is an
intersection of registered handlers, the current workspace grant, the current
actor grant, the employee role grant, the versioned employee selection, and
the authenticated principal's existing MCP scopes. Discovery is capped at 50
entries and reuses the existing 12 KB / 64-field schema limits and schema
fingerprints.

At dispatch, `dispatchEmployeeTool` recomputes the intersection and requires
the current employee version, a live connection grant for the exact
capability, action, account and resource, required provider scopes, and (for
external writes) a fresh approval whose employee ID/version still match and
whose SHA-256 digest matches the canonical arguments passed to the registry.
Revoked or stale grants and unsupported
actions fail closed. The adapter then delegates to `ToolRegistry.invoke`,
which performs its existing principal scope check, durable receipt handling
and audit.

## Orchestrator / gateway integration contract

The authenticated gateway already injects a verified `TokenRecord`; the
orchestrator must resolve and pass current records rather than accept policy
objects from tool-call JSON:

1. Resolve the authenticated principal and workspace membership.
2. Load the current employee config/version and role grants from trusted
   storage; interpret `toolScopes` as namespaced IDs, never as provider scopes.
3. Resolve current workspace/actor/role capability grants and the exact live
   provider connection/resource grant.
4. Build discovery with `buildEmployeeToolCatalog(authority)`.
5. For a tool call, pass the registered registry, current authority, selection,
   connection policy/grant and stored exact-payload approval to
   `dispatchEmployeeTool` immediately before dispatch.

The current repository does not yet persist workspace/actor/role capability
grants or employee action approvals, and coding-run approvals are not an
exact-payload connector-action approval store. Therefore current custom-agent
create/update/run routes continue to reject nonempty legacy `toolScopes`;
removing those guards before the resolvers and durable approval record exist
would silently grant no effective policy or tempt a fail-open fallback. The
policy adapter is tested with deterministic in-memory registry dispatch and
connection snapshots; it makes no claim that a live provider connection or
third-party write is configured.
