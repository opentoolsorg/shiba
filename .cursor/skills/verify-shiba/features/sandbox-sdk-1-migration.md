## Sub-features

- Wrangler `scheduling_policy: durable_object` and `@cloudflare/sandbox@1.0.x` with a custom `Sandbox` Durable Object
- Outbound egress still deny-by-default with Worker-side credential injection (`egress.ts` via `SandboxOutbound`)
- Inactivity timeout (1m) plus alarm keepalive for long harness runs
- Optional `snapshotContainer` persistence on the DO
- Preview hostname proxy (`{port}-{sandboxId}-{token}.{WORKER_HOSTNAME}`) without `proxyToSandbox` from the npm package

## How to get to it (user POV)

1. Launch verify-shiba (`scripts/launch.sh`) on a branch that includes Phase 2a.
2. Drive `task-submit-and-approval` then `sandbox-run-and-diff` — a real container should start under Docker after approval.
3. Optionally run `doctor.sh` and confirm wrangler ≥ 4.136.0 and Docker are healthy.

Staging production rehearsal is **deferred** — see `apps/web/src/content/docs/docs/sandbox-sdk-1.md` (owner deploys from Mac with a renamed Worker).

## Driving it with Playwright

There is no new dashboard surface. Reuse `drive.mjs --feature sandbox-run-and-diff` and capture:

- Screenshot after approval showing run status transitions
- `docker ps` output in evidence showing a container for the sandbox image
- Wrangler log tail containing `container.start` / exec lines (no credential material)

## Gotchas

- SDK 1.0 is a **one-way** production deploy; local `wrangler dev` is the rehearsal surface for this phase.
- Cloud agent environments may lack Docker or a throwaway `GITHUB_TOKEN`; label evidence inconclusive when doctor fails.
- Mixed 0.12 and 1.0 Workers cannot coexist on one account — staging deploy must use a separate Worker name (documented, not executed here).
