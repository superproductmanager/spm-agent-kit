#!/usr/bin/env node
'use strict';
/**
 * agent-health.cjs: the agent's health reports to SPM (kit 0.2.0). Numbers only: counts, token totals, fixed words.
 * It never reads or sends conversation text, a person's name or address, a key, a token or the report salt.
 *
 *   node agent-health.cjs start --role main|listener --config <absolute path>
 *       Asks SPM whose key this is (GET /agent/self, key header only; 10 s, two tries). Writes agent.name, agent.email
 *       and app_id (when the file has none) into the settings file; exits 5 when agent.name or agent.email differ.
 *       Stores SPM's settings.reports in the state folder (health.json). Then queues usage and sends the spool.
 *       Exits 7 when SPM cannot be reached ("could not reach SPM, run again"), 6 for a refused key or no valid name.
 *   node agent-health.cjs session-start --config <absolute path>
 *       Prints one line, "autostart on" or "autostart off". Local "autostart": false wins; SPM's settings.autostart
 *       decides otherwise. When SPM is not reached: the default (on) with " (SPM not reached, using the default)".
 *       Always exits 0, writes nothing but the reports-on state.
 *   node agent-health.cjs settings --config <absolute path> [--autostart on|off] [--reports on|off]
 *       Posts the given settings to SPM (key header only) and prints "settings: autostart <on|off>, reports <on|off>".
 *       Exits 6 for a refused key, 7 when SPM cannot be reached, 2 when no flag is given.
 *   node agent-health.cjs usage --role main|listener --config <absolute path> [--transcript <absolute path>]
 *       Queues one usage item per model and price tier for the newest session transcript, then sends the spool.
 *   node agent-health.cjs heartbeat --config <absolute path> [--main-status <word>] [--transcript <absolute path>]
 *       Queues one heartbeat item (listener.log lines since the last heartbeat, container and main-session changes), then sends.
 *   node agent-health.cjs flush --config <absolute path>
 *       Sends the spool only.
 *
 * SETTINGS FILE: the JSON file of lib/config.cjs. Read here: key_file, agent, app_id, report, autostart. A file without
 * agent is fine. "report": false means nothing is sent at all (no network call); the local files are still written.
 * The state folder is SPM_AGENT_STATE_DIR, else $HOME/.spm-agent-state (see lib/report.cjs). It holds the spool
 * (setup-report.jsonl), the rejected log, the sent copy (health-sent.jsonl), the salt for session keys (report-salt),
 * health.json (state, and reports from SPM), and the listener log and main-session-id the heartbeat reads.
 * SPM: https://asia-south1-litethink.cloudfunctions.net/accountApi (override for tests: SPM_AGENT_API_BASE, 127.0.0.1 only;
 * SPM_AGENT_IDENTIFY_TIMEOUT_MS shortens the 10 s identify timeout, for tests only).
 * EXIT CODES: 0 ok, or reports kept for later, or reports off; 2 bad arguments or settings file, a queueing command
 * with no kit VERSION file, or a bad report-salt; 5 the settings file names another agent than this key's; 6 SPM refused
 * the key or gave no valid identity; 7 SPM could not be reached (identify and settings). An unexpected failure exits 1.
 * Every line starts with "health:" except the session-start and settings lines. A kit older than SPM's min_kit_version
 * gets one warning line and still runs.
 * SESSION FILES (Addendum C2): usage, heartbeat and start read every file of the session: <projects>/<folder>/<id>.jsonl
 * in all folders and <folder>/<id>/subagents/*.jsonl. The id is --session <id> (8 to 64 letters, digits or dashes),
 * else the --transcript file's name, else the newest transcript's name.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { keyMode, NO_PROXY_REFUSAL } = require(path.join(__dirname, 'lib', 'key-mode.cjs'));
const R = require(path.join(__dirname, 'lib', 'report.cjs'));

const AGENT_NAME_RE = /^[A-Za-z0-9 ._()-]{1,60}$/;
const AGENT_ADDRESS_RE = /^[a-z0-9._-]+@agents\.invalid$/;
const APP_ID_RE = /^[A-Za-z0-9_-]{20,60}$/;
const SALT_RE = /^[0-9a-f]{32}$/;
const SESSION_RE = /^[A-Za-z0-9-]{8,64}$/;
const MODEL_RE = /^claude-[a-z0-9.-]{1,60}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const MAX_NUMBER = 1e12;
const LONG_TIER_TOKENS = 100000;
const IDENTIFY_TIMEOUT_MS = 10000;
const CALL_TRIES = 2;
const COMMANDS = ['start', 'usage', 'heartbeat', 'flush', 'session-start', 'settings'];
const USAGE = 'usage: node agent-health.cjs start|usage --role main|listener --config <absolute path> [--transcript <absolute path>] | heartbeat --config <absolute path> [--main-status <word>] [--transcript <absolute path>] | flush --config <absolute path> | session-start --config <absolute path> | settings --config <absolute path> [--autostart on|off] [--reports on|off]';
const COULD_NOT_REACH = 'could not reach SPM, run again';

// The command line. Reads nothing. { ok: true, ...fields } or { ok: false, error }.
function parseArgs(argv) {
  const bad = (error) => ({ ok: false, error });
  const cmd = argv[0];
  if (!COMMANDS.includes(cmd)) return bad('the first word must be start, usage, heartbeat, flush, session-start or settings');
  const allowed = {
    start: ['--role', '--config', '--transcript', '--session'],
    usage: ['--role', '--config', '--transcript', '--session'],
    heartbeat: ['--config', '--main-status', '--transcript', '--session'],
    flush: ['--config'],
    'session-start': ['--config'],
    settings: ['--config', '--autostart', '--reports'],
  }[cmd];
  const v = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!allowed.includes(a)) return bad(`unknown argument ${JSON.stringify(String(a).slice(0, 40))}`);
    if (Object.prototype.hasOwnProperty.call(v, a)) return bad(`${a} given twice`);
    if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) return bad(`${a} needs a value`);
    v[a] = argv[++i];
  }
  if (v['--config'] === undefined) return bad('--config <absolute path> is required');
  if (!path.isAbsolute(v['--config'])) return bad('--config must be an absolute path');
  if (cmd === 'start' || cmd === 'usage') {
    if (!['main', 'listener'].includes(v['--role'])) return bad('--role must be main or listener');
  }
  // B4: an unknown main status is reported as "unknown", not refused.
  const mainStatus = v['--main-status'] === undefined ? undefined : (R.MAIN_STATUSES.includes(v['--main-status']) ? v['--main-status'] : 'unknown');
  if (mainStatus !== undefined && cmd !== 'heartbeat') return bad('--main-status is only for heartbeat');
  if (v['--transcript'] !== undefined && !path.isAbsolute(v['--transcript'])) return bad('--transcript must be an absolute path');
  if (v['--session'] !== undefined && !SESSION_RE.test(v['--session'])) return bad('--session must be 8 to 64 letters, digits or dashes');
  const onOff = (name) => {
    if (v[name] === undefined) return { value: undefined };
    if (v[name] !== 'on' && v[name] !== 'off') return { error: `${name} must be on or off` };
    return { value: v[name] === 'on' };
  };
  let autostart; let reports;
  if (cmd === 'settings') {
    const a = onOff('--autostart'); if (a.error) return bad(a.error);
    const r = onOff('--reports'); if (r.error) return bad(r.error);
    autostart = a.value; reports = r.value;
    if (autostart === undefined && reports === undefined) return bad('settings needs --autostart on|off, --reports on|off, or both');
  }
  return { ok: true, cmd, config: v['--config'], role: v['--role'], mainStatus, transcript: v['--transcript'], session: v['--session'], autostart, reports };
}

// The settings file as a JSON object, or { error }. A link is refused: the file is rewritten in place.
function readSettings(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (_) { return { error: 'cannot read the settings file' }; }
  if (st.isSymbolicLink()) return { error: 'the settings file is a link' };
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return { error: 'the settings file is not valid JSON' }; }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { error: 'the settings file must hold a JSON object' };
  if (c.key_file !== undefined && (typeof c.key_file !== 'string' || !path.isAbsolute(c.key_file))) return { error: 'key_file must be an absolute path' };
  if (c.report !== undefined && typeof c.report !== 'boolean') return { error: 'report must be true or false' };
  if (c.autostart !== undefined && typeof c.autostart !== 'boolean') return { error: 'autostart must be true or false' };
  return { c, mode: st.mode & 0o777 };
}

// The key for SPM calls: the key file, or the cloud proxy's network-secret placeholder. { key } or { error }.
function resolveKey(c, env) {
  const mode = keyMode({ keyFile: c.key_file || null }, env);
  if (mode.mode === 'refused') return { error: NO_PROXY_REFUSAL };
  if (mode.mode === 'secret') return { key: mode.key };
  try {
    const k = fs.readFileSync(c.key_file, 'utf8').trim();
    if (!k) return { error: 'the key file is empty' };
    return { key: k };
  } catch (_) { return { error: 'cannot read the key file' }; }
}

// The key and the base URL for a send. { key, base } or { error }.
function sendTarget(c, env) {
  const kr = resolveKey(c, env);
  if (kr.error) return { error: kr.error };
  try { return { key: kr.key, base: R.spmBase(env) }; } catch (e) { return { error: e.message }; }
}

// The kit version from <kit>/VERSION, written by the installer. { version } or { error }.
function readKitVersion() {
  let text;
  try { text = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8'); } catch (_) { return { error: 'the kit VERSION file is missing; the installer writes it' }; }
  const v = text.split('\n')[0].trim();
  if (!VERSION_RE.test(v)) return { error: 'the kit VERSION file does not hold a version' };
  return { version: v };
}

// True when kit version a is older than b (both x.y.z).
function versionOlder(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] < pb[i]; }
  return false;
}

// One call to SPM with the key header only (no user email). Two tries on a network error, 429 or 5xx; a 4xx answer
// is returned at once. Resolves { status, text }, or null when SPM could not be reached.
async function callSpm({ base, key, method = 'GET', pathname, body = null, timeoutMs }) {
  for (let attempt = 1; attempt <= CALL_TRIES; attempt++) {
    let r;
    try {
      r = await R.requestSpm({ base, pathname, method, headers: { 'X-SPM-API-Key': key }, body, timeoutMs });
    } catch (_) { continue; }
    if (r.status === 429 || r.status >= 500) continue;
    return r;
  }
  return null;
}

const identifyTimeout = (env) => {
  const v = Number(env.SPM_AGENT_IDENTIFY_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : IDENTIFY_TIMEOUT_MS;
};

// Asks SPM whose key this is. { kind: 'ok', name, address, appId, minKit, reportOn, autostart }
// | { kind: 'refused', status } | { kind: 'unreachable' } | { kind: 'invalid' }.
// settings.reports false turns reports off; settings.autostart false turns autostart off (absent: on).
async function identify({ base, key, timeoutMs }) {
  const r = await callSpm({ base, key, pathname: '/agent/self', timeoutMs });
  if (!r) return { kind: 'unreachable' };
  if (r.status === 401 || r.status === 403 || r.status === 404) return { kind: 'refused', status: r.status };
  if (r.status !== 200) return { kind: 'invalid' };
  let j;
  try { j = JSON.parse(r.text); } catch (_) { return { kind: 'invalid' }; }
  if (!j || typeof j.name !== 'string' || !AGENT_NAME_RE.test(j.name) || typeof j.address !== 'string' || !AGENT_ADDRESS_RE.test(j.address)) return { kind: 'invalid' };
  const appId = typeof j.app_id === 'string' && APP_ID_RE.test(j.app_id) ? j.app_id : null;
  const minKit = typeof j.min_kit_version === 'string' && VERSION_RE.test(j.min_kit_version) ? j.min_kit_version : null;
  const settings = j.settings && typeof j.settings === 'object' ? j.settings : {};
  return {
    kind: 'ok', name: j.name, address: j.address, appId, minKit,
    reportOn: settings.reports !== false,
    autostart: settings.autostart !== false,
  };
}

// The newest *.jsonl directly under <home>/.claude/projects/<folder>/ (by mtime), or null.
function newestTranscript(home) {
  const root = path.join(home, '.claude', 'projects');
  let best = null;
  let folders;
  try { folders = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return null; }
  for (const d of folders) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files;
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, f.name);
      let mtime;
      try { mtime = fs.statSync(file).mtimeMs; } catch (_) { continue; }
      if (!best || mtime > best.mtime) best = { file, mtime };
    }
  }
  return best ? best.file : null;
}

const cap = (v) => (Number.isSafeInteger(v) && v >= 0 ? Math.min(v, MAX_NUMBER) : 0);

// C2: is `file` a regular file (not a link or a folder)? A file that cannot be stat'ed is not one.
const isRegularFile = (file) => { try { return fs.lstatSync(file).isFile(); } catch (_) { return false; } };
// C2: a sub-agent file lives in <folder>/<session id>/subagents/; its parent session id is that folder's name.
const parentOfSubagentFile = (file) => (path.basename(path.dirname(file)) === 'subagents' ? path.basename(path.dirname(path.dirname(file))) : null);

// C2: every file of one session, as [{ file, parent }]. Discovery needs a valid session id: every
// <home>/.claude/projects/<folder>/<id>.jsonl (regular files, all folders) and every regular *.jsonl directly in
// <folder>/<id>/subagents/ (parent = <id>). A transcript named by --transcript (or the newest one) is added too.
// Paths are de-duplicated. Returns [] when there is nothing to read.
function sessionFiles(home, sid, transcript) {
  const out = [];
  const seen = new Set();
  const add = (file, parent) => {
    const key = path.resolve(file);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file, parent });
  };
  if (sid && SESSION_RE.test(sid)) {
    const root = path.join(home, '.claude', 'projects');
    let folders = [];
    try { folders = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { folders = []; }
    const found = [];
    for (const d of folders) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      const main = path.join(dir, `${sid}.jsonl`);
      if (isRegularFile(main)) found.push({ file: main, parent: null });
      const sub = path.join(dir, sid, 'subagents');
      let subs = [];
      try { subs = fs.readdirSync(sub, { withFileTypes: true }); } catch (_) { subs = []; }
      for (const f of subs) { if (f.isFile() && f.name.endsWith('.jsonl')) found.push({ file: path.join(sub, f.name), parent: sid }); }
    }
    found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    for (const f of found) add(f.file, f.parent);
  }
  if (transcript) add(transcript, parentOfSubagentFile(transcript));
  return out;
}

// Reads each file line by line (never whole) and keeps only counts, as ONE result across all files. Per session: the
// LAST line of each message id wins (across files too); <synthetic> and models outside the pattern are skipped.
// compact_boundary lines are counted once per key: the line's uuid, or `${timestamp}|${preTokens}` without one (C2).
// A line from a sub-agent file counts under that file's parent session id; any other line under its own sessionId.
// A file that cannot be opened or read is skipped; the others still count.
// Each call gets a price tier: "long" when input + cache read + cache write tokens exceed 100,000, else "standard".
// Cache writes: the 5m and 1h breakdown when the line has it, else all of cache_creation_input_tokens is 5m (B5).
// Text fields are never read. Input: one path, or a list of paths or { file, parent }.
// Returns { sessions: Map<sessionId, {msgs, compactions, preTokens}>, primary }.
async function readTranscript(input) {
  const list = (Array.isArray(input) ? input : [input]).map((e) => (typeof e === 'string' ? { file: e, parent: null } : e));
  const sessions = new Map();
  const counts = new Map();
  for (const { file, parent } of list) {
    const fallback = parent || path.basename(file, '.jsonl');
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.closeSync(fs.openSync(file, 'r'));
    } catch (_) { continue; }
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    stream.on('error', () => rl.close());
    for await (const line of rl) {
      if (line.trim() === '') continue;
      let o;
      try { o = JSON.parse(line); } catch (_) { continue; }
      if (!o || typeof o !== 'object') continue;
      const sid = parent || (typeof o.sessionId === 'string' && o.sessionId ? o.sessionId : fallback);
      counts.set(sid, (counts.get(sid) || 0) + 1);
      let s = sessions.get(sid);
      if (!s) { s = { msgs: new Map(), compactions: 0, preTokens: 0, compactKeys: new Set() }; sessions.set(sid, s); }
      if (o.type === 'system' && o.subtype === 'compact_boundary') {
        const pre = cap(o.compactMetadata && o.compactMetadata.preTokens);
        const key = typeof o.uuid === 'string' && o.uuid ? `u:${o.uuid}` : `t:${o.timestamp}|${pre}`;
        if (!s.compactKeys.has(key)) { s.compactKeys.add(key); s.compactions++; s.preTokens += pre; }
        continue;
      }
      const m = o.message;
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.model !== 'string') continue;
      if (m.model === '<synthetic>' || !MODEL_RE.test(m.model) || !m.usage || typeof m.usage !== 'object') continue;
      const u = m.usage;
      const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
      const hasBreakdown = cc !== null && (cc.ephemeral_5m_input_tokens !== undefined || cc.ephemeral_1h_input_tokens !== undefined);
      const input = cap(u.input_tokens);
      const cacheRead = cap(u.cache_read_input_tokens);
      const cacheWriteAll = cap(u.cache_creation_input_tokens);
      s.msgs.set(m.id, {
        model: m.model,
        tier: input + cacheRead + cacheWriteAll > LONG_TIER_TOKENS ? 'long' : 'standard',
        input,
        output: cap(u.output_tokens),
        cacheRead,
        write5m: hasBreakdown ? cap(cc.ephemeral_5m_input_tokens) : cacheWriteAll,
        write1h: hasBreakdown ? cap(cc.ephemeral_1h_input_tokens) : 0,
      });
    }
  }
  let primary = list.length ? (list[0].parent || path.basename(list[0].file, '.jsonl')) : '';
  let best = -1;
  for (const [sid, n] of counts) { if (n > best) { best = n; primary = sid; } }
  return { sessions, primary };
}

// Addendum A2: first 16 hex of sha256(salt + sessionId).
const sessionKey = (sid, salt) => crypto.createHash('sha256').update(salt + sid).digest('hex').slice(0, 16);

// The salt when <state>/report-salt already holds a valid one, else null. Never creates it (settings uses this).
function readSaltIfValid(sdir) {
  try {
    const s = fs.readFileSync(path.join(sdir, 'report-salt'), 'utf8').trim();
    return SALT_RE.test(s) ? s : null;
  } catch (_) { return null; }
}

// The salt in <state>/report-salt (32 lower-case hex). Created 0600 when missing. { salt } or { error }.
function loadSalt(sdir) {
  const file = path.join(sdir, 'report-salt');
  const valid = (text) => { const s = text.trim(); return SALT_RE.test(s) ? { salt: s } : { error: 'report-salt is not valid' }; };
  try {
    return valid(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') return { error: 'cannot read report-salt' };
  }
  fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
  try {
    const fresh = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(file, fresh + '\n', { mode: 0o600, flag: 'wx' });
    return { salt: fresh };
  } catch (e) {
    if (e.code !== 'EEXIST') return { error: 'cannot create report-salt' };
    try { return valid(fs.readFileSync(file, 'utf8')); } catch (_) { return { error: 'cannot read report-salt' }; }
  }
}

// One usage item per session, model and price tier (cumulative totals). The session's compactions go on its
// (model, tier) group with most calls.
function usageItems(parsed, role, meta, salt) {
  const items = [];
  for (const [sid, s] of parsed.sessions) {
    const groups = new Map();
    for (const m of s.msgs.values()) {
      const key = `${m.model}\u0000${m.tier}`;
      let g = groups.get(key);
      if (!g) { g = { model: m.model, tier: m.tier, calls: 0, input: 0, output: 0, write5m: 0, write1h: 0, cacheRead: 0 }; groups.set(key, g); }
      g.calls++;
      g.input += m.input; g.output += m.output; g.write5m += m.write5m; g.write1h += m.write1h; g.cacheRead += m.cacheRead;
    }
    const rows = [...groups.values()].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : 0));
    if (rows.length === 0) continue;
    let target = 0;
    rows.forEach((g, i) => { if (g.calls > rows[target].calls) target = i; });
    rows.forEach((g, i) => {
      items.push({
        kind: 'usage', role, ...meta, session_key: sessionKey(sid, salt), model: g.model, price_tier: g.tier,
        numbers: {
          calls: cap(g.calls), input_tokens: cap(g.input), output_tokens: cap(g.output),
          cache_write_5m_tokens: cap(g.write5m), cache_write_1h_tokens: cap(g.write1h), cache_read_tokens: cap(g.cacheRead),
          compactions: i === target ? cap(s.compactions) : 0,
          compaction_pre_tokens: i === target ? cap(s.preTokens) : 0,
        },
      });
    });
  }
  return items;
}

// Queues the usage items of one transcript. Returns how many were queued (0 when there is no transcript).
async function queueUsage({ files, role, spool, meta, now, salt }) {
  if (!files || files.length === 0) return 0;
  let parsed;
  try { parsed = await readTranscript(files); } catch (_) { return 0; }
  let n = 0;
  for (const item of usageItems(parsed, role, meta, salt)) { if (R.queueItem(spool, item, now).ok) n++; }
  return n;
}

const readHealth = (file) => {
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8'));
    return h && typeof h === 'object' && !Array.isArray(h) ? h : null;
  } catch (_) { return null; }
};
const readBootId = () => {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch (_) { return null; }
};
const readMainId = (file) => {
  try { return fs.readFileSync(file, 'utf8').trim() || null; } catch (_) { return null; }
};

// Counts the listener.log lines after `offset` (bytes). A trailing line without its newline is left for next time.
// A log shorter than the offset was replaced, so it is read from the start. A missing log counts nothing.
// B4: a start is a {"kind":"wrapper.start"} line, written once the wrapper holds its lock.
function readLogSince(file, offset) {
  const counts = { starts: 0, restarts: 0, failing: 0 };
  let size;
  try { size = fs.statSync(file).size; } catch (_) { return { counts, offset: 0 }; }
  const start = offset > size ? 0 : offset;
  const len = size - start;
  if (len <= 0) return { counts, offset: start };
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { counts, offset: start };
  for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || typeof o !== 'object') continue;
    if (o.kind === 'wrapper.start') counts.starts++;
    else if (o.kind === 'listener.restart') counts.restarts++;
    else if (o.kind === 'listener.failing') counts.failing++;
  }
  return { counts, offset: start + lastNl + 1 };
}

// The output for a send. Rejected batches get their own line first. Unreachable: "health: kept <n> for later".
// Key refused: exit 6.
function finish(io, f, head) {
  if (f.keyRefused) { io.err(`health: SPM refused the key while sending; kept ${f.kept}`); return 6; }
  if (f.rejected > 0) io.out(`health: dropped ${f.rejected}: ${f.rejectedCodes.join(', ')}`);
  if (f.unreachable) { io.out(`health: kept ${f.kept} for later`); return 0; }
  const h = head ? `${head}; ` : '';
  io.out(`health: ${h}sent ${f.sent}, kept ${f.kept}${f.refused ? `, refused ${f.refused}` : ''}`);
  return 0;
}

// The one output line when nothing is sent. fromSpm: the off switch came from SPM's settings.
function offLine(io, detail, fromSpm) {
  io.out(`health: reports off${fromSpm ? ' from SPM' : ''}; nothing sent${detail ? `, ${detail}` : ''}`);
  return 0;
}

// session-start: one autostart line. Never fails; the default is on unless the settings file says autostart false.
async function sessionStart(argv, deps) {
  const io = deps.io;
  const env = deps.env || process.env;
  const i = argv.indexOf('--config');
  const configPath = i !== -1 ? argv[i + 1] : undefined;
  const fallbackLine = (on, note) => { io.out(`autostart ${on ? 'on' : 'off'}${note ? ` (${note})` : ''}`); return 0; };
  const NOTE = 'SPM not reached, using the default';
  if (!configPath || !path.isAbsolute(configPath)) return fallbackLine(true, NOTE);
  const rs = readSettings(configPath);
  if (rs.error) return fallbackLine(true, NOTE);
  const c = rs.c;
  // C1: a local autostart false is final. Nothing is called and nothing is said to SPM.
  if (c.autostart === false) return fallbackLine(false, null);
  if (c.report === false) return fallbackLine(true, null);
  const t = sendTarget(c, env);
  if (t.error) return fallbackLine(true, NOTE);
  const id = await identify({ base: t.base, key: t.key, timeoutMs: identifyTimeout(env) });
  if (id.kind !== 'ok') return fallbackLine(true, NOTE);
  try {
    const sdir = R.stateDir(env);
    const st = readHealth(path.join(sdir, 'health.json'));
    R.writeFileAtomic(path.join(sdir, 'health.json'), JSON.stringify({ ...(st || {}), reportOn: id.reportOn }) + '\n', 0o600);
  } catch (_) { /* the state folder is not writable: the answer is still printed */ }
  return fallbackLine(id.autostart, null);
}

