# Feature: subscription auth (ChatGPT per user + Claude compliance)

## Preconditions

- `MODEL_CREDENTIAL_KEY` set (64 hex) on the Worker for per-user ChatGPT storage.
- Optional: `SHIBA_CODEX_SUBSCRIPTION=1` or per-user key alone registers `codex-subscription`.
- `SHIBA_CLAUDE_SUBSCRIPTION` should remain `0` unless explicitly testing deprecated path.

## Dashboard

1. **Settings → Models → ChatGPT subscription** (`data-testid="chatgpt-subscription-card"`).
2. Paste flow: `chatgpt-subscription-paste` → `chatgpt-subscription-connect`; page must not echo secrets back.
3. `chatgpt-subscription-disconnect` clears connection (`connected: false` on GET).

## API (authenticated)

- `GET /api/subscription/openai` → `{ connected, accountEmailHash?, expiresAt?, savedAt }` only.
- `POST /api/subscription/openai/paste` `{ authJson }` → status shape; no secrets in response.
- `DELETE /api/subscription/openai` → disconnect.

## Run behavior

- User-started run with `openai-subscription` connection: egress `Authorization: Bearer` on `chatgpt.com` only.
- Automation on `default` orchestrator: must not select `openai-subscription` (clear error).
- Container `auth.json` stub only; `auth.openai.com` denied from sandbox.

## Claude

- Catalog omits `claude-subscription` when flag off.
- `claude-login` uses distinct `CLAUDE_CONFIG_DIR` per `initiatorUserId` (volume mount blocked until Sandbox SDK #119/#123).

## Automated tests

`apps/backend/test/subscription-auth.test.ts` (A1–A8), `apps/frontend/src/components/chatgpt-subscription.test.tsx` (A9).
