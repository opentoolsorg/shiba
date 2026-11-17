# Password reset

The dashboard's Forgot password link opens `/auth/forgot`. The form posts to
`/api/auth/request-password-reset`. Better Auth creates a one-hour token and the
Worker sends a transactional email through the existing outbox and `SEND_EMAIL`.
The email opens `/auth/reset?token=…`; the form posts `token` and `newPassword`
to `/api/auth/reset-password`. Successful reset consumes the token, revokes all
existing sessions, and asks the user to sign in with the new password.

Known and unknown addresses receive the same successful request response.
Delivery failures do not disclose whether the address exists. Both POST routes
use the existing `AUTH_RATE_LIMIT` binding, keyed by client IP, when configured;
exhausted limits return 429 before account lookup or email delivery.

## Preview without real email

Set these optional Worker variables only in an isolated preview:

```
SHIBA_EMAIL_DRY_RUN=1
SHIBA_EMAIL_DRY_RUN_LOG_LINKS=1
```

Neither variable should be enabled in production. Full links contain bearer
tokens that authorize changing a password. Restrict access to preview logs and
remove the logging flag after testing. The logging flag has no effect unless
dry-run is also enabled.

Dry-run replaces transactional email delivery with an `email.dry_run` audit row
containing recipient, subject and link with only the first six token characters
followed by `…`. It does not enqueue or send new mail. Queued messages consumed
while dry-run is enabled are recorded and marked complete without sending.
No `SEND_EMAIL` binding is required for dry-run; the canonical HTTPS
`BETTER_AUTH_URL` and a syntactically valid `BETTER_AUTH_VERIFICATION_FROM` are
still required. Dry-run applies to transactional authentication and invitation
emails, not employee draft sends.

Use a disposable QA owner with an `example.test` address. Open `/auth/forgot`,
request a reset, then read the full `Email dry-run link:` line from preview
`wrangler tail`. Open that link, set a new disposable QA password, and sign in.
Try the link again to confirm it cannot be reused. The audit endpoint has only
a redacted link; it cannot supply a usable reset token.

Automated coverage in `apps/backend/test/password-reset.test.ts` exercises real
Better Auth handlers against in-memory SQLite with an injected send binding.
No real email is sent by these tests.