// settings: posts the given keys to SPM and prints the answer. Local "report": false sends nothing.
async function settingsCommand(p, c, deps) {
  const io = deps.io;
  const env = deps.env || process.env;
  if (c.report === false) { io.out('settings: reports off in the settings file; nothing sent'); return 0; }
  const t = sendTarget(c, env);
  if (t.error) { io.err(`health: ${t.error}`); return 2; }
  const body = {};
  if (p.autostart !== undefined) body.autostart = p.autostart;
  if (p.reports !== undefined) body.reports = p.reports;
  // C5: the kit version, and the session key of the newest session when there is a session id and a salt already.
  const kv = readKitVersion();
  if (kv.version) body.kit_version = kv.version;
  const sid = path.basename(newestTranscript(env.HOME || os.homedir()) || '', '.jsonl');
  const salt = readSaltIfValid(R.stateDir(env));
  if (sid && SESSION_RE.test(sid) && salt) body.session_key = sessionKey(sid, salt);
  const r = await callSpm({ base: t.base, key: t.key, method: 'POST', pathname: '/agent/settings', body, timeoutMs: identifyTimeout(env) });
  if (!r) { io.err(`health: ${COULD_NOT_REACH}`); return 7; }
  if (r.status === 401 || r.status === 403 || r.status === 404) { io.err(`health: SPM refused the key (status ${r.status}); nothing changed`); return 6; }
  if (r.status < 200 || r.status >= 300) { io.err(`health: SPM refused the settings (status ${r.status}); nothing changed`); return 2; }
  let j;
  try { j = JSON.parse(r.text); } catch (_) { j = null; }
  const answer = j && typeof j === 'object' ? (j.settings && typeof j.settings === 'object' ? j.settings : j) : null;
  if (!answer || typeof answer.autostart !== 'boolean' || typeof answer.reports !== 'boolean') {
    io.err(`health: SPM's answer was not valid; run again`);
    return 7;
  }
  const sdir = R.stateDir(env);
  const st = readHealth(path.join(sdir, 'health.json'));
  R.writeFileAtomic(path.join(sdir, 'health.json'), JSON.stringify({ ...(st || {}), reportOn: answer.reports }) + '\n', 0o600);
  io.out(`settings: autostart ${answer.autostart ? 'on' : 'off'}, reports ${answer.reports ? 'on' : 'off'}`);
  return 0;
}

