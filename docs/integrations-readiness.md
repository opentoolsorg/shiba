# Apps, MCP and skills readiness

This inventory describes the checked-in product contracts on November 6, 2026.
Counts describe discovery options, not connected accounts or successful vendor
calls. Each self-hosted deployment must configure and verify its own services.

## What is available to discover

| Inventory | Count | Meaning |
| --- | ---: | --- |
| Static integration-directory rows | 39 | Named entries, including grouped products and generic channels. |
| Rows labelled `live` | 9 | A Shiba product path exists; account setup and runtime acceptance remain separate. |
| Rows labelled `catalog_only` | 30 | Discovery metadata; the label does not establish a working connection. |
| Rows with OpenConnector mappings | 23 | Map to 28 distinct pinned upstream service IDs; these overlap the 39 rows. |
| Curated remote MCP presets | 6 | Stripe, Notion, Sentry, PostHog, Figma and Atlassian; these overlap the directory. |
| General managed-skill templates | 5 | Install as drafts, then review and activate. |
| Founder skill packs | 6 | Draft instructions and setup recipes; scheduled deployment remains blocked. |

The nine `live` labels are Gmail/Calendar, Slack, Telegram, Discord, Shiba Mailbox,
Generic Webhook, External MCP, GitHub and Linear. A label can represent more than
one product, and some entries represent infrastructure rather than app actions.
Do not add these overlapping counts or present them as 39 connected apps.

The dynamic OpenConnector catalog is fetched from the configured sibling Worker,
not limited to the 39 static directory rows. The pinned v1.9.4 source contains
1,714 provider directories; the actual deployed `/api/providers` response is the
source of truth for a deployment and can differ by release/build. Shiba pages that
full response with search and readiness filters. OAuth-capable rows are connectable
only when the sibling's per-provider setup metadata says `ready`; non-OAuth rows
are `unsupported`, and failed metadata checks are `unverified`. These are setup
states, not connected/live claims. No vendor action or live account has been
verified by the fixture acceptance.

Inventory sources: [integration directory](../packages/shared/src/integration-catalog.ts),
[MCP presets](../packages/shared/src/curated-mcp-vendors.ts),
[general templates](../apps/backend/src/skill-library/index.ts) and
[founder packs](../packages/shared/src/founder-skill-library.ts).

## Connection state and authority

| State | What it establishes | What is still required |
| --- | --- | --- |
| Catalog entry / preset | An option can be found. | A supported runtime path and deployment configuration. |
| Product path available | Shiba has an implementation for this surface. | Required resources, credentials and account-specific setup. |
| Configured | A server, binding or connection record exists. | Valid authentication and current service health. |
| Authenticated | An account completed authorization or has stored credentials. | Revalidation, tool review and scoped permissions. |
| Healthy | A bounded probe or discovery succeeded at its recorded time. | Actual account/action compatibility; health can change. |
| Reviewed and enabled | A human accepted the exact MCP tool schema and effect. | Principal or employee/resource grants. |
| Granted | The current actor and selected employee may use exact capabilities/resources. | An invocation allowed by current policy and a human approval when required. |
| Runtime verified | A recorded authorized call succeeded for a particular account, action and revision. | Separate verification of other actions, accounts and deployments. |

An employee's job title is a recommendation, not an owner/admin policy role.
Workspace visibility does not grant credentials, private context or tool access.
Removing a grant or changing a reviewed schema must affect later invocations.

## OpenConnector apps

Shiba uses a separate, unmodified OpenConnector sibling Worker. Follow
[its deployment and verification guide](OPENCONNECTOR.md) for the pinned release,
service binding or HTTPS fallback, storage migrations, operator-managed OAuth
clients and separate admin/runtime secrets. Secrets stay in Workers; provider
credentials do not enter the model context or coding container.

Connect through **Integrations → Connectors** as the authenticated user, complete
vendor consent, then refresh the connection list. Account names are derived by
the Worker from the authenticated owner, rather than supplied by the browser.
An upstream service declaration does not prove its OAuth client is configured.
The catalog enables connection only when provider setup metadata is `ready`;
`needs_configuration`, `unsupported` and `unverified` remain unavailable.
Reconnect states require attention before use. The provider health probe tests
service and metadata authentication, rather than live vendor actions.

For employee actions, select the connected service and exact resources in
**Employee tools**. The runtime discovers actions through
`integrations.search_actions` and requests them through `integrations.execute`.
Both use the current employee policy; execution requires human approval of the
exact action arguments. Connecting an account or adding an occupational template
does not install grants. A runtime credential or service health response alone
does not prove that the upstream runtime token permits an action.
Direct `POST /api/integrations/provider/execute` returns 403 and cannot substitute
for the registered employee approval path.

Personal connections remain scoped to the authenticated user. A separate
workspace-owned connection path is implemented in Integrations → Connectors:
a current native workspace owner/admin explicitly starts consent using a
server-derived workspace alias; Shiba keeps the receipt, grant, member, employee,
consent-generation and approval checks in the workspace integrations store. It does
not transfer a personal connection, and membership alone grants no account or
employee access. See [workspace app account design and authority](workspace-integrations.md).
This safely supports shared service accounts under explicit owner/admin authority;
legal ownership at the vendor is not inferred.

