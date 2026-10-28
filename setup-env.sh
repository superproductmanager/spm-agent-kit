#!/usr/bin/env bash
# setup-env.sh: the one-line setup. Writes what Claude needs into the user's own Claude folder.
#
#   bash "$HOME/spm-agent-kit/setup-env.sh" [--app-id <SPM app id>] [--name "<agent name>" --email <agent address>] [options]
#
#   --app-id <value>              optional (Addendum A1): the public SPM app id, 20 to 60 of A-Z a-z 0-9 _ - . Given: validated and written.
#                                 Not given: an app id already in the config is kept; agent-health.cjs start writes it from SPM otherwise.
#   --report on|off               optional (Addendum A4): off writes "report": false into the config (no health reports are sent); on (default) writes nothing
#   --autostart on|off            optional (Addendum B1): off writes "autostart": false into the config, writes no CLAUDE.md block,
#                                 and removes the kit's block if one is there (Addendum C1); on (default) writes nothing
#   --name <text>                 optional (0.2.0): the agent's name as people tag it, 1 to 60 of A-Z a-z 0-9, space, dot, brackets, hyphen.
#                                 Give it with --email. Without both, the agent is identified later by agent-health.cjs start.
#   --email <address>             optional (0.2.0): the agent's address: lower case, ending in @agents.invalid. Give it with --name.
#   --ignore-agent <name>         another agent whose comments are not tags for this one (repeatable, optional)
#   --transport node|webchannel   how the listener talks to Firestore (optional; default node)
#   --no-sdk                      do not install the Firebase SDK
#   --help
#
# Writes:
#   ~/.spm-agent-state/config.json        folder 0700, file 0600; rewritten on every run. An agent block already there is kept when
#                                         --name and --email are not given.
#   ~/.claude/skills/spm-agent/SKILL.md   copied from skill/spm-agent/SKILL.md, with the literal
#                                         /root/spm-agent-kit replaced by this kit folder and
#                                         /root/.spm-agent-state by $HOME/.spm-agent-state; replaced on every run
#   ~/.claude/settings.json               the seven allow rules (absolute, from this kit folder) merged in; other keys and rules kept;
#                                         written through a temp file in the same folder, then renamed; no change when already there
#   ~/.claude/CLAUDE.md                   (Addendum B1) the block from <kit>/hook/claude-md-block.md, between the lines
#                                         <!-- spm-agent-kit:start --> and <!-- spm-agent-kit:end -->; the two literal paths replaced;
#                                         created at 0600 if missing; a re-run replaces the block; text outside the markers is kept byte for byte
#                                         (Addendum C1: with --autostart off, no block is written and the kit's block is removed; no file is created)
#   ~/.spm-agent-state/setup-report.jsonl one line per step (config, skill, claude-md, settings, sdk), setup report spool (0.2.0)
#   ~/.spm-agent-state/report-salt        32 random lower-case hex, mode 0600, written once (Addendum A2); kept on every later run
# Then runs cloud-agent-setup.sh --apply (the Firebase SDK) unless --no-sdk, and agent-selfcheck.cjs --setup (its result never
# changes the exit code).
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
# The version the setup report carries: only a release number is valid there.
KIT_VERSION=""
if [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then KIT_VERSION="$VERSION"; fi

usage() {
  cat <<'USAGE'
usage: setup-env.sh [--app-id <value>] [--name <text> --email <address>] [--ignore-agent <name>]... [--transport node|webchannel] [--report on|off] [--autostart on|off] [--no-sdk] [--help]
  --app-id        optional: the public SPM app id, 20 to 60 of A-Z a-z 0-9 _ - (kept from the config when not given)
  --report        on (default) or off: off sends no health reports
  --autostart     on (default) or off: off turns the agent's automatic start off (no CLAUDE.md block is written, and the kit's block is removed)
  --name          optional: the agent's name as people tag it, 1 to 60 of A-Z a-z 0-9, space, dot, brackets, hyphen (give it with --email)
  --email         optional: the agent's address, lower case, ending in @agents.invalid (give it with --name)
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
REPORT=""
AUTOSTART=""
TRANSPORT=""
NAME_GIVEN=0
EMAIL_GIVEN=0
HAS_IGNORE=0
IGNORE_LIST=""
SDK=1

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --no-sdk) SDK=0; shift ;;
    --name|--email|--app-id|--ignore-agent|--transport|--report|--autostart)
      if [ $# -lt 2 ] || [ -z "$2" ] || [[ "$2" == --* ]]; then
        fail "$1 needs a value (see --help)"
      fi
      case "$2" in *$'\n'*) fail "$1 must be one line" ;; esac
      case "$1" in
        --name) NAME="$2"; NAME_GIVEN=1 ;;
        --email) EMAIL="$2"; EMAIL_GIVEN=1 ;;
        --app-id) APP_ID="$2" ;;
        --ignore-agent) HAS_IGNORE=1; IGNORE_LIST="$IGNORE_LIST$2"$'\n' ;;
        --transport) TRANSPORT="$2" ;;
        --report) REPORT="$2" ;;
        --autostart) AUTOSTART="$2" ;;
      esac
      shift 2
      ;;
    *) fail "unknown argument: $1 (see --help)" ;;
  esac
