'use strict';
// Reports to SPM (kit 0.2.0). One place for: the item rules (the field table of the wire contract), the spool file
// (one JSON item per line in <state>/setup-report.jsonl), and the one POST that sends a batch to SPM.
// agent-health.cjs builds usage and heartbeat items; the setup scripts write setup and check lines to the same spool.
// Items carry numbers, fixed words and ids only: a secret-shaped string in any text field refuses the item.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { findSecrets } = require('./secret-patterns.cjs');

const SPM_DEFAULT_BASE = 'https://asia-south1-litethink.cloudfunctions.net/accountApi';
const BATCH_MAX_ITEMS = 50;
const BATCH_MAX_BYTES = 16 * 1024;
const SEND_TIMEOUT_MS = 3000;
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_AHEAD_MS = 5 * 60 * 1000;
const MAX_NUMBER = 1e12;
const DETAIL_MAX = 200;

const KINDS = ['setup', 'check', 'heartbeat', 'usage'];
const ROLES = ['setup', 'main', 'listener'];
const STATUSES = ['pass', 'fail', 'skip'];
const MAIN_STATUSES = ['idle', 'working', 'blocked', 'review_ready', 'completed', 'failed', 'archived', 'unknown'];
const USAGE_NUMBERS = ['calls', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'compactions', 'compaction_pre_tokens'];
const HEARTBEAT_NUMBERS = ['listener_starts', 'listener_restarts', 'listener_failing', 'container_starts', 'main_changes', 'uptime_s'];

// Fields every kind may carry, and the extra fields each kind carries (the table in the wire contract).
const COMMON_FIELDS = ['id', 'kind', 'role', 'at', 'kit_version', 'node_version', 'code', 'detail'];
const KIND_FIELDS = {
  setup: ['run_id', 'step', 'status'],
  check: ['run_id', 'step', 'status'],
  heartbeat: ['session_key', 'main_status', 'numbers'],
  usage: ['session_key', 'model', 'numbers'],
};
const REQUIRED = {
  setup: ['run_id', 'step', 'status'],
  check: ['run_id', 'step', 'status'],
  heartbeat: ['session_key', 'numbers'],
  usage: ['session_key', 'model', 'numbers'],
};

const RE = {
  id: /^[a-f0-9-]{16,64}$/,
  at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/,
  kit_version: /^\d+\.\d+\.\d+$/,
  node_version: /^v\d+\.\d+\.\d+$/,
  run_id: /^[a-f0-9-]{8,64}$/,
  step: /^[a-z0-9-]{1,32}$/,
  code: /^[a-z0-9_]{1,64}$/,
  session_key: /^[a-f0-9]{16}$/,
  model: /^claude-[a-z0-9.-]{1,60}$/,
};

const fail = (error) => ({ ok: false, error });
const isInt = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_NUMBER;

