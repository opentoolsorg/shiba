# Extensions contract

Shiba's extension model follows Overlay's `personal` / `workspace` scope and
`personal` / `workspace` / `archived` views. Skills, MCP servers, and
openconnector workspace bindings share archive, restore, and scope-move rules.
Archived rows remember `archivedFromScope`; restoring returns the row to that
scope. Archiving an MCP server also disables it, matching Overlay's
`mcpServers` lifecycle. Shared Zod records and the pure scope planners live in
`packages/shared/src/extensions/` for Worker stores and API DTOs to reuse.

## Overlay mapping

| Overlay record | Shiba contract / D1 table | Notes |
| --- | --- | --- |
| `skills` | `Skill` / `extension_skills` | Shiba's existing `skills` and `skill_versions` tables store reviewed, versioned authored skills, so extension rows use a separate table. |
| `mcpServers` | `McpServer` / `mcp_servers` | Encrypted auth and OAuth fields are persisted on the server side. List DTOs expose `hasAuth`, policy and catalog metadata, never credential material. |
| `workspaceConnectors` | `WorkspaceConnector` / `workspace_connectors` | A scoped binding to the openconnector `providerKey` and `connectedAccountId`; provider catalog and OAuth remain with openconnector. Other members' list DTOs omit the account ID. |
| `mcpOAuthSessions` | `McpOAuthSession` / `mcp_oauth_sessions` | One-use PKCE state with an encrypted verifier and optional browser session binding. |
| `mcpToolExecutions` | `McpToolExecution` / `mcp_tool_executions` | Audit metadata stores `argumentsHash`, never tool arguments. |

Overlay's Convex document IDs become string IDs in D1. Timestamps remain epoch
milliseconds. Optional legacy `scope` values read as `personal`; new writers
should persist the resolved scope. `scopeMutations` plans patches without
database or Cloudflare dependencies, leaving authorization context loading and
the actual D1 write to backend stores.
