# Fix guide for https://app.tryshiba.dev

Prince can follow this after the auth and provider-sign-in fix is deployed. Names only. Do not paste secret values into chat, issues, or logs.

## What was going wrong

1. Sign-up and sign-in left the button on "Working…" because the browser waited with no timeout. A stuck or slow auth request never surfaced an error. The Worker now stops an auth call at 12 seconds and returns HTTP 504. The form stops at 15 seconds and shows the error. The button becomes usable again.
2. Provider cards on production showed Connection failed, or a Codex device code that never finished. Codex now polls the real ChatGPT device endpoints and stores the token encrypted. Claude Connect starts a local pairing command or a setup-token paste, with no operator flag. Gemini, Grok, and OpenCode take a pasted key, stored encrypted and sent to the provider at egress. An unconfigured card stays Not connected. The container still only has a dummy key.
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
| `BETTER_AUTH_BOOTSTRAP_TOKEN` | secret | Required first-account lock on public hosts. The sign-up form sends it as header `x-shiba-bootstrap-token`. |
| `BETTER_AUTH_OWNER_EMAIL` | secret | Optional additional lock. Only this email can create the first account. Compared with case ignored. |
| `MODEL_CREDENTIAL_KEY` | secret, 64 hex characters | Encrypts Codex tokens, Claude setup tokens, and pasted Gemini, xAI, OpenCode, and DeepSeek keys. Generate with `openssl rand -hex 32`. Required before Finish sign-in or Use API credential can store anything. |
| `AI_GATEWAY_TOKEN` | secret | Optional. Not used by the Providers cards. Leave unset if you do not want a gateway. |
| `AGENT_TOKENS` | KV binding | Already in wrangler. Holds the encrypted provider grant and pasted keys. Not D1. |
| `ChatGptAuth` | Durable Object | Already in wrangler. Holds the Codex device-code pending grant and the encrypted ChatGPT connection. |

Set `BETTER_AUTH_BOOTSTRAP_TOKEN` before anyone can claim the public dashboard. Set `BETTER_AUTH_OWNER_EMAIL` to further restrict signup to the owner. Loopback `wrangler dev` can still create the first account without them. `https://app.tryshiba.dev` cannot.

Leave every other existing secret in place. An Alchemy deploy (`pnpm run deploy:alchemy`) **deletes Worker secrets that are missing from the root `.env`**. If you use Alchemy, copy every name in `apps/backend/worker-secrets.json` into `.env` first, including `MODEL_CREDENTIAL_KEY`. `wrangler secret put` does not delete the others.

Claude pairing on a local computer is optional. Set `SHIBA_LOCAL_RUNTIME=1` and either `PAIRING_SECRET` or `LOCAL_ADAPTER_TOKEN` when you want the card to show a pair command. Without those, Connect with sign-in asks for a `claude setup-token` paste. Do not set `SHIBA_CLAUDE_SUBSCRIPTION` for the dashboard card.

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

Pass looks like JSON. On public hosts, `locked` is false when a token is set and true when it is absent, even if an owner email is set. The body must not contain the token or the email.

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
2. Choose **Connect with sign-in**. Pass: status "Sign-in pending". If a local daemon can be paired, the card shows the pair command. Otherwise it shows a setup-token field. The card does not name an environment variable.
3. For the token path: on your computer run `claude setup-token`, paste the token, choose **Finish sign-in**.
4. Pass: the chip says **Connected**. The API JSON does not contain the token.

### Codex

1. Same `MODEL_CREDENTIAL_KEY` requirement.
2. **Connect with sign-in**. Pass: a short code such as `ABCD-EFGH`, and the link points at `https://auth.openai.com/codex/device`.
3. Open that page, sign in to ChatGPT, enter the code, approve it.
4. **Finish sign-in**. If you finish before ChatGPT accepts the code, the chip stays "Sign-in pending". That is the waiting state, not a dead button.
5. Pass: chip says **Connected**.

### Gemini, OpenCode, Grok

`MODEL_CREDENTIAL_KEY` must already be set. Paste the provider key (Gemini, xAI, or OpenCode/DeepSeek) and choose **Use API credential**. The key is stored encrypted for that user. Egress sends it to the provider. The sandbox only sees a placeholder. No gateway token is involved.

- Pass: chip **Connected**. The API JSON does not contain the key.
- Nothing pasted and nothing saved: chip stays **Not connected**. It does not say Connection failed.

A run uses a saved grant only when the task harness talks to that vendor. Pick the matching harness in the task composer.

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
