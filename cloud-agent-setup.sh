#!/usr/bin/env bash
# cloud-agent-setup.sh: installs the three Firebase SDK packages that agent-listen.cjs needs, into a runtime folder.
# The versions are pinned below (the ones firebase 12.4.0 itself declares). Bump them deliberately, with the listener tested against the new versions.
# The install comes from the kit's committed runtime/package.json and runtime/package-lock.json, with npm ci and --ignore-scripts.
#
#   bash cloud-agent-setup.sh                 DRY RUN (the default): prints the plan, installs nothing
#   bash cloud-agent-setup.sh --apply         copies runtime/package.json and runtime/package-lock.json into the runtime folder,
#                                             then runs: npm ci --prefix <runtime folder> --ignore-scripts --no-audit --no-fund
#   bash cloud-agent-setup.sh --runtime-dir <absolute path>   (default: $SPM_AGENT_RUNTIME_DIR, else $HOME/.spm-agent-runtime)
#   bash cloud-agent-setup.sh --help
#
# Nothing is written inside a git work tree: the runtime folder is refused when its parent is one.
# Exit codes: 0 ok (dry run or applied), 2 usage or a refused path, 1 the npm ci failed, the kit's runtime files are missing, or an installed version differs from its pin.
set -u

# One pinned version per SDK package the listener uses.
PIN_APP="0.14.4"
PIN_AUTH="1.11.0"
PIN_FIRESTORE="4.9.2"
SDK_PINS="@firebase/app:$PIN_APP @firebase/auth:$PIN_AUTH @firebase/firestore:$PIN_FIRESTORE"
KIT_RUNTIME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime"

usage() {
  cat <<'USAGE'
usage: cloud-agent-setup.sh [--apply] [--runtime-dir <absolute path>] [--help]
  default: DRY RUN (prints the plan and the pinned versions; installs nothing)
  --apply: installs the three pinned SDK packages into the runtime folder with npm ci, then prints the installed versions
USAGE
}

installed_version() {
  node -p "require(process.argv[1] + '/node_modules/' + process.argv[2] + '/package.json').version" "$RUNTIME_DIR" "$1" 2>/dev/null
}

APPLY=0
RUNTIME_DIR="${SPM_AGENT_RUNTIME_DIR:-$HOME/.spm-agent-runtime}"
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --runtime-dir)
      [ $# -ge 2 ] || { echo "cloud-agent-setup: --runtime-dir needs a value" >&2; usage >&2; exit 2; }
      RUNTIME_DIR="$2"; shift 2 ;;
    *) echo "cloud-agent-setup: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$RUNTIME_DIR" in /*) ;; *) echo "cloud-agent-setup: the runtime folder must be an absolute path" >&2; exit 2 ;; esac
case "$RUNTIME_DIR" in *..*) echo "cloud-agent-setup: the runtime folder must be a normalised path" >&2; exit 2 ;; esac

# refuse a runtime folder whose parent is inside any git work tree (nothing is written inside a repository)
PARENT="$(dirname "$RUNTIME_DIR")"
if [ -d "$PARENT" ] && git -C "$PARENT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "cloud-agent-setup: the runtime folder would sit inside a git work tree; refused" >&2
  exit 2
fi

if [ "$APPLY" -ne 1 ]; then
  echo "DRY RUN: would install @firebase/app@$PIN_APP @firebase/auth@$PIN_AUTH @firebase/firestore@$PIN_FIRESTORE into $RUNTIME_DIR"
  echo "DRY RUN: would copy $KIT_RUNTIME/package.json and $KIT_RUNTIME/package-lock.json there, then run: npm ci --prefix $RUNTIME_DIR --ignore-scripts --no-audit --no-fund"
  echo "DRY RUN: nothing installed (add --apply to install)"
  exit 0
fi

for f in package.json package-lock.json; do
  [ -f "$KIT_RUNTIME/$f" ] || { echo "cloud-agent-setup: the kit's runtime/$f is missing; refused" >&2; exit 1; }
done

# already at the pins, with the kit's lockfile and manifest in place: say so and leave npm alone
PINS_OK=1
for entry in $SDK_PINS; do
  [ "$(installed_version "${entry%%:*}")" = "${entry#*:}" ] || PINS_OK=0
done
if [ "$PINS_OK" -eq 1 ] \
  && cmp -s "$KIT_RUNTIME/package.json" "$RUNTIME_DIR/package.json" \
  && cmp -s "$KIT_RUNTIME/package-lock.json" "$RUNTIME_DIR/package-lock.json"; then
  echo "cloud-agent-setup: @firebase/app $PIN_APP, @firebase/auth $PIN_AUTH and @firebase/firestore $PIN_FIRESTORE are already installed in $RUNTIME_DIR; nothing to do"
  exit 0
fi

mkdir -p "$RUNTIME_DIR" || { echo "cloud-agent-setup: cannot create the runtime folder" >&2; exit 1; }
# copy both files in under temporary names first, then rename them into place
for f in package.json package-lock.json; do
  tmp="$RUNTIME_DIR/.$f.tmp.$$"
  if ! cp "$KIT_RUNTIME/$f" "$tmp" || ! mv -f "$tmp" "$RUNTIME_DIR/$f"; then
    rm -f "$tmp"
    echo "cloud-agent-setup: cannot copy $f into the runtime folder" >&2
    exit 1
  fi
done
if ! npm ci --prefix "$RUNTIME_DIR" --ignore-scripts --no-audit --no-fund >/dev/null 2>&1; then
  echo "cloud-agent-setup: npm ci failed; see npm's own log for the cause" >&2
  exit 1
fi

BAD=0
SUMMARY=""
for entry in $SDK_PINS; do
  name="${entry%%:*}"; pin="${entry#*:}"; have="$(installed_version "$name")"
  if [ "$have" != "$pin" ]; then
    echo "cloud-agent-setup: $name is $have, pinned $pin: the installed version does not match the pin" >&2
    BAD=1
  fi
  SUMMARY="$SUMMARY${SUMMARY:+, }$name $have"
done
echo "installed $SUMMARY into $RUNTIME_DIR"
[ "$BAD" -eq 0 ] || exit 1
exit 0
