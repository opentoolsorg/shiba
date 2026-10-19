# Public API keys (Phase 6)

## Sub-features

- Settings → API keys mints an `shk_` bearer key and lists key metadata.
- `GET /api/v1/openapi.json` returns the machine-readable contract (no auth).
- `POST /api/v1/threads` accepts `requestId` for idempotent create.
- `POST /api/v1/threads/:id/message` accepts `delivery` (`interrupt`, `queue`, `steer`).

## How to get to it (user POV)

1. Open the dashboard at `/app/`.
2. Open Settings → API keys.
3. Mint a key and copy the one-time token.
4. Call `/api/v1/openapi.json` and `/api/v1/threads` with `Authorization: Bearer <key>`.

## Driving it with Playwright

```javascript
await page.getByRole("button", { name: /settings/i }).click();
await page.getByRole("button", { name: "API keys" }).click();
await expect(page.getByTestId("api-keys-settings")).toBeVisible();
await page.getByLabel("API key label").fill("verify-phase6");
await page.getByLabel("Mint API key").click();
await expect(page.getByText(/New key \(copy now\): shk_/)).toBeVisible();
```

## Gotchas

- API keys are org-scoped (`self-hosted` in single-tenant mode).
- `delivery=steer` on an active run returns 501 until live harness intake exists.
- Subagent list endpoints are read-only stubs until Phase 2b.
