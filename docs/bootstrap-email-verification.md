# Explicit verification for the bootstrap account

The original dashboard account keeps its existing login compatibility while its
email is unverified. Native features that require confirmed email ownership stay
unavailable until the user completes this verification. No account is created,
no permissions change, and verification never signs a user in automatically.
Invited-account enrollment and its existing Better Auth links are unchanged.

The signed-in bootstrap owner opens **Check my account verification** in the
team Work view, reads the exact account email, and chooses **Send verification
email**. Opening this panel, signing up, signing in, or refreshing status does not
send bootstrap email. The sender must be configured with `SEND_EMAIL`, a verified
`BETTER_AUTH_VERIFICATION_FROM`, and a canonical root HTTPS `BETTER_AUTH_URL`.
Bootstrap delivery does not require invitation enrollment to be enabled.

The email link uses a fragment:

```text
https://<configured-origin>/app/?verify=bootstrap#bootstrapVerification=<proof>
```

The proof is never placed in an HTTP URL query, a rendered input, browser storage,
or an API response. The callback captures the fragment in memory and immediately
removes it with `history.replaceState`. It sends nothing until the user chooses
**Confirm email**, then POSTs the proof in a JSON body. This works in a new browser
without a dashboard session and does not create a session. After confirmation,
the user returns to the dashboard and refreshes the account status.

The proof is a real Better Auth 1.7.7 token, generated and verified with its public
`createEmailVerificationToken` and `verifyJWT` exports. Its signed purpose,
original account UUID, canonical email, origin, nonce and one-hour expiry must
match a private issuance row. The database stores the token hash rather than the
token. Confirmation atomically consumes the nonce and updates only the exact
current bootstrap UUID/email/provenance. A replacement account with the same
email, changed provenance/email, tampering, expiry or replay cannot verify.
Bootstrap-purpose proofs on generic auth query routes are rejected, including
duplicate token parameters and trailing-path variants, so they cannot enter
Better Auth's email-only update path.

The API contract is:

- `GET /api/auth/bootstrap-verification`: requires a current bootstrap session;
  returns its canonical email, verification/readiness status and an opaque
  session-bound `statusSnapshot`. Responses are private and `no-store`.
- `POST /api/auth/bootstrap-verification`: same-origin JSON containing only
  `{ "expectedSnapshot": "<snapshot>" }`. The server selects the recipient from
  current provenance; callers cannot choose an address, owner, redirect or
  verification flag. A changed/revoked session or stale snapshot fails closed.
  Sends are limited to one per minute and five per hour.
- `POST /api/auth/bootstrap-verification/confirm`: same canonical-origin JSON
  containing only `{ "token": "<proof>" }`. The signed proof supplies authority;
  no cookie is required. It returns `{ "verified": true }` only after the guarded
  one-use update. Responses have `Referrer-Policy: no-referrer` and no auth cookie.

Delivery failures return an explicit unconfirmed outcome; neither the server nor
the UI automatically resends. A mail accepted before a transport failure might
still arrive. Check email before deliberately requesting another link. Missing
sender configuration is shown as unavailable rather than verification success.

Verification evidence is deterministic: real Better Auth signing and native
SQLite-backed auth/session/provenance queries with mock mail; UI fixtures cover
explicit actions, stale identity, StrictMode fragment removal, malformed/replayed
proof and stalled requests. The integrated test demonstrates that the original
native account and model-funder guard reject the unverified owner and accept that
same UUID after the signed callback. No real email was sent and no live delivery
or deployed account was verified by these tests.

```sh
pnpm -C apps/backend test test/bootstrap-verification.test.ts test/native-enrollment-auth.test.ts --maxWorkers=1 --no-file-parallelism
pnpm -C apps/frontend test src/components/BootstrapVerificationPanel.test.tsx src/components/AuthScreen.test.tsx --maxWorkers=1 --no-file-parallelism
```