Sources: [adapter](../apps/backend/src/integrations/openconnector-provider.ts),
[employee policy](../apps/backend/src/employee-tool-policy.ts) and
[runtime tools](../apps/backend/src/mcp-integration-tools.ts).

## Remote MCP servers

The [MCP guide](../apps/web/src/content/docs/docs/mcp.md) separates inbound clients
of Shiba's `/mcp` gateway from outgoing connections to vendor MCP servers. The six
presets provide a curated OAuth path with operator-registered client IDs and
encrypted credential storage, plus a bearer form where the vendor supports it. Client registration,
consent, supported account tier and vendor endpoint compatibility remain live
prerequisites. Custom remote servers use HTTPS Streamable HTTP and an exact
trusted public host; local/private destinations, stdio and SSE-only transport
are unavailable through this registry.

Vendor prerequisites differ: [Figma currently requires an approved MCP client](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/),
and [Sentry documents OAuth-only connections](https://mcp.sentry.dev/).
Shiba's Figma client approval and live vendor consent have not been verified.
The bearer form cannot make an OAuth-only vendor accept arbitrary API keys.

After sign-in, discover tools, inspect their schema, review each effect, enable
the selected capabilities and grant the intended principal or employee exact
resources. Server errors and changed schemas require renewed discovery/review.
Potential writes require an exact-call human approval. A model cannot resolve
its own approval. Schema shapes that cannot be safely resource-scoped remain
unavailable to employees instead of receiving broad grants.

Sources: [registry and invocation checks](../apps/backend/src/external-mcp.ts),
[OAuth](../apps/backend/src/external-mcp-oauth.ts) and
[employee boundary](../apps/backend/src/employee-external-mcp.ts).

## Skills and founder setup

Managed run skills and extension skills are separate surfaces:

- **Run-attached skills:** the five general templates and six founder packs
  create owner-scoped drafts. Review the exact instructions, mark reviewed, then
  activate that version. Approved tasks freeze at most five selected skill pins;
  changed or inactive versions cannot silently replace the approved instructions.
- **Extension skills:** enabled personal/workspace instructions are discoverable
  on eligible employee Work turns through `list_skills`, then loaded with
  `get_skill_instructions` and a current version. Owner/session, visibility,
  version and enabled-state checks apply. These instructions do not confer app
  permissions or action approval.

Founder packs offer a reviewed employee-setup path. Review the recipe and its
digest before importing an `archived_pending_review` employee and draft skills,
then activate skills and configure real app connections and resource grants
separately. Recipe previews write nothing. Installation retries reuse the owner's
existing installed skill without replacing active instructions. Setup does not create
connections, permissions, recurring schedules or running employees. Direct
`POST /api/founder-skills/:id/deploy` returns **409** with
`integration_schedule_configuration_required`; a listed suggested schedule is
not a deployed automation.

Sources: [draft installation](../apps/backend/src/skill-library/install.ts),
[managed review and versions](../apps/backend/src/skills-store.ts),
[extension runtime tools](../apps/backend/src/extension-skills-tools.ts),
[employee turn exposure](../apps/backend/src/agents/orchestrator.ts) and
[founder setup](../apps/backend/src/founder-skills-routes.ts).

## Acceptance limits

Local tests can establish setup, isolation, revocation and approval behavior with
fixtures. Real acceptance additionally needs a deployed matching revision,
authenticated users, configured sibling/vendor clients and authorized accounts.
Record the account, exact action, success/error, cleanup and cross-user denial
without recording credential values. This document does not claim those live
vendor checks have passed.

The [November 6 OpenConnector catalog fixture journey](verification/openconnector-catalog-fixture-20261106.md)
covers catalog search/readiness, connect/reconnect/disconnect and responsive
layout against intercepted synthetic OpenConnector responses. All evidence is
explicitly fixture-only; no sibling Worker, vendor, account or credential was used.
The [November 4 browser acceptance](verification/integrations-local-browser-20261104.md)
records the prior local Worker/dashboard journeys and separate responsive component
checks. Remote MCP success and vendor actions were not exercised. Reports retain expected HTTP failures and SDK navigation warnings.
The [preview observation](verification/preview-auth-reexposure-20261104.json)
separately records the deployed anonymous default identity after external operator
changes; the branch's static-only authentication protection is not deployed there.

## Consent and dispatch limits

OpenConnector OAuth accounts use an opaque Shiba connection identifier derived from the owned record and completed OAuth authorization provenance. A fresh consent changes that identifier; old grants and approvals fail current-connection checks. Token refresh within the same consent retains it. Configured legacy/API-key records without that provenance remain visible for recovery but are unavailable for employee execution. A connection is not executable merely because it is stored.

The adapter verifies the approved generation immediately before dispatch and supplies the server-derived raw connection pin to the upstream action request. Pinned upstream OpenConnector has no atomic expected-consent condition on action execution. A simultaneous out-of-band operator mutation of credentials in the same row is therefore outside this verified guarantee; this implementation does not claim atomic vendor-account substitution protection.
