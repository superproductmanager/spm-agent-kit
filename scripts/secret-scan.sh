#!/usr/bin/env bash
# Scans text for likely secrets. Pure bash and grep: no network, no installs.
#
# Usage:
#   scripts/secret-scan.sh --staged     scan what is staged (the index copy, not the working copy)
#   scripts/secret-scan.sh --all        scan tracked files plus untracked files that are not ignored
#   scripts/secret-scan.sh <file>...    scan the named files
#
# Exit codes: 0 clean, 1 a possible secret was found, 2 bad usage.
# It prints file, line and kind only. It never prints the matched text.
set -u

usage() {
  echo "usage: secret-scan.sh --staged | --all | <file>..." >&2
  exit 2
}

# The key shapes are one list, lib/secret-patterns.txt (name|ERE per line, # comments), shared with
# agent-reply.cjs. The exact test fakes that may carry a shape are in scripts/allowed-fakes.txt.
# Both files are read from the kit's own folder, never from the current directory.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATTERNS_FILE="$HERE/../lib/secret-patterns.txt"
ALLOW_FILE="$HERE/allowed-fakes.txt"
[ -f "$PATTERNS_FILE" ] || { echo "secret-scan: missing $PATTERNS_FILE" >&2; exit 2; }
PNAMES=()
PRES=()
while IFS= read -r entry || [ -n "$entry" ]; do
  case "$entry" in ''|'#'*) continue ;; esac
  PNAMES+=("${entry%%|*}")
  PRES+=("${entry#*|}")
done < "$PATTERNS_FILE"
ALLOWED=""
[ -f "$ALLOW_FILE" ] && ALLOWED="$(cat "$ALLOW_FILE")"

# True (0) when $1 is exactly one of the allowed values. A value is never a prefix or a substring match.
is_allowed() {
  case $'\n'"$ALLOWED"$'\n' in
    *$'\n'"$1"$'\n'*) return 0 ;;
  esac
  return 1
}

# Reads the text to scan on stdin, once. $1 is the label used in the report.
# Prints one line per hit: label:line: kind. Never prints the matched text.
# A match counts unless its token (the match without one leading boundary character) is exactly an allowed value.
scan_stream() {
  local label="$1" text i hit ln m tok last
  text="$(cat)"

  for i in "${!PRES[@]}"; do
    last=""
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      ln="${hit%%:*}"
      m="${hit#*:}"
      tok="$m"
      case "$tok" in [!A-Za-z0-9_]*) tok="${tok:1}" ;; esac
      is_allowed "$tok" && continue
      [ "$ln" = "$last" ] && continue
      echo "$label:$ln: ${PNAMES[$i]}"
      last="$ln"
    done < <(printf '%s\n' "$text" | grep -n -I -o -E -e "${PRES[$i]}")
  done
  return 0
}

# Reads stdin, so the staged blob is scanned, not the working copy.
scan_repo_files() {
  local mode="$1" f
  if [ "$mode" = "staged" ]; then
    while IFS= read -r -d '' f; do
      git show ":$f" 2>/dev/null | scan_stream "$f"
    done < <(git diff --cached --name-only --diff-filter=ACMR -z)
  else
    while IFS= read -r -d '' f; do
      [ -f "$f" ] || continue
      scan_stream "$f" < "$f"
    done < <(git ls-files -z --cached --others --exclude-standard)
  fi
}

main() {
  [ $# -ge 1 ] || usage
  local out
  case "$1" in
    --staged|--all)
      [ $# -eq 1 ] || usage
      git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "secret-scan: not inside a git repository" >&2; exit 2; }
      out="$(scan_repo_files "${1#--}")"
      ;;
    -*)
      usage
      ;;
    *)
      local f
      for f in "$@"; do
        [ -f "$f" ] || { echo "secret-scan: not a file: $f" >&2; exit 2; }
      done
      out="$(for f in "$@"; do scan_stream "$f" < "$f"; done)"
      ;;
  esac

  if [ -n "$out" ]; then
    printf '%s\n' "$out"
    echo "secret-scan: possible secret found (text not printed). Remove it; if it is real, revoke it, then retry." >&2
    exit 1
  fi
  exit 0
}

main "$@"
