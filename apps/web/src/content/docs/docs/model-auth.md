---
title: Model authentication modes
description: API keys, ChatGPT SIWC plan usage, and Claude compliance paths.
---

# Model authentication modes

Shiba supports several ways to pay for model inference. Pick the mode that matches your deployment and your vendor's terms.

## Terms summary

| Provider | Mode | Allowed for this product? | Source |
| --- | --- | --- | --- |
| Anthropic | API key via AI Gateway BYOK | Yes — default for `claude-code` / OpenCode | [Claude legal & compliance](https://code.claude.com/docs/en/legal-and-compliance) |
| Anthropic | Worker-stored `claude setup-token` (`claude-subscription`) | **Deprecated** — third-party storage/relay of Claude.ai tokens is not permitted | [Claude legal & compliance](https://code.claude.com/docs/en/legal-and-compliance) |
| Anthropic | Operator runs `claude` `/login` in their sandbox (`claude-login`) | Yes — unmodified CLI, Anthropic's own flow | [Claude legal & compliance](https://code.claude.com/docs/en/legal-and-compliance) |
| OpenAI | API key via AI Gateway BYOK | Yes — default for `codex` / OpenCode | [OpenAI API authentication](https://platform.openai.com/docs/api-reference/introduction) |
| OpenAI | Sign in with ChatGPT plan (`openai-subscription` + `codex-subscription`) | Yes for **open-source, self-hosted** instances; shared/paid hosted shiba needs [OpenAI's interest form](https://developers.openai.com/siwc/token-sharing-open-source.md) first | [SIWC OSS](https://developers.openai.com/siwc/token-sharing-open-source.md), [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) |

## ChatGPT subscription (Sign in with ChatGPT)

Primary flow (t3code-style token sharing):

1. Set `MODEL_CREDENTIAL_KEY` (64 hex) on the Worker.
2. Each user gets a stable `ext_agent_host_id` (`urn:uuid:…`) stored encrypted.
3. **Settings → Models → ChatGPT subscription → Start sign-in** opens OpenAI authorize URL (`dynamic_agent_client` first time, then saved `oaiapp_*` client). Redirect is always `http://127.0.0.1:<port>/auth/callback` (never `localhost`).
4. After browser sign-in, paste the final `127.0.0.1` callback URL back. Shiba validates state, single `code`, and `oaiapp_*` client id, exchanges with PKCE, and verifies `id_token` (JWKS).
5. Encrypted per user: `clientId`, tokens, `earliest_refresh_at`, scopes, `subject`, `email`, `hostId`. **Refresh** runs in a per-user `ChatGptAuth` Durable Object (single writer, rotated refresh token). **Logout** revokes at `revocation_endpoint` then deletes.
6. Runs call `codex app-server --listen stdio://` with `model_provider=openai_chatgpt_plan` and only a ~1h **`ACCESS_TOKEN`** in the child env (private `CODEX_HOME`). **Refresh tokens never enter the sandbox.** Egress allowlist: `api.openai.com` (not `chatgpt.com`).

**Worker vs sandbox for OAuth (2026-10-19):** `chatgpt.com` returns a Cloudflare bot-challenge to Workers; plan inference therefore uses `api.openai.com` via app-server. Token exchange/refresh is implemented on the Worker first; if `auth.openai.com` is also bot-challenged in your environment, exchange/refresh must move into the sandbox (documented fallback — not verified in CI).

**Fallback (labeled):** `codex login --device-auth` inside the user's sandbox with `auth.json` only on that user's sandbox volume — never stored in the Worker DB. Pasting `auth.json` to the server is **deprecated** (`410` on `/paste`).

Optional: `npx shiba-login` loopback helper (posts the callback code to shiba) — follow-up.

## Claude

- No shiba-managed Claude OAuth. Do not read, store, or relay `~/.claude` credentials.
- Use **API keys** (BYOK), or the operator runs **`claude auth login`** in their own sandbox terminal (`claude-login` harness).
- `SHIBA_CLAUDE_SUBSCRIPTION` defaults to `0`.

## API keys (unchanged)

Gateway BYOK connections remain the default. Automations without a signed-in user **cannot** select `openai-subscription`.