done

# 0.2.0: name and email are optional, but they come together.
HAS_AGENT=0
if [ "$NAME_GIVEN" -eq 1 ] || [ "$EMAIL_GIVEN" -eq 1 ]; then
  [ "$NAME_GIVEN" -eq 1 ] && [ "$EMAIL_GIVEN" -eq 1 ] || fail "--name and --email must be given together, or neither (see --help)"
  NAME="$(printf '%s' "$NAME" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -n "$NAME" ] || fail "--name is required and must not be blank (see --help)"
  NAME_RE='^[A-Za-z0-9 ._()-]{1,60}$'
  [[ "$NAME" =~ $NAME_RE ]] || fail "--name must be 1 to 60 letters, digits, spaces, dots, brackets or hyphens"
  [ -n "$EMAIL" ] || fail "--email is required (see --help)"
  EMAIL_RE='^[a-z0-9._-]+@agents\.invalid$'
  [[ "$EMAIL" =~ $EMAIL_RE ]] || fail "--email must be a lower-case address ending in @agents.invalid"
  HAS_AGENT=1
fi
HAS_APP=0
if [ -n "$APP_ID" ]; then
  APP_ID_RE='^[A-Za-z0-9_-]{20,60}$'
  [[ "$APP_ID" =~ $APP_ID_RE ]] || fail "--app-id must be 20 to 60 letters, digits, hyphens or underscores"
  HAS_APP=1
fi
case "$REPORT" in
  ""|on|off) ;;
  *) fail "--report must be on or off (see --help)" ;;
esac
case "$AUTOSTART" in
  ""|on|off) ;;
  *) fail "--autostart must be on or off (see --help)" ;;
esac
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

# Setup report spool (0.2.0): shared by the node steps below and by spool_setup. Only the setup report's own fields are written.
# A release number is needed for kit_version; without one, no line is written. No write failure reaches the caller.
SPOOL_JS="$(cat <<'JS'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } }
// The one run id of a setup run: reused while setup-run-id is younger than one hour, else a new one is written.
function runIdFor(dir) {
  const f = path.join(dir, 'setup-run-id');
  try {
    const st = fs.lstatSync(f);
    const v = st.isFile() ? fs.readFileSync(f, 'utf8').trim() : '';
    if (Date.now() - st.mtimeMs < 3600000 && /^[a-f0-9-]{8,64}$/.test(v)) return v;
  } catch (_) { /* none yet */ }
  const id = crypto.randomBytes(16).toString('hex');
  try {
    if (!isLink(f)) { fs.writeFileSync(f, id + '\n', { mode: 0o600 }); fs.chmodSync(f, 0o600); }
  } catch (_) { /* the id still goes into this run's lines */ }
  return id;
}
function spool(home, kitVersion, rec) {
  if (!/^\d+\.\d+\.\d+$/.test(kitVersion || '')) return;
  try {
    const dir = path.join(home, '.spm-agent-state');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'setup-report.jsonl');
    if (isLink(file)) return;
    const item = { id: crypto.randomBytes(16).toString('hex'), kind: 'setup', role: 'setup', run_id: runIdFor(dir), step: rec.step, status: rec.status };
    if (rec.code) item.code = rec.code;
    item.at = new Date().toISOString();
    item.kit_version = kitVersion;
    fs.appendFileSync(file, JSON.stringify(item) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (_) { /* a spool write never stops setup */ }
}
JS
)"

