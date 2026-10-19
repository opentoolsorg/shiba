# Feature: ChatGPT SIWC + Claude compliance

## Preconditions

- `MODEL_CREDENTIAL_KEY` (64 hex) and `ChatGptAuth` Durable Object binding.
- `SHIBA_CLAUDE_SUBSCRIPTION=0` (default).

## Dashboard

1. **Settings → Models → ChatGPT subscription**
2. `chatgpt-subscription-begin` → authorize link (`127.0.0.1` callback, not localhost).
3. Paste callback into `chatgpt-subscription-callback` → `chatgpt-subscription-connect`.
4. `chatgpt-subscription-disconnect` clears connection.

## API

- `GET /api/subscription/openai` — status only (no tokens).
- `POST /api/subscription/openai/begin` — `{ authorizeUrl, redirectUri, flowId }`.
- `POST /api/subscription/openai/complete` — `{ callbackUrl }`.
- `POST /api/subscription/openai/paste` — **410 deprecated**.
- `DELETE /api/subscription/openai` — revoke + delete.

## Run behavior

- `codex-subscription`: `codex app-server` + `ACCESS_TOKEN` only; egress `api.openai.com`.
- Refresh on `ChatGptAuth` DO; no refresh token in sandbox.
- Automations without `initiatorUserId` cannot use `openai-subscription`.

## Tests

- `apps/backend/test/chatgpt-siwc.test.ts` — callback, PKCE, id_token, refresh, app-server restart.
- `apps/backend/test/subscription-auth.test.ts` — A1–A9.
- `apps/frontend/src/chatgpt-subscription.test.ts` — UI wire.
