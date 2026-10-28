#!/usr/bin/env bash
# cloud-agent-setup.sh: installs the Firebase SDK that agent-listen.cjs needs, into a runtime folder.
# The version is pinned below. Bump it deliberately, with the listener tested against the new version.
#
#   bash cloud-agent-setup.sh                 DRY RUN (the default): prints the plan, installs nothing
#   bash cloud-agent-setup.sh --apply         runs: npm install --prefix <runtime folder> firebase@<pinned version>
#   bash cloud-agent-setup.sh --runtime-dir <absolute path>   (default: $SPM_AGENT_RUNTIME_DIR, else $HOME/.spm-agent-runtime)
#   bash cloud-agent-setup.sh --help
#
# Nothing is written inside a git work tree: the runtime folder is refused when its parent is one.
# Exit codes: 0 ok (dry run or applied), 2 usage or a refused path, 1 the npm install failed or the installed version differs from the pin.
set -u

PINNED="12.4.0"
PACKAGE="firebase"

usage() {
  cat <<'USAGE'
usage: cloud-agent-setup.sh [--apply] [--runtime-dir <absolute path>] [--help]
  default: DRY RUN (prints the plan and the pinned version; installs nothing)
  --apply: installs firebase at the pinned version into the runtime folder, then prints the installed version
USAGE
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
  echo "DRY RUN: would install $PACKAGE@$PINNED into $RUNTIME_DIR with: npm install --prefix $RUNTIME_DIR $PACKAGE@$PINNED"
  echo "DRY RUN: nothing installed (add --apply to install)"
  exit 0
fi

# already at the pinned version: say so and leave npm alone
HAVE="$(node -p "require(process.argv[1] + '/node_modules/$PACKAGE/package.json').version" "$RUNTIME_DIR" 2>/dev/null)"
if [ "$HAVE" = "$PINNED" ]; then
  echo "cloud-agent-setup: $PACKAGE $PINNED is already installed in $RUNTIME_DIR; nothing to do"
  exit 0
fi

mkdir -p "$RUNTIME_DIR" || { echo "cloud-agent-setup: cannot create the runtime folder" >&2; exit 1; }
if ! npm install --prefix "$RUNTIME_DIR" "$PACKAGE@$PINNED" --no-audit --no-fund >/dev/null 2>&1; then
  echo "cloud-agent-setup: npm install failed; see npm's own log for the cause" >&2
  exit 1
fi
INSTALLED="$(node -p "require(process.argv[1] + '/node_modules/$PACKAGE/package.json').version" "$RUNTIME_DIR" 2>/dev/null)"
echo "installed $PACKAGE $INSTALLED into $RUNTIME_DIR (pinned $PINNED)"
[ "$INSTALLED" = "$PINNED" ] || { echo "cloud-agent-setup: installed version does not match the pin" >&2; exit 1; }
exit 0
