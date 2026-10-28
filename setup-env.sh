#!/usr/bin/env bash
# setup-env.sh: the one-line setup. Writes what Claude needs into the user's own Claude folder.
#
#   bash "$HOME/spm-agent-kit/setup-env.sh" --name "<agent name>" --email <agent address> --app-id <SPM app id> [options]
#
#   --name <text>                 the agent's name as people tag it, 1 to 60 of A-Z a-z 0-9, space, dot, brackets, hyphen (required)
#   --email <address>             the agent's address: lower case, ending in @agents.invalid (required)
#   --app-id <value>              the public SPM app id, 20 to 60 of A-Z a-z 0-9 _ - (required)
#   --ignore-agent <name>         another agent whose comments are not tags for this one (repeatable, optional)
#   --transport node|webchannel   how the listener talks to Firestore (optional; default node)
#   --no-sdk                      do not install the Firebase SDK
#   --help
#
# Writes:
#   ~/.spm-agent-state/config.json        folder 0700, file 0600; rewritten on every run
#   ~/.claude/skills/spm-agent/SKILL.md   copied from skill/spm-agent/SKILL.md, with the literal
#                                         /root/spm-agent-kit replaced by this kit folder and
#                                         /root/.spm-agent-state by $HOME/.spm-agent-state; replaced on every run
#   ~/.claude/settings.json               the six allow rules (absolute, from this kit folder) merged in;
#                                         other keys and rules kept; temp file in the same folder, then mv
# Then runs cloud-agent-setup.sh --apply (the Firebase SDK) unless --no-sdk.
#
# Exit codes: 0 set up
#             2 bad arguments, or a settings file that cannot be merged (nothing is written)
#             1 the SDK step or a write failed
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
usage: setup-env.sh --name <text> --email <address> --app-id <value> [--ignore-agent <name>]... [--transport node|webchannel] [--no-sdk] [--help]
  --name          the agent's name as people tag it: 1 to 60 of A-Z a-z 0-9, space, dot, brackets, hyphen (required)
  --email         the agent's address, lower case, ending in @agents.invalid (required)
  --app-id        the public SPM app id, 20 to 60 of A-Z a-z 0-9 _ - (required)
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
APP_ID=""
TRANSPORT=""
HAS_IGNORE=0
IGNORE_LIST=""
SDK=1

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --no-sdk) SDK=0; shift ;;
    --name|--email|--app-id|--ignore-agent|--transport)
      if [ $# -lt 2 ] || [ -z "$2" ] || [[ "$2" == --* ]]; then
        fail "$1 needs a value (see --help)"
      fi
      case "$2" in *$'\n'*) fail "$1 must be one line" ;; esac
      case "$1" in
        --name) NAME="$2" ;;
        --email) EMAIL="$2" ;;
        --app-id) APP_ID="$2" ;;
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
NAME_RE='^[A-Za-z0-9 ._()-]{1,60}$'
[[ "$NAME" =~ $NAME_RE ]] || fail "--name must be 1 to 60 letters, digits, spaces, dots, brackets or hyphens"
[ -n "$EMAIL" ] || fail "--email is required (see --help)"
EMAIL_RE='^[a-z0-9._-]+@agents\.invalid$'
[[ "$EMAIL" =~ $EMAIL_RE ]] || fail "--email must be a lower-case address ending in @agents.invalid"
[ -n "$APP_ID" ] || fail "--app-id is required (see --help)"
APP_ID_RE='^[A-Za-z0-9_-]{20,60}$'
[[ "$APP_ID" =~ $APP_ID_RE ]] || fail "--app-id must be 20 to 60 letters, digits, hyphens or underscores"
case "$TRANSPORT" in
  ""|node|webchannel) ;;
  *) fail "--transport must be node or webchannel" ;;
esac
if [ "$HAS_IGNORE" -eq 1 ]; then
  while IFS= read -r line; do
    trimmed="$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$trimmed" ] || fail "--ignore-agent must not be blank (see --help)"
  done <<< "${IGNORE_LIST%$'\n'}"
fi
[ -n "${HOME:-}" ] || fail "HOME is not set"
[ -f "$KIT/skill/spm-agent/SKILL.md" ] || { echo "setup-env: the kit has no skill/spm-agent/SKILL.md; nothing written" >&2; exit 1; }

CLAUDE_DIR="$HOME/.claude"
if [ ! -d "$CLAUDE_DIR" ]; then
  mkdir -m 0700 "$CLAUDE_DIR" || { echo "setup-env: cannot create $CLAUDE_DIR" >&2; exit 1; }
fi
# The settings temp file lives in the same folder, so the final mv is a rename.
SETTINGS_TMP="$(mktemp "$CLAUDE_DIR/.settings.json.XXXXXX")" || { echo "setup-env: cannot create a temporary settings file" >&2; exit 1; }

