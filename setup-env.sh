#!/usr/bin/env bash
# setup-env.sh: the one-line setup. Writes what Claude needs into the user's own Claude folder.
#
#   bash "$HOME/spm-agent-kit/setup-env.sh" --name "<agent name>" --email <agent address> [options]
#
#   --name <text>             the agent's name as people tag it, for example "Example agent" (required)
#   --email <address>         the agent's address: lower case, ending in @agents.invalid (required)
#   --ignore-agent <name>     another agent whose comments are not tags for this one (repeatable, optional)
#   --transport node|webchannel   how the listener talks to Firestore (optional; default node)
#   --no-sdk                  do not install the Firebase SDK
#   --help
#
# Writes:
#   ~/.spm-agent-state/config.json        folder 0700, file 0600; rewritten on every run
#   ~/.claude/skills/spm-agent/SKILL.md   copied from skill/spm-agent/SKILL.md; replaced on every run
#   ~/.claude/settings.json               the six spm-agent allow rules merged in; other keys and rules kept
# Then runs cloud-agent-setup.sh --apply (the Firebase SDK) unless --no-sdk.
#
# Exit codes: 0 set up
#             2 bad arguments, or a settings file that cannot be merged (nothing is written)
#             1 the SDK step or a copy failed
set -u
umask 077

KIT="$(cd "$(dirname "$0")" && pwd)"

VERSION="dev"
if [ -f "$KIT/VERSION" ]; then
  V="$(head -n 1 "$KIT/VERSION" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -n "$V" ] && VERSION="$V"
fi

usage() {
  cat <<'USAGE'
usage: setup-env.sh --name <text> --email <address> [--ignore-agent <name>]... [--transport node|webchannel] [--no-sdk] [--help]
  --name          the agent's name as people tag it (required)
  --email         the agent's address, lower case, ending in @agents.invalid (required)
  --ignore-agent  another agent whose comments are not tags for this one (repeatable)
  --transport     node (default) or webchannel
  --no-sdk        do not install the Firebase SDK
USAGE
}

fail() {
  echo "setup-env: $1" >&2
  exit 2
}

NAME=""
EMAIL=""
TRANSPORT=""
HAS_IGNORE=0
IGNORE_LIST=""
SDK=1

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --no-sdk) SDK=0; shift ;;
    --name|--email|--ignore-agent|--transport)
      if [ $# -lt 2 ] || [ -z "$2" ] || [[ "$2" == --* ]]; then
        fail "$1 needs a value (see --help)"
      fi
      case "$2" in *$'\n'*) fail "$1 must be one line" ;; esac
      case "$1" in
        --name) NAME="$2" ;;
        --email) EMAIL="$2" ;;
        --ignore-agent) HAS_IGNORE=1; IGNORE_LIST="$IGNORE_LIST$2"$'\n' ;;
        --transport) TRANSPORT="$2" ;;
      esac
      shift 2
      ;;
    *) fail "unknown argument: $1 (see --help)" ;;
  esac
done

NAME="$(printf '%s' "$NAME" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
[ -n "$NAME" ] || fail "--name is required and must not be blank (see --help)"
[ -n "$EMAIL" ] || fail "--email is required (see --help)"
EMAIL_RE='^[a-z0-9._-]+@agents\.invalid$'
[[ "$EMAIL" =~ $EMAIL_RE ]] || fail "--email must be a lower-case address ending in @agents.invalid"
case "$TRANSPORT" in
  ""|node|webchannel) ;;
  *) fail "--transport must be node or webchannel" ;;
esac
[ -n "${HOME:-}" ] || fail "HOME is not set"
[ -f "$KIT/skill/spm-agent/SKILL.md" ] || { echo "setup-env: the kit has no skill/spm-agent/SKILL.md; nothing written" >&2; exit 1; }

