# OpenConnector coordinated runtime foundation, 2026-11-07

## Status and scope

**Not enabled or deployed.** The Shiba-owned sibling runtime foundation now has
executable code and offline tests. It is not end-to-end live API-key acceptance.
No upstream tracked source, account, credential, production resource or binding
was changed. Parent authority integration is a separate implementation slice.
Existing OAuth-only adapters and direct-execute rejection remain in force.

Base: PR #199 `d312707acc10fe1c72371915780fcfdd7c1c31b4`.
Native source: upstream v1.9.4, exact
`d89dc9f24f5a057bb500272d7dbf333837c77c68`.

## Implemented

- `packages/openconnector-read-gateway/src/coordinated-owner.ts`: one
  non-expiring execution owner serializes native requests, cron and protected
  dispatch. All pinned D1 methods use a scope-bound facade. Module-lifetime
  `AsyncLocalStorage` routes native cached applications to the active owner's
  database even after object reconstruction. Saved statements and detached
  continuations retain their original scope and cannot mutate a later job.
- Native response bodies are bounded and consumed before releasing the owner.
  Registered `waitUntil` tasks and even unawaited SQL drain before the next job.
  Unresolved tasks hold the owner rather than releasing a stale lease. Background
  SQL failure makes that owner unavailable. SSE, WebSockets and passthrough are
  deliberately unavailable in the generated conservative wrapper.
- `operator-envelope.ts`: bounded duplicate-key-rejecting JSON, well-formed
  Unicode, exact field sets, sorted grant references, server-derived personal
  alias, strict action arguments and domain-separated complete request digest.
  Capabilities and secrets are never in its digest or persisted envelope.
- `operator-store.ts`: SQLite transactions and durability flushes, unique
  invocation and approval tombstones, startup conversion of unfinished work to
  `unknown`, digest conflicts, and response pruning without deleting one-shot
  records. Retired epochs cannot reactivate through an expiring lease.
- `operator-gateway.ts`: protected capture, durable claim, parent redemption,
  irreversible durable dispatch commitment, then final expiry/cancellation
  checks immediately before the single-use prepared request. Unknown admission,
  timeout, redirect, malformed or oversized response never causes another send.
  Revocation barriers echo the exact deployment epoch and revocation nonce.
- `operator-upstream.ts`: actual pinned storage/codec/token/policy APIs, explicit
  encrypted local SQL provenance, exact revision, and one exact stored runtime
  action/account grant. Admin/static tokens, wildcards, proxies, triggers,
  plaintext, SaaS, OAuth and custom credentials cannot use this lane.
- `operator-provider.ts`: only `figma.get_file_metadata`, with GET to the fixed
  `api.figma.com/v1/files/{fileKey}/meta` template and `X-Figma-Token`. No native
  generic action runner, arbitrary URL, redirect, refresh or provider retry.
  Response projects only redacted name and a validated canonical UTC timestamp.
- `infra/openconnector-coordinated-gateway.mjs`: a pure alternative-entry plan
  with one fixed Durable Object name across epochs and an append-only SQLite
  migration. Public and encoded operator execution paths always return 503.
  There is no API-key enable switch and no deploy/provision command. MCP OAuth
  KV and existing unreviewed Durable Object migrations are rejected by the plan.

The operator manifest contains hashes of the six runtime implementation files,
input schema and fixed executor. Root exports preserve browser-compatible
imports; the Node-compatible owner has an explicit `/operator-runtime` entry.
Adding package exports changes the existing read-gateway build digest. Existing
read deployments would therefore need a new reviewed manifest/version pin, not
silent reuse of an old approval or standing grant.

## Verification

Run focused tests with the existing installed toolchain:

```sh
pnpm -C packages/openconnector-read-gateway test
node --test infra/openconnector.test.mjs infra/openconnector-read-gateway.test.mjs infra/openconnector-coordinated-gateway.test.mjs
node packages/openconnector-read-gateway/scripts/generate-operator-manifest.mjs --check
```

Checkpoint results:

- **150 gateway tests passed**, including 74 new operator/coordination cases.
- **16 infra tests passed**, including source-hash and hard-disabled-entry checks.
- Gateway production TypeScript and both new test files typechecked.
- Changed package source/test ESLint and `git diff --check` passed.
- Independent review found and corrected two issues: cached native facades after
  object reconstruction, and credential reflection inside a permissively parsed
  timestamp. Both now have regression coverage.

The selected-module fixture imports original upstream AES codec, SQL store,
`RuntimeTokenService` and action policy sources after verifying their Git blob
hashes. Unrelated storage constructors remain explicit stubs in that fixture.
The separate full-native test below does not stub those native modules.

### Full native Worker and generated entry in workerd

Prepare a clean, dependency-installed upstream checkout at the exact pin; generate
its normal provider registry if needed. Then run:

```sh
node packages/openconnector-read-gateway/scripts/verify-native-coordinator.mjs /path/to/open-connector
```

The runner never downloads, deploys or creates remote resources. Without a path it
prints an explicit skip, not a pass. It validates the exact Git revision, clean
tracked files and seven critical API hashes before bundling the full native
Worker graph, including all 1,674 generated provider executor imports.

Verified offline using fake tokens, an empty fixture catalog, local D1/R2 and
real SQLite Durable Object storage:

- All 18 original D1 migrations.
- 22 HTTP checks across the instrumented owner and the exact generated entry.
- Repeated native health/catalog requests and cached native application reuse.
- Native runtime-policy PUT/GET, preserved across actual runtime stop/restart.
- Native cron `waitUntil` drainage including background SQL.
- Durable interrupted claim recovery to `unknown` and permanent replay refusal.
- Generated cron forwarding through a plain serializable RPC event.
- Plain and encoded reserved operator paths return 503.
- Zero Worker outbound calls; Miniflare host metadata networking explicitly off.

The native unminified bundle is approximately 41 MB. This verifies local runtime
behavior, not production bundle-size eligibility or deployment compatibility.
The catalog is synthetic and empty; this is not evidence that all providers or
real credential operations work. No real account was connected or queried.

## Remaining activation gates

1. Integrate the parent authority coordinator into **all** existing relevant
   employee, grant, principal, session, cancellation and enrollment invalidations.
   Copying snapshots or accepting review-only proposals is insufficient.
2. Bind immutable execution enrollment and authenticated owner acceptance to the
   complete deployment/account/action tuple, not a review record or row label.
3. Demonstrate coordinated epoch retirement and drain/removal of old deployments,
   alternate entrypoints and every other writer with access to sibling D1. The
   in-process facade cannot fence an independent raw database writer.
4. Test the complete parent-to-sibling service-binding protocol and targeted
   mutation races, including old/new epoch handover. The full-native smoke test
   proves native plumbing, not every admission race in one deployed topology.
5. Review supported native streaming/background paths and production bundle size.
6. Only after explicit operator deployment/configuration and account consent,
   verify the reviewed non-mutating operation against a live account.

Until those gates pass, preserve the unavailable production route. Offline
success does not prove live vendor compatibility or authorize deployment.
