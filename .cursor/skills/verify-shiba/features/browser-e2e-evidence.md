# browser-e2e-evidence

## Sub-features

- Worker runs a Playwright/CDP loop against an `exposePort` static preview after a publish run.
- Step frames and `manifest.json` land in R2 (`e2e/{sandboxId}/…`) and are linked from the PR body.
- Authenticated `GET /api/e2e-evidence/:sandboxId/manifest.json` returns the manifest JSON.

## How to get to it (user POV)

1. Launch verify-shiba (`scripts/launch.sh`) with `BROWSER` binding configured locally (wrangler dev) and `WORKER_HOSTNAME` set in `.dev.vars`.
2. Approve a publish run on a throwaway repo that serves static HTML from the workdir (default `python3 -m http.server` preview).
3. Open the published PR body: expect a **Browser E2E evidence** section with a manifest link (no tokenized preview URL).
4. While signed in to the dashboard origin, open the manifest URL and confirm `ok: true` with at least one frame.

Optional: add `.shiba/browser-e2e.json` in the target repo so the agent-authored plan replaces the default smoke steps.

## Driving it with Playwright

This journey is primarily proven by unit tests (`apps/backend/test/browser-e2e.test.ts`) plus a publish journey:

```bash
pnpm test --filter backend -- browser-e2e
node .cursor/skills/verify-shiba/scripts/drive.mjs --feature pr-publish
```

After `pr-publish`, read the mock GitHub stub or live PR body for `Browser E2E evidence` when Browser Rendering is configured.

## Gotchas

- Without `BROWSER` + `WORKER_HOSTNAME`, capture is skipped fail-safe — do not claim E2E proof.
- Preview URLs are bearer credentials; the PR must only link auth-gated `/api/e2e-evidence/…` URLs.
- Mock GitHub mode does not validate R2 objects — combine with manifest `curl` against wrangler dev when claiming live proof.
