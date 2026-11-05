# Shiba positioning and search plan

**Draft:** 2026-09-26. This is a content and measurement plan, not a claim of search ranking or launch readiness.

## Positioning

**Working category:** an open-source, self-hosted *cloud software engineer* that runs coding tasks in the operator's Cloudflare account. The phrase describes the product direction; do not claim Shiba is literally the first cloud software engineer. Other cloud coding agents and open-source runtimes already exist.

**Why build it:** developers need a task-to-reviewable-change workflow without giving a hosted vendor unchecked repository access. Shiba's distinctive boundary is exact-input human approval before sandbox startup by default (with opt-in unattended mode limited to PR-only automations on an explicit repository allowlist), account-owned Cloudflare infrastructure, provider credentials injected by Worker-side egress (AI Gateway for supported routes, direct forwarding for Devin), and inspectable output. The trust and ownership story is more credible than “fully autonomous engineer” copy.

**Audience:** solo developers and small engineering teams who want to self-host an AI coding agent, delegate scoped GitHub tasks, and review diffs/PRs. Secondary audience: contributors who care about approval gates, Workers, Sandbox, and harness adapters.

**Honest qualifiers:** Shiba is single-tenant; real cloud acceptance still needs the account's AI Gateway credentials and cloud deployment. Do not promise autonomous merging, complete human replacement, a price advantage, or a fully hosted service. A waitlist signup is for project updates and contribution, not access to the open-source code.

## Positioning

Shiba's comparison point is the category of hosted, cloud-based coding agents. Positioning copy must not name other products.

- **Category overlap:** both accept a scoped coding task and return a reviewable change (diff/PR).
- **Shiba's actual differentiators** (from this repo, not marketing): open-source and self-hosted in the operator's own Cloudflare account; exact-input human approval before sandbox startup by default, with opt-in unattended mode limited to allowlisted PR-only automations; provider credentials injected by Worker-side egress rather than passed into the sandbox.
- **Where hosted products are stronger:** a managed product with no self-hosting burden. Do not downplay this; it is the honest trade-off.
- **What not to claim:** no price advantage claim, no "better than" verdict, no claim that self-hosting is right for everyone, and no feature claims about other products.

`/why-shiba/` may describe the high-level managed-versus-self-hosted trade-off, but must avoid unsupported feature, pricing, or maturity claims.

## Search architecture

| Intent | Page | Main query theme | Next step |
| --- | --- | --- | --- |
| Understand the product | `/` | self-hosted AI software engineer | Read why / docs |
| Founder story and category | `/why-shiba/` | cloud software engineer; why self-host coding agents | Join or inspect architecture |
| Join/contribute | `/waitlist/` | Shiba waitlist; contribute to Shiba | Submit form or open GitHub |
| Evaluate trust | `/docs/approval-gates/`, `/docs/security/` | approval-gated coding agent; AI agent credential isolation | Try local setup |
| Implement | `/docs/getting-started/`, `/docs/deployment/`, `/docs/architecture/` | Cloudflare coding agent; self-host AI coding agent | Deploy in own account |

No comparison pages are published. Do not reuse other products' branding or assets.

## 90-day execution

1. **Now — make the site crawlable and useful.** Publish `/why-shiba/` and `/waitlist/` with unique titles, descriptions, one H1, self-canonical URLs, internal links, and sitemap entries. Keep `/app/` private/noindex; keep docs public. Validate output and the signup flow locally before deployment. Submit sitemap in Search Console after an authorized deployment.
2. **Next 30 days — publish proof, not volume.** Write one implementation note each for (a) approval before sandbox startup, (b) AI Gateway credential egress, and (c) the local end-to-end run including its gateway-auth limitation. Link each from the relevant docs and founder page. Include diagrams or code references and dated verification.
3. **Days 31–60 — answer adoption questions.** Improve quickstart and troubleshooting based on real setup friction. Publish a cost *surface* explainer using official pricing links and no invented bills. Ask contributors for concrete setup reports/issues, not generic testimonials.
4. **Days 61–90 — update.** Update positioning if Shiba's actual workflow changes.

## Measurement and guardrails

- Baseline Search Console impressions, indexed pages, clicks and queries; review monthly rather than chasing daily fluctuations. Track `/why-shiba/` → `/waitlist/` visits and successful submissions without placing emails in analytics.
- Review `robots.txt`, sitemap, canonical URLs, broken internal links and mobile readability after each build. Validate structured data against the actual page content; no fabricated reviews, ratings, prices or “first” claim.
- Success in the first cycle is **qualified developer interest and useful contribution**, not a ranking promise. Count stored signups by interest privately; never publish email addresses or unverified popularity figures.

Search guidance: [Google helpful content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content), [sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).
