#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
VERIFY_DIR=${VERIFY_DIR:-$ROOT/.verify}
mkdir -p "$VERIFY_DIR"
PORT=${PORT:-8788}
GITHUB_STUB_PORT=${GITHUB_STUB_PORT:-8799}
echo "$PORT" > "$VERIFY_DIR/port"
echo "$GITHUB_STUB_PORT" > "$VERIFY_DIR/github-stub-port"

# Effective mode is decided before install/build so VERIFY_PLAN_ONLY=1 can test it.
GITHUB_MODE=mock
[ "${VERIFY_GITHUB:-mock}" = mock ] || GITHUB_MODE=live
echo "$GITHUB_MODE" > "$VERIFY_DIR/github-mode"
CONTAINERS_WANT=${VERIFY_ENABLE_CONTAINERS:-}
DOCKER_OK=0
docker info >/dev/null 2>&1 && DOCKER_OK=1
DEV_EXTRA=()
if [ "$CONTAINERS_WANT" = 1 ] && [ "$DOCKER_OK" = 1 ]; then
  CONTAINERS=enabled
  echo "containers=enabled" > "$VERIFY_DIR/containers-mode"
elif [ "$CONTAINERS_WANT" = 1 ]; then
  # An explicit container request must never degrade to a stand-in that fakes success.
  echo "unavailable (VERIFY_ENABLE_CONTAINERS=1 but docker info failed)" > "$VERIFY_DIR/containers-mode"
  echo disabled > "$VERIFY_DIR/standin-mode"
  echo "VERIFY_ENABLE_CONTAINERS=1 but Docker is unavailable; refusing to fall back to the stand-in" >&2
  exit 1
elif [ "${CI:-}" = true ] || [ "${CI:-}" = 1 ] || [ "$CONTAINERS_WANT" = 0 ]; then
  CONTAINERS=disabled
  DEV_EXTRA+=(--local --enable-containers=false)
  echo disabled > "$VERIFY_DIR/containers-mode"
elif [ "$DOCKER_OK" != 1 ]; then
  CONTAINERS=disabled
  DEV_EXTRA+=(--enable-containers=false)
  echo "containers=disabled (no docker)" > "$VERIFY_DIR/containers-mode"
else
  CONTAINERS=enabled
  echo "containers=enabled" > "$VERIFY_DIR/containers-mode"
fi
# Synthetic runs only when containers are off AND GitHub is the loopback mock.
STANDIN=0
if [ "$CONTAINERS" = disabled ] && [ "$GITHUB_MODE" = mock ]; then
  STANDIN=1
  echo enabled > "$VERIFY_DIR/standin-mode"
else
  echo disabled > "$VERIFY_DIR/standin-mode"
fi

# wrangler skips .dev.vars when --env-file is given, so stale flags persisted there are
# dropped per invocation and .dev.vars itself is never mutated. Values are never printed.
DEV_VARS_SRC=${VERIFY_DEV_VARS:-apps/backend/.dev.vars}
[ -f "$DEV_VARS_SRC" ] || DEV_VARS_SRC=apps/backend/.dev.vars.example
RUN_ENV="$VERIFY_DIR/run.env"
(
  umask 077
  {
    if [ "$GITHUB_MODE" = mock ]; then
      grep -Ev '^(GITHUB_API_BASE|GITHUB_TOKEN|SHIBA_VERIFY_STANDIN)=' "$DEV_VARS_SRC" || true
      printf 'GITHUB_API_BASE=http://127.0.0.1:%s\nGITHUB_TOKEN=mock-github-token\n' "$GITHUB_STUB_PORT"
      grep -q '^DASHBOARD_APPROVERS=.\+' "$DEV_VARS_SRC" || printf 'DASHBOARD_APPROVERS=default\n'
    else
      grep -Ev '^(GITHUB_API_BASE|SHIBA_VERIFY_STANDIN)=' "$DEV_VARS_SRC" || true
    fi
    printf 'SHIBA_VERIFY_STANDIN=%s\n' "$STANDIN"
  } > "$RUN_ENV"
)
if [ -n "${VERIFY_PLAN_ONLY:-}" ]; then
  echo plan-only
  exit 0
fi

if [ "${VERIFY_SKIP_INSTALL:-0}" != 1 ]; then
  pnpm install --frozen-lockfile
fi
if [ "${VERIFY_SKIP_BUILD:-0}" != 1 ]; then
  pnpm build
