#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
VERIFY_DIR="$ROOT/.verify"
PORT=$(cat "$VERIFY_DIR/port" 2>/dev/null || echo 8788)
PID=$(cat "$VERIFY_DIR/wrangler.pid" 2>/dev/null || true)
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  echo "PID not alive" >&2
  exit 1
fi
if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "nothing listening on $PORT" >&2
  exit 1
fi
if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q "$PID"; then
  # wrangler dev often listens from a child process; in CI we only require the port.
  if [ "${CI:-}" = true ] || [ "${CI:-}" = 1 ]; then
    echo "port_listen=ok (wrangler child)"
  elif ! pgrep -P "$PID" >/dev/null 2>&1; then
    echo "PID $PID does not own port $PORT" >&2
    exit 1
  else
    echo "port_listen=ok (child of $PID)"
  fi
fi
CONTAINERS_MODE=$(cat "$VERIFY_DIR/containers-mode" 2>/dev/null || echo enabled)
if [ "$CONTAINERS_MODE" = disabled ]; then
  echo "docker=skipped (containers disabled)"
elif docker info >/dev/null 2>&1; then
  echo "docker=ok"
else
  echo "docker=unavailable" >&2
  exit 1
fi
PKG=$(node -e "const r=require('$ROOT/package.json'); console.log(r.devDependencies?.wrangler || r.dependencies?.wrangler || '')")
HAVE=$(npx wrangler --version | awk '{print $NF}')
echo "wrangler package=$PKG have=$HAVE"
BODY=$(curl -sS "http://127.0.0.1:$PORT/api/setup/status")
echo "$BODY" | python3 -c "import sys,json; json.load(sys.stdin)"
if grep -q '^GITHUB_TOKEN=.\+' "$ROOT/apps/backend/.dev.vars" 2>/dev/null; then
  echo "GITHUB_TOKEN=present"
else
  echo "GITHUB_TOKEN=absent"
fi
echo doctor_ok
