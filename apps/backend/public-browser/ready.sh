#!/bin/sh
set -eu
export DISPLAY=:1
: > /tmp/shiba-browser-go
i=0
until xdpyinfo -display :1 >/dev/null 2>&1 && xdotool search --onlyvisible --class '[Cc]hromium' >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -le 200 ] || exit 70; sleep 0.1
done
# Every Chromium process must be unprivileged and sandboxed.
found=0
for d in /proc/[0-9]*; do
  [ "$(cat "$d/comm" 2>/dev/null)" = chromium ] || continue
  found=1
  [ "$(stat -c %u "$d")" -ne 0 ] || exit 72
  ! tr '\0' ' ' < "$d/cmdline" 2>/dev/null | grep -q -- '--no-sandbox' || exit 73
done
[ "$found" -eq 1 ] || exit 70
