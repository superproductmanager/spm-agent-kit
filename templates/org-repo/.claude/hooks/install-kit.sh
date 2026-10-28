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

BASE="${SPM_AGENT_KIT_URL_BASE:-https://github.com/superproductmanager/spm-agent-kit/releases/download}"
URL="$BASE/v$VERSION/spm-agent-kit-$VERSION.tar.gz"

TMP="$(mktemp -d)" || die "could not create a temporary folder" 4
trap 'rm -rf "$TMP"' EXIT

curl -fsSL -o "$TMP/kit.tar.gz" "$URL" 2>/dev/null \
  || die "could not download release $VERSION" 4

if command -v sha256sum >/dev/null 2>&1; then
  GOT="$(sha256sum "$TMP/kit.tar.gz" | cut -d' ' -f1)"
else
  GOT="$(shasum -a 256 "$TMP/kit.tar.gz" | cut -d' ' -f1)"
fi
if [ "$(printf '%s' "$GOT" | tr 'A-F' 'a-f')" != "$(printf '%s' "$SHA" | tr 'A-F' 'a-f')" ]; then
  die "checksum does not match release $VERSION; nothing was installed" 3
fi

STAGE="$TMP/stage"
mkdir -p "$STAGE" || die "could not create a staging folder" 4
tar -xzf "$TMP/kit.tar.gz" -C "$STAGE" --strip-components=1 2>/dev/null \
  || die "could not unpack release $VERSION" 4
printf '%s\n' "$VERSION" > "$STAGE/VERSION"
printf 'spm-agent-kit %s\n' "$VERSION" > "$STAGE/$MARKER"

mkdir -p "$(dirname "$DIR")" || die "could not create the parent of $DIR" 4

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