# Node checks the settings file first, then writes the config and the skill, and writes the merged settings
# into SETTINGS_TMP. It prints "write" when bash must move SETTINGS_TMP over settings.json, else "keep".
WRITE_JS="$(cat <<'JS'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const e = process.env;
const KIT = e.SPM_SETUP_KIT;
const HOME = e.SPM_SETUP_HOME;
const RULES = [
  `Bash(node ${KIT}/agent-reply.cjs *)`,
  `Bash(node ${KIT}/agent-ack.cjs *)`,
  `Bash(node ${KIT}/agent-resolve.cjs *)`,
  `Bash(node ${KIT}/agent-relay.cjs *)`,
  `Bash(node ${KIT}/agent-selfcheck.cjs *)`,
  `Bash(bash ${KIT}/start.sh *)`,
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
  const settingsFile = path.join(HOME, '.claude', 'settings.json');
  const configDir = path.join(HOME, '.spm-agent-state');
  const configFile = path.join(configDir, 'config.json');
  const skillDir = path.join(HOME, '.claude', 'skills', 'spm-agent');

  // 1. settings: read and check first; a refusal writes nothing
  let st = null;
  try { st = fs.lstatSync(settingsFile); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  let text = null;
  let mode = 0o600;
  if (st) {
    if (st.isSymbolicLink()) refuse('~/.claude/settings.json is a symbolic link; refused, file untouched');
    if (!st.isFile()) refuse('~/.claude/settings.json is not a plain file; refused, file untouched');
    mode = st.mode & 0o777;
    let raw = fs.readFileSync(settingsFile, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    let obj = {};
    if (raw.trim() !== '') {
      try { obj = JSON.parse(raw); } catch { refuse('~/.claude/settings.json is not valid JSON; refused, file untouched'); }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) refuse('~/.claude/settings.json is not a JSON object; refused, file untouched');
    const perms = obj.permissions === undefined ? {} : obj.permissions;
    if (!perms || typeof perms !== 'object' || Array.isArray(perms)) refuse('permissions in ~/.claude/settings.json is not an object; refused, file untouched');
    const allow = perms.allow === undefined ? [] : perms.allow;
    if (!Array.isArray(allow)) refuse('permissions.allow in ~/.claude/settings.json is not a list; refused, file untouched');
    const missing = RULES.filter((r) => !allow.includes(r));
    if (missing.length > 0) {
      perms.allow = allow.concat(missing);
      obj.permissions = perms;
      text = JSON.stringify(obj, null, 2) + '\n';
    }
  } else {
    text = JSON.stringify({ permissions: { allow: RULES } }, null, 2) + '\n';
  }

  // 2. config
  const cfg = { agent: { name: e.SPM_SETUP_NAME, email: e.SPM_SETUP_EMAIL }, app_id: e.SPM_SETUP_APP_ID };
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

  // 3. skill: the two literal paths replaced
  const skillText = fs.readFileSync(path.join(KIT, 'skill', 'spm-agent', 'SKILL.md'), 'utf8')
    .split('/root/spm-agent-kit').join(KIT)
    .split('/root/.spm-agent-state').join(configDir);
  fs.mkdirSync(skillDir, { recursive: true });
  writeAtomic(path.join(skillDir, 'SKILL.md'), skillText, 0o644);

  // 4. settings: the merged text goes to the temp file bash created; bash moves it into place
  if (text === null) {
    process.stdout.write('keep\n');
  } else {
    fs.writeFileSync(e.SPM_SETUP_SETTINGS_TMP, text, { mode });
    fs.chmodSync(e.SPM_SETUP_SETTINGS_TMP, mode);
    process.stdout.write('write\n');
  }
} catch (err) {
  process.stderr.write('setup-env: could not write the settings files (' + (err.code || 'error') + ')\n');
  process.exit(1);
}
JS
)"

PLAN="$(SPM_SETUP_KIT="$KIT" SPM_SETUP_HOME="$HOME" SPM_SETUP_NAME="$NAME" SPM_SETUP_EMAIL="$EMAIL" \
  SPM_SETUP_APP_ID="$APP_ID" SPM_SETUP_TRANSPORT="$TRANSPORT" SPM_SETUP_HAS_IGNORE="$HAS_IGNORE" \
  SPM_SETUP_IGNORE="$IGNORE_LIST" SPM_SETUP_SETTINGS_TMP="$SETTINGS_TMP" \
  node -e "$WRITE_JS")"
RC=$?
if [ "$RC" -ne 0 ]; then
  rm -f "$SETTINGS_TMP"
  exit "$RC"
fi
if [ "$PLAN" = "write" ]; then
  mv -f "$SETTINGS_TMP" "$CLAUDE_DIR/settings.json" || { rm -f "$SETTINGS_TMP"; echo "setup-env: could not move the settings file into place" >&2; exit 1; }
else
  rm -f "$SETTINGS_TMP"
fi

if [ "$SDK" -eq 1 ]; then
  if ! bash "$KIT/cloud-agent-setup.sh" --apply >/dev/null 2>&1; then
    echo "setup-env: the Firebase SDK step failed (run: bash \"$KIT/cloud-agent-setup.sh\" --apply to see why)" >&2
    exit 1
  fi
fi

echo "spm-agent-kit $VERSION: set up for $NAME"
exit 0
