# Phase 5 — integrations and automations hardening

## Sub-features

- Slack signature self-test (`POST /api/integrations/slack/verify`) without calling Slack servers.
- GitHub App vs PAT readiness on `GET /api/setup/status` (`github.app`, `github.publish`).
- Linear agent session row on Integrations (`data-testid="integration-linear"`).
- Automations: multiple schedule triggers, IANA timezone cron, webhook batching, Linear trigger kind.

## How to get to it (user POV)

1. Open **Integrations** in the dashboard nav.
2. Confirm GitHub shows PAT/App publish state and Linear shows configuration chips (mock labels until live credentials exist).
3. Optional: call `POST /api/integrations/slack/verify` from the browser devtools or curl on loopback (requires dashboard Access or local dev without Access).

## Driving it with Playwright

```javascript
await page.goto(`${baseUrl}?tab=integrations`);
await page.getByTestId("integration-linear").waitFor();
await shot("integrations-linear");
const slackVerify = await page.request.post(`${apiBase}/api/integrations/slack/verify`);
// expect JSON checks.signatureSelfTest when SLACK_SIGNING_SECRET is set in .dev.vars
```

Run: `node .cursor/skills/verify-shiba/scripts/drive.mjs --feature phase5-integrations-automations`

## Gotchas

- Live Slack, Linear, and GitHub App installs are **NOT VERIFIED** without real secrets; mocks prove code paths only.
- `LINEAR_ALLOW_UNSIGNED_WEBHOOK=1` is for local webhook fixtures only.
- Webhook batch flushes on the `*/5` automation cron tick, not sub-second.
