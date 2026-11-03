# Extensions API contract

The Integrations screen uses a small typed client for the Overlay-style extension
views. Shiba currently has no `/api/v1/extensions/*` routes, so those requests
return an error until the routes below are implemented. The frontend tests use
fixtures for these contracts; they do not imply that the endpoints are live.

## Shared rules

- Authenticate every route with the dashboard session and derive the user and
  active workspace on the server. Do not accept a caller supplied owner ID as
  authority.
- Return `Cache-Control: no-store`; enforce same-origin intent for mutations.
- `view` is `personal`, `workspace`, or `archived`. Archived items retain their
  original `scope` and have `archivedAt` set.
- Use `scope: "personal" | "workspace"` when creating an item. A workspace
  write must check membership and the caller's permission to create extensions.
- MCP responses may expose `hasAuth`, but must never return bearer tokens,
  custom header values, encrypted credential blobs, or OAuth tokens. The backend
  must encrypt submitted auth configuration at rest.
- Keep OpenConnector's admin/runtime credentials in Worker secrets. Connector
  association must verify that the `connectedAccountId` belongs to the current
  authenticated owner and matches `providerKey`.

## MCP servers

Base path: `/api/v1/extensions/mcp-servers`.

```ts
type McpServer = {
  id: string;
  name: string;
  description?: string;
  transport: "streamable-http" | "sse";
  url: string;
  enabled: boolean;
  authType: "none" | "bearer" | "header" | "oauth";
  hasAuth: boolean;
  timeoutMs?: number;
  defaultToolPolicy: "allow" | "approval_required" | "deny";
  toolPolicies: Record<string, "allow" | "approval_required" | "deny">;
  toolCatalogCount: number;
  scope: "personal" | "workspace";
  archivedAt?: number;
  oauthStatus?: "connected" | "needs_reconnect" | "disconnected";
};
```

| Method and path | Contract |
|---|---|
| `GET /?view=personal\|workspace\|archived` | `{ servers: McpServer[] }` |
| `POST /` | Body is the editable server fields plus `scope`; returns `{ server }` with status 201 |
| `PATCH /:id` | Partial editable server fields; `{ enabled }` toggles server availability |
| `DELETE /:id` | Permanently removes an owned server; `{ ok: true }` |
| `POST /:id/archive` | Archives the server; `{ ok: true }` |
| `POST /:id/restore` | Restores the server; `{ ok: true }` |
| `POST /:id/oauth` | Starts OAuth and returns `{ redirectUrl }`; persist OAuth state server-side |
| `DELETE /:id/oauth` | Disconnects the OAuth session; `{ ok: true }` |
| `POST /test` | Tests server connectivity and tool catalog discovery; returns `{ ok: boolean, message: string, toolCount?: number, requiresAuth?: boolean }` |

The create/update body supports `name`, `description`, `transport`, `url`,
`enabled`, `authType`, `authConfig`, `timeoutMs`, `defaultToolPolicy`,
`toolPolicies`, and `scope`. `authConfig` accepts `{ bearerToken }` or
`{ headerName, headerValue }`. Updates omit it to keep the saved credential;
`clearAuthConfig: true` clears it. New servers default to Streamable HTTP,
enabled, no authentication, a 30-second runtime timeout, and the `allow` tool
policy, matching Overlay's form defaults.

## Workspace connectors

Base path: `/api/v1/extensions/connectors`.

```ts
type WorkspaceConnector = {
  id: string;
  provider: "openconnector";
  providerKey: string;
  scope: "personal" | "workspace";
  identityLabel?: string | null;
  archivedAt?: number;
};
```

| Method and path | Contract |
|---|---|
| `GET /?view=personal\|workspace\|archived` | `{ connectors: WorkspaceConnector[] }` |
| `POST /` | `{ provider: "openconnector", providerKey, connectedAccountId, scope }` → `{ connector }` |
| `DELETE /:id` | Removes the connector association; `{ ok: true }` |
| `POST /:id/archive` | Archives the association; `{ ok: true }` |
| `POST /:id/restore` | Restores the association; `{ ok: true }` |
| `PATCH /:id` | `{ scope: "personal" | "workspace" }` moves the connector between scopes |

OAuth is provided by the existing `/api/integrations/provider/*` routes. The UI
opens the returned HTTPS URL, listens for the existing
`shiba-integrations-oauth` completion signal, then refetches
`GET /api/integrations/provider/connections`. The callback signal is only a
refresh hint; the server response is the source of truth. It then associates
the matching OpenConnector account using `POST /api/v1/extensions/connectors`.

## Existing APIs kept separate

`/api/v1/mcp/servers` manages Shiba's reviewed external MCP tools, worker-secret
references, allow-listed destinations, and agent grants. Its transport, auth,
and lifecycle differ from Overlay's general MCP server editor, so the frontend
does not send Overlay-shaped requests to that route. The new extensions API
needs a backend implementation before MCP CRUD and workspace connector scope
changes can persist outside the fixture-backed UI tests.
