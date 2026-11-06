#!/bin/sh
set -eu
export DISPLAY=:1
i=0
until xdpyinfo -display :1 >/dev/null 2>&1 && xdotool search --onlyvisible --class '[Cc]hromium' >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -le 100 ] || exit 70; sleep 0.1
done
