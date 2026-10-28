#!/usr/bin/env node
'use strict';
/**
 * agent-health.cjs: the agent's health reports to SPM (kit 0.2.0). Numbers only: counts, token totals, fixed words.
 * It never reads or sends conversation text, a person's name or address, a key, a token or the report salt.
 *
 *   node agent-health.cjs start --role main|listener --config <absolute path>
 *       Asks SPM whose key this is (GET /agent/self, key header only). Writes agent.name and agent.email, and app_id
 *       when the file has none, into the settings file; exits 5 when agent.name or agent.email differ. Stores SPM's
 *       report.on in the state folder (health.json). Then queues usage and sends the spool.
 *   node agent-health.cjs usage --role main|listener --config <absolute path> [--transcript <absolute path>]
 *       Queues one usage item per model for the newest session transcript, then sends the spool.
 *   node agent-health.cjs heartbeat --config <absolute path> [--main-status <word>] [--transcript <absolute path>]
 *       Queues one heartbeat item (listener.log lines since the last heartbeat, container and main-session changes), then sends.
 *   node agent-health.cjs flush --config <absolute path>
 *       Sends the spool only.
 *
 * SETTINGS FILE: the JSON file of lib/config.cjs. Read here: key_file, agent, app_id, report. A file without agent is fine.
 * "report": false in the file means nothing is sent at all (no network call); the local files are still written.
 * The state folder is SPM_AGENT_STATE_DIR, else $HOME/.spm-agent-state (see lib/report.cjs). It holds the spool
 * (setup-report.jsonl), the sent copy (health-sent.jsonl, Addendum A3), the salt for session keys (report-salt, A2),
 * health.json (state, and report.on from SPM, A4), and the listener log and main-session-id the heartbeat reads.
 * SPM: https://asia-south1-litethink.cloudfunctions.net/accountApi (override for tests: SPM_AGENT_API_BASE, 127.0.0.1 only).
 * EXIT CODES: 0 ok, or reports kept for later ("health: kept <n> for later"), or reports off; 2 bad arguments or settings
 * file, a queueing command with no kit VERSION file, or a bad report-salt; 5 the settings file names another agent than
 * this key's; 6 SPM refused the key. An unexpected failure exits 1.
 * Every line starts with "health:". A kit older than SPM's min_kit_version gets one warning line and still runs.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { keyMode, NO_PROXY_REFUSAL } = require(path.join(__dirname, 'lib', 'key-mode.cjs'));
const R = require(path.join(__dirname, 'lib', 'report.cjs'));

const AGENT_NAME_RE = /^[A-Za-z0-9 ._()-]{1,60}$/;
const AGENT_ADDRESS_RE = /^[a-z0-9._-]+@agents\.invalid$/;
const APP_ID_RE = /^[A-Za-z0-9_-]{20,60}$/;
const SALT_RE = /^[0-9a-f]{32}$/;
const MODEL_RE = /^claude-[a-z0-9.-]{1,60}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const MAX_NUMBER = 1e12;
const COMMANDS = ['start', 'usage', 'heartbeat', 'flush'];
const USAGE = 'usage: node agent-health.cjs start|usage --role main|listener --config <absolute path> [--transcript <absolute path>] | heartbeat --config <absolute path> [--main-status <word>] [--transcript <absolute path>] | flush --config <absolute path>';

// The command line. Reads nothing. { ok: true, ...fields } or { ok: false, error }.
function parseArgs(argv) {
  const bad = (error) => ({ ok: false, error });
  const cmd = argv[0];
  if (!COMMANDS.includes(cmd)) return bad('the first word must be start, usage, heartbeat or flush');
  const allowed = {
    start: ['--role', '--config', '--transcript'],
    usage: ['--role', '--config', '--transcript'],
    heartbeat: ['--config', '--main-status', '--transcript'],
    flush: ['--config'],
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
  if (v['--main-status'] !== undefined && (cmd !== 'heartbeat' || !R.MAIN_STATUSES.includes(v['--main-status']))) {
    return bad(cmd === 'heartbeat' ? '--main-status must be one of the listed words' : '--main-status is only for heartbeat');
  }
  if (v['--transcript'] !== undefined && !path.isAbsolute(v['--transcript'])) return bad('--transcript must be an absolute path');
  return { ok: true, cmd, config: v['--config'], role: v['--role'], mainStatus: v['--main-status'], transcript: v['--transcript'] };
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

// Asks SPM whose key this is. { kind: 'ok', name, address, appId, minKit, reportOn } | { kind: 'refused', status }
// | { kind: 'unreachable' }. Any answer that is not a valid identity counts as unreachable: nothing is written from it.
// app_id, min_kit_version and report are optional: a bad value is ignored. report.on false turns reports off.
async function identify({ base, key, timeoutMs }) {
  let r;
  try {
    r = await R.requestSpm({ base, pathname: '/agent/self', method: 'GET', headers: { 'X-SPM-API-Key': key }, timeoutMs });
  } catch (_) { return { kind: 'unreachable' }; }
  if (r.status === 401 || r.status === 403 || r.status === 404) return { kind: 'refused', status: r.status };
  if (r.status !== 200) return { kind: 'unreachable' };
  let j;
  try { j = JSON.parse(r.text); } catch (_) { return { kind: 'unreachable' }; }
  if (!j || typeof j.name !== 'string' || !AGENT_NAME_RE.test(j.name) || typeof j.address !== 'string' || !AGENT_ADDRESS_RE.test(j.address)) return { kind: 'unreachable' };
  const appId = typeof j.app_id === 'string' && APP_ID_RE.test(j.app_id) ? j.app_id : null;
  const minKit = typeof j.min_kit_version === 'string' && VERSION_RE.test(j.min_kit_version) ? j.min_kit_version : null;
  const reportOn = !(j.report && typeof j.report === 'object' && j.report.on === false);
  return { kind: 'ok', name: j.name, address: j.address, appId, minKit, reportOn };
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

// Reads a transcript and keeps only counts: per session, per model, the LAST line of each message id wins;
// <synthetic> and models outside the pattern are skipped; compact_boundary lines are counted with their preTokens.
// Text fields are never read. Returns { sessions: Map<sessionId, {models, compactions, preTokens}>, primary }.
function readTranscript(file) {
  const fallback = path.basename(file, '.jsonl');
  const sessions = new Map();
  const counts = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || typeof o !== 'object') continue;
    const sid = typeof o.sessionId === 'string' && o.sessionId ? o.sessionId : fallback;
    counts.set(sid, (counts.get(sid) || 0) + 1);
    let s = sessions.get(sid);
    if (!s) { s = { models: new Map(), compactions: 0, preTokens: 0 }; sessions.set(sid, s); }
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      s.compactions++;
      s.preTokens += cap(o.compactMetadata && o.compactMetadata.preTokens);
      continue;
    }
    const m = o.message;
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.model !== 'string') continue;
    if (m.model === '<synthetic>' || !MODEL_RE.test(m.model) || !m.usage || typeof m.usage !== 'object') continue;
    let ids = s.models.get(m.model);
    if (!ids) { ids = new Map(); s.models.set(m.model, ids); }
    const u = m.usage;
    ids.set(m.id, {
      input: cap(u.input_tokens), output: cap(u.output_tokens),
      cacheWrite: cap(u.cache_creation_input_tokens), cacheRead: cap(u.cache_read_input_tokens),
    });
  }
  let primary = fallback;
  let best = -1;
  for (const [sid, n] of counts) { if (n > best) { best = n; primary = sid; } }
  return { sessions, primary };
}

// Addendum A2: first 16 hex of sha256(salt + sessionId).
const sessionKey = (sid, salt) => crypto.createHash('sha256').update(salt + sid).digest('hex').slice(0, 16);

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

// One usage item per session and model (cumulative totals). The session's compactions go on its model with most calls.
function usageItems(parsed, role, meta, salt) {
  const items = [];
  for (const [sid, s] of parsed.sessions) {
    const rows = [...s.models].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([model, ids]) => {
      const t = { calls: ids.size, input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 };
      for (const u of ids.values()) {
        t.input_tokens += u.input; t.output_tokens += u.output;
        t.cache_write_tokens += u.cacheWrite; t.cache_read_tokens += u.cacheRead;
      }
      return { model, t };
    });
    if (rows.length === 0) continue;
    let target = 0;
    rows.forEach((x, i) => { if (x.t.calls > rows[target].t.calls) target = i; });
    rows.forEach((x, i) => {
      const numbers = {};
      for (const k of Object.keys(x.t)) numbers[k] = cap(x.t[k]);
      numbers.compactions = i === target ? cap(s.compactions) : 0;
      numbers.compaction_pre_tokens = i === target ? cap(s.preTokens) : 0;
      items.push({ kind: 'usage', role, ...meta, session_key: sessionKey(sid, salt), model: x.model, numbers });
    });
  }
  return items;
}

// Queues the usage items of one transcript. Returns how many were queued (0 when there is no transcript).
function queueUsage({ transcript, role, spool, meta, now, salt }) {
  if (!transcript) return 0;
  let parsed;
  try { parsed = readTranscript(transcript); } catch (_) { return 0; }
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
    if (o.kind === 'start') counts.starts++;
    else if (o.kind === 'listener.restart') counts.restarts++;
    else if (o.kind === 'listener.failing') counts.failing++;
  }
  return { counts, offset: start + lastNl + 1 };
}

// The one output line for a send. Unreachable: "health: kept <n> for later". Key refused: exit 6.
function finish(io, f, head) {
  if (f.keyRefused) { io.err(`health: SPM refused the key while sending; kept ${f.kept}`); return 6; }
  if (f.unreachable) { io.out(`health: kept ${f.kept} for later`); return 0; }
  const h = head ? `${head}; ` : '';
  io.out(`health: ${h}sent ${f.sent}, kept ${f.kept}${f.refused ? `, refused ${f.refused}` : ''}`);
  return 0;
}

// The one output line when nothing is sent. fromSpm: the off switch came from SPM's identify answer.
function offLine(io, detail, fromSpm) {
  io.out(`health: reports off${fromSpm ? ' from SPM' : ''}; nothing sent${detail ? `, ${detail}` : ''}`);
  return 0;
}

// Runs one command. deps: io { out, err }, env (default process.env), now () -> epoch ms. Returns the exit code.
async function main(argv, deps) {
  const io = deps.io;
  const env = deps.env || process.env;
  const now = deps.now ? deps.now() : Date.now();
  const p = parseArgs(argv);
  if (!p.ok) { io.err(`health: ${p.error}`); io.err(USAGE); return 2; }
  const rs = readSettings(p.config);
  if (rs.error) { io.err(`health: ${rs.error}; nothing changed`); return 2; }
  const c = rs.c;
  const home = env.HOME || os.homedir();
  const sdir = R.stateDir(env);
  const spool = path.join(sdir, 'setup-report.jsonl');
  const sentLog = path.join(sdir, 'health-sent.jsonl');
  const healthFile = path.join(sdir, 'health.json');
  const st = readHealth(healthFile);
  const kv = readKitVersion();
  const transcript = p.transcript || newestTranscript(home);
  const settingsOff = c.report === false;
  const storedOff = st !== null && st.reportOn === false;
  const offFromSpm = storedOff && !settingsOff;
  const metaOf = () => ({ at: new Date(now).toISOString(), kit_version: kv.version, node_version: process.version });
  const flushWith = (t) => R.flushSpool({ spoolFile: spool, base: t.base, key: t.key, kitVersion: kv.version || null, now, sentLog });

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
    const queued = queueUsage({ transcript, role: p.role, spool, meta: metaOf(), now, salt: sa.salt });
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
    if (!transcript) {
      const head = 'no session transcript yet; heartbeat not queued';
      return offNow ? offLine(io, head, offFromSpm) : finish(io, await flushWith(t), head);
    }
    const sid = readTranscript(transcript).primary;
    const item = {
      kind: 'heartbeat', role: 'listener', ...meta, session_key: sessionKey(sid, sa.salt),
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

  // start
  if (settingsOff) {
    const queued = queueUsage({ transcript, role: p.role, spool, meta: metaOf(), now, salt: sa.salt });
    return offLine(io, `usage queued ${queued}`, false);
  }
  const t = sendTarget(c, env);
  if (t.error) { io.err(`health: ${t.error}`); return 2; }
  const id = await identify({ base: t.base, key: t.key, timeoutMs: R.SEND_TIMEOUT_MS });
  if (id.kind === 'refused') { io.err(`health: SPM refused the key (status ${id.status}); nothing changed`); return 6; }
  if (id.kind === 'unreachable') {
    if (kv.version) queueUsage({ transcript, role: p.role, spool, meta: metaOf(), now, salt: sa.salt });
    io.out(`health: kept ${R.readSpool(spool).length} for later`);
    return 0;
  }
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
  const queued = kv.version ? queueUsage({ transcript, role: p.role, spool, meta: metaOf(), now, salt: sa.salt }) : 0;
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
    process.stderr.write('health: internal error; nothing more was sent\n');
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, readTranscript, usageItems, newestTranscript, readLogSince, versionOlder, sessionKey };
