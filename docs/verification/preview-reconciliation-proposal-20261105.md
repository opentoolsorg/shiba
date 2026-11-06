# PR 188 preview reconciliation proposal

This proposal has not been executed. It creates no credential, account, resource
or deployment. Production is excluded.

## Exact target and observed drift

- Cloudflare account: `73cf43cd7ec224111282832dc96b90e2`.
- Worker: `shiba-ai-coworker-pr-188`, on its existing Workers development hostname.
- Observed deployment: `e0c4eed0-5229-4daf-bb88-061624f46492`.
- Observed version: `4fd5d263-00d8-4d0e-ae82-844092656fe9`, at 100 percent traffic.
- The November 5 settings read found 47 bindings, `OPEN_DASHBOARD=1`, zero
  `secret_text` bindings and persisted invocation logs with query redaction
  disabled. Binding metadata does not establish the state of stored accounts.
- The [02:07 UTC identity check](preview-readonly-check-20261105.json) confirmed
  anonymous HTTP 200, `auth: none` and the default identity with TLS verification.

The existing updater pins version `101b11ea` and requires `OPEN_DASHBOARD=0`.
It correctly rejects this drift. Do not remove its version, resource, routing,
container or authentication checks to force an upload. Its prior Cloudflare 401
was before upload; unchanged credentials must not be retried.

## Proposed bounded actions

1. Use an existing authorized deployment identity for this account and Worker.
   Reconnect or repair its permissions without creating a new persistent token
   as an implicit fallback. Read current version, routes, schedules, resource
   bindings and the existing Sandbox attachment again. Compare the complete
   inventory with the reviewed snapshot before any write.
2. Restore private API access by setting `OPEN_DASHBOARD=0`, and enable query
   redaction while preserving the other reviewed observability settings. This
   may intentionally leave sign-in unavailable until the next step; do not
   restore anonymous identity to make testing possible.
3. Confirm the intended administrator's email and review existing account and
   immutable bootstrap provenance before choosing first-account setup or audited
   account recovery. Existing account state has not been inspected; do not
   assume an empty database or delete records to reopen signup. For a new first
   account on this public hostname, the built-in lane requires both a persistent
   Worker-only `BETTER_AUTH_SECRET` and `BETTER_AUTH_BOOTSTRAP_TOKEN`.
   `BETTER_AUTH_OWNER_EMAIL` additionally restricts the allowed email; it cannot
   replace the bootstrap token. Creation of each new persistent secret needs
   action-time approval. Do not create an account, send mail or expose a secret
   in logs or committed files.
4. Approved control-plane tests additionally need persistent Worker-only
   `INTERNAL_SIGNING_KEY` and `ARTIFACT_SIGNING_KEY`, each independently generated
   from at least 32 cryptographically random bytes, encoded for the secret
   binding. Creating these credentials requires action-time approval. They must
   never enter the container, browser, task payload or evidence report. A changed
   signing key also invalidates capabilities or dispatches signed by an older
   key.
5. Review a new existing-resource snapshot and guarded updater configuration
   against the actual secured version. Preserve the 13 existing Durable Object
   namespaces, D1/KV/R2/Vectorize bindings and the proven Sandbox application and
   image; create no replacement resources. Include the built-in
   `CF_VERSION_METADATA` binding and exact Git revision tag. It has no backing
   storage resource. The current updater does not yet emit this binding and
   rejects secret-bearing snapshots, so authentication preservation must be
   explicitly supported and tested before code upload. Never round-trip secret
   values from a settings response or broaden unknown-binding acceptance.
   Its existing bounded schedule action clears only the reviewed preview
   `*/5 * * * *` cron if present. Retain that explicit action in the reviewed
   plan; an unknown schedule must stop reconciliation rather than be removed.
6. Only after that review, upload the frozen PR revision to this preview. Verify
   the resulting version, exact revision tag, private anonymous API denial,
   authentication lane, unchanged resource identities, no production routes and
   the expected image. A metadata sample is not continuous rollout proof.

## Permission, persistence and cost boundaries

The deployment identity needs read access for the target settings, deployments,
routes, resource identities and existing Sandbox attachment, plus Worker script
and settings update permission for the approved write. It does not need new
account credentials, account-wide resource creation, production routing,
repository administration or payment authority. Secret creation is a separate
explicit action, even if the deployment identity technically permits it.

The proposed settings, code and approved Worker secrets persist until explicitly
changed or the preview is removed. Existing data and resources remain in place.
Do not assume removing a PR also cleans up separately managed resources.

No new storage or container application is proposed. Actual acceptance still
consumes the account's normal Worker, Durable Object, storage, container and
model usage. Reconciliation does not queue or approve new tasks or intentionally
invoke a model. Existing Durable Object state and alarms have not been inspected;
startup can recover retained work or submissions under their existing policy.
Zero downstream execution cannot therefore be promised solely from an upload.
Review the handling of existing recovery/alarms and a non-waking verification
plan before uploading code. Generic run, approval or session reads must not wake
unrelated work. This proposal grants no permission to inspect private state or
cancel existing work. Sandbox execution still requires its frozen named human
approval, and real Slack or vendor effects require their separately authorized
test destinations/accounts.
Installed email verification for invited members, Slack, model providers and
OpenConnector require additional verified configuration; this minimal sign-in
setup does not establish those integrations.

## Present blocker

The selected executor has no authenticated deployment identity. Repository
secret metadata could not be inspected because GitHub returned 403. The
connected Cloudflare app supplied read-only inventory evidence, but no supported
local bundle upload and credential-preserving update path has been established.
The administrator email and approval to create the named persistent Worker
secrets remain pending. No new token, secret, account or remote mutation was
performed for this proposal.