# The node step: checks the settings file and CLAUDE.md, then writes config, skill, CLAUDE.md and settings, and spools each step.
# It prints nothing on success. A refusal writes nothing and exits 2 (no spool line: nothing was set up).
MAIN_JS="$(cat <<'JS'
const e = process.env;
const KIT = e.SPM_SETUP_KIT;
const HOME = e.SPM_SETUP_HOME;
const KV = e.SPM_SETUP_KIT_VERSION || '';
const RULES = [
  `Bash(node ${KIT}/agent-reply.cjs *)`,
  `Bash(node ${KIT}/agent-ack.cjs *)`,
  `Bash(node ${KIT}/agent-resolve.cjs *)`,
  `Bash(node ${KIT}/agent-relay.cjs *)`,
  `Bash(node ${KIT}/agent-selfcheck.cjs *)`,
  `Bash(bash ${KIT}/start.sh *)`,
  `Bash(node ${KIT}/agent-health.cjs *)`,
];
const BLOCK_FILE = path.join(KIT, 'hook', 'claude-md-block.md');
const START_MARK = '<!-- spm-agent-kit:start -->';
const END_MARK = '<!-- spm-agent-kit:end -->';
function SPOOL(step, status, code) { spool(HOME, KV, { step, status, code }); }
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
  const claudeDir = path.join(HOME, '.claude');
  const settingsFile = path.join(claudeDir, 'settings.json');
  const configDir = path.join(HOME, '.spm-agent-state');
  const configFile = path.join(configDir, 'config.json');
  const skillDir = path.join(claudeDir, 'skills', 'spm-agent');

  // 1. settings: read and check first; a refusal writes nothing
  let st = null;
  try { st = fs.lstatSync(settingsFile); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  let obj = {};
  let mode = 0o600;
  let changed = st === null;
  // Addendum B1: the CLAUDE.md block is planned here too, so a refusal writes nothing.
  const cmFile = path.join(claudeDir, 'CLAUDE.md');
  let cmSt = null;
  try { cmSt = fs.lstatSync(cmFile); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  let cmRaw = '';
  let cmMode = 0o600;
  if (cmSt) {
    if (cmSt.isSymbolicLink()) refuse('~/.claude/CLAUDE.md is a symbolic link; refused, file untouched');
    if (!cmSt.isFile()) refuse('~/.claude/CLAUDE.md is not a plain file; refused, file untouched');
    cmMode = cmSt.mode & 0o777;
    cmRaw = fs.readFileSync(cmFile, 'utf8');
  }
  // Rework C1 (review fix): the effective autostart value, computed once. --autostart off is off; --autostart on is on;
  // no flag keeps the value already in the config (the same rule as the config step below).
  let oldAuto = null;
  try {
    const old = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (old && typeof old === 'object' && !Array.isArray(old) && typeof old.autostart === 'boolean') oldAuto = old.autostart;
  } catch (_) { /* no config yet, or not readable: nothing kept */ }
  const AUTOSTART_OFF = e.SPM_SETUP_AUTOSTART === 'off' || (e.SPM_SETUP_AUTOSTART !== 'on' && oldAuto === false);
  let cmBlock = null;
  if (!AUTOSTART_OFF) {
    try {
      cmBlock = fs.readFileSync(BLOCK_FILE, 'utf8')
        .split('/root/spm-agent-kit').join(KIT)
        .split('/root/.spm-agent-state').join(configDir);
    } catch (_) { cmBlock = null; }
  }
  let cmNew = null;
  if (AUTOSTART_OFF) {
    // Rework C1: remove the lines from the start marker through the end marker, inclusive; nothing else changes.
    if (cmSt !== null) {
      const nS = cmRaw.split(START_MARK).length - 1;
      const nE = cmRaw.split(END_MARK).length - 1;
      if (nS === 0 && nE === 0) {
        cmNew = cmRaw;
      } else if (nS === 1 && nE === 1 && cmRaw.indexOf(START_MARK) < cmRaw.indexOf(END_MARK)) {
        const a = cmRaw.indexOf(START_MARK);
        let b = cmRaw.indexOf(END_MARK) + END_MARK.length;
        if (cmRaw.charAt(b) === '\n') b += 1;
        cmNew = cmRaw.slice(0, a) + cmRaw.slice(b);
      } else {
        refuse('~/.claude/CLAUDE.md has unbalanced or repeated spm-agent-kit markers; refused, file untouched');
      }
    }
  } else if (cmBlock !== null) {
    const body = cmBlock.replace(/\n+$/, '');
    const core = START_MARK + '\n' + body + '\n' + END_MARK;
    const nS = cmRaw.split(START_MARK).length - 1;
    const nE = cmRaw.split(END_MARK).length - 1;
    if (nS === 0 && nE === 0) {
      cmNew = cmRaw + (cmRaw === '' ? '' : (cmRaw.endsWith('\n') ? '\n' : '\n\n')) + core + '\n';
    } else if (nS === 1 && nE === 1 && cmRaw.indexOf(START_MARK) < cmRaw.indexOf(END_MARK)) {
      const a = cmRaw.indexOf(START_MARK);
      const b = cmRaw.indexOf(END_MARK) + END_MARK.length;
      cmNew = cmRaw.slice(0, a) + core + cmRaw.slice(b);
    } else {
      refuse('~/.claude/CLAUDE.md has unbalanced or repeated spm-agent-kit markers; refused, file untouched');
    }
  }
  if (st) {
    if (st.isSymbolicLink()) refuse('~/.claude/settings.json is a symbolic link; refused, file untouched');
    if (!st.isFile()) refuse('~/.claude/settings.json is not a plain file; refused, file untouched');
    mode = st.mode & 0o777;
    let raw = fs.readFileSync(settingsFile, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    if (raw.trim() !== '') {
      try { obj = JSON.parse(raw); } catch { refuse('~/.claude/settings.json is not valid JSON; refused, file untouched'); }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) refuse('~/.claude/settings.json is not a JSON object; refused, file untouched');
  }
  const perms = obj.permissions === undefined ? {} : obj.permissions;
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) refuse('permissions in ~/.claude/settings.json is not an object; refused, file untouched');
  const allow = perms.allow === undefined ? [] : perms.allow;
  if (!Array.isArray(allow)) refuse('permissions.allow in ~/.claude/settings.json is not a list; refused, file untouched');
  const missing = RULES.filter((r) => !allow.includes(r));
  if (missing.length > 0) {
    perms.allow = allow.concat(missing);
    obj.permissions = perms;
    changed = true;
  }
  // 2. config: the agent block when --name and --email were given; else the one already there, if any
  let oldCfg = {};
  try {
    const old = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (old && typeof old === 'object' && !Array.isArray(old)) oldCfg = old;
  } catch (_) { /* no config yet, or not readable: nothing kept */ }
  let agent = null;
  if (e.SPM_SETUP_HAS_AGENT === '1') {
    agent = { name: e.SPM_SETUP_NAME, email: e.SPM_SETUP_EMAIL };
  } else if (oldCfg.agent && typeof oldCfg.agent === 'object' && !Array.isArray(oldCfg.agent)) {
    agent = oldCfg.agent;
  }
  const cfg = {};
  if (agent) cfg.agent = agent;
  if (e.SPM_SETUP_HAS_APP === '1') cfg.app_id = e.SPM_SETUP_APP_ID;
  else if (typeof oldCfg.app_id === 'string' && /^[A-Za-z0-9_-]{20,60}$/.test(oldCfg.app_id)) cfg.app_id = oldCfg.app_id;
  if (e.SPM_SETUP_HAS_IGNORE === '1') {
    const parts = e.SPM_SETUP_IGNORE.split('\n');
    parts.pop(); // the list ends with a newline
    cfg.ignore_agents = parts.map((s) => s.trim());
    if (cfg.ignore_agents.some((s) => s === '')) refuse('--ignore-agent must not be blank (see --help)');
  }
  if (e.SPM_SETUP_TRANSPORT) cfg.transport = e.SPM_SETUP_TRANSPORT;
  // Addendum A4: off writes false; on writes nothing; not given keeps the value already there.
  if (e.SPM_SETUP_REPORT === 'off') cfg.report = false;
  else if (e.SPM_SETUP_REPORT !== 'on' && typeof oldCfg.report === 'boolean') cfg.report = oldCfg.report;
  // Addendum B1: the same rule for autostart
  if (AUTOSTART_OFF) cfg.autostart = false;
  else if (e.SPM_SETUP_AUTOSTART !== 'on' && typeof oldCfg.autostart === 'boolean') cfg.autostart = oldCfg.autostart;
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(configDir, 0o700);
    writeAtomic(configFile, JSON.stringify(cfg, null, 2) + '\n', 0o600);
  } catch (err) { SPOOL('config', 'fail', 'write_failed'); throw err; }
  SPOOL('config', 'pass');

  // 3. skill: the two literal paths replaced
  try {
    const skillText = fs.readFileSync(path.join(KIT, 'skill', 'spm-agent', 'SKILL.md'), 'utf8')
      .split('/root/spm-agent-kit').join(KIT)
      .split('/root/.spm-agent-state').join(configDir);
    fs.mkdirSync(skillDir, { recursive: true });
    writeAtomic(path.join(skillDir, 'SKILL.md'), skillText, 0o644);
  } catch (err) { SPOOL('skill', 'fail', 'write_failed'); throw err; }
  SPOOL('skill', 'pass');

  // Addendum B1: the CLAUDE.md block. A missing block file is a fail line; the file is then left alone.
  const writeCm = (text) => {
    const cmTmp = path.join(claudeDir, '.CLAUDE.md.' + process.pid + '.tmp');
    try {
      fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(cmTmp, text, { mode: cmMode });
      fs.chmodSync(cmTmp, cmMode);
      fs.renameSync(cmTmp, cmFile);
    } catch (err) {
      try { fs.rmSync(cmTmp, { force: true }); } catch { /* nothing more to do */ }
      SPOOL('claude-md', 'fail', 'write_failed');
      throw err;
    }
  };
  if (AUTOSTART_OFF) {
    // Rework C1: write only when the block was there; a file with no block (or no file) is left alone.
    if (cmNew !== null && cmNew !== cmRaw) writeCm(cmNew);
    SPOOL('claude-md', 'skip', 'autostart_off');
  } else if (cmNew === null) {
    SPOOL('claude-md', 'fail', 'missing_claude_md_block');
  } else if (cmNew !== cmRaw || cmSt === null) {
    writeCm(cmNew);
    SPOOL('claude-md', 'pass');
  } else {
    SPOOL('claude-md', 'pass');
  }

  // Addendum A2: the salt for session keys, written once; every later run keeps it
  try {
    fs.writeFileSync(path.join(configDir, 'report-salt'), crypto.randomBytes(16).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
  } catch (_) { /* already there, or not writable: the salt is not needed by setup itself */ }

  // 4. settings: the merged text goes to a temp file in the same folder, then is renamed over the old one
  if (changed) {
    const text = JSON.stringify(obj, null, 2) + '\n';
    const tmp = path.join(claudeDir, '.settings.json.' + process.pid + '.tmp');
    try {
      fs.writeFileSync(tmp, text, { mode });
      fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, settingsFile);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
      SPOOL('settings', 'fail', 'write_failed');
      throw err;
    }
  }
  SPOOL('settings', 'pass');
} catch (err) {
  process.stderr.write('setup-env: could not write the settings files (' + (err.code || 'error') + ')\n');
  process.exit(1);
}
JS
)"
WRITE_JS="$SPOOL_JS
$MAIN_JS"

