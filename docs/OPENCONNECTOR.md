# OpenConnector sibling Worker

Shiba's sole `openconnector` integrations provider calls a separately deployed
[open-connector](https://github.com/oomol-lab/open-connector) Worker on the same
Cloudflare account. A private `OPEN_CONNECTOR` service binding takes precedence
over the `OPEN_CONNECTOR_URL` HTTP fallback. `INTEGRATIONS_PROVIDER` accepts only
`openconnector`; there is no provider switcher. The legacy
integrations `/session` route returns HTTP 503 with an `unsupported` error;
connect through the provider connection flow instead. Generic `/execute` uses
the openconnector tool executor.

No upstream application source is vendored, imported, or linked into Shiba. The
helper clones upstream release **v1.9.4**, pinned to commit
`d89dc9f24f5a057bb500272d7dbf333837c77c68`, into gitignored `.openconnector/`.
The pinned upstream [Apache license](https://github.com/oomol-lab/open-connector/blob/v1.9.4/LICENSE)
and Shiba AGPL-3.0-only license apply to their respective distributions. Keeping the
applications separate preserves their separate distributions and license terms;
review upstream's license before distributing or offering the sibling service.

## Prepare and provision

On macOS, use a compatible Node installation (for example via your existing
Node version manager), then authenticate Wrangler from the repository root:

```sh
node --version
pnpm exec wrangler login
pnpm exec wrangler whoami
```

Select Shiba's Cloudflare account with
`CLOUDFLARE_ACCOUNT_ID` before running remote commands. Use a Node version allowed
by the pinned upstream release (`^22.23.4 || ^24.22.1 || >=26.12.1`) and npm. Shiba
uses its existing Alchemy deployment for the backend; this sibling uses upstream's
own Wrangler build/deploy script, without changes to upstream tracked files.

```sh
pnpm prepare:openconnector
# Optional KV transit storage instead of R2; set before provisioning/configuring:
# export OPEN_CONNECTOR_TRANSIT_BACKEND=kv
pnpm provision:openconnector
```

`prepare` only clones, checks the pinned commit and installs upstream's lockfile
with `npm ci`. `provision` is an explicit live operation: it creates D1 database
`shiba-openconnector` and R2 bucket `shiba-openconnector-transit` (or a transit KV
namespace when `OPEN_CONNECTOR_TRANSIT_BACKEND=kv`). On an existing
installation skip creation and reuse its IDs. If creation partially succeeds,
create only the missing resource using Wrangler rather than recreating the first.

Copy D1's returned UUID into the following variable, then generate the local
config from the upstream example:

```sh
export OPEN_CONNECTOR_D1_ID='<database UUID>'
export OPEN_CONNECTOR_WORKER=shiba-openconnector
# Optional alternate R2 name (set before provisioning as well):
# export OPEN_CONNECTOR_R2_BUCKET=shiba-openconnector-transit
# For KV, copy the namespace ID returned by provision:
# export OPEN_CONNECTOR_KV_ID='<32-hex namespace ID>'
# Required for the service-binding path: use the sibling's public workers.dev
# origin, or an optional custom domain configured below. Never use an internal URL.
export OOMOL_CONNECT_ORIGIN='https://shiba-openconnector.<workers-subdomain>.workers.dev'
pnpm configure:openconnector
```

The generated `.openconnector/v1.9.4/wrangler.local.jsonc` retains upstream's
Workers entrypoint, D1 `DB` binding and migrations directory, R2 `TRANSIT_FILES`,
once-per-minute cron and Static Assets Web Console configuration. Only resource
names/IDs and the public origin are customized. R2 supports larger temporary
files; configure a bucket lifecycle rule for expired unread files. Upstream also
supports KV (25 MiB maximum). Set `OPEN_CONNECTOR_TRANSIT_BACKEND=kv` and
`OPEN_CONNECTOR_KV_ID` before configuring to replace R2 with the KV `TRANSIT_FILES`
binding and `TRANSIT_FILES_BACKEND=kv`. Exactly one transit backend is enabled.
KV expires temporary files through TTL; R2 needs the lifecycle rule.

## Migrate, set secrets, deploy

**Apply migrations for the initial installation and every upgrade:**

```sh
pnpm apply-openconnector-d1
```

This runs upstream's `wrangler d1 migrations apply shiba-openconnector --remote`
with its local config. The Shiba deploy helper also applies pending migrations
before invoking the upstream build/deploy script and stops on migration failure.
The unmodified upstream `npm run deploy:cloudflare` does **not** apply migrations;
when running it directly, always apply all pending migrations first. This includes
the SaaS cleanup migration (`0015_saas_cleanup_runtime.sql`) shipped in the pin.

Generate two independent random values (`openssl rand -base64 32`, twice), store
them in an external secret vault, then paste them into Wrangler's secret prompts:

```sh
pnpm secret:openconnector OOMOL_CONNECT_ADMIN_TOKEN
pnpm secret:openconnector OOMOL_CONNECT_ENCRYPTION_KEY
pnpm deploy:openconnector
```

After applying D1 migrations, the last command runs unmodified upstream
`npm run deploy:cloudflare`: generate catalog, build Web Console, copy catalog
assets, then `wrangler deploy --config wrangler.local.jsonc --minify`.
Minification is required for Worker size and memory usage. Retain the encryption
key across upgrades: replacing or losing it makes existing encrypted records
unreadable. No secrets belong in config files, command arguments, or source.

The service binding sends an internal request URL. Set `OOMOL_CONNECT_ORIGIN`
on the sibling to its reachable public HTTPS origin, even when using workers.dev;
otherwise upstream builds unreachable OAuth callback and temporary-file URLs.
Register `<OOMOL_CONNECT_ORIGIN>/oauth/callback` on each provider's OAuth client.
For an optional custom domain, add its `routes` entry to the ignored local config
and change `OOMOL_CONNECT_ORIGIN` to that exact HTTPS origin. This adapter uses named
connections and locally configured OAuth clients: configure provider client
credentials in the upstream admin Console before connecting. The Console admin
token belongs only to trusted operators; do not distribute it to dashboard users.

## Connect the Shiba backend

Create a scoped runtime token through the upstream admin Console. Grant only the
services, actions and named connections Shiba needs. Secrets checklist:

- `OOMOL_CONNECT_ADMIN_TOKEN`: sibling only; generated above for operator/admin access.
- `OPEN_CONNECTOR_ADMIN_TOKEN`: the sibling's `OOMOL_CONNECT_ADMIN_TOKEN`, used for
  catalog and connection management.
- `OPEN_CONNECTOR_RUNTIME_TOKEN`: the upstream runtime API key for tool execution.
- `OOMOL_CONNECT_ENCRYPTION_KEY`: sibling only; never copy it into Shiba.

```sh
pnpm exec wrangler secret put OPEN_CONNECTOR_ADMIN_TOKEN --config apps/backend/wrangler.jsonc
pnpm exec wrangler secret put OPEN_CONNECTOR_RUNTIME_TOKEN --config apps/backend/wrangler.jsonc
```

Deploy the sibling first. For Alchemy, export the following before the normal
Shiba deployment, with backend secrets also present in its deploy environment:

```sh
export OPEN_CONNECTOR_WORKER=shiba-openconnector
# INTEGRATIONS_PROVIDER defaults to openconnector; no override is needed.
# Optional public HTTPS origin for HTTP fallback (binding wins when present):
# export OPEN_CONNECTOR_URL=https://connect.example.com
pnpm deploy:alchemy
```

Alchemy adds the service binding only when `OPEN_CONNECTOR_WORKER` is set. For the
Wrangler rollback path, uncomment the `services` example in
`apps/backend/wrangler.jsonc` and set its service name to the deployed sibling.
The default `vars.INTEGRATIONS_PROVIDER` is already `openconnector`. Add `OPEN_CONNECTOR_URL`
to `vars` only when using HTTP fallback; then use the usual backend deploy.
Without the binding, the adapter requires that URL. Setting an HTTP URL does not
remove the need for administrator and runtime authentication.

The backend derives `connectionName = "u_" + first 16 hex of SHA-256(userId)` and
uses it for every connection operation and execution. OAuth opens the upstream
authorization page; after completing authorization, refresh Shiba's connections
list. Upstream does not send a Shiba popup completion message or accept a Shiba
callback URL in this flow. Named connections are isolated by Shiba's adapter;
trusted operators with the upstream administrator token can access all names.

## Verify and upgrade

Check `<sibling origin>/health` returns `{"ok":true}`, then verify authenticated
catalog, connect, list, execute and disconnect in Shiba with two distinct users.
Check Cloudflare scheduled invocations and D1 cleanup progress: HTTP traffic does
not substitute for the minute cron. Live operation still needs account resources,
provider OAuth clients and the secrets above; local mocked tests do not prove
those account settings.

Remaining Cloudflare live acceptance blockers are a compatible Node runtime,
Wrangler authentication for the selected account, provisioned D1 and transit
storage IDs, applied migrations, both sibling secrets, a scoped runtime token,
and provider OAuth clients with the public callback registered. After deployment,
verify the backend service binding, two-user connection isolation, action approval
and execution, and actual minute-cron cleanup. These are deployment requirements;
the local tests do not establish that a live account has satisfied them.

Upstream's optional ChatGPT-compatible MCP OAuth additionally needs its own
`OAUTH_KV` namespace. Shiba's authenticated adapter uses runtime tokens and does
not require that optional binding; see the upstream guide to expose the sibling's
`/mcp` endpoint directly to OAuth clients.

For an upgrade, review upstream release notes/license, update both the tag and
commit pin in `infra/openconnector.mjs`, prepare the new checkout, configure the
same resources, apply its D1 migrations, then deploy (the helper repeats the
idempotent migration apply before building). Keep the encryption
key stable. Back up D1 before schema upgrades; rolling back Worker code does not
roll back D1 migrations.

References: [authoritative upstream Cloudflare deployment guide](https://github.com/oomol-lab/open-connector/blob/main/docs/cloudflare.md)
and [the pinned release guide](https://github.com/oomol-lab/open-connector/blob/v1.9.4/docs/cloudflare.md).
The helper keeps upstream's tracked sources unmodified and preserves Static Assets,
its scheduled handler/cron, and the minified deploy script.

## Employee and MCP action tools

`integrations.search_actions` discovers action IDs and input schemas for one
connected service. `integrations.execute` executes an action after human review.
Both use the existing employee tool policy: grant
`mcp:shiba:integrations.search_actions` and/or `mcp:shiba:integrations.execute`
with the exact upstream service ID (for example `github`) as the resource.
The policy intersects workspace, actor, role and employee grants on every call.
MCP bearer tokens also need `integrations:read` or `integrations:execute`,
respectively. MCP calls must include `employeeId`; employee chat discovers the
same actions through `employee_tool_catalog` and calls `employee_tool_call`.

For discovery, pass `toolkitSlug`, optional `query`, and optional `limit` (1–50).
For execution, pass `toolkitSlug`, the discovered `toolSlug`, and `arguments`.
Every execution, including actions with unknown effects, enters the existing
employee action approval flow. Review the frozen payload in the dashboard or
chat, then retry the identical call after approval. Changed arguments need new
approval; consumed approvals replay their receipt without repeating the action.

The grant stores the configuring human's authenticated owner namespace, the
same namespace used by integration connection routes. Employee token names and
caller-supplied account selectors cannot choose another owner's connection.
Dispatch checks the current provider, connection and service grant, and verifies
that the action belongs to that service. Tokens and action outputs are never
logged; the audit trail stores argument hashes and invocation status.
