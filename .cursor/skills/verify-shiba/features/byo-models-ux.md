# BYO models UX (Phase 7)

## Sub-features

- Ordered model connections list with move-up/move-down controls persisted in the ModelConfig DO.
- Per-role harness/model pins editable in Settings → Models (dashboard overrides wrangler `ROLE_MODEL_*`).
- Worker-side **Test connection** on each connection row (keys never sent to the browser; errors redacted).
- Harness-reported token/cost on the task thread (`data-testid="run-usage"`) and in Analytics run rows.

## How to get to it (user POV)

1. Launch verify-shiba (`scripts/launch.sh`) and open `http://127.0.0.1:$PORT/app/`.
2. Open **Settings** → **Models**.
3. Confirm **Model connections** shows the ordered list, **Test** on a row, and **Per-role model pins** above deploy-time vars.
4. Optionally reorder a connection and save role pins (requires auth when `REQUIRE_ACCESS=1`).
5. After a completed run that reported usage, open the task thread and confirm **Run usage** under the timeline.

## Driving it with Playwright

```bash
node .cursor/skills/verify-shiba/scripts/drive.mjs --feature byo-models-ux
```

- Open settings: `getByRole('button', { name: /Settings/i })` then `getByRole('button', { name: 'Models' })`.
- Connections card: `getByTestId('model-connections-card')`.
- Test button: `getByTestId('test-connection').first()`.
- Thread usage (when runs exist): `getByTestId('run-usage')`.

## Gotchas

- `/api/model-config` is identity-gated when Access is required; loopback without `REQUIRE_ACCESS` still works.
- **Test connection** performs a real Worker-side gateway HEAD or service probe — without `AI` binding or secrets it may return `invalid` honestly; that still proves the UI path.
- Usage appears only when a retained run has `usage` on its record (opencode/claude-code/codex streams); do not mock usage in the UI.
