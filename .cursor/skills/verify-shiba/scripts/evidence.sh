#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
VERIFY_DIR=${VERIFY_DIR:-$ROOT/.verify}
STAMP=${1:-$(date -u +%Y-%m-%dT%H%M%SZ)}
DEST="$VERIFY_DIR/evidence/$STAMP"
mkdir -p "$DEST"
cp -R "$VERIFY_DIR/drive/." "$DEST/" 2>/dev/null || true
tail -n 200 "$VERIFY_DIR/wrangler.log" > "$DEST/wrangler.tail.log" 2>/dev/null || true
docker ps -a > "$DEST/docker-ps.txt" 2>/dev/null || echo "docker unavailable" > "$DEST/docker-ps.txt"
PORT=$(cat "$VERIFY_DIR/port" 2>/dev/null || echo 8788)
curl -sS "http://127.0.0.1:$PORT/api/setup/status" > "$DEST/setup-status.json" || true
curl -sS "http://127.0.0.1:$PORT/api/runs" > "$DEST/runs.json" || true
curl -sS "http://127.0.0.1:$PORT/api/v1/threads" > "$DEST/threads.json" || true
cp "$VERIFY_DIR/drive/assertions.json" "$DEST/assertions.json" 2>/dev/null || true
cat "$VERIFY_DIR/standin-mode" 2>/dev/null > "$DEST/standin-mode.txt" || true
cat "$VERIFY_DIR/containers-mode" 2>/dev/null > "$DEST/containers-mode.txt" || true
MODE=$(cat "$VERIFY_DIR/github-mode" 2>/dev/null || echo mock)
echo "$MODE" > "$DEST/github-mode.txt"
if [ "$MODE" = mock ]; then
  STUB_PORT=$(cat "$VERIFY_DIR/github-stub-port" 2>/dev/null || echo 8799)
  curl -sS "http://127.0.0.1:$STUB_PORT/__shiba/state" > "$DEST/github-stub-state.json" 2>/dev/null || true
  echo "mock GitHub" > "$DEST/LABEL.txt"
  cp "$VERIFY_DIR/github-stub-calls.json" "$DEST/github-stub-calls.json" 2>/dev/null || true
fi
echo "$DEST"
