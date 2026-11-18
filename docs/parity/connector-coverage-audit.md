# Connector coverage audit

Developer audit of Shiba's connector (app and action) coverage, measured
against a reference set of 43 widely used workplace apps and against the
pinned OpenConnector release (`d89dc9f2`, see
[`docs/OPENCONNECTOR.md`](../OPENCONNECTOR.md)). Dashboard copy stays
plain-language; implementation detail lives here.

## How the numbers were produced

1. The reference app set is the union of services named in the product
   requirements this lane implements: a "Popular" group (Gmail, Google
   Calendar, GitHub, Slack, Notion, Linear, Google Drive, Outlook), plus
   apps grouped as New, Sales, Business, Projects, Developer and brand
   marks.
2. Hard action dependencies come from the flows a coding agent actually
   runs: pull-request create/get/update/list/merge/close, create-or-update
   file contents, and send email.
3. OpenConnector coverage comes from running the pinned checkout's own
   generator (`npm ci && node scripts/generate-provider-registry.ts && node
   scripts/generate-catalog.ts`) and reading `catalog/apps-index.json`. The
   pinned release has **1,680 services and 21,053 actions**, and **117**
   services declare OAuth sign-in.
4. Shiba coverage comes from `INTEGRATION_CATALOG`
   (`packages/shared/src/integration-catalog.ts`, `openConnectorServiceIds`),
   `FEATURED_INTEGRATIONS` and native bindings.

To rerun it, regenerate `apps-index.json` in `.openconnector/` (or any
checkout of the pinned SHA), then join it against the three Shiba sources
above.

## What "covered" means in Shiba

Coverage has four levels, and only the last one runs anything:

| Level | Source of truth | Meaning |
| --- | --- | --- |
| Listed | `GET /api/integrations/provider/catalog` (all 1,680 OpenConnector services) | Search finds the service. Nothing is installed or permitted. |
| Curated | `INTEGRATION_CATALOG`, `FEATURED_INTEGRATIONS`, `INTEGRATION_COLLECTIONS` | Shiba names, describes and groups the service. Every row is `catalog_only` unless it is native. |
| Sign-in ready | Per-service `/v1/providers/:service/setup` probe | The operator has configured an OAuth client. `connectable` is true only then. |
| Executable | Workspace grant + per-action human approval → `executeTool` | Actions come from `/v1/actions/search` at run time. Credential-input actions (for example the Google Ads `developerToken`) are refused by `action-input-policy.ts`. |

Because actions are discovered dynamically, every action in the pinned
OpenConnector catalog can be reached once a service is connected, a workspace
grants it and a human approves the call. Shiba does not hard-code action
lists. The open question for each app is therefore whether OpenConnector has
the service and its actions, plus whether an operator can sign it in.

## App-by-action matrix

Actions are counted from the pinned `apps-index.json` (r = read, w = any
mutating operation type). "Shiba curated" is the state **after** this lane.

| Reference group | Service ID | Actions (r/w) | Auth | Shiba curated | Notes |
| --- | --- | --- | --- | --- | --- |
| Popular | `gmail` | 47 (21/26) | oauth2 | yes (featured) | `send_email`, `search_threads` present. A native Gmail mailbox also exists. |
| Popular | `googlecalendar` | 38 (15/23) | oauth2 | yes (featured) | |
| Popular | `github` | 147 (81/66) | oauth2, api_key | yes (featured, native) | PR create/get/update/list/merge present. The reference `CREATE_OR_UPDATE_FILE_CONTENTS` action maps to `create_or_update_file`. Shiba's own PR publishing uses the repo-scoped native GitHub path, not OpenConnector. |
| Popular | `slack` | 28 (17/11) | oauth2, api_key | yes (featured, native) | |
| Popular | `notion` | 31 (17/14) | oauth2, api_key | yes (featured) | |
| Popular | `linear` | 34 (18/16) | oauth2, api_key | native only | See "Still uncovered". |
| Popular | `googledrive` | 43 (20/23) | oauth2 | yes (**featured, new**) | |
| Popular | `outlook` | 15 (5/10) | oauth2 | yes (**featured, new**) | |
| New | `granola` | 6 (6/0) | oauth2, api_key | yes | Read-only. |
| New | `attio` | 10 (6/4) | oauth2, api_key | yes | |
| New | `sentry` | 19 (18/1) | oauth2 | yes | |
| New | `figma` | 26 (19/7) | api_key, oauth2 | yes | |
| New | `calendly` | 37 (25/12) | oauth2, api_key | **new** | |
| New | `zoom` | 4 (2/2) | oauth2 | **new** | Thin action set upstream. |
| Sales | `hubspot` | 26 (18/8) | oauth2 | yes (featured) | |
| Sales | `salesforce` | 84 (52/32) | oauth2 | yes | |
| Sales | `affinity` | 20 (20/0) | api_key | **new** | Read-only upstream. |
| Sales | `apollo` | 5 (5/0) | api_key | yes | Read-only upstream. |
| Sales | `pipedrive` | 27 (15/12) | api_key | **new** | |
| Sales | `close` | 16 (8/8) | api_key | **new** | |
| Business | `stripe` | 18 (10/8) | api_key | yes (featured) | |
| Business | `quickbooks` | 147 (68/79) | oauth2 | yes | |
| Business | `shopify` | 98 (42/56) | oauth2, api_key | **new** | |
| Business | `dropbox` | 24 (14/10) | oauth2 | **new** | |
| Business | `xero` | 15 (12/3) | oauth2 | **new** | |
| Business | `square` | 6 (4/2) | api_key | yes | |
| Projects | `asana` | 101 (44/57) | oauth2, api_key | yes | |
| Projects | `jira` | 7 (5/2) | oauth2 | yes | Thin action set upstream. |
| Projects | `airtable` | 14 (5/9) | oauth2, api_key | yes | |
| Projects | `clickup` | 68 (31/37) | oauth2, api_key | yes | |
| Projects | `monday` | 67 (22/45) | oauth2, api_key | yes | |
| Projects | `trello` | 28 (11/17) | custom_credential | **new** | No OAuth sign-in. Needs operator credentials. |
| Developer | `gitlab` | 15 (6/9) | oauth2, api_key | yes | |
| Developer | `vercel` | 39 (20/19) | api_key | **new** | |
| Developer | `supabase` | 23 (17/6) | oauth2, api_key | **new** | |
| Reference | `googlesheets` | 40 (12/28) | oauth2 | yes | |
| Reference | `googledocs` | 32 (5/27) | oauth2 | yes | |
| Reference | `linkedin` | 5 (1/4) | oauth2 | yes | Posting only. No feed or analytics reads upstream. |
| Reference | `twitter` | 71 (44/27) | oauth2 | yes | |
| Reference | `cal` | 47 (23/24) | oauth2 | **new** | Cal.com. |
| Reference | `openai` | 15 (6/9) | api_key | no | Model provider. Shiba models go through its own provider lanes. |
| Reference | `medium` | — | — | no | Not in OpenConnector. |
| Reference | `threads` | — | — | no | Not in OpenConnector. |
| (extra) | `confluence` | 5 (3/2) | oauth2, api_key | **new** | Added to the Docs & files shelf. Thin action set upstream. |

