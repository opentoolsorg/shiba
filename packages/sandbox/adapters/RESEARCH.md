# Sandbox provider research (dated 2026-10-19)

Planning notes for `@shiba/sandbox` adapters. **No pricing below is invented** — each row links to an official page fetched 2026-10-19. Re-check before quoting in marketing.

| Provider | Docs | Egress / secrets model | Preview URLs | Snapshots | Notes for shiba |
| --- | --- | --- | --- | --- | --- |
| **Cloudflare Containers + Sandbox SDK 1.0** | [Sandbox SDK](https://developers.cloudflare.com/sandbox/), [Containers pricing](https://developers.cloudflare.com/containers/pricing/) | Worker `SandboxOutbound` intercepts HTTP(S); credentials stay in Worker ([security model](https://developers.cloudflare.com/sandbox/concepts/security/)) | Token-gated host pattern via `exposePort` | `container.snapshotContainer` (beta) | **Default production path** — matches five invariants in `ARCHITECTURE-AS-BUILT.md`. |
| **Docker (local)** | [Docker Engine](https://docs.docker.com/engine/) | **No edge enforcement** — container has full egress unless operator adds firewall | Host network or published ports | Image commit / volume | `docker-local` adapter; requires `SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS=1`. |
| **E2B** | [E2B docs](https://e2b.dev/docs), [Pricing](https://e2b.dev/pricing) | API keys on Worker only; sandboxes get ephemeral env ([docs](https://e2b.dev/docs/sandbox)) | Built-in HTTPS preview links per sandbox | Pause/resume via API | Stub adapter in `src/adapters/e2b.ts`; live wiring deferred. |
| **Daytona** | [Daytona docs](https://www.daytona.io/docs/), [Pricing](https://www.daytona.io/pricing) | Workspace isolation; API key on control plane | Dev server preview URLs in dashboard | Workspace snapshots (product-dependent) | Good fit for self-hosters with a Daytona control plane; no adapter yet. |
| **Modal** | [Modal Sandboxes](https://modal.com/docs/guide/sandbox), [Pricing](https://modal.com/pricing) | Secrets via Modal secrets API, not in image | Tunnel URLs (`modal forward`) | Filesystem ephemeral | Python-first control plane; would need a thin Worker proxy. |
| **Fly Machines** | [Fly Machines](https://fly.io/docs/machines/), [Pricing](https://fly.io/docs/about/pricing/) | Per-machine network policies | `fly proxy` / public services | Machine images / volumes | Firecracker VMs; egress policy is operator-defined, not shiba's outbound handlers. |

## Capability honesty

Shiba's approval and egress invariants assume **edge-enforced outbound HTTP**. Providers without that flag must set `edgeEgressEnforcement: false` and the backend refuses them unless `SHIBA_SANDBOX_ALLOW_UNENFORCED_EGRESS=1`.

## Template

See [ADAPTER-TEMPLATE.md](./ADAPTER-TEMPLATE.md) for implementing a new adapter.