// Runs one command. deps: io { out, err }, env (default process.env), now () -> epoch ms. Returns the exit code.
async function main(argv, deps) {
  const io = deps.io;
  const env = deps.env || process.env;
  const now = deps.now ? deps.now() : Date.now();
  if (argv[0] === 'session-start') return sessionStart(argv, deps);
  const p = parseArgs(argv);
  if (!p.ok) { io.err(`health: ${p.error}`); io.err(USAGE); return 2; }
  const rs = readSettings(p.config);
  if (rs.error) { io.err(`health: ${rs.error}; nothing changed`); return 2; }
  const c = rs.c;
  if (p.cmd === 'settings') return settingsCommand(p, c, deps);
  const home = env.HOME || os.homedir();
  const sdir = R.stateDir(env);
  const spool = path.join(sdir, 'setup-report.jsonl');
  const sentLog = path.join(sdir, 'health-sent.jsonl');
  const rejectedLog = path.join(sdir, 'setup-report.rejected.jsonl');
  const healthFile = path.join(sdir, 'health.json');
  const st = readHealth(healthFile);
  const kv = readKitVersion();
  // C2: the session id is --session, else the --transcript name, else the newest transcript's name.
  const transcript = p.transcript || (p.session ? null : newestTranscript(home));
  const sessId = p.session || (transcript ? path.basename(transcript, '.jsonl') : null);
  const files = sessionFiles(home, sessId, transcript);
  const settingsOff = c.report === false;
  const storedOff = st !== null && st.reportOn === false;
  const offFromSpm = storedOff && !settingsOff;
  const metaOf = () => ({ at: new Date(now).toISOString(), kit_version: kv.version, node_version: process.version });
  const flushWith = (t) => R.flushSpool({ spoolFile: spool, base: t.base, key: t.key, kitVersion: kv.version || null, now, sentLog, rejectedLog });

  if (p.cmd === 'flush') {
    if (settingsOff || offFromSpm) return offLine(io, null, offFromSpm);
    const t = sendTarget(c, env);
    if (t.error) { io.err(`health: ${t.error}`); return 2; }
    return finish(io, await flushWith(t), null);
  }

  // Every command that queues items needs the salt; usage and heartbeat also need the kit version.
  const sa = loadSalt(sdir);
  if (sa.error) { io.err(`health: ${sa.error}; nothing queued`); return 2; }
  if ((p.cmd === 'usage' || p.cmd === 'heartbeat') && kv.error) { io.err(`health: ${kv.error}; nothing queued`); return 2; }

  if (p.cmd === 'usage') {
    const offNow = settingsOff || offFromSpm;
    let t = null;
    if (!offNow) { t = sendTarget(c, env); if (t.error) { io.err(`health: ${t.error}`); return 2; } }
    const queued = await queueUsage({ files, role: p.role, spool, meta: metaOf(), now, salt: sa.salt });
    if (offNow) return offLine(io, `usage queued ${queued}`, offFromSpm);
    return finish(io, await flushWith(t), `usage queued ${queued}`);
  }

  if (p.cmd === 'heartbeat') {
    const offNow = settingsOff || offFromSpm;
    let t = null;
    if (!offNow) { t = sendTarget(c, env); if (t.error) { io.err(`health: ${t.error}`); return 2; } }
    const bootId = readBootId();
    const fresh = !st || st.bootId !== bootId;
    const offsetIn = fresh ? 0 : (Number.isSafeInteger(st.logOffset) && st.logOffset >= 0 ? st.logOffset : 0);
    const log = readLogSince(path.join(sdir, 'listener.log'), offsetIn);
    const mainNow = readMainId(path.join(sdir, 'main-session-id'));
    const mainStored = fresh ? null : (typeof st.lastMainId === 'string' ? st.lastMainId : null);
    const meta = metaOf();
    const containerStartedAt = fresh ? meta.at : (typeof st.containerStartedAt === 'string' ? st.containerStartedAt : meta.at);
    const started = Date.parse(containerStartedAt);
    const uptime = fresh || !Number.isFinite(started) ? 0 : Math.max(0, Math.floor((now - started) / 1000));
    if (files.length === 0) {
      const head = 'no session transcript yet; heartbeat not queued';
      return offNow ? offLine(io, head, offFromSpm) : finish(io, await flushWith(t), head);
    }
    const sid = (await readTranscript(files)).primary;
    // B4: the id is fixed by the salt, the boot id and the log offsets, so a retry after a crash is a duplicate.
    const id = crypto.createHash('sha256').update(sa.salt + (bootId || '') + String(offsetIn) + String(log.offset)).digest('hex').slice(0, 64);
    const item = {
      id, kind: 'heartbeat', role: 'listener', ...meta, session_key: sessionKey(sid, sa.salt),
      numbers: {
        listener_starts: log.counts.starts, listener_restarts: log.counts.restarts, listener_failing: log.counts.failing,
        container_starts: fresh ? 1 : 0, main_changes: mainNow !== null && mainNow !== mainStored ? 1 : 0, uptime_s: uptime,
      },
    };
    if (p.mainStatus) item.main_status = p.mainStatus;
    const q = R.queueItem(spool, item, now);
    if (!q.ok) { io.err(`health: ${q.error}; nothing queued`); return 1; }
    R.writeFileAtomic(healthFile, JSON.stringify({
      ...(st || {}), bootId, containerStartedAt, logOffset: log.offset, lastMainId: mainNow !== null ? mainNow : mainStored,
    }) + '\n', 0o600);
    if (offNow) return offLine(io, 'heartbeat queued', offFromSpm);
    return finish(io, await flushWith(t), 'heartbeat queued');
  }

  // start: always identifies (the agent name and address are needed even with reports off); local report off only
  // decides that nothing is sent or queued after identify.
  const t = sendTarget(c, env);
  if (t.error) { io.err(`health: ${t.error}`); return 2; }
  const id = await identify({ base: t.base, key: t.key, timeoutMs: identifyTimeout(env) });
  if (id.kind === 'refused') { io.err(`health: SPM refused the key (status ${id.status}); nothing changed`); return 6; }
  if (id.kind === 'unreachable') { io.err(`health: ${COULD_NOT_REACH}`); return 7; }
  if (id.kind === 'invalid') { io.err(`health: SPM's answer is not a valid agent identity; nothing changed`); return 6; }
  const agent = c.agent;
  if (agent !== undefined && (!agent || typeof agent !== 'object' || Array.isArray(agent) ||
      (agent.name !== undefined && typeof agent.name !== 'string') || (agent.email !== undefined && typeof agent.email !== 'string'))) {
    io.err('health: the agent entry in the settings file is not valid; nothing changed');
    return 2;
  }
  if (agent && ((agent.name !== undefined && agent.name !== id.name) || (agent.email !== undefined && agent.email !== id.address))) {
    io.err(`health: the settings file names another agent than this key's agent "${id.name}"; nothing changed`);
    return 5;
  }
  const next = { ...c };
  let changed = false;
  if (!agent || agent.name !== id.name || agent.email !== id.address) {
    next.agent = { ...(agent || {}), name: id.name, email: id.address };
    changed = true;
  }
  if (id.appId && c.app_id === undefined) { next.app_id = id.appId; changed = true; }
  if (changed) R.writeFileAtomic(p.config, JSON.stringify(next, null, 2) + '\n', rs.mode);
  R.writeFileAtomic(healthFile, JSON.stringify({ ...(st || {}), reportOn: id.reportOn }) + '\n', 0o600);
  if (id.minKit && kv.version && versionOlder(kv.version, id.minKit)) {
    io.out(`health: warning: kit ${kv.version} is older than the minimum ${id.minKit} that SPM asks for`);
  }
  if (settingsOff) { io.out(`health: identified ${id.name}; reports off; nothing sent`); return 0; }
  const queued = kv.version ? await queueUsage({ files, role: p.role, spool, meta: metaOf(), now, salt: sa.salt }) : 0;
  if (!id.reportOn) return offLine(io, `identified ${id.name}; usage queued ${queued}`, true);
  const head = `identified ${id.name}` + (kv.version ? '' : '; kit VERSION missing, usage not queued');
  return finish(io, await flushWith(t), head);
}

function realDeps() {
  return {
    io: { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') },
    env: process.env,
    now: () => Date.now(),
  };
}

if (require.main === module) {
  main(process.argv.slice(2), realDeps()).then((code) => { process.exitCode = code; }, () => {
    if (process.argv[2] === 'session-start') { process.stdout.write('autostart on (SPM not reached, using the default)\n'); process.exitCode = 0; return; }
    process.stderr.write('health: internal error; nothing more was sent\n');
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, readTranscript, usageItems, newestTranscript, readLogSince, versionOlder, sessionKey };