# One setup line from bash (the sdk step): spool_setup <step> <pass|fail|skip> [code]. Never stops setup.
SPOOL_CLI_JS="$SPOOL_JS
const e = process.env;
spool(e.SPM_SETUP_HOME, e.SPM_SETUP_KIT_VERSION || '', { step: e.SPM_SETUP_STEP, status: e.SPM_SETUP_STATUS, code: e.SPM_SETUP_CODE || '' });"
spool_setup() {
  SPM_SETUP_HOME="$HOME" SPM_SETUP_KIT_VERSION="$KIT_VERSION" SPM_SETUP_STEP="$1" SPM_SETUP_STATUS="$2" SPM_SETUP_CODE="${3:-}" \
    node -e "$SPOOL_CLI_JS" >/dev/null 2>&1 || true
}

# Steps config, skill, claude-md and settings (node), each spooled as it is done. A refusal exits 2 with nothing written.
SPM_SETUP_KIT="$KIT" SPM_SETUP_HOME="$HOME" SPM_SETUP_KIT_VERSION="$KIT_VERSION" \
  SPM_SETUP_HAS_AGENT="$HAS_AGENT" SPM_SETUP_NAME="$NAME" SPM_SETUP_EMAIL="$EMAIL" \
  SPM_SETUP_APP_ID="$APP_ID" SPM_SETUP_HAS_APP="$HAS_APP" SPM_SETUP_REPORT="$REPORT" SPM_SETUP_AUTOSTART="$AUTOSTART" SPM_SETUP_TRANSPORT="$TRANSPORT" SPM_SETUP_HAS_IGNORE="$HAS_IGNORE" \
  SPM_SETUP_IGNORE="$IGNORE_LIST" \
  node -e "$WRITE_JS"