# Config and settings. Node validates the settings file first, so a refusal writes nothing.
WRITE_JS="$(cat <<'JS'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const e = process.env;
const RULES = [
  'Bash(node */spm-agent-kit/agent-reply.cjs *)',
  'Bash(node */spm-agent-kit/agent-ack.cjs *)',
  'Bash(node */spm-agent-kit/agent-resolve.cjs *)',
  'Bash(node */spm-agent-kit/agent-relay.cjs *)',
  'Bash(node */spm-agent-kit/agent-selfcheck.cjs *)',
  'Bash(bash */spm-agent-kit/start.sh *)',
];
function refuse(msg) {
  process.stderr.write('setup-env: ' + msg + '\n');
  process.exit(2);
}
function writeAtomic(file, text, mode) {
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.tmp');
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
    throw err;
  }
}
try {
  const home = e.SPM_SETUP_HOME;
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const configDir = path.join(home, '.spm-agent-state');
  const configFile = path.join(configDir, 'config.json');

  // 1. settings: read and check first
  let plan = null;
  let st = null;
  try { st = fs.statSync(settingsFile); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (!st) {
    plan = { text: JSON.stringify({ permissions: { allow: RULES } }, null, 2) + '\n', mode: 0o600 };
  } else {
    if (!st.isFile()) refuse('~/.claude/settings.json is not a plain file; refused, file untouched');
    let obj;
    try { obj = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { refuse('~/.claude/settings.json is not valid JSON; refused, file untouched'); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) refuse('~/.claude/settings.json is not a JSON object; refused, file untouched');
    const perms = obj.permissions === undefined ? {} : obj.permissions;
    if (!perms || typeof perms !== 'object' || Array.isArray(perms)) refuse('permissions in ~/.claude/settings.json is not an object; refused, file untouched');
    const allow = perms.allow === undefined ? [] : perms.allow;
    if (!Array.isArray(allow)) refuse('permissions.allow in ~/.claude/settings.json is not a list; refused, file untouched');
    const missing = RULES.filter((r) => !allow.includes(r));
    if (missing.length > 0) {
      perms.allow = allow.concat(missing);
      obj.permissions = perms;
      plan = { text: JSON.stringify(obj, null, 2) + '\n', mode: st.mode & 0o777 };
    }
  }

  // 2. config
  const cfg = { agent: { name: e.SPM_SETUP_NAME, email: e.SPM_SETUP_EMAIL } };
  if (e.SPM_SETUP_HAS_IGNORE === '1') {
    const parts = e.SPM_SETUP_IGNORE.split('\n');
    parts.pop(); // the list ends with a newline
    cfg.ignore_agents = parts.map((s) => s.trim());
    if (cfg.ignore_agents.some((s) => s === '')) refuse('--ignore-agent must not be blank (see --help)');
  }
  if (e.SPM_SETUP_TRANSPORT) cfg.transport = e.SPM_SETUP_TRANSPORT;
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(configDir, 0o700);
  writeAtomic(configFile, JSON.stringify(cfg, null, 2) + '\n', 0o600);

  // 3. settings, only when a rule is missing
  if (plan) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
    writeAtomic(settingsFile, plan.text, plan.mode);
  }
} catch (err) {
  process.stderr.write('setup-env: could not write the settings files (' + (err.code || 'error') + ')\n');
  process.exit(1);
}
JS
)"

SPM_SETUP_HOME="$HOME" SPM_SETUP_NAME="$NAME" SPM_SETUP_EMAIL="$EMAIL" \
SPM_SETUP_TRANSPORT="$TRANSPORT" SPM_SETUP_HAS_IGNORE="$HAS_IGNORE" SPM_SETUP_IGNORE="$IGNORE_LIST" \
  node -e "$WRITE_JS" || exit $?

# The skill: copied byte-for-byte, replaced on every run.
SKILL_DIR="$HOME/.claude/skills/spm-agent"
mkdir -p "$SKILL_DIR" || { echo "setup-env: cannot create $SKILL_DIR" >&2; exit 1; }
SKILL_TMP="$(mktemp "$SKILL_DIR/.SKILL.md.XXXXXX")" || { echo "setup-env: cannot create a temporary skill file" >&2; exit 1; }
if ! { cp "$KIT/skill/spm-agent/SKILL.md" "$SKILL_TMP" && chmod 0644 "$SKILL_TMP" && mv "$SKILL_TMP" "$SKILL_DIR/SKILL.md"; }; then
  rm -f "$SKILL_TMP"
  echo "setup-env: could not copy the skill to $SKILL_DIR" >&2
  exit 1
fi

if [ "$SDK" -eq 1 ]; then
  if ! bash "$KIT/cloud-agent-setup.sh" --apply >/dev/null 2>&1; then
    echo "setup-env: the Firebase SDK step failed (run: bash \"$KIT/cloud-agent-setup.sh\" --apply to see why)" >&2
    exit 1
  fi
fi

echo "spm-agent-kit $VERSION: set up for $NAME"
exit 0
