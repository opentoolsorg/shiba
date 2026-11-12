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
| Anthropic | Native cloud login (`claude-login`) | Unavailable — no authorized per-user credential volume; credentials must not enter containers | [Claude legal & compliance](https://code.claude.com/docs/en/legal-and-compliance) |
| OpenAI | API key via AI Gateway BYOK | Yes — default for `codex` / OpenCode | [OpenAI API authentication](https://platform.openai.com/docs/api-reference/introduction) |
| OpenAI | Sign in with ChatGPT plan (`openai-subscription` + `codex-subscription`) | Yes for **open-source, self-hosted** instances; shared/paid hosted shiba needs [OpenAI's interest form](https://developers.openai.com/siwc/token-sharing-open-source.md) first | [SIWC OSS](https://developers.openai.com/siwc/token-sharing-open-source.md), [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) |

## ChatGPT subscription (Sign in with ChatGPT)

Primary flow (t3code-style token sharing):

1. Set `MODEL_CREDENTIAL_KEY` (64 hex) on the Worker.
2. Each user gets a stable `ext_agent_host_id` (`urn:uuid:…`) stored encrypted.
3. **Settings → Models → ChatGPT subscription → Start sign-in** opens OpenAI authorize URL (`dynamic_agent_client` first time, then saved `oaiapp_*` client). Redirect is always `http://127.0.0.1:<port>/auth/callback` (never `localhost`).
4. After browser sign-in, paste the final `127.0.0.1` callback URL back. Shiba validates state, single `code`, and `oaiapp_*` client id, exchanges with PKCE, and verifies `id_token` (JWKS).
5. Encrypted per user: `clientId`, tokens, `earliest_refresh_at`, scopes, `subject`, `email`, `hostId`. **Refresh** runs in a per-user `ChatGptAuth` Durable Object (single writer, rotated refresh token). **Logout** revokes at `revocation_endpoint` then deletes.
6. Runs call `codex app-server --listen stdio://` with `model_provider=openai_chatgpt_plan` and **`ACCESS_TOKEN=shiba-egress-placeholder`** in the child environment. No real access token, refresh token, or `auth.json` is placed in that run container. For `api.openai.com` plan traffic, the Worker `codexPlan` egress handler resolves the initiating user's connection, obtains the real access token from `ChatGptAuth`, and attaches it to the outgoing request. Egress parameters carry the user ID, not the credential.

The standard SIWC route keeps OAuth exchange, credential custody, and refresh on the Worker side. Plan inference uses `api.openai.com`; do not move token exchange or refresh into a task sandbox to work around an OAuth error or provider challenge. Diagnose the connection and deployment configuration instead.

### Device-auth is a separate opt-in branch

The device-auth endpoint is default-off and returns unavailable unless `SHIBA_CODEX_DEVICE_AUTH=1`. Its code advertises a per-user volume path and `codex login --device-auth`, then selects a different credential/egress path from standard SIWC. A derived path is not proof that a persistent volume was mounted, securely isolated, or tested end to end.

Treat this branch as deployment-dependent and unverified, not a generally available fallback or a way around Worker-side credential custody. Do not recommend it for untrusted task execution without resolving those security and provisioning requirements. Pasting `auth.json` to the subscription endpoint is deprecated and returns `410` on `/paste`.

## Claude

- No shiba-managed Claude OAuth. Do not read, store, or relay `~/.claude` credentials.
- Use **API keys** (BYOK), or explicitly pair an operator-owned local daemon using an already authenticated official Claude CLI.
- Native cloud **`claude-login` is unavailable**: no authorized per-user credential volume is provisioned, and native credentials must not enter a sandbox. A derived config-directory path is not a credential mount. Direct configuration and launch fail closed.
- `SHIBA_CLAUDE_SUBSCRIPTION` defaults to `0`.

## API keys (unchanged)

Gateway BYOK connections remain the default. Automations without a signed-in user **cannot** select `openai-subscription`.
