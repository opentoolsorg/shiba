#!/bin/sh
# Ad-hoc re-sign a locally built (unsigned) Shiba.app so it launches on
# Apple-silicon macOS. electron-builder skips signing entirely under
# CSC_IDENTITY_AUTO_DISCOVERY=false, leaving the fused Electron binary with an
# invalid signature (kernel kills it: "Code Signature Invalid"). codesign's
# --deep mode is broken for Electron's nested bundles, so sign inside-out.
# Signed/notarized CI builds never need this.
set -eu

APP="$1"

for helper in "$APP/Contents/Frameworks/"*.app; do
  [ -d "$helper" ] && codesign --force --sign - "$helper" >/dev/null
done
for fw in "$APP/Contents/Frameworks/"*.framework; do
  [ -d "$fw" ] && codesign --force --sign - "$fw" >/dev/null
done
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "ad-hoc signed: $APP"
