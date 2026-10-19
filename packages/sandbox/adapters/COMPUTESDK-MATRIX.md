# ComputeSDK compatibility matrix (shiba `@shiba/sandbox`)

**Core pin:** [`computesdk@4.1.12`](https://www.npmjs.com/package/computesdk) (MIT). Provider packages are installed separately (e.g. `@computesdk/e2b@1.7.62`). API verified from `computesdk@4.1.12` TypeScript definitions (`compute.instances.*`, `Instance.runCommand`, `filesystem`, `getUrl`, `destroy`) on **2026-10-19**.

## Where this runs

| Runtime | `SHIBA_SANDBOX_PROVIDER=computesdk` |
| --- | --- |
| **Cloudflare Worker (production edge)** | **Refused** — Worker isolates cannot load `computesdk` (Node/Bun + `daemond`). Use `cloudflare` (default) or route runs through a **Node/Bun control plane** (local daemon, self-hosted agent) that sets `SHIBA_SANDBOX_PROVIDER=computesdk` on the host process. |
| **Node / Bun host** (e.g. `wrangler dev` with Node compat, local agent) | Supported via lazy `import()` of `computesdk` and `@computesdk/<backend>`. |
| **docker-local** | Independent free path — does not use ComputeSDK. |

Shiba **never** logs credential env vars. Map secrets in `.dev.vars` / Worker secrets only.

## Capability matrix (honest defaults)

`edgeEgressEnforcement` is **never** true for ComputeSDK — that flag is reserved for shiba’s native Cloudflare `SandboxOutbound` path. Optional ComputeSDK `CreateInstanceOptions.egress` router is **NOT VERIFIED** against shiba’s five invariants.

| Backend (`SHIBA_COMPUTESDK_PROVIDER`) | Preview URLs (`getUrl`) | Snapshots | Streaming exec | Wired in `computesdk-load.ts` | Pricing note (2026-10-19) |
| --- | --- | --- | --- | --- | --- |
| `e2b` | Yes | Yes | Yes | Yes (`E2B_API_KEY`) | ~$0.166/h — [e2b.dev/pricing](https://e2b.dev/pricing) |
| `modal` | Yes | Yes | Yes | Yes (`MODAL_TOKEN_ID` / `SECRET`) | ~$0.238/h — [modal.com/pricing](https://modal.com/pricing) |
| `daytona` | Yes | Yes | Yes | Yes (`DAYTONA_API_KEY`) | NOT VERIFIED |
| `vercel` | Yes | NOT VERIFIED | Yes | Yes (`VERCEL_TOKEN` / `VERCEL_OIDC_TOKEN`) | NOT VERIFIED |
| `cloudflare` (ComputeSDK HTTP sandbox) | Yes | NOT VERIFIED | Yes | Yes (`CLOUDFLARE_SANDBOX_URL` / `API_KEY`) | Not the same as shiba native CF Containers; ~$0.09–0.22/h CF Containers — [developers.cloudflare.com/containers/pricing](https://developers.cloudflare.com/containers/pricing/) |
| Other ComputeSDK backends | Per provider README | NOT VERIFIED | Usually yes | Add to `PACKAGE_BY_BACKEND` | See [computesdk repo](https://github.com/computesdk/computesdk) |

## `raw()` escape hatch

When `capabilities.rawProviderHandle` is true (ComputeSDK adapter), `instance.raw()` returns the underlying ComputeSDK `Instance` for provider-specific APIs. Callers must check the flag first.
