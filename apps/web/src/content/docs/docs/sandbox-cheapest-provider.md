---
title: Choosing a sandbox provider (cost)
description: Neutral cost-oriented guide for picking Cloudflare, docker-local, or ComputeSDK backends (prices as of 2026-10-19).
---

Shiba defaults to **native Cloudflare Containers** (`SHIBA_SANDBOX_PROVIDER=cloudflare`) because only that path enforces Worker-side egress without extra flags. When you self-host or experiment, you can trade cost and convenience against those security guarantees.

## Quick comparison (2026-10-19)

| Option | Typical $/hour (order of magnitude) | Edge egress enforced | Where it runs |
| --- | --- | --- | --- |
| **docker-local** | **$0** (your hardware) | No — requires `SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS=1` | Docker on your machine |
| **Cloudflare Containers** (shiba default) | ~**$0.09–0.22**/h (instance size) | **Yes** | Your Cloudflare account — [Containers pricing](https://developers.cloudflare.com/containers/pricing/) |
| **E2B** via ComputeSDK | ~**$0.166**/h | No | Node/Bun control plane + [E2B pricing](https://e2b.dev/pricing) |
| **Modal** via ComputeSDK | ~**$0.238**/h | No | Node/Bun control plane + [Modal pricing](https://modal.com/pricing) |

Re-check vendor pages before budgeting — this page is dated **2026-10-19** and does not track promotions.

## When to use what

### Free local dev: `docker-local`

```bash
SHIBA_SANDBOX_PROVIDER=docker-local
SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS=1
```

Best for: hacking on a laptop with Docker, no cloud spend. Not for production multi-tenant trust boundaries.

### Production on your Cloudflare account: `cloudflare` (default)

No extra sandbox env vars. You pay Cloudflare list price for container CPU/RAM; shiba keeps GitHub tokens and model keys out of the container via `SandboxOutbound`.

### Cheapest hosted sandboxes without Cloudflare Containers: `computesdk`

ComputeSDK ([MIT](https://github.com/computesdk/computesdk), core pin **4.1.12**) exposes one API across many vendors. Shiba wires it as:

```bash
SHIBA_SANDBOX_PROVIDER=computesdk
SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS=1
SHIBA_COMPUTESDK_PROVIDER=e2b   # or modal, daytona, …
E2B_API_KEY=...                 # provider-specific; see COMPUTESDK-MATRIX.md
```

**Important:** `computesdk` does **not** run inside the Cloudflare Worker bundle. It loads only on a **Node/Bun host** (local agent, self-hosted control plane). The Worker edge must stay on `cloudflare` unless you proxy sandbox ops to that host.

Capability matrix and NOT VERIFIED cells: `packages/sandbox/adapters/COMPUTESDK-MATRIX.md`.

See also [Sandbox providers](/docs/sandbox-providers/) and [Security](/docs/security/).
