---
title: Runtime costs and limits
description: Distinguish execution budgets, capture limits, output formats, and provider charges.
---

Running Shiba can use Workers requests, planning or condition-evaluation services, Durable Object storage/execution, Containers compute, coding inference, private artifact storage, and GitHub API quotas. An approval gate stops workspace execution from starting without permission; it does not make earlier planning or condition checks free.

Check current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Containers pricing](https://developers.cloudflare.com/containers/pricing/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), and [AI Gateway](https://developers.cloudflare.com/ai-gateway/), plus the model or condition service you configure. No fixed per-task price or free-use guarantee is implied.

## Concurrency and execution budgets

| Control | Current behavior |
| --- | --- |
| Orchestrator run policy | Five active runs by default; ten with `SHIBA_ELEVATED_CONCURRENCY` enabled. |
| Cloud container configuration | `standard-1`, with up to ten instances in the deployment configuration. |
| `SHIBA_DAILY_CONTAINER_BUDGET_USD` | Optional threshold enabled only by a positive finite number; it blocks new starts when recorded, harness-reported usage reaches that amount. Zero, negative, and non-finite values do not enable the threshold. |
| Automation request budget | Defaults to 20 requests per automation per UTC day. |

The run policy is checked against the current orchestrator's run registry. It is not a guarantee of one deployment-global five-run limit, available container capacity, or queued retry. The container ceiling, account quotas, provider limits, and local-computer capacity are separate constraints.

Budget accounting is explicitly **harness reported**. Some runs have no reported cost, and the report is not a complete Cloudflare or model-provider invoice. The optional daily threshold cannot cap all account charges or retroactively stop costs already incurred. Set provider-side alerts and limits where supported, and reconcile them with actual invoices.

Sources: `packages/shared/src/container-budget.ts`, `apps/backend/src/agents/orchestrator.ts`, `apps/backend/wrangler.jsonc`, and `alchemy.run.ts`.

## Repository runs and capture

| Limit | Value |
| --- | --- |
| Sandbox harness execution timeout | 15 minutes |
| Git command timeout | 5 minutes |
| Test command timeout | 5 minutes |
| Retained diff text | 120,000 characters |
| Transcript diff display | 20,000 characters |
| stderr tail | 8,000 characters |
| Changed-file capture | 50 files |
| Per-file repository contents | 100,000 bytes |
| Combined captured file contents | 500,000 bytes |

For sandbox repository work, capture reads the immutable baseline and settled Git snapshots. It rejects unsupported file types, unsafe paths, malformed manifests, corrupt or incomplete byte transport, and file-count or file-size overflow. It refuses to publish a partial captured tree rather than treating those errors as a successful complete result.

The constants `MAX_FILE_CHARS` and `MAX_TOTAL_FILE_CHARS` retain historical names, but repository blob capture enforces byte counts. Supported complete binary blobs are encoded for transport; symlinks and unsupported file types are rejected. A truncated diff display is different from missing captured file bytes. Inspect the captured result and any exported diff before approving publication, and narrow a task that exceeds the limits. The read-only pre-publication review rejects a staged diff marked as truncated; exporting a longer diff does not automatically make that review pass.

Local execution has its own daemon envelope and validation path. Do not assume a cloud capture test establishes live local-runtime acceptance. See [Review reference](/docs/review-reference/) and [Your computers](/docs/remote-access/).

Sources: `apps/backend/src/runtime.ts`, `apps/backend/src/transcript.ts`, and `apps/backend/src/pr-publish-approval.ts`. These are application limits, not guaranteed in-memory read bounds or Cloudflare plan quotas.

## Files and reference sources

| Data | Current bound |
| --- | --- |
| Named text deliverables | 8 files; 16,384 bytes per file; 65,536 bytes total. UTF-8 Markdown, text, JSON, or CSV. |
| Cloud artifact ZIP inputs | 64 files under `out/`; 1,048,576 bytes per file; 8,388,608 bytes total, plus bounded archive overhead. |
| Artifact ZIP link | Expires after seven days. Anyone with the complete link can download it before expiry. |
| Memory file upload | Nonempty UTF-8 TXT/Markdown, at most 40,000 bytes. |
| Pasted memory source | Up to 40,000 characters; title up to 200 characters. |
| Memory project | Up to eight active sources; approval snapshot currently includes up to 360 characters per source. |

These are different mechanisms, not interchangeable storage allowances. Oversized named deliverables are refused rather than silently truncated. ZIP capture does not collect files outside `out/`. Memory-source expiry excludes future recall; uploaded originals remain until deletion, and already approved snapshots are not rewritten.

For practical workflows, see [Files and revisions](/docs/artifacts/) and [Context and memory](/docs/context-and-memory/). Sources: `packages/shared/src/deliverables.ts`, `apps/backend/src/run-deliverables.ts`, `apps/backend/src/owner-memory-store.ts`, and `apps/backend/src/owner-memory-ingestion.ts`.

## Verify your own usage

The dated [`VERIFICATION.md`](/docs/readiness/#evidence-status-2026-09-24) does not provide measured end-to-end cloud usage or a validated price per task. Clearing history does not stop running resources. Cancellation requests best-effort cleanup; confirm the task and resource state in your installation and check actual provider charges.