RC=$?
if [ "$RC" -ne 0 ]; then
  exit "$RC"
fi

SDK_RC=0
if [ "$SDK" -eq 1 ]; then
  if bash "$KIT/cloud-agent-setup.sh" --apply >/dev/null 2>&1; then
    spool_setup sdk pass
  else
    SDK_RC=1
    spool_setup sdk fail sdk_failed
  fi
else
  spool_setup sdk skip
fi

# The setup check (no key needed). Its result never changes the exit code; its lines go to the spool only.
node "$KIT/agent-selfcheck.cjs" --setup --config "$HOME/.spm-agent-state/config.json" >/dev/null 2>&1 || true

# 0.2.1: with reports off nothing waits to be sent. The config this run wrote (or kept) says report false, so the setup
# report spool is removed now, after every step has run. With reports on the file is left as it is.
if node -e "let c; try { c = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')); } catch (_) { process.exit(1); } process.exit(c && c.report === false ? 0 : 1);" "$HOME/.spm-agent-state/config.json" >/dev/null 2>&1; then
  rm -f "$HOME/.spm-agent-state/setup-report.jsonl"
fi

if [ "$SDK_RC" -ne 0 ]; then
  echo "setup-env: the Firebase SDK step failed (run: bash \"$KIT/cloud-agent-setup.sh\" --apply to see why)" >&2
  exit 1
fi

if [ "$HAS_AGENT" -eq 1 ]; then
  echo "spm-agent-kit $VERSION: set up for $NAME"
else
  echo "spm-agent-kit $VERSION: set up; the agent's name and address come from SPM at first start"
fi
exit 0
