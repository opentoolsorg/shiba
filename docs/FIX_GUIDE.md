# Fix guide for https://app.tryshiba.dev

Prince can follow this after the auth and provider-sign-in fix is deployed. Names only. Do not paste secret values into chat, issues, or logs.

## What was going wrong

1. Sign-up and sign-in left the button on "Working…" because the browser waited with no timeout. A stuck or slow auth request never surfaced an error. The Worker now stops an auth call at 12 seconds and returns HTTP 504. The form stops at 15 seconds and shows the error. The button becomes usable again.
2. "Open sign-in" on the live build opened a normal ChatGPT or Claude homepage and "Finish sign-in" only checked a pre-stored Worker secret (`SHIBA_CLAUDE_SUBSCRIPTION` / `SHIBA_CODEX_SUBSCRIPTION` plus `CLAUDE_SUBSCRIPTION_TOKEN` or `CODEX_SUBSCRIPTION_AUTH_JSON`). It did not run a vendor login, so the card stayed "Sign-in pending". Codex now uses the ChatGPT device code at `https://auth.openai.com/codex/device`. Claude Code now uses the Claude authorize page and a pasted `code#state`. Finish exchanges that grant and the status becomes Connected. A later run to `api.openai.com` or `api.anthropic.com` sends that access token from the Worker. The container still only has a dummy key.
3. Logged-out `/app/` painted the full shell and fired `/api/sessions`, `/api/runs`, `/api/agents`, and the rest, which 401. The first paint was an empty dark page. The shell now waits for `/api/whoami`. Until then the page says "Checking your session…". `/app/` stays put until sign-in. After sign-in, the tasks view lives at `/`. That path change is intentional. `/api/setup/status` stays private. The login page does not need it. A 401 there before login is the gate, not a missing route.

A probe on 2026-10-21 (no account was created by it):

- `GET /api/whoami` returned 401 `{"code":"better_auth"}` in about 4 seconds. `BETTER_AUTH_SECRET` is set. The lane is on.
- `POST /api/auth/sign-in/email` for an address that was not the QA address returned 401 `Invalid email or password` in about 4 seconds. `AGENT_AUDIT` is bound and D1 answered that read.
- `GET /api/auth/get-session` returned `null` in about 0.1 seconds.
- `GET /api/setup/status` returned the same 401 as every other private route.

That probe cannot tell whether `shiba-qa-test@example.com` was inserted. Better Auth uses the same error for an unknown email and a wrong password. The browser gave up without a response, so the row may or may not have committed. Check D1. Do not guess.

## 1. Secrets, vars, and bindings

Set these on the live Worker. Wrangler names:

| Name | Kind | Why |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | secret, 32 characters or more | Already on. Keep it. Signing key for the session cookie. |
| `BETTER_AUTH_URL` | plain var | Already `https://app.tryshiba.dev` in `apps/backend/wrangler.jsonc`. Cookie scope and origin checks. Do not point it at another host. |
| `AGENT_AUDIT` | D1 binding | Database name `shiba-audit`, id in `apps/backend/wrangler.jsonc`. Auth tables and `audit_log`. |
| `BETTER_AUTH_BOOTSTRAP_TOKEN` | secret | One of the two first-account locks. The sign-up form sends it as header `x-shiba-bootstrap-token`. |
| `BETTER_AUTH_OWNER_EMAIL` | secret | The other lock. Only this email can create the first account. Compared with case ignored. |
| `MODEL_CREDENTIAL_KEY` | secret, 64 hex characters | Encrypts the Claude and Codex tokens in KV. Generate with `openssl rand -hex 32`. API-key mode does not need it. |
| `AI_GATEWAY_TOKEN` | secret | Gemini, OpenCode, and Grok "Use API credential". Also the gateway path when no subscription grant is stored. |
| `AGENT_TOKENS` | KV binding | Already in wrangler. Holds the encrypted provider grant. Not D1. |

Set **either** `BETTER_AUTH_BOOTSTRAP_TOKEN` **or** `BETTER_AUTH_OWNER_EMAIL` before anyone can claim the public dashboard. You can set both. Loopback `wrangler dev` can still create the first account without them. `https://app.tryshiba.dev` cannot.

Leave every other existing secret in place. An Alchemy deploy (`pnpm run deploy:alchemy`) **deletes Worker secrets that are missing from the root `.env`**. If you use Alchemy, copy every name in `apps/backend/worker-secrets.json` into `.env` first, including the two new ones. `wrangler secret put` does not delete the others.

```bash
npx wrangler secret put BETTER_AUTH_BOOTSTRAP_TOKEN --config apps/backend/wrangler.jsonc
npx wrangler secret put BETTER_AUTH_OWNER_EMAIL --config apps/backend/wrangler.jsonc
npx wrangler secret put MODEL_CREDENTIAL_KEY --config apps/backend/wrangler.jsonc
```

Run only the lines you are setting. Wrangler prompts for the value. It does not echo it.

## 2. D1

Auth tables are not in `apps/backend/migrations`. The Worker runs `CREATE TABLE IF NOT EXISTS` for `"user"`, `"session"`, `"account"`, and `"verification"` on the first auth request, when `AGENT_AUDIT` is bound. The only committed migration is `audit_log`.

From a machine logged into this Cloudflare account:

```bash
npx wrangler d1 migrations apply shiba-audit --remote --config apps/backend/wrangler.jsonc
```

Pass looks like: the command lists `0001_audit_log.sql` as applied or already applied, and exits 0.

## 3. Redeploy the fix

From the repo root, on this branch (or after it merges):

