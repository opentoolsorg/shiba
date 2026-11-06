# Pinned OpenConnector scheduled-read adapter

The Worker-only `@shiba/openconnector-read-gateway` package has an independently
authored adapter for unmodified OpenConnector v1.9.4 at commit
`d89dc9f24f5a057bb500272d7dbf333837c77c68`. It reuses the upstream encrypted
connection storage, stored runtime-token service and action-policy APIs. It does
not call the generic action executor, refresh OAuth, select an API key, enumerate
private connections or fall back to an operator account.

This is a bounded route added to the existing upstream Worker. The entire
upstream Worker is not read-only: ordinary manual routes and its scheduled
maintenance still delegate to the original entry and retain their existing
authentication and behavior. The read namespace never delegates an unknown or
encoded reserved route to those manual APIs.

## Package and credential boundary

`src/upstream-adapter.ts` owns per-request API adaptation. It constructs a private
context through the generated wrapper's real upstream imports:

- `createWorkerSecretCodec` from `server/secrets/worker-secret-codec.ts`;
- `D1RuntimeDatabase` with the sibling's existing `DB` and secret codec;
- `connectionStore.get(service, exactAlias)` for one selected local connection;
- `RuntimeTokenService.resolveToken` and `runtimePolicyStore.get` on each check;
- `ActionPolicySnapshot` for deployment, current runtime and token policy.

There is no parent `AGENT_AUDIT` binding. The sibling's existing encryption key
remains a Worker secret. No key, token, credential metadata or connection object
is serialized to a report, sent to a container or written by this helper.

The upstream encrypted codec can decode legacy plaintext rows. This lane wraps
that codec and requires the `enc:worker:v1:` prefix before decoding. A missing
encryption key or plaintext codec fails closed. Existing manual upstream
behavior is not changed.

Only a stored `oct_` token with nonempty explicit audited action IDs and exact
raw connection IDs is accepted. Empty or wildcard grants are not treated as
restricted grants; upstream normally interprets some empty lists as unrestricted.
Static runtime secrets, administrator tokens and subscription credentials are
not authentication fallbacks for this lane.

The selected connection must be local OAuth for the exact service and
server-derived workspace alias. Its consent provenance, revision and token are
rechecked after policy awaits. SaaS references, default aliases, API keys,
reauthorization-required records and malformed or expiring credentials fail
closed. An absent OAuth expiry remains unknown; a supplied expiry must be valid
and more than one minute away. No refresh is attempted. Known access, refresh
and runtime-token values are redacted before result serialization by the core
gateway.

The reverse `SHIBA_AUTOMATIC_AUTHORITY` service binding carries only opaque,
stage-scoped parent permits. The parent signing key is never bound to the
sibling. Parent admission is required before the fixed provider request; a
stored completed receipt can be returned after acknowledgment loss without a
second provider read.

## Local configuration planning

`infra/openconnector-read-gateway.mjs` supports only **plan** and **prepare**.
It does not clone, install dependencies, create credentials, provision resources,
apply migrations, deploy or enable the feature. Start with an already prepared,
configured, clean upstream checkout at `.openconnector/v1.9.4`. The helper checks
the exact Git revision and immutable source blob hashes before writing anything.

Google Ads additionally requires the sibling-only secret
`SHIBA_AUTOMATIC_SOURCE_FINGERPRINT_KEY`: an operator-provisioned cryptographically
random base64url key of 43–128 characters, with at least 16 distinct characters.
The plan reports this requirement without generating or placing a value in
configuration. It is not a parent Worker secret. A dedicated runtime token must
allow only `googleads.campaign_daily_metrics` and the exact selected connection.
An encrypted, current OAuth source must include the documented `adwords` scope
and developer-token configuration. Preparation and execution recheck an opaque
keyed source fingerprint. Rotation invalidates the reviewed Ads grant. These
requirements do not activate a feature or certify live vendor compatibility.

Set `PARENT_WORKER_NAME` to the exact existing parent Worker selected by the
operator, then inspect the local plan:

```sh
node infra/openconnector-read-gateway.mjs plan "$PARENT_WORKER_NAME"
```

After reviewing that plan, local preparation writes two new files without
overwriting either existing file:

```sh
node infra/openconnector-read-gateway.mjs prepare "$PARENT_WORKER_NAME"
```

