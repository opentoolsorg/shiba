# Internal signing migration — PR notes

Set a dedicated `INTERNAL_SIGNING_KEY` with at least 32 characters before
turning off compatibility. During the one-release grace window,
`SHIBA_LEGACY_SIGNING_FALLBACK=1` (the default) allows only explicitly opted-in
callers to verify their previous raw HMAC format. Child dispatch, specialist
dispatch and archive sealing can also issue that format with their previous
model credential key when the dedicated signing key is missing. This emits
one warning per isolate. A configured dedicated key always issues purpose-bound
versioned signatures; a short configured key is refused.

Set `SHIBA_LEGACY_SIGNING_FALLBACK=0` after one release, by **2026-11-24**.
Remove the legacy code path on that date after deployments have the dedicated
key and outstanding legacy capabilities have expired. Raw legacy signatures
have no cryptographic purpose binding; compatibility remains limited to the
previous per-site key and payload contracts until removal.

Strict mode without the dedicated key refuses internal requests, including
requests without vouched headers. Durable Object consumers return a 401 body
that names `INTERNAL_SIGNING_KEY` as missing. Do not enable strict mode until
the dedicated key is configured.

`run-env-seal.ts` intentionally stays in the encryption-key lane. Its digest
is an HKDF-derived HMAC tied to AES-GCM encrypted owner-scoped environment
values. It prevents offline guessing of those values and binds the encrypted
record to its owner; it is not a Worker dispatch or capability signature.
Changing that digest key independently would invalidate existing sealed
records. A separate migration is needed if that storage format changes.

The WebCrypto signing helper is a leaf utility with no vendor SDK dependency.
Introduce a key-provider port and adapter contract when rotation (AR-07) adds
an external key provider.
