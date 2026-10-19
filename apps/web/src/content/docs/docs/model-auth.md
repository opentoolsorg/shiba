---
title: Model authentication modes
description: API keys, ChatGPT subscription (SIWC OSS), and Claude compliance paths.
---

# Model authentication modes

Shiba supports several ways to pay for model inference. Pick the mode that matches your deployment and your vendor's terms.

## Terms summary

| Provider | Mode | Allowed for this product? | Source |
| --- | --- | --- | --- |
| Anthropic | API key via AI Gateway BYOK | Yes — default for `claude-code` / OpenCode | [Claude legal & compliance](https://code.claude.com/docs/en/legal-and-compliance) |
| Anthropic | Worker-stored `claude setup-token` (`claude-subscription`) | **Deprecated** — third-party storage/relay of Claude.ai tokens is not permitted | [Claude legal & compliance](https://code.claude.com/docs/en/legal-and-compliance), [The Register (2026-02-20)](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546) |
| Anthropic | Operator runs `claude` `/login` in their sandbox (`claude-login`) | Yes — unmodified CLI, Anthropic's own flow, credentials stay on a per-user volume | [Claude legal & compliance](https://code.claude.com/docs/en/legal-and-compliance) |
| OpenAI | API key via AI Gateway BYOK | Yes — default for `codex` / OpenCode | [OpenAI API authentication](https://platform.openai.com/docs/api-reference/introduction) |
| OpenAI | Per-user ChatGPT plan (`openai-subscription` + `codex-subscription`) | Yes for **open-source, self-hosted** deployments; multi-tenant SaaS needs OpenAI approval | [Sign in with ChatGPT (OSS)](https://developers.openai.com/siwc/token-sharing-open-source.md), [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) |
| OpenAI | Copying `~/.codex/auth.json` manually | Treat like a password; supported for headless/Docker per OpenAI docs | [ChatGPT authentication](https://learn.chatgpt.com/docs/auth) |

## ChatGPT subscription (per user)

1. Set `MODEL_CREDENTIAL_KEY` to 64 hex characters (AES-256) on the Worker.
2. Register an `openai-subscription` connection in **Providers** and order it like any other connection.
3. Each user connects under **Settings → Models → ChatGPT subscription** by pasting `auth.json` from `codex login` on their machine.
4. Runs that user starts attach their access token at the **egress** boundary; the sandbox sees only a stub `auth.json`. The Worker refreshes tokens against `auth.openai.com` — that host is **not** on the container allowlist.

For a single-operator deployment you may still set `SHIBA_SINGLE_USER=1` and store `CODEX_SUBSCRIPTION_AUTH_JSON` as a Worker secret (legacy path).

## Claude subscription

- **`SHIBA_CLAUDE_SUBSCRIPTION` defaults to `0`.** Opting in enables the deprecated `claude-subscription` harness (setup-token at egress).
- Prefer **`claude-login`**: the operator opens a terminal into their sandbox and runs the official `claude` binary → `/login`. `CLAUDE_CONFIG_DIR` is on a per-user persistent volume when the Sandbox SDK supports it ([#119](https://github.com/bezalel-network/shiba/pull/119) / [#123](https://github.com/bezalel-network/shiba/pull/123)); until then the UI documents the flow and the harness stays blocked.

## API keys (unchanged)

Gateway BYOK connections remain the recommended default. Subscription connections are additional entries in the connection order; automations and shared triggers without a signed-in user **cannot** select `openai-subscription`.
