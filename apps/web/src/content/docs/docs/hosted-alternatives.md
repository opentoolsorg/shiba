---
title: Shiba vs hosted coding agents
description: Neutral comparison between self-hosting Shiba on your Cloudflare account and using a vendor-hosted coding-agent product — no lock-in claims, public facts only.
---

This page compares **deployment models**, not feature checklists copied from any vendor site. Product names below refer to common **categories** of hosted coding agents (multi-tenant SaaS with credits, VMs, and managed integrations). Read each vendor’s own docs for their current feature set and pricing.

## Summary

| Dimension | Self-hosted Shiba (this project) | Typical hosted coding agent |
| --- | --- | --- |
| **Where it runs** | Your Cloudflare account (Worker + Durable Objects + Containers) | Vendor’s cloud |
| **Source license** | AGPL-3.0-only — fork and publish changes | Proprietary |
| **Model billing** | Your AI Gateway / provider accounts (BYOK) | Often vendor credits, sometimes BYOK with platform fees |
| **Machine billing** | Cloudflare Containers metered usage | Often per-machine-hour credits on top of model cost |
| **Approval before execution** | Frozen input hash; human approves before any sandbox starts | Varies; many products approve per action in-product |
| **Credentials in the sandbox** | Deny-by-default egress; real keys injected outside the container | Varies; reputable vendors also keep git tokens off the VM |
| **Ops burden** | You provision CF resources, secrets, Access, gateway keys | Vendor operates scale, SSO, support tiers |

## When self-hosting fits

- You need **data and runs to stay in an account you control** (single-tenant by architecture, not by contract add-on).
- You already pay for **Cloudflare Workers** and want agent compute beside your existing edge stack.
- You want **AGPL** assurances for forks and hosted derivatives.
- You accept **operator work**: Access, secrets hygiene, gateway BYOK, and honest limits (container size, concurrency caps in `wrangler.jsonc`).

## When a hosted product may fit better

- You want **managed machine sizes**, desktop streaming, or snapshot-heavy VM workflows without operating Containers.
- You need **vendor SOC 2 / enterprise SSO** as a packaged offering rather than your own Cloudflare Access + policies.
- You prefer **flat monthly credits** over reconciling Cloudflare + provider invoices.
- Your team will not run **deploy tooling** (Alchemy or wrangler) or Docker image builds.

## Capability framing (high level)

Hosted products often emphasize **long-lived captains**, deep **subagent trees**, and **large VMs** with graphical desktops. Shiba today targets an **approval-gated pipeline**: plan/delegate → sandbox run → optional Worker-side PR publish → optional chained **review posted from the Worker** (not from the container). Parallelism is **flat** with configured caps (`MAX_CONCURRENT_RUNS`, container `max_instances`). See [Architecture](/docs/architecture/) and the repository `PLAN.md` for an honest capability map.

Neither model removes the need to **review agent output**; Shiba makes the approval step explicit in the product contract (`spec/GOAL.md`).

## Cost shape (qualitative)

- **Shiba:** Cloudflare usage (Workers, DO storage, Container vCPU/GiB-seconds) plus **your** model tokens via AI Gateway. Tokens usually dominate; see [Models & costs](/docs/costs/).
- **Hosted:** Subscription or credit bundles plus **machine time** meters on many public pricing pages. BYOK may still bill machine hours separately.

Numbers change — check Cloudflare and your chosen provider’s current pricing before committing.

## Lock-in and exit

- **Shiba:** Export is “keep your Cloudflare account”; code is on GitHub under AGPL. Moving away means re-implementing integrations you added (Slack apps, webhooks, custom domains).
- **Hosted:** Export is usually API/export features and git history on your repos; agent thread state may not portable.

## Legal and branding

Do not present this page as an official comparison to any trademarked product. Cite **public documentation** when you make factual claims elsewhere. Shiba does not ship another vendor’s UI, copy, or assets.

## Next steps

- [Self-hosting on Cloudflare](/docs/self-hosting/)
- [Getting started](/docs/getting-started/)
- [Readiness checklist](/docs/readiness/)
