#!/usr/bin/env bash
# Installs one pinned release of the SPM agent kit.
#
# Usage: install-kit.sh <version> <sha256>
#   <version>  a release number such as 0.1.0 (the release tag is v<version>)
#   <sha256>   the SHA-256 of spm-agent-kit-<version>.tar.gz, from the release's SHA256SUMS
#
# Environment:
#   SPM_AGENT_KIT_DIR       install folder (default: $HOME/spm-agent-kit)
#   SPM_AGENT_KIT_URL_BASE  download base (default: the GitHub releases page; tests use a file:// base)
#
# The install folder is only ever replaced when it carries the kit marker .spm-agent-kit
# (one line: "spm-agent-kit <version>"). An empty folder is installed into. Anything else is refused.
#
# Setup report (0.2.0): each of the download, checksum and unpack steps appends one JSON line to
# $HOME/.spm-agent-state/setup-report.jsonl (folder 0700, file 0600). A run id is written to
# $HOME/.spm-agent-state/setup-run-id on every run. Spool lines never go to stdout, and a failed write never stops the install.
#
# Exit codes: 0 installed, or that version is already there
#             2 bad arguments or an unsafe install folder (nothing is deleted)
#             3 checksum does not match (nothing is installed)
#             4 download or unpack failed
set -u

MARKER=".spm-agent-kit"
KIT_RE='^spm-agent-kit ([0-9]+\.[0-9]+\.[0-9]+)$'

die() {
  echo "install-kit: $1" >&2
  exit "$2"
}

STATE_DIR="$HOME/.spm-agent-state"
RUN_ID=""

# A 32-character lower-case hex id from the system random source; empty when there is none.
rand_hex() {
  local id
  id="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
  [[ "$id" =~ ^[a-f0-9]{32}$ ]] && printf '%s' "$id"
  return 0
}

# Makes this run's id and writes it to setup-run-id. A failure leaves RUN_ID empty, and spool lines are then skipped.
new_run_id() {
  local id
  id="$(rand_hex)"
  [ -n "$id" ] || return 0
  if (
    umask 077
    [ ! -L "$STATE_DIR" ] && mkdir -p "$STATE_DIR" && chmod 0700 "$STATE_DIR" \
      && [ ! -L "$STATE_DIR/setup-run-id" ] && printf '%s\n' "$id" > "$STATE_DIR/setup-run-id"
  ) 2>/dev/null; then
    RUN_ID="$id"
  fi
  return 0
}

# spool_line <step> <pass|fail> [code]: one setup line, kind setup, role setup. Never fails the install.
spool_line() {
  [ -n "$RUN_ID" ] || return 0
  local f="$STATE_DIR/setup-report.jsonl" id at code_part=""
  id="$(rand_hex)"
  [ -n "$id" ] || return 0
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ -n "${3:-}" ]; then code_part=",\"code\":\"$3\""; fi
  (
    umask 077
    mkdir -p "$STATE_DIR" && chmod 0700 "$STATE_DIR" || exit 1
    [ ! -L "$f" ] || exit 1
    printf '{"id":"%s","kind":"setup","role":"setup","run_id":"%s","step":"%s","status":"%s"%s,"at":"%s"}\n' \
      "$id" "$RUN_ID" "$1" "$2" "$code_part" "$at" >> "$f" && chmod 0600 "$f"
  ) 2>/dev/null
  return 0
}