Those files are `src/server/shiba-read-entry.ts` and
`wrangler.shiba-read.jsonc` in the upstream checkout. The original manual entry
and `wrangler.local.jsonc` remain unchanged. Existing assets, migrations, transit
storage, compatibility settings and maintenance configuration are preserved.
The separate configuration adds platform version metadata and the one-purpose
reverse binding, and sets `SHIBA_AUTOMATIC_READ_GATEWAY_ENABLED` to **false**.
Literal credential variables and silent replacement of an existing authority or
version binding are rejected. Named environment overrides are unsupported:
select one explicit standalone manual configuration before planning, so an
environment cannot override the disabled flag or hide another resource target.
The plan cannot establish that a supplied resource
ID belongs to the intended account; the operator must review that before any
separate deployment action.

Activation still requires explicit operator configuration and an authorized
deployment. The parent separately pins the exact platform version UUID and
generated manifest digest through `OPEN_CONNECTOR_READ_VERSION_ID` and
`OPEN_CONNECTOR_READ_MANIFEST_SHA256`, selects the trusted
`OPEN_CONNECTOR_READ_GATEWAY` binding, and enables its own feature flag. Platform
version metadata is not a cryptographic signature of arbitrary code. The trusted
binding, immutable manifest, source review and operator pins are separate checks.
Any production adapter or helper change requires manifest regeneration and new
review before using another deployed version.

## Offline evidence and limits

The adapter test executes hash-verified, unmodified Apache source fixtures for
the real AES codec, SQL selected-connection read, D1 token/policy stores,
runtime-token service and policy snapshot, against SQLite. Unrelated upstream
store constructors and API imports are explicit test stand-ins; any attempted
unrelated operation throws. Provider requests and the reverse authority binding
are synthetic. The fixtures include the upstream Apache license and preserve
source blob hashes; they are test data, not production vendoring.

```sh
pnpm -C apps/backend exec vitest run --root ../../packages/openconnector-read-gateway test/upstream-adapter.test.ts
node --test infra/openconnector-read-gateway.test.mjs
```

These checks cover actual API interoperability, exact selected aliases,
encrypted-only storage, revoked or unrestricted runtime keys, policy and
credential changes, expiry, unsupported auth modes, no fallback, private
redaction and completed-receipt replay. The pure helper tests cover plan output,
JSONC, preserved original configuration, source hashes and forbidden inline
credentials. They create no upstream account or provider effect.

The adapter gate passed 28 pinned-API/SQLite cases and the pure planner passed
eight cases; an independent reviewer reran both and verified nine official
source fixture blobs and the Apache license. The complete gateway package passed 59 cases,
including two actual local workerd transport checks. The parent scheduled-read
backend passed 27 scoped SQLite/reverse-HMAC/gateway cases. Fixture provider and
authority calls in those tests are separate from actual provider execution.

The [full-wrapper local report](verification/openconnector-wrapper-local-20261105.json)
now records a 41,147,924-byte bundle of the pinned upstream server, generated
wrapper and exact locked dependencies. Actual local workerd initialized it and
returned the expected `503 read_gate_unattested` for one disabled reserved
manifest request, with zero outbound attempts and owned-runtime cleanup. The
bundle SHA-256 is
`551d9f17712c467e76b73cb414b6f2cde82084849f39df0257c195118ced1eb0`.
It uses Wrangler 4.140.0's actual `workerd`, `worker`, `browser` export conditions,
`nodejs_compat` and compatibility date `2026-06-01`. This is actual local module
initialization of the complete bundle, beyond the selected API fixtures.

That smoke does not exercise enabled reads, OAuth, manual routes, provider
requests, cron, native bindings or deployment. Other Wrangler plugins were not
emulated. The literal registry was independently reproduced; the original
upstream generator was not exercised. Node 24.19.0 is below upstream's declared
24.22.1 minimum. The recorded 5,665ms includes local Miniflare setup and is not a
Cloudflare startup CPU measurement or proof of its startup limit. The report
captures the measured source hashes; later comment-only Biome annotations and
the regenerated manifest are outside that measured bundle. Current-head bundle
and deployed service-binding acceptance therefore remain separate gates.

No credentials, upstream account, provisioned resource or deployment were
created for these checks. Actual Cloudflare service bindings, installed OAuth
accounts and live scheduled reads remain unverified. See
[bounded scheduled reads](founder-automatic-reads.md) for the explicit standing
grant user flow and its report limitations.
