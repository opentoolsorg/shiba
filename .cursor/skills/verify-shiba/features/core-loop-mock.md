# core-loop-mock

End-to-end Phase 1 loop in **mock GitHub** boundary mode (not live GitHub success).

## What it proves

1. Task queued via dashboard/`POST /api/runs` → approval card
2. Approve → coding run completes (`SHIBA_VERIFY_STANDIN=1` in `.verify/run.env` only when containers are off and GitHub is the loopback mock)
3. Worker publishes a PR against the loopback GitHub stub
4. Chained reviewer posts a COMMENT review to the stub
5. `GET /api/v1/threads/:id/pr/review` shows a **posted** round with findings

## Run

```bash
VERIFY_GITHUB=mock VERIFY_FEATURE=core-loop-mock bash .cursor/skills/verify-shiba/scripts/run-ci.sh
```

Local with Docker (real containers, no stand-in):

```bash
VERIFY_ENABLE_CONTAINERS=1 VERIFY_FEATURE=sandbox-run-and-diff bash .cursor/skills/verify-shiba/scripts/launch.sh
# then drive + assert separately
```

## Assertions

`scripts/assert-journey.mjs` fails loudly if any step lacks evidence. Container-backed steps are marked **skipped** when `containers-mode` is disabled.
