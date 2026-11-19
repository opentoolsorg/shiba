# Provider login flows (opencodex reference)

Reverse-engineered from [opencodex](https://github.com/lidge-jun/opencodex) (`src/oauth/*`) and implemented on the Shiba Providers card with the same per-user encryption + egress injection model as ChatGPT device grant (PR #155) and Claude setup-token (PR #147).

## Shared Shiba contract

| Step | Behavior |
|------|----------|
| Sign-in UI | `/api/providers/:id/connect` with `mode: "oauth"` |
| Pending state | `UserProviderOAuth` Durable Object (per user), 15-minute TTL |
| Tokens at rest | AES-GCM in D1 `user_subscription_credentials` via `MODEL_CREDENTIAL_KEY` |
| Runtime | Sandbox sees `shiba-egress-placeholder` / dummy keys; Worker `forward*` handlers attach real bearer tokens |
| Refresh | `UserProviderOAuth` `/access` refreshes when `expiresAt` is near |

---

## Gemini — Google Antigravity (Cloud Code Assist)

**opencodex:** `src/oauth/google-antigravity.ts`  
**Shiba harness:** `antigravity-subscription` (`agy` ACP) for OAuth; `gemini-acp` when the card uses API key.

### Sequence

```mermaid
sequenceDiagram
  participant U as User browser
  participant W as Shiba Worker
  participant G as accounts.google.com
  participant T as oauth2.googleapis.com
  participant C as cloudcode-pa.googleapis.com

  U->>W: POST /api/providers/gemini/connect (oauth)
  W->>W: PKCE begin (state, verifier)
  W-->>U: authorize URL (127.0.0.1:51121/callback)
  U->>G: Sign in + consent
  G-->>U: Redirect http://127.0.0.1:51121/callback?code&state
  U->>W: POST /api/providers/gemini/verify + pasted URL
  W->>T: authorization_code + code_verifier
  T-->>W: access + refresh tokens
  W->>C: loadCodeAssist / onboardUser
  C-->>W: projectId
  W->>W: Encrypt record (access, refresh, projectId)
```

| Item | Value |
|------|--------|
| Client ID | `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com` (public Antigravity desktop client; override `GOOGLE_ANTIGRAVITY_CLIENT_ID`) |
| Client secret | Public desktop secret in opencodex; override `GOOGLE_ANTIGRAVITY_CLIENT_SECRET` |
| Auth | `https://accounts.google.com/o/oauth2/v2/auth` |
| Token | `https://oauth2.googleapis.com/token` |
| Redirect | `http://127.0.0.1:51121/callback` (`pnpm dev` / `pnpm shiba dev` start a local listener; paste only if that listener is off) |
| PKCE | S256 |
| Scopes | `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs` |
| Post-login | `loadCodeAssist` → `onboardUser` if needed; **projectId required** |
| Egress hosts | `cloudcode-pa.googleapis.com`, `daily-cloudcode-pa.googleapis.com`, `generativelanguage.googleapis.com` |
| Handler | `antigravityUser` + `userId` |

---

## Grok — xAI OAuth

**opencodex:** `src/oauth/xai.ts`

### Sequence

```mermaid
sequenceDiagram
  participant U as User browser
  participant W as Shiba Worker
  participant D as auth.x.ai (OIDC discovery)
  participant A as accounts.x.ai

  U->>W: POST /api/providers/grok/connect (oauth)
  W->>D: GET /.well-known/openid-configuration
  D-->>W: authorization + token endpoints
  W-->>U: authorize URL
  U->>A: Sign in
  A-->>U: http://127.0.0.1:56121/callback?code&state
  U->>W: POST verify + pasted URL
  W->>A: authorization_code + PKCE verifier
  A-->>W: access + refresh (+ id_token)
  W->>W: Encrypt record
```

| Item | Value |
|------|--------|
| Discovery | `https://auth.x.ai/.well-known/openid-configuration` |
| Client ID | `b1a00492-073a-47ea-816f-4c329264a828` |
| Redirect | `http://127.0.0.1:56121/callback` (auto via `pnpm dev` loopback listener) |
| Scope | `openid profile email offline_access grok-cli:access api:access` |
| Refresh | `grant_type=refresh_token` to discovered token endpoint |
| Egress | `api.x.ai` via `xaiUser` |
| Fallback | API key paste → existing `forwardGoogle` / gateway BYOK path on `grok` harness |

---

## Cursor — PKCE poll (cursor-agent CLI)

**opencodex:** `src/oauth/cursor.ts` (jawcode port)

### Sequence

```mermaid
sequenceDiagram
  participant U as User browser
  participant W as Shiba Worker
  participant C as cursor.com
  participant A as api2.cursor.sh

  U->>W: POST /api/providers/cursor/connect (oauth)
  W->>W: PKCE challenge + uuid
  W-->>U: https://cursor.com/loginDeepControl?challenge&uuid&mode=login
  U->>C: Approve login
  U->>W: POST /api/providers/cursor/verify (Finish sign-in)
  loop Poll until 200 or timeout
    W->>A: GET /auth/poll?uuid&verifier
    A-->>W: 404 pending or 200 tokens
  end
  W->>W: Encrypt access + refresh JWTs
```

| Item | Value |
|------|--------|
| Login | `https://cursor.com/loginDeepControl` |
| Poll | `https://api2.cursor.sh/auth/poll` |
| Refresh | `POST https://api2.cursor.sh/auth/exchange_user_api_key` with refresh bearer |
| Egress | `api2.cursor.sh`, `repo2.cursor.sh` via `cursorUser` |
| Harness | `cursor-subscription` — `cursor-agent --force acp` |
| Operator fallback | `CURSOR_SUBSCRIPTION_TOKEN` wrangler secret + `SHIBA_CURSOR_SUBSCRIPTION=1` |

---

## Codex / Claude (existing)

| Provider | Flow | Reference |
|----------|------|-----------|
| Codex | Device grant + optional loopback SIWC | `ChatGptAuth` DO, PR #155 |
| Claude | Daemon pairing or `claude setup-token` | PR #147 |

---

## Server-side limitations

- **Loopback redirects:** Antigravity and xAI expect `http://127.0.0.1` callbacks. The Worker cannot receive those redirects; the operator must paste the full URL from the browser (same as ChatGPT PKCE fallback).
- **Cursor poll:** Requires outbound access from the Worker to `api2.cursor.sh` (works server-side).
- **Antigravity project discovery:** Requires Worker egress to `cloudcode-pa.googleapis.com` / `daily-cloudcode-pa.googleapis.com` during sign-in.

---

## opencodex token storage (contrast)

opencodex stores OAuth credentials locally (`src/oauth/store.ts`) on the operator machine. Shiba never writes tokens into the sandbox filesystem for these Providers flows; only encrypted D1 + egress injection.

## Personal API-key connections

Settings → Providers also supports OpenAI API, Anthropic API, OpenRouter,
Groq, and GitHub Copilot API access tokens. These are distinct from ChatGPT
and Claude subscription sign-in. Keys use the existing AES-GCM per-user KV
store and are attached by the Worker only to the selected provider host.
Anthropic API keys and Claude setup-tokens occupy separate encrypted records.

OpenRouter and Groq run through OpenCode ACP. Copilot accepts an existing
Copilot **API access token**, rather than a GitHub personal access token;
short-lived tokens must be replaced when they expire. TODO: add Copilot
OAuth device sign-in and refresh in a follow-up. There is no browser sign-in
button for this card yet.

## Kimi Code and Meta Muse plan keys

Two more personal lanes cover assistants people already pay for. Both run
through OpenCode ACP with a placeholder key in the sandbox; the Worker attaches
the saved key at egress, so neither needs `AI_GATEWAY_TOKEN`.

| Card | Paste | Host the key reaches | Default model |
|---|---|---|---|
| Kimi Code | An API key from the [Kimi Code Console](https://www.kimi.com/code/console). Usage draws on your Kimi membership quota. | `api.kimi.ai` (`/coding/v1`, OpenAI-compatible) | `kimi-code/k3.1-pro` |
| Meta Muse | A Meta Model API key from the Model API dashboard. | `api.meta.ai` (`/v1`, OpenAI-compatible) | `meta/muse-spark-1.3` |

Kimi keys issued for the China region use `api.kimi.com`, which this lane does
not reach. Devin has no model endpoint that a sandbox harness can call, so it
has no card here.

## More personal API-key lanes

Five more providers run through OpenCode ACP with the same shape: paste a key
on Providers, the Worker attaches it at egress for that user's runs, the
sandbox holds only a placeholder. None of them needs `AI_GATEWAY_TOKEN`.

| Card | Paste | Host | Default model |
|---|---|---|---|
| DeepSeek | DeepSeek platform key | `api.deepseek.com` | `deepseek/deepseek-flash` |
| Z.ai (GLM) | Z.ai platform key | `api.z.ai` (`/api/paas/v4`) | `zai/glm-5.3` |
| MiniMax | MiniMax platform or M Plan key | `api.minimax.io` | `minimax/MiniMax-M3` |
| Qwen (Model Studio) | DashScope key, international region | `dashscope-intl.aliyuncs.com` (`/compatible-mode/v1`) | `qwen/qwen3-coder-plus` |
| Mistral | La Plateforme key | `api.mistral.ai` | `mistral/devstral-medium-latest` |

Defaults are only a starting point — the composer's model id decides what the
run asks for. A saved DeepSeek platform key wins on `api.deepseek.com`, and an
OpenCode Go key still authenticates that host when no platform key is stored.
Keys for the China-region DashScope, Kimi, or Z.ai domains are not reached by
these lanes; each lane is pinned to one host so egress cannot be pointed
somewhere else.
