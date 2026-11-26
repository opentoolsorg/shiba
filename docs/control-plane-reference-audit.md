# Control plane reference audit — retired

Status: retired historical audit. This file previously recorded implementation
patterns observed in external reference products. It is no longer a source of
truth for Shiba architecture or for current implementation evidence.

Use the current Shiba-owned documents instead:

1. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — living employee-platform
   architecture.
2. [`../ARCHITECTURE-AS-BUILT.md`](../ARCHITECTURE-AS-BUILT.md) — measured
   implementation snapshot.
3. [`../INFRA-AUTH-HARNESS-MONOREPO.md`](../INFRA-AUTH-HARNESS-MONOREPO.md) —
   end-to-end runtime, auth, harness, and monorepo flow.
4. [`architecture/durable-objects.md`](architecture/durable-objects.md) — state
   ownership.
5. [`architecture/request-lifecycle.md`](architecture/request-lifecycle.md) —
   approved work lifecycle.
6. [`architecture/security-model.md`](architecture/security-model.md) —
   authority invariants.

## Current rule

Evaluate control-plane decisions against Shiba's own code, tests, threat model,
and product contract. External products can be useful evidence, but their file
layout, provider model, or terminology is not authority for Shiba.

A control-plane proposal must identify:

- the Shiba product object it changes;
- the owning module;
- the exact approval envelope;
- the execution lane;
- the state owner;
- the evidence and receipt contract;
- cancellation, retry, and outcome-unknown behavior;
- why the change does not weaken the security invariants.
