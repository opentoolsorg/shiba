#!/bin/sh
set -eu
case "${SHIBA_COMPUTER_EXPIRES_AT:-}" in ''|*[!0-9]*) exit 64;; esac
now_ms=$(($(date +%s) * 1000))
remaining_ms=$((SHIBA_COMPUTER_EXPIRES_AT - now_ms))
[ "$remaining_ms" -gt 0 ] && [ "$remaining_ms" -le 600000 ] || exit 64
export DISPLAY=:1 HOME=/home/desktop
mkdir -p /tmp/shiba-computer-home
# The watchdog survives Worker/DO disconnection. No read/heartbeat extends it.
sleep "$((remaining_ms / 1000 + 1))" & watchdog=$!
cleanup() { kill "$watchdog" "${xpid:-}" "${wpid:-}" "${bpid:-}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
Xvfb :1 -screen 0 1024x768x24 -nolisten tcp -noreset & xpid=$!
i=0
until xdpyinfo -display :1 >/dev/null 2>&1; do i=$((i+1)); [ "$i" -le 100 ] || exit 70; sleep 0.1; done
openbox --sm-disable & wpid=$!
# Browser sandboxing is not the VM isolation boundary. No external network,
# authenticated sites, account profile, extensions or coding process exists.
chromium --no-sandbox --disable-dev-shm-usage --disable-background-networking \
  --disable-extensions --disable-component-update --no-first-run --disable-sync \
  --disable-quic --disable-features=MediaRouter --user-data-dir=/tmp/shiba-computer-home \
  --app=file:///opt/shiba-computer/desktop.html --window-size=1024,768 --window-position=0,0 \
  >/tmp/shiba-computer-browser.log 2>&1 & bpid=$!
wait "$watchdog"
