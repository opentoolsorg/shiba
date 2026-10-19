---
title: Sandbox providers
description: Choose where shiba runs agent containers — Cloudflare by default, or alternate backends for self-hosting.
---

Shiba isolates each run in a **sandbox** (Linux container or microVM). The Worker talks to sandboxes through [`@shiba/sandbox`](https://github.com/princepal9120/shiba/tree/main/packages/sandbox): a small typed interface with pluggable adapters.

## Default: Cloudflare (`cloudflare`)

Production deployments use **Cloudflare Containers** and the [Sandbox SDK 1.0](/docs/sandbox-sdk-1/). Outbound HTTP(S) from the container is intercepted by the Worker (`SandboxOutbound`), so **GitHub tokens and model keys never enter the container**. This is the only provider that satisfies shiba's five security invariants without extra flags.

No configuration is required when `SHIBA_SANDBOX_PROVIDER` is unset or `cloudflare`.

## Self-host on one machine (`docker-local`)

For local development without Cloudflare Containers, set:

```bash
SHIBA_SANDBOX_PROVIDER=docker-local
SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS=1
SHIBA_DOCKER_SANDBOX_IMAGE=shiba-sandbox:local   # docker build -f apps/backend/Dockerfile .
```

**Honest limitations:**

| Capability | Cloudflare | docker-local |
| --- | --- | --- |
| Edge egress enforcement | Yes | **No** — container has normal Docker networking |
| Token-gated preview URLs | Yes | Best-effort via host networking |
| Container snapshots | Beta (SDK) | No |
| Managed by | Worker + Sandbox DO | Local Docker Engine |

The backend **refuses** `docker-local` unless `SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS=1`, so you cannot accidentally disable egress enforcement in production.

## Other providers (research)

Neutral comparison and official doc links (pricing checked **2026-10-19**) live in the repo at `packages/sandbox/adapters/RESEARCH.md`:

- [E2B](https://e2b.dev/docs) — hosted sandboxes with API keys on the control plane
- [Daytona](https://www.daytona.io/docs/) — workspace-oriented dev environments
- [Modal](https://modal.com/docs/guide/sandbox) — Python-centric sandboxes
- [Fly Machines](https://fly.io/docs/machines/) — Firecracker VMs you operate

An E2B adapter stub exists for contract tests; live wiring is not enabled in this release.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHIBA_SANDBOX_PROVIDER` | `cloudflare` | Adapter id |
| `SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS` | off | Opt-in when the provider cannot enforce Worker egress |
| `SHIBA_DOCKER_SANDBOX_IMAGE` | `shiba-sandbox:local` | Image for `docker-local` |
| `SHIBA_DOCKER_PREVIEW_HOST` | `127.0.0.1` | Preview URL host for `docker-local` |

See also [Configuration & Secrets](/docs/configuration/) and [Security](/docs/security/).
