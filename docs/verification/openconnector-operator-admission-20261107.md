# Operator gateway admission investigation, 2026-11-07

Result: **API-key execution remains disabled.** No new executor was implemented.
The [proposed contract](../openconnector-operator-gateway-contract.md) distinguishes
the missing admission boundary from the already-available pinned revision API.

## Scope and source

- Shiba local base: `35f765f8198f0604420b3a0f3e5efe673f86bb70`.
- Upstream: `oomol-lab/open-connector`, v1.9.4,
  `d89dc9f24f5a057bb500272d7dbf333837c77c68`.
- Actual upstream storage/codec/policy code came from the existing hash-verified
  Apache-licensed fixture. Unrelated constructors and APIs remained the
  fixture's explicit stand-ins. Provider requests and reverse-binding replies
  were synthetic; no live secret or external provider was used.
- Upstream source was not edited. No account, secret, deployment, infrastructure
  resource or remote branch was created or changed.

## Checks completed

| Check | Result |
| --- | --- |
| Existing gateway, pinned adapter and independent security-v3 fixtures | 74 passed, 3 files |
| Operator boundary, employee preflight/routes and capability invocation fixtures | 49 passed, 4 files |
| Read-wrapper planning/source pin tests | 8 passed |
| Temporary admission/idempotency characterization probes below | 4 passed as counterexamples |
| `git diff --check` | Passed |

An independent contract review found the proposed distributed ordering sound
as a design, not a proven implementation. Its two clarifications were applied:
exclude `requestDigest` from its own preimage, and bind/recheck the earliest
applicable authority expiry after the last awaited dispatch commitment.

The 131 existing test cases remain green. The four characterization passes
mean the unwanted behavior was observed, **not** that the new security contract
passed. These probes were removed from the test suite rather than enshrining
unsafe behavior as a desired regression contract.

Used the installed Vitest binaries directly. An initial `pnpm exec` invocation
attempted automatic dependency setup and failed creating its user store; no
package installation completed. Direct invocation used the already-installed
dependencies and did not require installation or credentials.

Commands, from the checkout unless otherwise stated:

```sh
./apps/backend/node_modules/.bin/vitest run --root packages/openconnector-read-gateway \
  test/upstream-adapter.test.ts test/upstream-adapter.security-v3.test.ts test/gateway.test.ts

# From apps/backend:
./node_modules/.bin/vitest run test/openconnector-operator-accounts.test.ts \
  test/employee-openconnector-preflight.test.ts test/capability-invocations.test.ts \
  test/employee-tool-routes.test.ts

node --test infra/openconnector-read-gateway.test.mjs
git diff --check
```

Not run: a new gateway implementation, positive API-key enrollment/dispatch,
complete pinned Worker bundle, coordinated native mutation/cron/cache behavior,
real service bindings, full repository aggregate/build gates or live-provider
acceptance. The only committed changes from this investigation are documents;
no runtime behavior changed.

## Reproduce the characterization probes

At the base above, copy
`packages/openconnector-read-gateway/test/upstream-adapter.test.ts` to a
temporary `upstream-adapter.admission-audit.test.ts` in the same directory. Append
the following code to that temporary file, preserving its existing helper
functions, fixtures and imports. Run it with the `audit witness` test filter.
The test's actual source loader verifies the pinned upstream blob hashes.
Delete the temporary file afterward; do not convert its observed dispatches
into the new gateway's acceptance expectations.

```ts
describe("audit witness: no cross-store mutation admission fence", () => {
  it.each(["credential", "token", "policy"])(
    "permits %s mutation during the awaited final callback", async mode => {
      const f = await fixture();
      f.authority.fetch.mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        f.stages.push(body.stage);
        if (body.stage === "dispatch") {
          if (mode === "credential") f.db.sqlite.exec(
            "UPDATE connections SET revision='rotated-after-last-read' WHERE id='raw-one'");
          if (mode === "token") f.db.sqlite.exec(
            "DELETE FROM runtime_tokens WHERE id='runtime-one'");
          if (mode === "policy") f.db.sqlite.prepare(
            "UPDATE runtime_policy SET value=?").run(JSON.stringify({
              ...modules.emptyPolicyRules(), blockedActions: ["github.list_pull_requests"],
            }));
        }
        return Response.json({ ok: true });
      });
      expect((await f.call()).status).toBe(200);
      expect(f.provider).toHaveBeenCalledOnce();
      expect(f.stages).toEqual(["claim", "dispatch", "complete"]);
    },
  );
});

describe("audit witness: expiring generic idempotency", () => {
  it("reacquires an expired in-progress claim", async () => {
    const db = new FixtureD1();
    db.sqlite.exec("CREATE TABLE idempotency_records(key_hash TEXT PRIMARY KEY," +
      "claim_id TEXT,request_hash TEXT,state TEXT,response_value TEXT," +
      "created_at INTEGER,expires_at INTEGER)");
    type Claim = {
      keyHash: string; claimId: string; requestHash: string;
      now: number; expiresAt: number;
    };
    const upstream = await actualModule<{
      D1RuntimeDatabase: new (binding: FixtureD1,
        options: {secretCodec: UpstreamSecretCodec}) => {
          idempotencyStore: { claim(input: Claim): Promise<{kind: string}> };
        };
    }>("src/server/storage/d1/runtime-store.ts");
    const store = new upstream.D1RuntimeDatabase(db, {secretCodec: codec}).idempotencyStore;
    const original = {
      keyHash: "fixture-key", claimId: "attempt-one", requestHash: "fixture-digest",
      now: 100, expiresAt: 200,
    };
    expect(await store.claim(original)).toEqual({kind: "acquired"});
    expect(await store.claim({
      ...original, claimId: "attempt-two", now: 201, expiresAt: 300,
    })).toEqual({kind: "acquired"});
  });
});
```

Run from `packages/openconnector-read-gateway`:

```sh
../../apps/backend/node_modules/.bin/vitest run \
  test/upstream-adapter.admission-audit.test.ts -t 'audit witness'
```

Observed output: one test file passed; four probes passed and the 30 original
fixture cases were skipped by the filter. The mutation cases each recorded
exactly one synthetic provider call. The expiry case made no provider call.

## Remaining implementation blockers

1. No sibling coordinator or database-enforced gate covers existing credential,
   token and policy writers, background tasks, cached native apps and old
   deployments.
2. No parent coordinated authority/revocation barrier covers every relevant
   D1, KV and session/run invalidation path for this lane.
3. No separate immutable API-key enrollment, owner acceptance, full-envelope
   permits, permanent sibling uncertainty storage or reviewed API-key operation
   registry exists.
4. Complete Worker/coordinator integration and deployment-epoch acceptance
   remain untested. Selected source-fixture success cannot close that gap.

These actions are not denied or uncertain external operations. They are
unimplemented prerequisite contracts. Work deliberately stopped before adding
a permissive runtime path. A coordinated Shiba-owned runtime is technically
possible while keeping upstream source unchanged; the proposed contract states
what must be built and proven before activation.
