#!/bin/sh
set -eu
case "${SHIBA_BROWSER_EXPIRES_AT:-}" in ''|*[!0-9]*) exit 64;; esac
case "${SHIBA_BROWSER_START_URL:-}" in https://*) ;; *) exit 64;; esac
[ "$(id -u)" -ne 0 ] || exit 65
now_ms=$(($(date +%s) * 1000))
remaining_ms=$((SHIBA_BROWSER_EXPIRES_AT - now_ms))
[ "$remaining_ms" -gt 0 ] && [ "$remaining_ms" -le 600000 ] || exit 64
export DISPLAY=:1 HOME=/home/browser
# The watchdog survives Worker/DO disconnection. No read/heartbeat extends it.
sleep "$((remaining_ms / 1000 + 1))" & watchdog=$!
cleanup() { kill "$watchdog" "${xpid:-}" "${wpid:-}" "${bpid:-}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
Xvfb :1 -screen 0 1024x768x24 -nolisten tcp -noreset & xpid=$!
i=0
until xdpyinfo -display :1 >/dev/null 2>&1; do i=$((i+1)); [ "$i" -le 100 ] || exit 70; sleep 0.1; done
openbox --sm-disable & wpid=$!
# The session releases this only after its outbound interceptors are installed.
i=0
until [ -f /tmp/shiba-browser-go ]; do i=$((i+1)); [ "$i" -le 300 ] || exit 70; sleep 0.1; done
# Runtime-generated interception CA; never baked into the image. Missing CA fails closed.
ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
[ -s "$ca" ] || exit 71
mkdir -p "$HOME/.pki/nssdb"
certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password
certutil -d "sql:$HOME/.pki/nssdb" -A -n cloudflare-containers -t "C,," -i "$ca"
profile=$(mktemp -d /tmp/shiba-browser-profile.XXXXXX)
# Chromium keeps its sandbox. If it cannot sandbox here, it exits and readiness fails.
chromium --incognito --disable-dev-shm-usage --disable-background-networking \
  --disable-extensions --disable-component-update --no-first-run --disable-sync \
  --disable-quic --disable-features=MediaRouter,DnsOverHttps --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  --user-data-dir="$profile" --app="$SHIBA_BROWSER_START_URL" --window-size=1024,768 --window-position=0,0 \
  >/tmp/shiba-browser.log 2>&1 & bpid=$!
wait "$watchdog"