// { ok: true } or { ok: false, error }. The error names a field, never a value. `now` is in epoch milliseconds.
function validateItem(item, now = Date.now()) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return fail('an item must be an object');
  if (!KINDS.includes(item.kind)) return fail('kind must be setup, check, heartbeat or usage');
  const allowed = new Set([...COMMON_FIELDS, ...KIND_FIELDS[item.kind]]);
  for (const k of Object.keys(item)) {
    if (!allowed.has(k)) return fail(`field ${String(k).slice(0, 40)} is not allowed for kind ${item.kind}`);
  }
  for (const k of ['id', 'role', 'at', 'kit_version', ...REQUIRED[item.kind]]) {
    if (item[k] === undefined) return fail(`${k} is required for kind ${item.kind}`);
  }
  if (typeof item.id !== 'string' || !RE.id.test(item.id)) return fail('id is not valid');
  if (!ROLES.includes(item.role)) return fail('role must be setup, main or listener');
  if (typeof item.at !== 'string' || !RE.at.test(item.at)) return fail('at must be ISO 8601 UTC with Z');
  const t = Date.parse(item.at);
  if (!Number.isFinite(t)) return fail('at is not a date');
  if (t < now - MAX_AGE_MS) return fail('at is older than 8 days');
  if (t > now + MAX_AHEAD_MS) return fail('at is more than 5 minutes ahead');
  if (typeof item.kit_version !== 'string' || !RE.kit_version.test(item.kit_version)) return fail('kit_version is not valid');
  if (item.node_version !== undefined && (typeof item.node_version !== 'string' || !RE.node_version.test(item.node_version))) return fail('node_version is not valid');
  if (item.code !== undefined && (typeof item.code !== 'string' || !RE.code.test(item.code))) return fail('code is not valid');
  if (item.detail !== undefined) {
    if (typeof item.detail !== 'string' || Array.from(item.detail).length > DETAIL_MAX) return fail(`detail must be text of at most ${DETAIL_MAX} characters`);
  }
  for (const v of Object.values(item)) {
    if (typeof v === 'string' && findSecrets(v).length > 0) return fail('a text field holds a secret-shaped string; nothing was written');
  }
  if (item.run_id !== undefined && (typeof item.run_id !== 'string' || !RE.run_id.test(item.run_id))) return fail('run_id is not valid');
  if (item.step !== undefined && (typeof item.step !== 'string' || !RE.step.test(item.step))) return fail('step is not valid');
  if (item.status !== undefined && !STATUSES.includes(item.status)) return fail('status must be pass, fail or skip');
  if (item.session_key !== undefined && (typeof item.session_key !== 'string' || !RE.session_key.test(item.session_key))) return fail('session_key is not valid');
  if (item.model !== undefined && (typeof item.model !== 'string' || !RE.model.test(item.model))) return fail('model is not valid');
  if (item.main_status !== undefined && !MAIN_STATUSES.includes(item.main_status)) return fail('main_status is not one of the listed words');
  if (item.numbers !== undefined) {
    const keys = item.kind === 'usage' ? USAGE_NUMBERS : HEARTBEAT_NUMBERS;
    if (!item.numbers || typeof item.numbers !== 'object' || Array.isArray(item.numbers)) return fail('numbers must be an object');
    for (const [k, v] of Object.entries(item.numbers)) {
      if (!keys.includes(k)) return fail(`numbers key ${String(k).slice(0, 40)} is not allowed for kind ${item.kind}`);
      if (!isInt(v)) return fail(`numbers.${k} must be a whole number from 0 to 10^12`);
    }
  }
  return { ok: true };
}

// Where the state folder is: SPM_AGENT_STATE_DIR, else $HOME/.spm-agent-state (the same rule as start.sh).
function stateDir(env = process.env) {
  return env.SPM_AGENT_STATE_DIR || path.join(env.HOME || '/nonexistent', '.spm-agent-state');
}

// Writes text to a file through a temp file in the same folder, then renames it. The file gets `mode`.
function writeFileAtomic(file, text, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

// Appends one item to the spool. Assigns id = crypto.randomUUID() unless the item already has one (setup scripts
// write their own). Returns { ok: true, id } or { ok: false, error } and writes nothing when the item is refused.
function queueItem(spoolFile, item, now = Date.now()) {
  const withId = { ...item, id: item.id === undefined ? crypto.randomUUID() : item.id };
  const v = validateItem(withId, now);
  if (!v.ok) return v;
  fs.mkdirSync(path.dirname(spoolFile), { recursive: true, mode: 0o700 });
  fs.appendFileSync(spoolFile, JSON.stringify(withId) + '\n', { mode: 0o600 });
  return { ok: true, id: withId.id };
}

// Every line of the spool: { raw, item } with item null when the line is not JSON. A missing file is an empty spool.
function readSpool(spoolFile) {
  if (!fs.existsSync(spoolFile)) return [];
  return fs.readFileSync(spoolFile, 'utf8').split('\n').filter((l) => l.trim().length > 0).map((raw) => {
    let item = null;
    try { item = JSON.parse(raw); } catch (_) { item = null; }
    return { raw, item: item && typeof item === 'object' && !Array.isArray(item) ? item : null };
  });
}

// The SPM base URL: SPM_AGENT_API_BASE when set (tests), else the production accountApi. A plain http base must be 127.0.0.1.
function spmBase(env = process.env) {
  const v = env.SPM_AGENT_API_BASE;
  if (!v) return SPM_DEFAULT_BASE;
  let u;
  try { u = new URL(v); } catch (_) { throw new Error('SPM_AGENT_API_BASE is not a URL'); }
  if (u.protocol === 'http:' && u.hostname !== '127.0.0.1') throw new Error('SPM_AGENT_API_BASE may be plain http only on 127.0.0.1');
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('SPM_AGENT_API_BASE must be http or https');
  return v.replace(/\/+$/, '');
}

// The proxy agent for https calls (the same rule as agent-resolve.cjs): only the proxy URL reaches the agent.
function proxyAgent() {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!p) return false;
  return new https.Agent({ proxyEnv: { HTTPS_PROXY: p } });
}

