#!/usr/bin/env bash
# agent-keepalive.sh <LOG> '<shell command>'
# Restart wrapper for the customer agent listener.
# Runs the command with bash -c forever. Its stdout is appended to LOG, its stderr to LOG.err.
# On every exit it appends {"kind":"listener.restart","t":"<ISO UTC>","exit_code":n,"delay_s":s} to LOG,
# waits delay_s, and runs again. delay_s is the wait that follows that line.
#
# Back-off: the wait starts at RESTART_DELAY_S (default 5). A run under KEEPALIVE_FAST_S (default 30 s)
# doubles the next wait, capped at RESTART_MAX_DELAY_S (default 300). A run of KEEPALIVE_LONG_S (default 60 s)
# or more resets the wait to the base. A run in between keeps the wait as it is.
#
# After 3 fast runs in a row, one listener.failing line is appended to LOG per streak, with last_err set to the
# last line of LOG.err (cut to 200 characters, JSON-escaped).
#
# KEEPALIVE_MAX_RUNS (tests only): stop after that many runs with exit 0.
#
# Once its lock is held (Addendum B4) the wrapper appends {"kind":"wrapper.start","t":"<ISO UTC>"} to LOG, once per wrapper.
# A wrapper that finds the lock held writes nothing.
#
# Single instance: the wrapper takes an exclusive flock on LOG.lock (next to LOG), held on fd 9 for its whole life.
# A second wrapper on the same LOG prints one line to stderr ("another wrapper already runs for <LOG>") and exits 0
# without starting the command. The lock is released when the wrapper exits, SIGTERM included. Fd 9 is closed in the
# command and in the back-off sleep (9>&-), so an orphaned child can never keep the lock after the wrapper dies.
# Without flock installed, one warning line is printed and the wrapper runs without a lock.
#
# EXIT: 2 usage (LOG or the command missing). Otherwise it runs until KEEPALIVE_MAX_RUNS is reached.
set -u
# Character-based cut for last_err; falls back to C silently if the locale is missing.
export LC_ALL=C.UTF-8

LOG="${1:-}"
CMD="${2:-}"
if [ -z "$LOG" ] || [ -z "$CMD" ]; then
  echo "usage: agent-keepalive.sh <LOG> '<shell command>'" >&2
  exit 2
fi

# Single-instance lock, see the header. fd 9 stays open for this wrapper's life.
LOCK="$LOG.lock"
if command -v flock >/dev/null 2>&1; then
  if ! ( : >> "$LOCK" ) 2>/dev/null; then
    echo "agent-keepalive: cannot open lock file $LOCK" >&2
    exit 1
  fi
  exec 9>> "$LOCK"
  if ! flock -n 9; then
    echo "agent-keepalive: another wrapper already runs for $LOG" >&2
    exit 0
  fi
else
  echo "agent-keepalive: flock not installed, running without a single-instance lock" >&2
fi

printf '{"kind":"wrapper.start","t":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"

ERR="$LOG.err"
BASE="${RESTART_DELAY_S:-5}"
MAX_DELAY="${RESTART_MAX_DELAY_S:-300}"
FAST_MS=$(( ${KEEPALIVE_FAST_S:-30} * 1000 ))
LONG_MS=$(( ${KEEPALIVE_LONG_S:-60} * 1000 ))
MAX_RUNS="${KEEPALIVE_MAX_RUNS:-0}"

# Milliseconds since the epoch (EPOCHREALTIME is seconds.microseconds; drop the separator).
now_ms() {
  local t="${EPOCHREALTIME//[!0-9]/}"
  echo $(( t / 1000 ))
}

iso_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

delay="$BASE"
runs=0
streak=0
alerted=0

# Stopping the wrapper (TERM, INT, HUP: a Monitor ending, a kill) stops the command's whole process group too,
# so no orphan listener keeps running next to the one the next start brings up. The command and the back-off
# sleep run in the background and are waited on, so a signal is handled at once, not after a sleep ends.
child=""
SETSID=""
if command -v setsid >/dev/null 2>&1; then SETSID="setsid"; fi
stop() {
  if [ -n "$child" ]; then
    if [ -n "$SETSID" ]; then kill -TERM -- "-$child" 2>/dev/null; fi
    kill -TERM "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  exit 143
}
trap stop TERM INT HUP

while :; do
  start=$(now_ms)
  $SETSID bash -c "$CMD" >> "$LOG" 2>> "$ERR" 9>&- &
  child=$!
  wait "$child"
  rc=$?
  child=""
  dur=$(( $(now_ms) - start ))
  runs=$((runs + 1))

  if [ "$dur" -ge "$LONG_MS" ]; then
    delay="$BASE"
  fi
  wait_s="$delay"
  if [ "$dur" -lt "$FAST_MS" ]; then
    streak=$((streak + 1))
    delay=$(( delay * 2 ))
    if [ "$delay" -gt "$MAX_DELAY" ]; then delay="$MAX_DELAY"; fi
  else
    streak=0
    alerted=0
  fi

  printf '{"kind":"listener.restart","t":"%s","exit_code":%d,"delay_s":%d}\n' "$(iso_utc)" "$rc" "$wait_s" >> "$LOG"

  if [ "$streak" -ge 3 ] && [ "$alerted" -eq 0 ]; then
    alerted=1
    last=$(tail -n 1 "$ERR" 2>/dev/null)
    last=$(printf '%s' "$last" | tr '\t' ' ' | tr -d '\000-\010\013-\037\177')
    last="${last:0:200}"
    last=$(printf '%s' "$last" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
    printf '{"kind":"listener.failing","t":"%s","restarts":%d,"last_err":"%s"}\n' "$(iso_utc)" "$streak" "$last" >> "$LOG"
  fi

  if [ "$MAX_RUNS" -gt 0 ] && [ "$runs" -ge "$MAX_RUNS" ]; then
    exit 0
  fi
  sleep "$wait_s" 9>&- &
  child=$!
  wait "$child"
  child=""
done
