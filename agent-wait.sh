#!/usr/bin/env bash
# agent-wait.sh: the listener session's wait (kit 0.2.1).
#
# USAGE: bash agent-wait.sh --log <absolute path> [--seconds N]
#
# Watches the listener log for lines written AFTER this script starts. It ends at the first new
# notice line, the first new FAIL line or fatal line, or at the timeout (default 7200 seconds, two hours).
# It prints one line, `agent-wait: notice`, `agent-wait: fail` or `agent-wait: timeout`, and never prints
# log content. Its end wakes the listener session, which then reads the log itself.
#
# EXIT: 0 notice; 3 fail; 124 timeout; 2 usage error (a relative or missing --log, a bad --seconds).
# Lines already in the log when the wait starts do not end it.
set -u

usage() { echo "usage: bash agent-wait.sh --log <absolute path> [--seconds N]" >&2; exit 2; }

LOG=""
SECONDS_LIMIT=7200
while [ $# -gt 0 ]; do
  case "$1" in
    --log)
      if [ $# -lt 2 ] || [ -z "$2" ]; then usage; fi
      case "$2" in --*) usage ;; esac
      LOG="$2"; shift 2 ;;
    --seconds)
      if [ $# -lt 2 ]; then usage; fi
      case "$2" in ''|*[!0-9]*) usage ;; esac
      if [ "$2" -lt 1 ]; then usage; fi
      SECONDS_LIMIT="$2"; shift 2 ;;
    *) usage ;;
  esac
done
case "$LOG" in
  /*) ;;
  *) usage ;;
esac

size_of() { if [ -f "$LOG" ]; then wc -c < "$LOG" | tr -d ' '; else echo 0; fi; }

OFFSET="$(size_of)"
DEADLINE=$(( $(date +%s) + SECONDS_LIMIT ))

while :; do
  NOW_SIZE="$(size_of)"
  # A log that shrank (rotated or cleared) is read from its start again.
  if [ "$NOW_SIZE" -lt "$OFFSET" ]; then OFFSET=0; fi
  if [ "$NOW_SIZE" -gt "$OFFSET" ]; then
    NEW="$(tail -c +"$((OFFSET + 1))" "$LOG" 2>/dev/null)"
    if printf '%s\n' "$NEW" | grep -q -E '"kind": ?"notice"'; then
      echo "agent-wait: notice"; exit 0
    fi
    if printf '%s\n' "$NEW" | grep -q -E 'FAIL|fatal'; then
      echo "agent-wait: fail"; exit 3
    fi
    OFFSET="$NOW_SIZE"
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "agent-wait: timeout"; exit 124
  fi
  sleep 1
done
