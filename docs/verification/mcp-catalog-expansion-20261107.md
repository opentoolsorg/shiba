# MCP catalog expansion, November 7, 2026

## Scope and sources

The catalog now contains eight remote MCP presets. Two additions use the
existing encrypted bearer store and HTTPS Streamable HTTP transport:

- **GitHub (read-only):** `https://api.githubcopilot.com/mcp/readonly`.
  GitHub's [remote-server documentation](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
  publishes this read-only endpoint; its [host-integration guide](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)
  permits personal access tokens in the Authorization header. Use a fine-grained
  token restricted to selected repositories and read permissions.
- **Linear (read-only):** `https://mcp.linear.app/mcp/readonly`.
  Linear's [MCP guide](https://linear.app/docs/mcp) documents the read-only
  Streamable HTTP endpoint and `Authorization: Bearer` with an API key. Use only
  Read permission and restrict team access.

These official documents were read on November 7, 2026. This is documentation
verification, not a successful authenticated session, remote tool-schema check,
account entitlement check or production deployment.

## Boundaries

Each preset declares the connection methods Shiba supports and links its official
documentation. GitHub and Linear offer only bearer setup here: the current client
does not implement GitHub's client-secret flow or Linear's dynamic client
registration. No additional OAuth client secrets, scopes, headers or dependencies
were added. The existing six OAuth presets keep their configuration contract.

The API and credential helper reject unsupported connection methods. Sentry and
Figma's existing OAuth-only UI restriction is also enforced when saving a bearer
or changing a Worker credential reference. Authenticated presets reject an explicit `none` auth mode; drafts still await
credentials. A catalog connection's endpoint stays pinned, including
the read-only path; changing it to a write-capable path is rejected.

Bearer setup creates a private draft and stores only encrypted owner-bound
credentials. The existing encrypted-token lane uses the persisted `oauth` mode
for both OAuth and manually supplied bearer tokens; `connectionMethods` records
the distinct setup paths rather than changing that storage format.

Saving credentials does not enable tools or grant employee access. Discovery
retains disabled, unreviewed tools. The two additions recommend approval-required
for every discovered tool until an owner explicitly reviews the exact schema and
effect, including unknown future tool names. This conservative recommendation is
not a claim that the providers' read tools mutate data. A role filter recommends
these presets for engineering, QA and product without connecting accounts.

## Local verification

Passed:

- 85 backend tests covering MCP OAuth, bearer handling, external MCP isolation,
  endpoint pinning, unsupported authentication and deployment configuration.
- All 1,527 frontend tests (188 files), including 33 focused MCP/role tests
  covering bearer-only setup, private defaults, no implicit grants, existing
  OAuth/custom OAuth flows, registry management and role recommendations.
- TypeScript checks for shared contracts, backend source and tests, and frontend.
- Dashboard production build; Astro documentation check (zero errors/warnings)
  and production build; six post-build marketing tests; documentation verification
  of 94 HTML pages and 6,907 local links/assets/anchors.
- Changed-file Biome check (warnings only, no errors) and `git diff --check`.

A broader backend run exposes existing failures outside the catalog change.
All five reproduced in an untouched `b8e2dec5` worktree: four employee-fixture
process-group tests cannot determine the runner process group in this execution
environment, and one phase1 direct-intake test expects HTTP 400 but receives 403.
These are not counted as passed. Completion of the broader suite was then
blocked by execution review because it attempted a request to
`https://api.typesafe.ai/v1/systemone` without verified disclosure authorization.
The source includes a live TypeSafe suite that auto-enables when a key is
available; its examples are synthetic, but no live-provider retry was made here.
The full backend result remains incomplete, not green. Run the coordinated
branch's offline aggregate checks after integration; live provider tests require
separate authorization.

No vendor account was connected, no real token was submitted, no tool was granted
or invoked against a vendor, and no code was pushed or deployed by this change.
