# 0012 — Credential vault with key ids; a separate signing key

## Context

Hand-written AES-GCM lives in eight files: `apps/backend/src/env.ts`,
`apps/backend/src/founder-hubspot-credential.ts`,
`apps/backend/src/founder-meta-credential.ts`,
`apps/backend/src/founder-stripe-credential.ts` (these three since merged into
`apps/backend/src/founder/reads/seal.ts`), `apps/backend/src/gmail.ts`,
`apps/backend/src/provider-oauth/types.ts`, `apps/backend/src/run-env-seal.ts`
and `apps/backend/src/subscription-credentials.ts`.
`apps/backend/src/child-dispatch.ts` keeps a
`legacySigningKey` fallback to `MODEL_CREDENTIAL_KEY` for the M06
dual-verify window, and `apps/backend/src/agents/specialists/contract.ts`
(`dispatchKey`) still
falls back to `MODEL_CREDENTIAL_KEY` when `INTERNAL_SIGNING_KEY` is unset — a
model credential doubling as an HMAC secret. Two credential classes exist:
workspace BYOK and personal subscription logins (Codex, Claude, Cursor,
Antigravity, ChatGPT).

## Options

- **(a) Keep per-file crypto** — loses: eight HKDF variants to audit and
  rotate, and the signing-key fallback stays.
- **(b) A vault module with kid prefixes and legacy read** — chosen.
- **(c) An external KMS** — loses: a cloud dependency the buyer may not have;
  stays optional later behind the same interface.

## Decision

(b). `apps/backend/src/vault/` replaces the hand-written AES-GCM.
Ciphertext format `v1.{kid}.{purpose}.{iv_b64url}.{ct_b64url}` — `kid` and
`purpose` match `[a-z0-9-]+` and base64url contains no `.`, so it parses
unambiguously. `SHIBA_VAULT_KEYS` is a JSON object `{kid: hex64}`;
`SHIBA_VAULT_ACTIVE_KID` names the active one. A value without the `v1.`
prefix decrypts as kid `legacy` = `MODEL_CREDENTIAL_KEY`, using each file's
exact HKDF info and salt captured as named purposes, with golden-vector tests
built from real dogfood ciphertext (never prod). `vault.rotate` re-encrypts
rows lazily on write plus a batched sweep; a kid is removed only after a query
shows zero rows still use it. `INTERNAL_SIGNING_KEY` becomes required: release
N warns and dual-verifies (new key plus legacy derived key), release N+1 fails
the deploy without it and removes legacy verify — child-dispatch signatures
are short-lived, so the overlap is minutes. BYOK belongs to the workspace;
subscription logins belong to a person and by default power only runs that
person starts or approves.

## Consequences

- We own the crypto code — mitigated by WebCrypto only and golden vectors.
- Reversal cost: low. Legacy read stays forever, so old ciphertext never needs
  rewriting to remain readable.