The reference set names 43 distinct services. OpenConnector has 41 of them,
all except `medium` and `threads`. After this lane, Shiba curates 40: every
one except `openai`, `medium` and `threads`, with `linear` covered natively.

## Delivered in this lane

- **13 reference catalog entries** (`catalog_only`, OpenConnector-mapped):
  Calendly, Cal.com, Zoom, Pipedrive, Close, Affinity, Shopify, Xero,
  Dropbox, Trello, Confluence, Vercel and Supabase.
- **Featured apps** gain Google Drive and Outlook. These are the two
  "Popular" OAuth apps that were missing.
- **Browse collections** (`packages/shared/src/integration-collections.ts`).
  Eight curated shelves sit over the live provider catalog: Popular, Sales &
  CRM, Marketing, Payments & finance, Projects & tasks, Developer tools,
  Meetings & scheduling, and Docs & files.
  - `GET /api/integrations/provider/catalog?collection=<id>` and
    `GET /api/workspace-integrations/catalog?collection=<id>` restrict the
    page to the shelf's services in shelf order. They keep search,
    readiness filtering, pagination and probe budgets. An unknown ID returns
    400 (`invalid_collection` on the workspace route). Services that the
    configured OpenConnector does not offer are dropped silently. The
    setup-required fallback narrows its featured rows the same way.
  - The browse dialog shows the shelves as a toggle group. Each shelf has a
    one-line plain-language description.
  - Selecting a shelf only changes what is listed. It never installs,
    connects or grants anything.
- **Local brand marks** for the new entries under
  `apps/web/public/integration-logos/` (Calendly, Cal.com, Zoom, Pipedrive,
  Close, Affinity, Shopify, Xero, Dropbox, Trello, Vercel and Supabase;
  Confluence already had one). Sources are the pinned Iconify collections
  except Affinity, which is the site's own favicon PNG.

No environment variables, bindings or migrations were added.

## Still uncovered (honest gaps)

- **The long tail.** Search lists all 1,680 OpenConnector services, but this
  audit did not compare the full upstream service universe app by app
  against every other app directory. Other catalogs may have apps that
  OpenConnector lacks, and the reverse.
- **OAuth readiness is operator work.** 117 of 1,680 services declare
  OAuth, and none is sign-in ready until an operator registers a client in
  OpenConnector. API-key and custom-credential services (Stripe, Pipedrive,
  Close, Affinity, Apollo, Vercel, Square, Trello) show "No OAuth sign-in"
  in the dashboard. They have no end-user enrollment flow in Shiba. See
  `OPERATOR_ENROLLMENT_UNAVAILABLE` in `openconnector-provider.ts`.
- **No curated action catalog.** Shiba deliberately exposes only what
  `/v1/actions/search` returns, behind grants and approval. Shiba ships no
  per-app "recommended actions" list or action-level browse UI. Action
  discovery stays inside the workspace action request flow.
- **Thin upstream action sets.** Zoom (4), Jira (7), LinkedIn (5, posting
  only), Apollo (5, read-only), Granola (6, read-only) and Square (6) are
  limited by what OpenConnector ships, not by Shiba.
- **Linear through OpenConnector.** Linear is covered by the native agent
  session integration. The OpenConnector `linear` service (34 actions) is
  listed in search and in the Popular, Projects and Developer shelves, but
  it has no separate reference catalog row. Mapping it onto the native row
  would merge provider rows into the native card in
  `IntegrationCatalogDirectory`.
- **Not in OpenConnector:** Medium and Threads (reference brand-mark set
  only) and OneDrive (a common ask). Facebook Pages is reached only through
  `meta` (ads).
- **Logos.** Services Shiba does not curate fall back to the provider
  `iconUrl`, or a letter avatar when there is none.
- **Triggers.** OpenConnector ships trigger definitions (for example
  `linear/trigger-on-issue-changed`, `outlook/trigger-on-message-received`).
  Shiba does not consume OpenConnector triggers. Event intake stays on
  native webhooks, which belong to the automations lane rather than this
  one.
