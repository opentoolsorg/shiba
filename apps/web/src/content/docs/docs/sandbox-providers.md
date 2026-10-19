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

## Multi-provider via ComputeSDK (`computesdk`)

[ComputeSDK](https://github.com/computesdk/computesdk) (MIT, core **4.1.12**) unifies ~25 sandbox vendors behind one TypeScript API (`compute.instances.create`, `runCommand`, `filesystem`, `getUrl`, `destroy`).

```bash
SHIBA_SANDBOX_PROVIDER=computesdk
SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS=1
SHIBA_COMPUTESDK_PROVIDER=e2b
# plus provider credentials (E2B_API_KEY, MODAL_TOKEN_*, …) — never logged
```

| Topic | Detail |
| --- | --- |
| **Worker edge** | **Not supported** — `computesdk` loads only on Node/Bun (host agent / control plane). Production Workers should use `cloudflare`. |
| **Egress** | Not shiba Worker egress. Optional ComputeSDK instance egress router is documented upstream; treat as **NOT VERIFIED** for shiba invariants. |
| **`raw()`** | Exposes the native ComputeSDK `Instance` when `rawProviderHandle` is true. |
| **Matrix** | `packages/sandbox/adapters/COMPUTESDK-MATRIX.md` |

Cost-oriented picking guide: [Sandbox cost guide](/docs/sandbox-cheapest-provider/).

## Other providers (research)

Neutral comparison and official doc links (pricing checked **2026-10-19**) live in the repo at `packages/sandbox/adapters/RESEARCH.md`:

- [E2B](https://e2b.dev/docs) — hosted sandboxes with API keys on the control plane
- [Daytona](https://www.daytona.io/docs/) — workspace-oriented dev environments
- [Modal](https://modal.com/docs/guide/sandbox) — Python-centric sandboxes
- [Fly Machines](https://fly.io/docs/machines/) — Firecracker VMs you operate

An E2B adapter stub exists for contract tests; live wiring is not enabled in this release.

## Extending: registry API

```typescript
import { registerSandboxProvider } from "@shiba/sandbox";
registerSandboxProvider("my-co", (ctx) => /* SandboxProvider */);
```

Built-ins register on package import. Full guide: [Custom sandbox provider](/docs/sandbox-custom-provider/).

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHIBA_SANDBOX_PROVIDER` | `cloudflare` | Registered provider id |
| `SHIBA_SANDBOX_TIMEOUT_MS` | `900000` | Default exec timeout (ms) |
| `SHIBA_SANDBOX_REGION` | unset | Region hint (provider-specific) |
| `SHIBA_SANDBOX_EGRESS_ALLOWLIST` | unset | Extra egress hosts (cloudflare pin) |
| `SHIBA_SANDBOX_ENV_PASSTHROUGH` | unset | Non-secret `KEY=value` exec env |
| `SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS` | off | Opt-in when edge egress is not enforced |
| `SHIBA_DOCKER_SANDBOX_IMAGE` | `shiba-sandbox:local` | Image for `docker-local` |
| `SHIBA_DOCKER_PREVIEW_HOST` | `127.0.0.1` | Preview URL host for `docker-local` |
| `SHIBA_COMPUTESDK_PROVIDER` | — | Backend id when `computesdk` |

See also [Configuration & Secrets](/docs/configuration/) and [Security](/docs/security/).
