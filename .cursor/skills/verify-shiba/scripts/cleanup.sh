#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
VERIFY_DIR=${VERIFY_DIR:-$ROOT/.verify}
kill_session() {
  local pid=$1
  [ -n "$pid" ] || return 0
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  local i=0
  while [ "$i" -lt 15 ] && kill -0 "$pid" 2>/dev/null; do
    sleep 1
    i=$((i + 1))
  done
  kill -9 -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
}
# A listener on the recorded port can belong to another invocation after a
# restart. Only stop process groups explicitly recorded by this launch.
if [ -f "$VERIFY_DIR/wrangler.pid" ]; then
  kill_session "$(cat "$VERIFY_DIR/wrangler.pid")"
  rm -f "$VERIFY_DIR/wrangler.pid"
fi
if [ -f "$VERIFY_DIR/github-stub.pid" ]; then
  kill_session "$(cat "$VERIFY_DIR/github-stub.pid")"
  rm -f "$VERIFY_DIR/github-stub.pid"
fi
if [ -f "$VERIFY_DIR/containers.txt" ]; then
  while read -r id; do
    [ -n "$id" ] && docker stop "$id" 2>/dev/null || true
  done < "$VERIFY_DIR/containers.txt"
fi
rm -rf "$VERIFY_DIR/state"
echo "cleanup kept $VERIFY_DIR/evidence"