# Prints one word for the install folder: missing, empty, symlink, refused, or "kit <version>".
# Reads only; it never changes anything.
classify_dir() {
  local d="$1" first
  if [ -L "$d" ]; then echo "symlink"; return; fi
  if [ ! -e "$d" ]; then echo "missing"; return; fi
  if [ ! -d "$d" ]; then echo "refused"; return; fi
  if [ -z "$(find "$d" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then echo "empty"; return; fi
  if [ -f "$d/$MARKER" ] && [ ! -L "$d/$MARKER" ]; then
    first="$(head -n 1 "$d/$MARKER" 2>/dev/null)"
    if [[ "$first" =~ $KIT_RE ]]; then echo "kit ${BASH_REMATCH[1]}"; return; fi
  fi
  echo "refused"
}

VERSION="${1:-}"
SHA="${2:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: install-kit.sh <version> <sha256>" 2
[[ "$SHA" =~ ^[0-9a-fA-F]{64}$ ]] || die "the second argument must be a 64-character SHA-256" 2

DIR="${SPM_AGENT_KIT_DIR:-$HOME/spm-agent-kit}"
case "$DIR" in
  ""|/|"$HOME") die "refusing to install into $DIR; set SPM_AGENT_KIT_DIR to a folder of its own" 2 ;;
esac

# Checked before any download.
STATE="$(classify_dir "$DIR")"
case "$STATE" in
  symlink) die "$DIR is a symlink; refusing to install through it" 2 ;;
  refused) die "$DIR exists and is not a kit folder (no $MARKER marker); set SPM_AGENT_KIT_DIR to another folder" 2 ;;
  "kit "*)
    if [ "${STATE#kit }" = "$VERSION" ]; then
      echo "install-kit: version $VERSION is already installed at $DIR"
      exit 0
    fi
    ;;
esac

new_run_id

BASE="${SPM_AGENT_KIT_URL_BASE:-https://github.com/superproductmanager/spm-agent-kit/releases/download}"
URL="$BASE/v$VERSION/spm-agent-kit-$VERSION.tar.gz"

TMP="$(mktemp -d)" || die "could not create a temporary folder" 4
trap 'rm -rf "$TMP"' EXIT

if curl -fsSL -o "$TMP/kit.tar.gz" "$URL" 2>/dev/null; then
  spool_line download pass
else
  spool_line download fail download_failed
  die "could not download release $VERSION" 4
fi

if command -v sha256sum >/dev/null 2>&1; then
  GOT="$(sha256sum "$TMP/kit.tar.gz" | cut -d' ' -f1)"
else
  GOT="$(shasum -a 256 "$TMP/kit.tar.gz" | cut -d' ' -f1)"
fi
if [ "$(printf '%s' "$GOT" | tr 'A-F' 'a-f')" != "$(printf '%s' "$SHA" | tr 'A-F' 'a-f')" ]; then
  spool_line checksum fail checksum_mismatch
  die "checksum does not match release $VERSION; nothing was installed" 3
fi
spool_line checksum pass

mkdir -p "$(dirname "$DIR")" || die "could not create the parent of $DIR" 4
# The staging folder sits beside the install folder, so the final mv is a rename on one filesystem.
STAGE="$(mktemp -d "$(dirname "$DIR")/.spm-agent-kit-stage.XXXXXX")" || die "could not create a staging folder" 4
trap 'rm -rf "$TMP" "$STAGE"' EXIT
chmod 0755 "$STAGE" || die "could not set up the staging folder" 4
if ! tar -xzf "$TMP/kit.tar.gz" -C "$STAGE" --strip-components=1 2>/dev/null; then
  spool_line unpack fail unpack_failed
  die "could not unpack release $VERSION" 4
fi
printf '%s\n' "$VERSION" > "$STAGE/VERSION"
printf 'spm-agent-kit %s\n' "$VERSION" > "$STAGE/$MARKER"
spool_line unpack pass


# Checked again right before the delete: the folder may have changed during the download.
STATE="$(classify_dir "$DIR")"
case "$STATE" in
  symlink|refused) die "$DIR changed during the download and is no longer a kit folder; nothing was deleted" 2 ;;
  missing) ;;
  empty) rmdir "$DIR" || die "could not use the empty folder $DIR" 4 ;;
  kit*) rm -rf "$DIR" || die "could not remove the old kit in $DIR" 4 ;;
esac
mv "$STAGE" "$DIR" || die "could not move the kit into $DIR" 4

echo "install-kit: installed version $VERSION at $DIR"
exit 0
