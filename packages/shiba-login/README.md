# shiba-login

Local loopback helper for **Sign in with ChatGPT** on a self-hosted shiba instance.

```bash
npx shiba-login --base-url https://app.example.com --cookie "session=..."
```

The CLI calls `POST /api/subscription/openai/begin`, opens the authorize URL, listens on the `127.0.0.1` redirect port, and `POST`s the callback to `/api/subscription/openai/complete`.

If you already have the callback URL:

```bash
npx shiba-login --base-url https://app.example.com --callback-url "http://127.0.0.1:1234/auth/callback?..." --cookie "session=..."
```

Set `SHIBA_BASE_URL` and `SHIBA_SESSION_COOKIE` instead of flags when convenient.
