#!/bin/sh
# Optional headless desktop stack for computer-use runs. Idempotent per container.
set -eu
MARKER=/tmp/shiba-desktop.ready
if [ -f "$MARKER" ]; then
  exit 0
fi

export DISPLAY=:0
VNC_PASS="${SHIBA_VNC_PASSWORD:-shiba}"

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  Xvfb :0 -screen 0 1280x720x24 -ac +extension GLX +render -noreset >/tmp/shiba-xvfb.log 2>&1 &
  sleep 1
fi

if command -v openbox >/dev/null 2>&1 && ! pgrep -x openbox >/dev/null 2>&1; then
  openbox >/tmp/shiba-openbox.log 2>&1 &
fi

if command -v x11vnc >/dev/null 2>&1 && ! pgrep -x x11vnc >/dev/null 2>&1; then
  x11vnc -display :0 -forever -shared -rfbauth /dev/null -passwd "$VNC_PASS" -rfbport 5900 \
    >/tmp/shiba-x11vnc.log 2>&1 &
fi

if command -v websockify >/dev/null 2>&1 && ! pgrep -f 'websockify.*6080' >/dev/null 2>&1; then
  NOVNC_WEB=/usr/share/novnc
  if [ ! -d "$NOVNC_WEB" ]; then
    NOVNC_WEB=/usr/share/novnc/utils/websockify
  fi
  websockify --web="$NOVNC_WEB" 6080 localhost:5900 >/tmp/shiba-websockify.log 2>&1 &
fi

if command -v chromium >/dev/null 2>&1 && ! pgrep -f 'chromium.*about:blank' >/dev/null 2>&1; then
  chromium --no-sandbox --disable-gpu --window-size=1280,720 about:blank \
    >/tmp/shiba-chromium.log 2>&1 &
elif command -v chromium-browser >/dev/null 2>&1 && ! pgrep -f 'chromium-browser.*about:blank' >/dev/null 2>&1; then
  chromium-browser --no-sandbox --disable-gpu --window-size=1280,720 about:blank \
    >/tmp/shiba-chromium.log 2>&1 &
fi

touch "$MARKER"