fi
if [ "$GITHUB_MODE" = mock ]; then
  python3 - "$VERIFY_DIR/github-stub.pid" "$VERIFY_DIR/github-stub.log" node "$ROOT/.cursor/skills/verify-shiba/scripts/github-stub.mjs" --port "$GITHUB_STUB_PORT" <<'PY'
import subprocess, sys
pidfile, log, *cmd = sys.argv[1:]
proc = subprocess.Popen(cmd, stdout=open(log, "w"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
open(pidfile, "w").write(str(proc.pid))
PY
fi
PERSIST="$VERIFY_DIR/state"
# Pinned wrangler 4.118.0 accepts --persist-to on d1 migrations apply and wrangler dev.
MODE=persist-to
if ! npx wrangler d1 migrations apply --help 2>&1 | grep -q -- '--persist-to'; then
  MODE=default-wrangler-state
fi
echo "$MODE" > "$VERIFY_DIR/persist-mode"
mkdir -p "$PERSIST"
MIGRATE=(npx wrangler d1 migrations apply shiba-audit --local --config apps/backend/wrangler.jsonc)
DEV=(npx wrangler dev --config apps/backend/wrangler.jsonc --port "$PORT" --local-upstream localhost --env-file "$RUN_ENV")
[ "${#DEV_EXTRA[@]}" -eq 0 ] || DEV+=("${DEV_EXTRA[@]}")
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "warn: CLOUDFLARE_API_TOKEN unset — wrangler 4.118 may fail establishing the remote container proxy in non-interactive shells even with --enable-containers=false." > "$VERIFY_DIR/cf-token"
fi
if [ "$MODE" = persist-to ]; then
  MIGRATE+=(--persist-to "$PERSIST")
  DEV+=(--persist-to "$PERSIST")
fi
if [ "${CI:-}" = true ] || [ "${CI:-}" = 1 ]; then
  CI=1 "${MIGRATE[@]}" > "$VERIFY_DIR/migrate.log" 2>&1
else
  CI=1 "${MIGRATE[@]}" > "$VERIFY_DIR/migrate.log" 2>&1 || true
fi
docker ps -aq > "$VERIFY_DIR/containers.before" 2>/dev/null || true
SKILL="$ROOT/.cursor/skills/verify-shiba"
if [ ! -d "$SKILL/node_modules/playwright" ]; then
  npm install --prefix "$SKILL" --no-save
fi
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$VERIFY_DIR/playwright-browsers}"
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
echo "$PLAYWRIGHT_BROWSERS_PATH" > "$VERIFY_DIR/playwright-browsers-path"
npx --prefix "$SKILL" playwright install chromium
python3 - "$VERIFY_DIR/wrangler.pid" "$VERIFY_DIR/wrangler.log" "${DEV[@]}" <<'PY'
import subprocess, sys
pidfile, log, *cmd = sys.argv[1:]
proc = subprocess.Popen(cmd, stdout=open(log, "w"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
open(pidfile, "w").write(str(proc.pid))
PY
READY_ATTEMPTS=${VERIFY_LAUNCH_READY_ATTEMPTS:-90}
READY_SLEEP=${VERIFY_LAUNCH_SLEEP_SECS:-2}
ready=0
status=000
app=000
rm -f "$VERIFY_DIR/setup-status.body" "$VERIFY_DIR/app.body"
for _ in $(seq 1 "$READY_ATTEMPTS"); do
  status=$(curl -sS -o "$VERIFY_DIR/setup-status.body" -w "%{http_code}" "http://127.0.0.1:$PORT/api/setup/status" || true)
  app=$(curl -sS -o "$VERIFY_DIR/app.body" -w "%{http_code}" "http://127.0.0.1:$PORT/app/" || true)
  if [ "$status" = 200 ] && grep -q '{' "$VERIFY_DIR/setup-status.body" && [ "$app" = 200 ] && grep -qi '<html' "$VERIFY_DIR/app.body"; then
    if grep -qE 'Ready on http://|Ready on https://' "$VERIFY_DIR/wrangler.log" 2>/dev/null; then
      ready=1
      break
    fi
  fi
  sleep "$READY_SLEEP"
done
if grep -qE 'Address already in use|Fatal uncaught' "$VERIFY_DIR/wrangler.log" 2>/dev/null; then
  echo "wrangler failed to bind or crashed" >&2
  tail -n 40 "$VERIFY_DIR/wrangler.log" >&2 || true
  exit 1
fi
if [ "$ready" != 1 ]; then
  echo "launch not ready: /api/setup/status=$status /app/=$app" >&2
  tail -n 40 "$VERIFY_DIR/wrangler.log" >&2 || true
  exit 1
fi
echo ready
