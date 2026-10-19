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
if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | grep -q "$PID"; then
  # wrangler may listen from a child of the recorded PID.
  if ! pgrep -P "$PID" >/dev/null 2>&1; then
    echo "PID $PID does not own port $PORT" >&2
    exit 1
  fi
  if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null; then
    echo "nothing listening on $PORT" >&2
    exit 1
  fi
fi
if docker info >/dev/null 2>&1; then
  echo "docker=ok"
else
  echo "docker=unavailable (sandbox runs and reject docker-diff proof need a local engine)" >&2
  # UI-only journeys (approval card, mock GitHub) can still run without Docker.
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
