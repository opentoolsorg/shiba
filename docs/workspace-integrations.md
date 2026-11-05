# Workspace-shared app accounts

Workspace app sharing uses a separate namespace and explicit consent. It does
not copy, relabel or transfer a personal OpenConnector connection. A workspace
manager chooses to share an upstream account with that workspace, then grants
an exact employee version and verified member access. This establishes Shiba's
sharing scope, not proof of legal company ownership at the vendor.

The initial identity contract supports verified native Shiba accounts. The
native account ID, verified email, workspace role and membership version are
bound together. Access-only identities without a native account are unavailable
for this scope. Existing personal account paths retain their prior behavior.

## Setup and consent

1. Configure the separate authorized OpenConnector sibling and its provider
   OAuth application using [the existing operator guide](OPENCONNECTOR.md).
   A catalog entry or configured OAuth client does not prove a working account.
2. Select the workspace and open Apps. A current native owner or admin starts
   consent with the explicit `workspace-members` audience. The server derives a
   `w_` alias from the workspace ID. Personal accounts continue using `u_` aliases.
3. Complete vendor sign-in in the isolated OAuth window. Shiba records a pending
   receipt before the upstream request, then confirms the exact workspace alias,
   service and server-issued OAuth consent fingerprint through a fresh account
   read. Closing a popup or sending a completion message does not grant access.
4. The original initiating native manager must still have the same account ID,
   role and membership version when reconciliation completes. Duplicate matching
   receipts do not create or activate another connection.
5. Grant a specific current employee version and native workspace member either
   discovery, execution, or both. There are no automatic grants. Execution-only
   permission does not implicitly grant discovery in the UI.

The consenting manager and the manager who grants access must retain their exact
native account identities and workspace membership versions. Removal, demotion,
account replacement under the same email, employee edits, consent replacement,
connection changes or grant revocation pause use. Recovery requires a current
manager's explicit cleanup and fresh consent or a new exact grant as appropriate.
Automatic personal account transfer and silent ownership replacement are absent.

## Manual execution

This runtime does not start a team model session or borrow deployment model
credentials. A granted native member can discover action metadata, enter exact
JSON arguments and request human review. A current native workspace owner or
admin reviews the frozen action and arguments. The first decision wins. Status
messages, model output, tool descriptions and occupational role names cannot
approve an action.

After approval, only the original native requester can explicitly execute that
request. The Worker validates the current workspace, native account identities,
employee and grant revisions, selected connection, consent generation, action
service, schema digest and exact argument digest. It revalidates after remote
preflight reads and claims the execution once in D1. The trusted cancellation
signal and frozen consent deadline are checked synchronously before the action
request. Cancellation known before sending prevents the POST; an in-flight
external request cannot be promised to retract its effects.

An uncertain external POST outcome is retained as `unknown` and is not repeated.
The whole connection blocks new actions while another request is executing or
has an unknown outcome, including requests from another actor. A missing receipt
after five minutes is displayed as unknown, without relaunching work. Operator
inspection is required before further use. Replayed request IDs return their
saved receipt; changed arguments under the same ID are rejected.

Members see only their currently granted accounts and their own currently
authorized requests. Revoked sources do not return cached arguments or results.
Managers can see blocked historical receipt metadata with its protected content
removed. Result strings are redacted structurally and remain untrusted data.

## API and storage

Every request under `/api/workspace-integrations` requires the authoritative
`X-Shiba-Workspace` header and a verified native session. API bearer credentials,
body workspace overrides and guessed actor identities cannot select the scope.
Mutations also require same-origin intent. Account setup, grants and decisions
are manager-only; action requests and execution use the authenticated requester.

The backend owns policy, provider calls and the `0010_workspace_integrations.sql`
migration. D1 stores workspace connection receipts, explicit grant tuples and
one-shot action approvals. OAuth credentials remain with the sibling. The shared
package contains browser-safe response contracts only. No credential, provider
client or Worker binding is imported into those shared contracts.

Connection readiness reports upstream-observed consent and configuration, not a
certified live vendor action. No new OAuth app, credential, account, terms
acceptance, integration send or cloud resource is created by a test run.

## Evidence and remaining verification

`apps/backend/test/workspace-integrations.test.ts` exercises actual route,
registry, approval and provider adapter code with real SQLite and fixture HTTP.
It covers private alias isolation, two workspaces, unrelated users, explicit
consent, duplicate receipts, separate human approval, native account replacement,
concurrent requests, one-shot execution, revocation during awaited preflight,
cancel/expiry and unknown effects. Native session resolution and sibling HTTP
are fixtures; no installed OAuth account or vendor action is contacted.

Live acceptance still requires the deployed exact revision, an authorized native
workspace with two test users, the configured sibling and OAuth clients, and an
explicitly approved harmless provider action. Verify consent, scoped grants,
approval, completion and revocation in that environment before claiming live
operation. Workspace Worker-model billing, unattended shared-account execution,
automatic ownership transfer and Access-only sharing remain unavailable.
