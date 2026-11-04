# Extensions contract

This document inventories shared schemas, including planned records. Only the
extension-skills registry currently implements the scope/archive lifecycle below.
The dashboard uses the reviewed `/api/v1/mcp/servers` registry for remote MCP and
the authenticated `/api/integrations/provider/*` routes for private OpenConnector
accounts. Generic extension MCP/connector schemas and tables do not implement
alternate API routes or workspace-owned app credentials. See
[current integration readiness](integrations-readiness.md) and
[package boundaries](integrations-architecture.md) for runtime authority.

The shared extension schemas model Overlay's `personal` / `workspace` scope and
`personal` / `workspace` / `archived` views. Skills, MCP servers, and
planned OpenConnector workspace bindings share pure archive, restore, and scope-move rules.
Archived rows remember `archivedFromScope`; restoring returns the row to that
scope. The schema's MCP archive plan also disables the server, matching Overlay's
`mcpServers` lifecycle. Shared Zod records and the pure scope planners live in
`packages/shared/src/extensions/` for Worker stores and API DTOs to reuse.

## Overlay mapping

| Overlay record | Shiba contract / D1 table | Notes |
| --- | --- | --- |
| `skills` | `Skill` / `extension_skills` | Shiba's existing `skills` and `skill_versions` tables store reviewed, versioned authored skills, so extension rows use a separate table. |
| `mcpServers` | `McpServer` / `mcp_servers` | Reserved server-side encrypted auth/OAuth fields. DTOs exclude credentials. The active reviewed registry is separate. |
| `workspaceConnectors` | `WorkspaceConnector` / `workspace_connectors` | Planned scoped binding to OpenConnector `providerKey` and `connectedAccountId`; it does not implement shared credential ownership or execution. Other members' DTOs omit the account ID. |
| `mcpOAuthSessions` | `McpOAuthSession` / `mcp_oauth_sessions` | One-use PKCE state with an encrypted verifier and optional browser session binding. |
| `mcpToolExecutions` | `McpToolExecution` / `mcp_tool_executions` | Audit metadata stores `argumentsHash`, never tool arguments. |

Overlay's Convex document IDs become string IDs in D1. Timestamps remain epoch
milliseconds. Optional legacy `scope` values read as `personal`; new writers
should persist the resolved scope. `scopeMutations` plans patches without
database or Cloudflare dependencies, leaving authorization context loading and
the actual D1 write to backend stores.
