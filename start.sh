#!/usr/bin/env bash
# start.sh --config <abs path> [--state-dir <abs path>]
# Starts the SPM agent listener for one settings file (K-A3 item 3).
#   1. Runs agent-selfcheck.cjs. On a failure it prints the FAIL line (or the selfcheck's own message), exits 1,
#      and starts nothing.
#   2. On success it prints ONE line, {"kind":"start","log":"<state>/listener.log","version":"<v>"}, and runs
#      agent-keepalive.sh <state>/listener.log '<listener command>' in the foreground. The caller backgrounds it.
# State dir: --state-dir, else $SPM_AGENT_STATE_DIR, else $HOME/.spm-agent-state. It is created 700 and refused
# when it is inside a git work tree (a state folder must never be committed by accident).
# Version: the VERSION file next to this script (a plain version string), else "dev".
# Test-only overrides: SPM_AGENT_START_SELFCHECK_CMD and SPM_AGENT_START_LISTENER_CMD replace the two commands
# (run with bash -c). KEEPALIVE_MAX_RUNS is read by the wrapper and is for tests only.
# EXIT: 0 when the wrapper exits 0; 1 when the selfcheck fails; 2 for a usage error or a refused state dir.
set -u

KIT="$(cd "$(dirname "$0")" && pwd)"
CONFIG=""
STATE="${SPM_AGENT_STATE_DIR:-${HOME:-/nonexistent}/.spm-agent-state}"

usage() { echo "usage: start.sh --config <abs path> [--state-dir <abs path>]" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --config|--state-dir)
      if [ $# -lt 2 ] || [ -z "$2" ]; then usage; fi
      case "$2" in --*) usage ;; esac
      if [ "$1" = "--config" ]; then CONFIG="$2"; else STATE="$2"; fi
      shift 2 ;;
    *) usage ;;
  esac
done

case "$CONFIG" in /*) ;; *) echo "start.sh: --config needs an absolute path to the settings file" >&2; exit 2 ;; esac
case "$STATE" in /*) ;; *) echo "start.sh: the state dir must be an absolute path" >&2; exit 2 ;; esac
case "$STATE" in *\"*|*\\*) echo "start.sh: the state dir path may not contain a double quote or a backslash" >&2; exit 2 ;; esac

# Refuse a state dir inside a git work tree. Walk up to the nearest folder that exists (nothing is created yet).
PROBE="$STATE"
while [ ! -e "$PROBE" ] && [ "$PROBE" != "/" ]; do PROBE="$(dirname "$PROBE")"; done
if git -C "$PROBE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "start.sh: the state dir is inside a git work tree; choose a folder outside every repository" >&2
  exit 2
fi

# 1. Selfcheck. Its output is captured: on success only the start line is printed.
if [ -n "${SPM_AGENT_START_SELFCHECK_CMD:-}" ]; then
  SC_CMD="$SPM_AGENT_START_SELFCHECK_CMD"
else
  SC_CMD="node $(printf '%q' "$KIT/agent-selfcheck.cjs") --config $(printf '%q' "$CONFIG")"
fi
SC_ALL="$(bash -c "$SC_CMD" 2>&1)"
SC_RC=$?
if [ "$SC_RC" -ne 0 ]; then
  FAIL_LINES="$(printf '%s\n' "$SC_ALL" | grep '^FAIL ' || true)"
  if [ -n "$FAIL_LINES" ]; then printf '%s\n' "$FAIL_LINES"; else printf '%s\n' "$SC_ALL"; fi
  exit 1
fi

# 2. State dir (created 700), start line, then the restart wrapper in the foreground.
if ! (umask 077 && mkdir -p "$STATE"); then
  echo "start.sh: cannot create the state dir" >&2
  exit 2
fi

VER="dev"
if [ -r "$KIT/VERSION" ]; then
  V="$(head -n 1 "$KIT/VERSION")"
  case "$V" in
    ""|*[!A-Za-z0-9._-]*) ;;
    *) if [ "${#V}" -le 40 ]; then VER="$V"; fi ;;
  esac
fi

LOG="$STATE/listener.log"
printf '{"kind":"start","log":"%s","version":"%s"}\n' "$LOG" "$VER"

if [ -n "${SPM_AGENT_START_LISTENER_CMD:-}" ]; then
  L_CMD="$SPM_AGENT_START_LISTENER_CMD"
else
  L_CMD="node $(printf '%q' "$KIT/agent-listen.cjs") --config $(printf '%q' "$CONFIG") --inbox --cursor-file $(printf '%q' "$STATE/cursor.json") --mode stream"
fi
exec bash "$KIT/agent-keepalive.sh" "$LOG" "$L_CMD"