// One request to SPM. Resolves { status, text }; rejects with an Error whose message is a short code (ETIMEDOUT, ECONNREFUSED ...).
function requestSpm({ base, pathname, method = 'GET', headers = {}, body = null, timeoutMs = SEND_TIMEOUT_MS }) {
  const u = new URL(base.replace(/\/+$/, '') + pathname);
  const isHttps = u.protocol === 'https:';
  const lib = isHttps ? https : http;
  const data = body === null ? null : JSON.stringify(body);
  const h = { ...headers, accept: 'application/json', host: u.host };
  if (data !== null) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method,
      agent: isHttps ? proxyAgent() : false, headers: h,
    }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_REPLY_BYTES) { req.destroy(new Error('TOOBIG')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => reject(new Error('ECONNRESET')));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', (e) => reject(new Error(e && typeof e.code === 'string' ? e.code : 'ECONNRESET')));
    if (data !== null) req.write(data);
    req.end();
  });
}

// How many items, from index `from`, fit one batch: at most 50 items and a body of at most 16 KB.
function batchEnd(items, from) {
  let bytes = '{"reports":[]}'.length; let n = 0;
  for (let j = from; j < items.length && n < BATCH_MAX_ITEMS; j++) {
    const len = Buffer.byteLength(JSON.stringify(items[j].item)) + (n ? 1 : 0);
    if (bytes + len > BATCH_MAX_BYTES) break;
    bytes += len; n++;
  }
  return Math.max(1, n);
}

// Sends the spool to SPM in batches and removes what SPM took. Lines that fail the item rules, and batches SPM
// answers 400 to, are removed too (refused). A key refusal (401, 403, 404), a network failure, 429 or 5xx keeps
// the rest for later. Lines queued while the send was running stay. Returns
// { sent, refused, kept, keyRefused, unreachable }.
async function flushSpool({ spoolFile, base, key, kitVersion, now = Date.now(), timeoutMs = SEND_TIMEOUT_MS }) {
  const lines = readSpool(spoolFile);
  const removeRaw = new Set();
  let refused = 0;
  const ready = [];
  for (const l of lines) {
    if (!l.item) { refused++; removeRaw.add(l.raw); continue; }
    const item = { ...l.item };
    if (item.kit_version === undefined) item.kit_version = kitVersion;
    if (!validateItem(item, now).ok) { refused++; removeRaw.add(l.raw); continue; }
    ready.push({ raw: l.raw, item });
  }
  let sent = 0; let processed = 0; let keyRefused = false; let unreachable = false;
  while (processed < ready.length) {
    const n = batchEnd(ready, processed);
    const slice = ready.slice(processed, processed + n);
    let r;
    try {
      r = await requestSpm({ base, pathname: '/agent/reports', method: 'POST', headers: { 'X-SPM-API-Key': key }, body: { reports: slice.map((x) => x.item) }, timeoutMs });
    } catch (_) { unreachable = true; break; }
    if (r.status === 202) { sent += slice.length; }
    else if (r.status === 400) { refused += slice.length; }
    else if (r.status === 401 || r.status === 403 || r.status === 404) { keyRefused = true; break; }
    else { unreachable = true; break; }
    for (const x of slice) removeRaw.add(x.raw);
    processed += n;
  }
  if (removeRaw.size > 0 && fs.existsSync(spoolFile)) {
    const keep = readSpool(spoolFile).filter((l) => !removeRaw.has(l.raw)).map((l) => l.raw);
    writeFileAtomic(spoolFile, keep.length ? keep.join('\n') + '\n' : '', 0o600);
  }
  return { sent, refused, kept: ready.length - processed, keyRefused, unreachable };
}

module.exports = {
  SPM_DEFAULT_BASE, BATCH_MAX_ITEMS, BATCH_MAX_BYTES, SEND_TIMEOUT_MS, KINDS, ROLES, STATUSES, MAIN_STATUSES,
  USAGE_NUMBERS, HEARTBEAT_NUMBERS, validateItem, stateDir, writeFileAtomic, queueItem, readSpool, spmBase,
  requestSpm, batchEnd, flushSpool,
};
