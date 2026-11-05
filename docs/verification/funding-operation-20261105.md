# Funding operation binding — November 5, 2026

Base: PR188 `7a96effab47d56820ae24f2c869d7d70eb1709f2`.
Dedicated integration branch: `feat/prince-multi-agent-control-plane--funding-operation`.

## Delivered boundary

New sponsorship contracts and price quotes explicitly bind `text-generation`.
The operation participates in quote and funding digests, so frozen turn hashes
transitively bind it. Usage receipts identify the text operation. Unsupported
operations, asymmetric contract/quote operation fields, and post-approval
operation tampering fail before reservation or dispatch. Absent fields retain
the historical text interpretation and original quote digest algorithm; no
stored approvals or receipts are rewritten. Amountless legacy output remains
readable under the existing authority fences, but cannot dispatch new calls.

No provider, URL, payment, model policy, UI, retention limit or lifetime cap was
added or changed. The original two text adapters, distinct native sponsorship,
requester review, tenant/account/source fences, permanent reservations, bounded
private text retention, and unknown/no-refund/no-automatic-retry behavior remain.
This is a safe contract increment, **not a completed non-text funding feature**.

## Why embedding remains disabled

The installed Workers AI types include `@cf/baai/bge-small-en-v1.5`. Current
[official model documentation](https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/)
states 512 input tokens, 384 dimensions and $0.0202 per million input tokens.
Its [synchronous output schema](https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/sync-output.json)
returns shape, data and pooling, **not token usage or a provider receipt ID**.
Checked November 5, 2026; these were documentation reads, not inference calls.
Existing private-memory embeddings do not establish a funded-operation contract.

Before enabling embeddings, the coordinator needs explicit product terms for:

- A trusted usage receipt, or explicit approval of an always-unknown-usage
  reservation model; vector success must not be treated as metered usage.
- Enforceable tokenizer/input bounds and a reviewed conservative debit envelope
  with no invented usage, pricing assumptions, refunds or retries.
- A private, bounded vector result-retention/access/deletion contract. Existing
  text redaction must not be assumed to sanitize an embedding of secret input.

Until those terms are established, non-text operations fail closed at ingress;
there is no dormant provider dispatch path that a policy flag can activate.

## Local acceptance

Five backend fixture suites cover money, adapters, sessions, security-v3 and
migrations. Added coverage checks unsupported operations without funding/debits,
explicit frozen text sponsorship, both asymmetric operation removals and
unsupported operations after approval, actual legacy activation/approval/
execution, unchanged legacy digest calculation, and operation-bearing receipts.
Existing cases cover cross-workspace/native/source revocation, secret fences,
one-shot concurrent dispatch, lifetime caps, cancellation and uncertain usage.

No live provider/payment/Slack/account tests, sandbox runs, preview operations,
production deployments, root-wide acceptance or browser acceptance were needed
or performed for this backend/shared-contract change. Parent retains final
integrated CI responsibility; prior Desktop acceptance remains unsuccessful.
