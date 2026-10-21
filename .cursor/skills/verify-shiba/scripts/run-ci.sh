#!/usr/bin/env bash
# CI entry: launch wrangler dev, drive one Playwright feature, assert evidence, collect artifacts, always cleanup.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/../../../.." && pwd)
cd "$ROOT"

export VERIFY_GITHUB=${VERIFY_GITHUB:-mock}
export CI=${CI:-true}
export VERIFY_ENABLE_CONTAINERS=${VERIFY_ENABLE_CONTAINERS:-0}
export PORT=${VERIFY_PORT:-8788}
export GITHUB_STUB_PORT=${GITHUB_STUB_PORT:-8799}
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$ROOT/.verify/playwright-browsers}
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
# wrangler --local cannot use the remote Workers AI binding; queue via /api/runs instead of chat.
export VERIFY_USE_RUNS_API=${VERIFY_USE_RUNS_API:-1}
FEATURE=${VERIFY_FEATURE:-core-loop-mock}
STAMP="ci-${GITHUB_RUN_ID:-local}-$(date -u +%Y%m%dT%H%M%SZ)"

cleanup() {
  local status=$?
  trap - EXIT
  # Snapshot failures too, while the Worker and in-memory stub still exist.
  if EVIDENCE_DIR=$(bash "$SCRIPT_DIR/evidence.sh" "$STAMP"); then
    echo "evidence=$EVIDENCE_DIR"
  else
    echo "evidence collection failed" >&2
    if [ "$status" -eq 0 ]; then status=1; fi
  fi
  bash "$SCRIPT_DIR/cleanup.sh" || true
  exit "$status"
}
trap cleanup EXIT

bash "$SCRIPT_DIR/launch.sh"
bash "$SCRIPT_DIR/doctor.sh"
node "$SCRIPT_DIR/drive.mjs" --feature "$FEATURE"
node "$SCRIPT_DIR/assert-journey.mjs"
