#!/bin/sh
# shiba-acp-install — fetch + verify + unpack an ACP registry binary agent.
#
# Usage: shiba-acp-install <agent-id> <archive-url> [sha256]
#
# The worker's ACP registry resolver emits /opt/acp-agents/<id>/ paths for
# binary-distributed agents; this script is the install half. It fails
# closed: no verify tool, wrong digest, or an unexpected archive layout is
# a hard error — a half-installed agent must never reach a run.
set -eu

id="${1:?agent id required}"
url="${2:?archive url required}"
want="${3:-}"
dest="/opt/acp-agents/$id"

case "$id" in
  "" | *[!a-z0-9-]* | -* | *-)
    echo "shiba-acp-install: invalid agent id: $id" >&2
    exit 2
    ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$tmp/agent.bin"

if [ -n "$want" ]; then
  got="$(sha256sum "$tmp/agent.bin" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    echo "shiba-acp-install: sha256 mismatch for $id (want $want, got $got)" >&2
    exit 1
  fi
else
  echo "shiba-acp-install: WARNING — no sha256 declared for $id; installing unverified" >&2
fi

mkdir -p "$dest"
case "$url" in
  *.zip)
    unzip -q "$tmp/agent.bin" -d "$tmp/x"
    ;;
  *.tar.gz | *.tgz)
    mkdir -p "$tmp/x" && tar -xzf "$tmp/agent.bin" -C "$tmp/x"
    ;;
  *.tar.xz)
    mkdir -p "$tmp/x" && tar -xJf "$tmp/agent.bin" -C "$tmp/x"
    ;;
  *)
    # A bare executable archive — install as <id> itself.
    cp "$tmp/agent.bin" "$dest/$id" && chmod +x "$dest/$id"
    exit 0
    ;;
esac

# Flatten a single top-level directory (archives like amp-acp-<plat>/).
# Never follow symlinks: a malicious archive could point outside staging.
safe_top_dir() {
  _candidate="$1"
  [ -L "$_candidate" ] && return 1
  [ -d "$_candidate" ] || return 1
  _real="$(cd "$_candidate" 2>/dev/null && pwd -P)" || return 1
  _staging="$(cd "$tmp/x" 2>/dev/null && pwd -P)" || return 1
  case "$_real" in
    "$_staging"|"$_staging"/*) return 0 ;;
    *) return 1 ;;
  esac
}

n_entries="$(find "$tmp/x" -mindepth 1 -maxdepth 1 ! -type l | wc -l)"
  if [ "$n_entries" = "1" ]; then
  _top="$(find "$tmp/x" -mindepth 1 -maxdepth 1 ! -type l -print -quit)"
  if safe_top_dir "$_top"; then
    for _entry in "$_top"/*; do
      [ -e "$_entry" ] || continue
      [ -L "$_entry" ] && continue
      _base="$(basename "$_entry")"
      mv "$_entry" "$dest/$_base" 2>/dev/null || cp -R "$_entry" "$dest/$_base"
    done
  else
    echo "shiba-acp-install: archive layout escapes staging (symlink or path traversal)" >&2
    exit 1
  fi
else
  for _entry in "$tmp/x"/*; do
    [ -e "$_entry" ] || continue
    [ -L "$_entry" ] && continue
    _base="$(basename "$_entry")"
    mv "$_entry" "$dest/$_base" 2>/dev/null || cp -R "$_entry" "$dest/$_base"
  done
fi

# Executable bit: anything the registry names as cmd must run.
find "$dest" -type f -name '*.so' -prune -o -type f -exec chmod +x {} +
echo "shiba-acp-install: installed $id -> $dest"