```bash
pnpm install
pnpm build
npx wrangler deploy --config apps/backend/wrangler.jsonc
```

Alchemy alternative, only when `.env` contains every secret name:

```bash
pnpm run deploy:alchemy
```

Pass looks like: deploy exits 0 and `https://app.tryshiba.dev/api/whoami` still returns 401 with `"code":"better_auth"`.

```bash
curl -sS -m 20 https://app.tryshiba.dev/api/auth/bootstrap
```

Pass looks like JSON. `locked` is false when a token or owner email is set. `locked` is true when neither is set. The body must not contain the token or the email.

## 4. Did shiba-qa-test@example.com become the owner?

```bash
npx wrangler d1 execute shiba-audit --remote --config apps/backend/wrangler.jsonc \
  --command 'SELECT id, email, createdAt FROM "user";'
```

- `no such table: user`: the sign-up did not create an account. The schema was never applied, or the insert never committed. Continue. The next real sign-up creates the tables.
- Zero rows: same answer. The QA attempt did not become the owner.
- A row with `shiba-qa-test@example.com`: that address is the owner. Sign-up is closed for everyone else until you delete it.

Remove only that account (do not wipe the table if other rows exist):

```bash
npx wrangler d1 execute shiba-audit --remote --config apps/backend/wrangler.jsonc --command 'DELETE FROM "session" WHERE userId IN (SELECT id FROM "user" WHERE email = '"'"'shiba-qa-test@example.com'"'"'); DELETE FROM "account" WHERE userId IN (SELECT id FROM "user" WHERE email = '"'"'shiba-qa-test@example.com'"'"'); DELETE FROM "verification" WHERE identifier = '"'"'shiba-qa-test@example.com'"'"'; DELETE FROM "user" WHERE email = '"'"'shiba-qa-test@example.com'"'"';'
```

Confirm with the SELECT again. Pass looks like no row for that email.

Do not use `--local` for this. `--local` is the laptop database, not production.

## 5. Sign in to each provider

Open the dashboard, sign in, then Sandbox adapters (Settings, providers).

### Claude Code

1. `MODEL_CREDENTIAL_KEY` must already be set, then redeploy or restart so the Worker sees it.
2. Choose **Connect with sign-in**. Pass: status "Sign-in pending", no user code, a paste box.
3. **Open sign-in**. Pass: a tab on `https://claude.ai/oauth/authorize` (not `https://claude.ai/login`). Approve with the Claude account.
4. Copy the value Claude shows. It looks like `code#state`. Paste it. Choose **Finish sign-in**.
5. Pass: the chip says **Connected**. The message says the subscription is connected. The JSON from the API does not contain the access token.
6. Storing a Claude.ai subscription token in this app can conflict with Anthropic's terms. API-key mode remains if you do not want that.

### Codex

1. Same `MODEL_CREDENTIAL_KEY` requirement.
2. **Connect with sign-in**. Pass: a short code such as `ABCD-EFGH`, and **Open sign-in** points at `https://auth.openai.com/codex/device`.
3. Open that page, sign in to ChatGPT, enter the code.
4. **Finish sign-in**. If you finish before ChatGPT accepts the code, the chip stays "Sign-in pending" and the message says to finish on the device page and try again. That is the waiting state, not a dead button.
5. Pass: chip says **Connected**.

### Gemini, OpenCode, Grok

These three do not have the device or PKCE grant. Choose **Use API credential**. That checks `AI_GATEWAY_TOKEN` only. The form never accepts a pasted key.

- Pass: chip **Connected**, message names `AI_GATEWAY_TOKEN`.
- Fail, and the honest one: chip **Connection failed**, message says no credential is provisioned. Set `AI_GATEWAY_TOKEN` with `wrangler secret put` and choose the button again.

A run uses a subscription grant only when the task harness talks to that vendor. Pick **Claude Code** or **Codex** in the task composer. The default OpenCode harness uses the gateway, not the ChatGPT or Claude token.

## 6. Smoke test

Do this on `https://app.tryshiba.dev` after the deploy.

1. **First paint.** Open `/app/` in a private window. Pass: the words "Checking your session…" on the dark page, then the sign-in card. The composer (Repository, Cloud, model name) does not appear. The address stays on `/app/` until you are signed in. No toast that says "Sessions request failed: 401".
2. **Sign up.** First account, with the setup token and/or the allowlisted email. Pass: the button leaves "Working…" within 15 seconds. You land in the dashboard. `GET /api/whoami` with the session cookie is 200 and `agent` is that email. A second sign-up is refused with "an account already exists".
3. **Sign in.** Sign out, sign in again with the same email. Pass: dashboard returns. A wrong password shows "Invalid email or password" and the button is enabled again. It does not sit on "Working…".
4. **Connect a provider.** Claude Code or Codex, section 5. Pass: chip **Connected**.
5. **Submit a task.** Composer: GitHub repo URL, a one-line task, harness Claude Code or Codex to match the account you connected, publish PR off unless `GITHUB_TOKEN` is set. Pass: an approval card with that repo and task. The run has not started.
6. **Reject.** Reject that card. Pass: it leaves the pending queue. Runs does not show a started sandbox for it.
7. **Approve.** Submit a second task and approve it. Pass: the run is accepted and progress appears. A provider failure is an error on the run (often HTTP 401), not a card stuck on "Sign-in pending". A finished run shows a diff. No Docker or model on the operator's laptop is required for this live check. The container runs on Cloudflare.

Local `wrangler dev` without Docker will fail the approved run with a clear sandbox error. That is expected. It is not a pass for step 7.
