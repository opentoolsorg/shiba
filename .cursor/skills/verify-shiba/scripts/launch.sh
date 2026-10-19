#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
VERIFY_DIR="$ROOT/.verify"
mkdir -p "$VERIFY_DIR"
PORT=${PORT:-8788}
echo "$PORT" > "$VERIFY_DIR/port"
pnpm install
pnpm build
if [ ! -f apps/backend/.dev.vars ]; then
  cp apps/backend/.dev.vars.example apps/backend/.dev.vars
fi
# Mock boundary: point GitHub REST at the local stub. Never print .dev.vars values.
if [ "${VERIFY_GITHUB:-mock}" = mock ]; then
  if ! grep -q '^GITHUB_API_BASE=' apps/backend/.dev.vars; then
    printf '\nGITHUB_API_BASE=http://127.0.0.1:8799\n' >> apps/backend/.dev.vars
  fi
  if ! grep -q '^GITHUB_TOKEN=.\+' apps/backend/.dev.vars; then
    printf 'GITHUB_TOKEN=mock-github-token\n' >> apps/backend/.dev.vars
  fi
  python3 - "$VERIFY_DIR/github-stub.pid" "$VERIFY_DIR/github-stub.log" node "$ROOT/.cursor/skills/verify-shiba/scripts/github-stub.mjs" --port 8799 <<'PY'
import subprocess, sys
pidfile, log, *cmd = sys.argv[1:]
proc = subprocess.Popen(cmd, stdout=open(log, "w"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
open(pidfile, "w").write(str(proc.pid))
PY
  echo mock > "$VERIFY_DIR/github-mode"
else
  echo live > "$VERIFY_DIR/github-mode"
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
DEV=(npx wrangler dev --config apps/backend/wrangler.jsonc --port "$PORT" --local-upstream localhost)
if [ "$MODE" = persist-to ]; then
  MIGRATE+=(--persist-to "$PERSIST")
  DEV+=(--persist-to "$PERSIST")
fi
CI=1 "${MIGRATE[@]}" > "$VERIFY_DIR/migrate.log" 2>&1 || true
docker ps -aq > "$VERIFY_DIR/containers.before" 2>/dev/null || true
SKILL="$ROOT/.cursor/skills/verify-shiba"
if [ ! -d "$SKILL/node_modules/playwright" ]; then
  npm install --prefix "$SKILL" --no-save playwright@1.55.1
fi
npx --prefix "$SKILL" playwright install chromium
python3 - "$VERIFY_DIR/wrangler.pid" "$VERIFY_DIR/wrangler.log" "${DEV[@]}" <<'PY'
import subprocess, sys
pidfile, log, *cmd = sys.argv[1:]
proc = subprocess.Popen(cmd, stdout=open(log, "w"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
open(pidfile, "w").write(str(proc.pid))
PY
ready=0
status=000
app=000
rm -f "$VERIFY_DIR/setup-status.body" "$VERIFY_DIR/app.body"
for _ in $(seq 1 90); do
  status=$(curl -sS -o "$VERIFY_DIR/setup-status.body" -w "%{http_code}" "http://127.0.0.1:$PORT/api/setup/status" || true)
  app=$(curl -sS -o "$VERIFY_DIR/app.body" -w "%{http_code}" "http://127.0.0.1:$PORT/app/" || true)
  if [ "$status" = 200 ] && grep -q '{' "$VERIFY_DIR/setup-status.body" && [ "$app" = 200 ] && grep -qi '<html' "$VERIFY_DIR/app.body"; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" != 1 ]; then
  echo "launch not ready: /api/setup/status=$status /app/=$app" >&2
  tail -n 40 "$VERIFY_DIR/wrangler.log" >&2 || true
  exit 1
fi
echo ready
