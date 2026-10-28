#!/usr/bin/env node
'use strict';
/**
 * agent-reply.cjs: post ONE reply to a comment, or ONE new top-level comment, as the agent named in a settings file.
 * No lookup is needed by the caller: the script finds the thread root of --to itself, then posts.
 *
 *   node agent-reply.cjs --config <absolute path to settings file> (--document <uuid> | --map <uuid> | --task <uuid>) --to <comment_id> (--text "<text>" | --text-file <absolute path>) [--dry-run]
 *   node agent-reply.cjs --config <absolute path to settings file> (--document <uuid> | --map <uuid> | --task <uuid>) --new (--text "<text>" | --text-file <absolute path>) [--dry-run]
 *   node agent-reply.cjs --selftest     OFFLINE: a local http server stands in for the API; no network call, no real key is read.
 *
 * ITEMS. Give EXACTLY one of --document, --task or --map. --document is a document comment, --task a task comment, --map a map comment.
 * --to is the comment id. --new posts a top-level comment on the item instead of a reply (--new cannot take --to; it works on a document, a task or a map).
 *
 * SETTINGS FILE. --config <path>, or the environment variable SPM_AGENT_CONFIG. The file is JSON:
 *   { "agent": { "name": "Example agent", "email": "spm-example-agent@agents.invalid" }, "key_file": "/abs/path/example-agent.key" }
 * The key is read from key_file. It is sent only as the X-SPM-API-Key header; it is never printed, logged or saved.
 * A missing, unreadable or invalid settings file stops the run with one line on stderr and exit 2.
 *
 * TEXT. A text over 600 characters (counted as Unicode code points, as posted) is refused with exit 2 before anything is sent.
 * A text that looks like a secret is refused with exit 2 and nothing is sent: every key shape in lib/secret-patterns.txt (no allowlist applies here), plus the reply-only checks (short sk-/ghp_/AKIA/sbp_/spm_k_/AIza forms, a JWT, a run of 40 or more hex characters, or X-SPM-API-Key / Bearer followed by a token).
 *
 * DOCUMENT FLOW. (a) POST documentsApi/listDocumentComments { documentId } with the key and address headers; the comment list carries parent_id.
 * The root of --to is its parent_id when it is a reply, else itself. Replies are one level deep, so the script never posts under a reply.
 * (b) POST documentsApi/createDocumentComment { documentId, body, parent_id: <root> } with the headers Origin, X-SPM-API-Key and X-SPM-User-Email.
 *
 * BOARD AND MAP FLOW (same steps, other routes): (a) GET boardsApi/tasks/<task id>/comments (--task) or GET mapsApi/maps/<map id>/comments (--map),
 * with the key and address headers only; the root of --to is its parent_id, else itself; --to must be in that list (exit 1 otherwise).
 * (b) POST the same path with Origin, X-SPM-API-Key and X-SPM-User-Email and the body { body, parent_id: <root> }; the reply is { comment: { id, ... } }.
 * The log line carries "task" or "map" where a document line carries "document".
 *
 * NEW MODE: the same create call with parent_id null (no lookup, no --to). A task or map posts { body, parent_id: null } to its comments route.
 * --dry-run prints what would be posted and sends nothing. The success line of --new ends with the full id of the new comment.
 *
 * IDEMPOTENCE AND SPACING. The state file <state dir>/state.json holds, per agent name, root and text hash, the last attempt.
 * An identical second post within 10 minutes is refused (exit 3) and the earlier comment id is printed. An attempt whose outcome is unknown
 * (a network error or a crash) is refused the same way, without an id, because the comment may exist. A definite non-200 clears the entry, so a retry is allowed.
 * Two posts of one agent are at least 3.2 s apart; a second process waits behind the first.
 *
 * LOG. Every attempt appends one JSON line to <state dir>/log.jsonl: IST time, agent name, item, comment id, text sha256 (never the text), mode, HTTP status, new comment id, outcome.
 * The state dir is ~/.claude/agent-reply-state.
 *
 * OUTPUT. Success prints one plain line on stdout: "posted <new id> under <root>" (or "posted new top-level comment on <item>: <id>" with --new).
 * The first non-200 or network error stops the run (exit 1) with the reason on stderr and no automatic retry.
 * EXIT CODES: 0 posted (or dry-run ok); 1 stopped (lookup, HTTP or network failure, comment not found); 2 usage, settings or refused text; 3 duplicate within 10 minutes.
 * Only Node built-ins are used.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { loadConfig, ConfigError } = require(path.join(__dirname, 'lib', 'config.cjs'));
const { keyMode, NETWORK_SECRET_VALUE } = require(path.join(__dirname, 'lib', 'key-mode.cjs')); // K-A3 item 1
const { findSecrets } = require(path.join(__dirname, 'lib', 'secret-patterns.cjs')); // the one key-shape list, shared with the repo scan

const FN_HOST = 'asia-south1-litethink.cloudfunctions.net';
const ORIGIN = 'https://app.superproductmanager.ai';
const GAP_MS = 3200;
const DUP_WINDOW_MS = 10 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ITEM_PATH_RE = new RegExp('^/(?:boardsApi/tasks|mapsApi/maps)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/comments$');
const USAGE = 'usage: node agent-reply.cjs --config <absolute path> (--document <uuid> | --map <uuid> | --task <uuid>) --to <comment_id> (--text "<text>" | --text-file <absolute path>) [--dry-run]  |  node agent-reply.cjs --config <absolute path> (--document <uuid> | --map <uuid> | --task <uuid>) --new (--text "<text>" | --text-file <absolute path>) [--dry-run]  |  node agent-reply.cjs --selftest (--config may also be set through SPM_AGENT_CONFIG; --new posts a top-level comment and takes no --to; a text over 600 characters is refused)';
const MAX_REPLY_BYTES = 16 * 1024 * 1024;
const TEXT_LIMIT = 600; // characters (Unicode code points), the standing comment format
const KEY_PATTERNS = [
  ['sk-', /\bsk-[A-Za-z0-9_-]{8,}/],
  ['ghp_', /\bghp_[A-Za-z0-9]{8,}/],
  ['AKIA', /\bAKIA[0-9A-Z]{12,}/],
  ['sbp_', /\bsbp_[A-Za-z0-9]{8,}/],
  ['spm_k_', /\bspm_k_[A-Za-z0-9_-]{4,}/],
  ['AIza', /\bAIza[0-9A-Za-z_-]{20,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/],
  ['hex40', /(?<![0-9A-Fa-f])[0-9A-Fa-f]{40,}(?![0-9A-Fa-f])/],
  ['x-spm-api-key', /\bX-SPM-API-Key\b\s*[:=]?\s*[A-Za-z0-9._~+/=-]{12,}/i],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i],
];

const parseJson = (text) => { try { return JSON.parse(text); } catch (_) { return null; } };
const word = (x) => (typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(x) ? x : 'none');
const istIso = (ms) => new Date(ms + 19800000).toISOString().slice(0, 19) + '+05:30';
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ==== IMPLEMENTATION-BEGIN
class GuardError extends Error { constructor(msg) { super(msg); this.name = 'GuardError'; this.code = 'allowlist_refused'; } }

function firstKeyLike(text) {
  for (const [name, re] of KEY_PATTERNS) if (re.test(text)) return name;
  const shared = findSecrets(text); // every shape in lib/secret-patterns.txt; no allowlist here, a fake is refused too
  if (shared.length > 0) return shared[0].name;
  return null;
}

// ---------------------------------------------------------------- the command line
// argv is the command line WITHOUT --config (main strips it). config is { name, email, keyFile } from the settings file.
function parseArgs(argv, config = {}) {
  const bad = (why) => ({ ok: false, error: why });
  const valued = ['--document', '--map', '--task', '--to', '--text', '--text-file'];
  const v = {}; let dryRun = false; let isNew = false;
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--dry-run') { if (dryRun) return bad('--dry-run given twice'); dryRun = true; continue; }
    if (f === '--new') { if (isNew) return bad('--new given twice'); isNew = true; continue; }
    if (!valued.includes(f)) return bad('unknown or misplaced argument');
    if (i + 1 >= argv.length) return bad(`${f} needs a value`);
    if (Object.prototype.hasOwnProperty.call(v, f)) return bad(`${f} given twice`);
    v[f] = String(argv[++i]);
  }
  if (isNew && Object.prototype.hasOwnProperty.call(v, '--to')) return bad('--new posts a top-level comment: it cannot be combined with --to (--to is for a reply)');
  if (!isNew && !Object.prototype.hasOwnProperty.call(v, '--to')) return bad('--to is required');
  const kinds = ['--document', '--map', '--task'].filter((f) => Object.prototype.hasOwnProperty.call(v, f));
  if (kinds.length !== 1) return bad('give exactly one of --document, --map and --task');
  const kind = kinds[0].slice(2);
  const itemId = v[kinds[0]].trim().toLowerCase();
  const to = isNew ? null : v['--to'].trim().toLowerCase();
  if (!UUID_RE.test(itemId)) return bad(`${kinds[0]} must be a uuid`);
  if (!isNew && !UUID_RE.test(to)) return bad('--to must be a comment id (a uuid)');
  const hasText = Object.prototype.hasOwnProperty.call(v, '--text'); const hasFile = Object.prototype.hasOwnProperty.call(v, '--text-file');
  if (hasText === hasFile) return bad('give exactly one of --text and --text-file');
  let text;
  if (hasText) text = v['--text'];
  else {
    const tf = v['--text-file'];
    if (!path.isAbsolute(tf)) return bad('--text-file must be an absolute path');
    try { text = fs.readFileSync(tf, 'utf8'); } catch (e) { return bad(`cannot read --text-file (${word(e && e.code)})`); }
    text = text.replace(/\r?\n$/, '');
  }
  if (!text.trim()) return bad('the text is empty');
  const nChars = Array.from(text).length; // code points of the text exactly as it will be posted
  if (nChars > TEXT_LIMIT) return { ok: false, noUsage: true, error: `refused: the text is ${nChars} characters; the standing format allows ${TEXT_LIMIT}` };
  return { ok: true, cfg: { identity: config.email, kind, document: kind === 'document' ? itemId : null, map: kind === 'map' ? itemId : null, task: kind === 'task' ? itemId : null, to, text, dryRun, isNew, keyFile: config.keyFile || null, email: config.email } };
}

// ---------------------------------------------------------------- the allow-list: checked before EVERY call
function guardRequest(url, method, headers, body, mode) { // mode 'new': the request of --new (a top-level comment: parent_id is null); anything else is a reply (parent_id is a uuid)
  let u;
  try { u = new URL(url); } catch (_) { throw new GuardError('refused: unparseable url'); }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '' || u.hash !== '' || u.search !== '') throw new GuardError('refused: scheme, port, query or credentials in the url');
  if (u.hostname !== FN_HOST) throw new GuardError('refused: host or method is not on the allow-list');
  const names = Object.keys(headers || {}).map((h) => h.toLowerCase());
  const only = (allowed) => { if (!names.every((n) => allowed.includes(n))) throw new GuardError('refused: a header that does not belong on this route'); };
  const exact = (wanted) => { if (names.length !== wanted.length || !wanted.every((n) => names.includes(n))) throw new GuardError('refused: the headers of this route are exactly ' + wanted.join(', ')); };
  const keys = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? Object.keys(b).sort().join(',') : null);
  if (ITEM_PATH_RE.test(u.pathname)) { // board (tasks) and map comments: GET the list, POST the reply; nothing else on these paths
    if (method === 'GET') {
      exact(['x-spm-api-key', 'x-spm-user-email']);
      if (body !== undefined) throw new GuardError('refused: a GET carries no body');
    } else if (method === 'POST') {
      exact(['origin', 'x-spm-api-key', 'x-spm-user-email']);
      const origin = Object.keys(headers).filter((h) => h.toLowerCase() === 'origin').map((h) => headers[h])[0];
      if (origin !== ORIGIN) throw new GuardError('refused: the Origin header');
      // --new (mode 'new'): parent_id is JSON null (a top-level comment); a reply: a uuid. An omitted or empty parent_id is refused in both.
      const parentOk = keys(body) === 'body,parent_id' && (mode === 'new' ? body.parent_id === null : UUID_RE.test(String(body.parent_id)));
      if (keys(body) !== 'body,parent_id' || !parentOk || typeof body.body !== 'string' || !body.body.trim()) throw new GuardError('refused: the create request body');
    } else throw new GuardError('refused: host or method is not on the allow-list');
    return;
  }
  if (method !== 'POST') throw new GuardError('refused: host or method is not on the allow-list');
  if (u.pathname === '/documentsApi/listDocumentComments') {
    only(['x-spm-api-key', 'x-spm-user-email']);
    if (keys(body) !== 'documentId' || !UUID_RE.test(String(body.documentId))) throw new GuardError('refused: the list request body');
  } else if (u.pathname === '/documentsApi/createDocumentComment') {
    only(['origin', 'x-spm-api-key', 'x-spm-user-email']);
    if (mode === 'new') { // the second explicit shape: the same keys, but parent_id must be JSON null (never omitted, never a uuid)
      if (keys(body) !== 'body,documentId,parent_id' || !UUID_RE.test(String(body.documentId)) || body.parent_id !== null || typeof body.body !== 'string' || !body.body.trim()) throw new GuardError('refused: the create request body');
      return;
    }
    if (keys(body) !== 'body,documentId,parent_id' || !UUID_RE.test(String(body.documentId)) || !UUID_RE.test(String(body.parent_id)) || typeof body.body !== 'string' || !body.body.trim()) throw new GuardError('refused: the create request body');
  } else throw new GuardError('refused: path is not on the allow-list');
}

// ---------------------------------------------------------------- the proxy: a real https call goes through HTTPS_PROXY (or https_proxy) when one is set.
let PROXY_AGENT = null; let PROXY_AGENT_FOR = null;
function proxyAgentFor(lib) {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (lib === http || !p) return false;
  if (PROXY_AGENT === null || PROXY_AGENT_FOR !== p) { PROXY_AGENT = new https.Agent({ proxyEnv: { HTTPS_PROXY: p } }); PROXY_AGENT_FOR = p; } // only the proxy URL reaches the agent: no other variable
  return PROXY_AGENT;
}
// ---------------------------------------------------------------- the transport (real https in a run; plain http to the local stand-in in the selftest: the SAME code either way)
function makeTransport({ lib, resolveTarget }) {
  return function transport(url, method, headers, bodyObj, opts = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const t = resolveTarget(u);
      const data = bodyObj === undefined ? null : JSON.stringify(bodyObj);
      const h = { ...headers, host: u.host, accept: 'application/json' };
      if (data !== null) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
      const ms = opts.timeoutMs || 90000;
      let settled = false; let req = null;
      const done = (f, v) => { if (settled) return; settled = true; f(v); };
      const fail = (code) => { if (settled) return; if (req) req.destroy(); done(reject, Object.assign(new Error(code), { code })); };
      req = lib.request({ hostname: t.hostname, port: t.port, path: u.pathname + u.search, method, agent: proxyAgentFor(lib), headers: h }, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (c) => { size += c.length; if (size > MAX_REPLY_BYTES) return fail('TOOBIG'); chunks.push(c); });
        res.on('end', () => done(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('aborted', () => fail('ECONNRESET'));
        res.on('error', () => fail('ECONNRESET'));
      });
      req.setTimeout(ms, () => fail('ETIMEDOUT'));
      req.on('error', (e) => fail(word(e && e.code) === 'none' ? 'ECONNRESET' : e.code));
      if (data !== null) req.write(data);
      req.end();
    });
  };
}

function realDeps() {
  return {
    io: { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    http: makeTransport({ lib: https, resolveTarget: (u) => ({ hostname: u.hostname, port: 443 }) }),
    readKeyFile: (file) => { const k = fs.readFileSync(file, 'utf8').trim(); if (!k) throw Object.assign(new Error('empty key file'), { code: 'EMPTY' }); return k; },
    stateDir: path.join(process.env.HOME || os.homedir(), '.claude', 'agent-reply-state'),
  };
}

// ---------------------------------------------------------------- the state file (idempotence and spacing) and the attempt log
const emptyState = () => ({ posts: {}, last: {} });
function readState(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, 'state.json'), 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return emptyState(); throw e; }
  const j = parseJson(text);
  if (!j || typeof j !== 'object' || Array.isArray(j) || typeof j.posts !== 'object' || typeof j.last !== 'object') throw new Error('the state file is not valid: fix or move it (it is never overwritten silently)');
  return j;
}
function writeStateAtomic(dir, st) {
  const file = path.join(dir, 'state.json'); const tmp = path.join(dir, `.state.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(st, null, 1) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
async function withLock(dir, fn) {
  const lock = path.join(dir, 'state.lock');
  let have = false;
  for (let i = 0; i < 400 && !have; i++) {
    try { fs.mkdirSync(lock); have = true; } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 15000) fs.rmSync(lock, { recursive: true, force: true }); } catch (_) { /* gone */ }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  if (!have) throw new Error('the state lock is held');
  try { return await fn(); } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_) { /* gone */ } }
}

// ---------------------------------------------------------------- the run
async function run(cfg, deps) {
  const io = deps.io;
  let key = null;
  const scrub = (text) => {
    let t = String(text);
    if (typeof key === 'string' && key.length >= 8) t = t.split(key).join('[redacted]');
    return t.replace(/spm_k_[A-Za-z0-9_-]+/g, '[redacted]').replace(/eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)*/g, '[redacted]');
  };
  const say = (s) => io.out(scrub(s));
  const warn = (s) => io.err(scrub(`agent-reply: ${s}`));
  const L = { root: null, http_status: null, comment_id: null, outcome: 'error' };
  const textSha = sha256(cfg.text);
  const mode = cfg.isNew ? 'new' : cfg.dryRun ? 'dry-run' : 'post'; // the log line says "new" for a --new call (a dry run of it shows in the outcome)
  try {
    // (c) the secret check, before anything leaves the machine
    const hit = firstKeyLike(cfg.text);
    if (hit) { L.outcome = 'refused_key_like'; warn(`refused: the text contains something shaped like a secret (${hit}); nothing was sent`); return 2; }
    if (cfg.secretMode) key = NETWORK_SECRET_VALUE; // K-A3 item 1: the placeholder; no key file is read
    else { try { key = deps.readKeyFile(cfg.keyFile); } catch (e) { L.outcome = 'no_key'; warn(`cannot read the key file (${word(e && e.code)})`); return 1; } }
    const headersRead = { 'X-SPM-API-Key': key, 'X-SPM-User-Email': cfg.email };
    const call = async (method, route, headers, body) => {
      const url = `https://${FN_HOST}/${route}`;
      guardRequest(url, method, headers, body, cfg.isNew ? 'new' : 'reply');
      try { const res = await deps.http(url, method, headers, body, { timeoutMs: 90000 }); return { status: res.status, json: parseJson(res.text), err: null }; } catch (e) { return { status: null, json: null, err: word(e && e.code) }; }
    };
    const itemId = cfg.kind === 'map' ? cfg.map : cfg.kind === 'task' ? cfg.task : cfg.document;
    const itemRoute = cfg.kind === 'map' ? `mapsApi/maps/${cfg.map}/comments` : `boardsApi/tasks/${cfg.task}/comments`; // board comments hang on TASKS
    // (a) the thread root of --to, from the real comment list (--new has no thread: no lookup at all, root stays null, the create carries parent_id null)
    let root = null;
    if (!cfg.isNew) {
      const lst = cfg.kind === 'document' ? await call('POST', 'documentsApi/listDocumentComments', headersRead, { documentId: cfg.document }) : await call('GET', itemRoute, headersRead, undefined);
      if (lst.status !== 200 || !lst.json || !Array.isArray(lst.json.comments)) {
        L.outcome = 'lookup_failed'; L.http_status = lst.status;
        warn(`stopped: the thread lookup failed (${lst.status === null ? `network ${lst.err}` : `HTTP ${lst.status} ${word(lst.json && lst.json.code)}`}); nothing was posted`);
        return 1;
      }
      const target = lst.json.comments.find((c) => c && typeof c.id === 'string' && c.id.toLowerCase() === cfg.to);
      if (!target) { L.outcome = 'comment_not_found'; warn(`stopped: comment ${cfg.to.slice(0, 8)} is not in ${cfg.kind} ${itemId.slice(0, 8)} (deleted, or a wrong id); nothing was posted`); return 1; }
      root = (typeof target.parent_id === 'string' && target.parent_id ? target.parent_id : target.id).toLowerCase();
      L.root = root;
    }
    // (h) dry run stops here
    if (cfg.dryRun) { L.outcome = 'dry_run'; say(cfg.isNew ? `dry-run: new top-level comment on ${itemId}; nothing posted` : `dry-run: root ${root}; nothing posted`); return 0; }
    // (d) and (i): the duplicate check and the spacing reservation, in one locked step (a --new key carries the mode and the document, a reply key the root: the two never collide)
    const dupKey = cfg.isNew ? `${cfg.identity}|new|${itemId}|${textSha}` : `${cfg.identity}|${root}|${textSha}`;
    fs.mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
    let wait = 0; let dup = null;
    await withLock(deps.stateDir, async () => {
      const st = readState(deps.stateDir); const now = deps.now();
      for (const [k, e] of Object.entries(st.posts)) if (now - e.at_ms > DUP_WINDOW_MS) delete st.posts[k];
      const e = st.posts[dupKey];
      if (e) { dup = e; return; }
      wait = Math.max(0, (st.last[cfg.identity] || 0) + GAP_MS - now);
      st.last[cfg.identity] = now + wait;
      st.posts[dupKey] = { state: 'pending', id: null, at_ms: now };
      writeStateAtomic(deps.stateDir, st);
    });
    if (dup) {
      L.outcome = 'duplicate'; L.comment_id = dup.id || null;
      if (dup.id) say(cfg.isNew ? `duplicate: an identical new comment was already posted as ${dup.id} on ${itemId} at ${istIso(dup.at_ms)}; nothing posted` : `duplicate: an identical reply was already posted as ${dup.id} under ${root} at ${istIso(dup.at_ms)}; nothing posted`);
      else say(cfg.isNew ? `duplicate: an identical new comment was attempted at ${istIso(dup.at_ms)} and may already exist (no comment id is known); look at the comments of the ${cfg.kind} before posting again; nothing posted` : `duplicate: an identical reply was attempted at ${istIso(dup.at_ms)} and may already exist (no comment id is known); look at the thread before posting again; nothing posted`);
      return 3;
    }
    if (wait > 0) await deps.sleep(wait);
    // (b) the post
    const postHeaders = { Origin: ORIGIN, 'X-SPM-API-Key': key, 'X-SPM-User-Email': cfg.email };
    const post = cfg.kind === 'document' ? await call('POST', 'documentsApi/createDocumentComment', postHeaders, { documentId: cfg.document, body: cfg.text, parent_id: root }) : await call('POST', itemRoute, postHeaders, { body: cfg.text, parent_id: root });
    L.http_status = post.status;
    const settle = (fn) => withLock(deps.stateDir, async () => { const st = readState(deps.stateDir); fn(st); writeStateAtomic(deps.stateDir, st); });
    const idOf = cfg.kind === 'document' ? (post.json && post.json.id) : (post.json && post.json.comment && post.json.comment.id); // a board or map reply is { comment: { id, ... } }, a document reply { id, ... }
    const newId = typeof idOf === 'string' && UUID_RE.test(idOf.toLowerCase()) ? idOf : null;
    if (post.status === 200 && newId) {
      L.outcome = 'posted'; L.comment_id = newId;
      await settle((st) => { st.posts[dupKey] = { state: 'posted', id: newId, at_ms: deps.now() }; });
      say(cfg.isNew ? `posted new top-level comment on ${itemId}: ${newId}` : `posted ${newId} under ${root}`);
      return 0;
    }
    if (post.status === null) {
      L.outcome = 'network_error';
      await settle((st) => { st.posts[dupKey] = { state: 'unknown', id: null, at_ms: deps.now() }; });
      warn(`stopped: network error (${post.err}) while posting; the comment may or may not exist: look at the thread before posting again; no retry was made`);
      return 1;
    }
    if (post.status === 200) {
      L.outcome = 'unknown_reply';
      await settle((st) => { st.posts[dupKey] = { state: 'unknown', id: null, at_ms: deps.now() }; });
      warn('stopped: HTTP 200 without a comment id; the comment may exist: look at the thread before posting again; no retry was made');
      return 1;
    }
    L.outcome = 'http_error';
    await settle((st) => { delete st.posts[dupKey]; });
    warn(`stopped: HTTP ${post.status} ${word(post.json && post.json.code)}; nothing was posted; no retry was made`);
    return 1;
  } catch (e) {
    warn(`unexpected failure (${word(e && (e.code || e.name))}): ${scrub(String(e && e.message)).slice(0, 160)}`);
    return 1;
  } finally {
    try {
      fs.mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(deps.stateDir, 'log.jsonl'), JSON.stringify({ t: istIso(deps.now()), identity: cfg.identity, ...(cfg.kind === 'map' ? { map: cfg.map } : cfg.kind === 'task' ? { task: cfg.task } : { document: cfg.document }), to: cfg.to, root: L.root, text_sha256: textSha, mode, http_status: L.http_status, comment_id: L.comment_id, outcome: L.outcome }) + '\n');
    } catch (_) { /* a log failure never changes the result */ }
  }
}

// The settings file names the agent (see the header). A missing or invalid file stops the run before anything is read or sent.
function withoutConfig(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--config') i++; else out.push(argv[i]); }
  return out;
}
async function main(argv, deps) {
  let config;
  try { config = loadConfig({ argv, env: deps.env || process.env }); } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    deps.io.err(`agent-reply: ${e.message}`); return 2;
  }
  const p = parseArgs(withoutConfig(argv), config);
  if (!p.ok) { deps.io.err(`agent-reply: ${p.error}`); if (!p.noUsage) deps.io.err(USAGE); return 2; }
  const mode = keyMode(config, deps.env || process.env); // K-A3 item 1: no key_file means network-secret mode, which needs the proxy
  if (mode.mode === 'refused') { deps.io.err(`agent-reply: ${mode.message}`); return 2; }
  p.cfg.secretMode = mode.mode === 'secret';
  return run(p.cfg, deps);
}
// ==== IMPLEMENTATION-END

// ---------------------------------------------------------------- the selftest: a LOCAL real http server that answers like the two production routes (a contract-faithful STAND-IN: production needs Postgres)
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
const FAKE_KEY = 'spm_k_test_reply_agent_key_0123456789abcdef';
const AGENT_EMAIL = 'spm-example-agent@agents.invalid';
// a second synthetic agent: its own key, bound to its own address only (the stand-in binds each key to one owner, as production does)
const OTHER_KEY = 'spm_k_test_reply_other_key_fedcba9876543210';
const OTHER_EMAIL = 'spm-other-agent@agents.invalid';
const DOC = '00000000-0000-4000-8000-000000000001';
const DOC2 = '00000000-0000-4000-8000-000000000002'; // a second document the stand-in accepts a create on (its list route knows only DOC)
const TOP ='00000000-0000-4000-8000-000000000003';
const REPLY = '00000000-0000-4000-8000-000000000004';
const TOP2 = '00000000-0000-4000-8000-000000000005';
// board (a TASK) and map comments: their own ids, so a reply routed to the wrong item type is visible
const TASK_ID = '00000000-0000-4000-8000-0000000000ab'; const MAP_ID = '00000000-0000-4000-8000-000000000007'; const NODE_ID = '00000000-0000-4000-8000-000000000008';
const BTOP = '00000000-0000-4000-8000-000000000009'; const BREPLY = '00000000-0000-4000-8000-00000000000a'; const BTOP2 = '00000000-0000-4000-8000-00000000000b';
const MTOP = '00000000-0000-4000-8000-00000000000c'; const MREPLY = '00000000-0000-4000-8000-00000000000d'; const MTOP2 = '00000000-0000-4000-8000-00000000000e';
const check = (cond, msg) => { if (!cond) throw new Error(msg); };

function makeStandIn() {
  const S = { port: 0, calls: [], creates: [], over: null, server: null };
  const comments = () => new Map([
    [TOP, { id: TOP, parent_id: null, body: 'top level question', author_email: 'human@example.com' }],
    [REPLY, { id: REPLY, parent_id: TOP, body: 'a reply in the thread', author_email: 'human@example.com' }],
    [TOP2, { id: TOP2, parent_id: null, body: 'another top level comment', author_email: 'human@example.com' }],
  ]);
  const itemSeed = (type) => {
    const mk = (id, parent, body) => ({ id, parent_id: parent, body, author_email: 'human@example.com', author_kind: 'human', author_display_name: 'Example person', created_at: new Date(T0).toISOString() });
    return type === 'board' ? new Map([[BTOP, mk(BTOP, null, 'top level board comment')], [BREPLY, mk(BREPLY, BTOP, 'a reply on the task')], [BTOP2, mk(BTOP2, null, 'another top level on the task')]])
      : new Map([[MTOP, mk(MTOP, null, 'top level map comment')], [MREPLY, mk(MREPLY, MTOP, 'a reply on the map')], [MTOP2, mk(MTOP2, null, 'another top level on the map')]]);
  };
  S.reset = () => { S.calls = []; S.creates = []; S.over = null; S.comments = comments(); S.items = { board: itemSeed('board'), map: itemSeed('map') }; };
  S.reset();
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const errBody = (code, message) => ({ error: code, code, message });
  const itemWire = (type, c, caller) => {
    const tail = { author_kind: c.author_kind, author_is_you: c.author_email === caller, parent_id: c.parent_id, resolved_at: null, resolved_by_email: null, reactions: {}, mentions: [], can_resolve: false, can_delete: c.author_email === caller };
    if (type === 'board') return { id: c.id, task_id: TASK_ID, author_email: c.author_email, body: c.body, created_at: c.created_at, updated_at: null, author_display_name: c.author_display_name, ...tail };
    return { id: c.id, map_id: MAP_ID, node_id: NODE_ID, author_email: c.author_email, author_display_name: c.author_display_name, body: c.body, created_at: c.created_at, updated_at: null, ...tail };
  };
  // GET /boardsApi/tasks/<id>/comments, GET /mapsApi/maps/<id>/comments, and the POST of the same paths: the wire format (auth first, then the route, the item, the parent)
  function itemHandler(req, res, p, m, body, rec, sentKey, owners) {
    const [, fn, seg, rawId] = m; const type = fn === 'boardsApi' ? 'board' : 'map';
    const em = String(req.headers['x-spm-api-key'] ? (req.headers['x-spm-user-email'] || '') : '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(owners, sentKey)) return send(res, 401, errBody('unauthenticated', 'invalid or revoked API key'));
    if (!owners[sentKey].includes(em)) return send(res, 403, errBody('api_key_owner_mismatch', 'this API key can only act as its owner'));
    if (!(seg === (type === 'board' ? 'tasks' : 'maps')) || !['GET', 'POST'].includes(req.method)) return send(res, 404, errBody('unknown_route', `${req.method} ${p} is not a route`));
    const id = rawId.toLowerCase();
    const store = S.items[type];
    if (id !== (type === 'board' ? TASK_ID : MAP_ID)) return send(res, 404, errBody('not_found', 'not found'));
    if (req.method === 'GET') return send(res, 200, { comments: [...store.values()].map((c) => itemWire(type, c, em)), cursor: store.size, signal_id: 'f'.repeat(64) });
    rec.create = true; S.creates.push({ body, em, type });
    const n = S.creates.length; const o = typeof S.over === 'function' ? S.over(n) : S.over;
    if (o && o.destroy) return req.socket.destroy();
    if (o) return send(res, o.status, o.body === undefined ? {} : o.body);
    if (!body || typeof body.body !== 'string' || !body.body.trim()) return send(res, 400, errBody('validation_error', 'body is required'));
    if (body.parent_id) {
      const parent = store.get(body.parent_id);
      if (!parent) return send(res, 404, errBody('not_found', 'not found'));
      if (parent.parent_id) return send(res, 400, errBody('reply_to_reply', 'replies are one level deep only: cannot reply to a reply'));
    }
    const nid = crypto.randomUUID();
    const row = { id: nid, parent_id: body.parent_id || null, body: body.body, author_email: em, author_kind: 'agent', author_display_name: 'Example agent', created_at: new Date(T0).toISOString() };
    store.set(nid, row);
    return send(res, 200, { comment: itemWire(type, row, em) }); // a top-level create answers the item create shape
  }
  S.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const p = new URL(req.url, 'http://x').pathname; const body = parseJson(Buffer.concat(chunks).toString('utf8'));
      const rec = { p, m: req.method, hdr: Object.keys(req.headers).sort(), body, q: new URL(req.url, 'http://x').search, key: req.headers['x-spm-api-key'] };
      S.calls.push(rec);
      const owners = { [FAKE_KEY]: ['spm-example-agent@agents.invalid', OTHER_EMAIL], [OTHER_KEY]: [OTHER_EMAIL], [OTHER_KEY]: [OTHER_EMAIL] };
      const sentKey = req.headers['x-spm-api-key'];
      const im = /^\/(boardsApi|mapsApi)\/([^/]+)\/([^/]+)\/comments$/.exec(p);
      if (im) return itemHandler(req, res, p, im, body, rec, sentKey, owners);
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      if (!Object.prototype.hasOwnProperty.call(owners, sentKey)) return send(res, 401, { code: 'invalid_credential' });
      const em = String(req.headers['x-spm-user-email'] || '').toLowerCase();
      if (!owners[sentKey].includes(em)) return send(res, 403, { code: 'api_key_owner_mismatch' });
      if (p === '/documentsApi/listDocumentComments') {
        if (!body || body.documentId !== DOC) return send(res, 404, { error: 'document not found' });
        return send(res, 200, { comments: [...S.comments.values()].map((c) => ({ ...c })), total: S.comments.size, signal_id: 'f'.repeat(64) });
      }
      if (p === '/documentsApi/createDocumentComment') {
        if (req.headers.origin !== ORIGIN) return send(res, 403, { code: 'origin_not_allowed' });
        S.creates.push({ body, em });
        const n = S.creates.length;
        const o = typeof S.over === 'function' ? S.over(n) : S.over;
        if (o && o.destroy) return req.socket.destroy();
        if (o) return send(res, o.status, o.body === undefined ? {} : o.body);
        if (!body || typeof body.body !== 'string' || !body.body.trim() || (body.documentId !== DOC && body.documentId !== DOC2)) return send(res, 400, { code: 'validation_error' });
        // the comment rules the stand-in enforces: anchorQuote needs anchorSection, an anchorSection must be pinned into the document (this stand-in knows no sections), a parent must exist and be top-level
        if (body.anchorQuote && !body.anchorSection) return send(res, 400, { code: 'validation_error', error: 'anchorQuote requires anchorSection (hybrid anchor: section is the required half)' });
        if (body.anchorSection) return send(res, 400, { code: 'validation_error', error: 'unknown_section_id' });
        if (body.parent_id) {
          const parent = S.comments.get(body.parent_id);
          if (!parent) return send(res, 404, { error: 'parent comment not found' });
          if (parent.parent_id) return send(res, 400, { error: 'replies are one level deep only — cannot reply to a reply' });
        } // else: a document-level comment (no parent: null, absent or empty; no anchor) is accepted and stored top-level
        const id = crypto.randomUUID();
        S.comments.set(id, { id, parent_id: body.parent_id || null, body: body.body, author_email: em });
        return send(res, 200, { id, document_id: body.documentId, body: body.body, parent_id: body.parent_id || null });
      }
      return send(res, 404, { error: 'unknown route' });
    });
  });
  S.start = () => new Promise((r) => S.server.listen(0, '127.0.0.1', () => { S.port = S.server.address().port; r(); }));
  S.stop = () => new Promise((r) => { S.server.closeAllConnections(); S.server.close(r); });
  return S;
}

let RUN_DIR = null; let CASE_N = 0;
async function runCli(S, argv, o = {}) {
  // each case gets its own folder: a settings file (agent name, address, key_file) and the key file it points to
  const dir = path.join(RUN_DIR, `c${++CASE_N}`);
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, 'k.key'); fs.writeFileSync(keyFile, `${o.key || FAKE_KEY}\n`);
  const agent = { name: o.name || 'Example agent', email: o.email || AGENT_EMAIL };
  const configFile = path.join(dir, 'agent.config.json');
  fs.writeFileSync(configFile, `${JSON.stringify(o.noKeyFile ? { agent } : { agent, key_file: o.keyPath || keyFile })}\n`);
  const stateDir = o.stateDir || path.join(dir, 'state');
  const clock = o.clock || { t: T0 }; const sleeps = []; const outs = []; const errs = [];
  const deps = {
    io: { out: (s) => outs.push(s), err: (s) => errs.push(s) },
    now: () => clock.t,
    sleep: async (ms) => { sleeps.push(ms); clock.t += ms; },
    http: makeTransport({ lib: http, resolveTarget: () => ({ hostname: '127.0.0.1', port: S.port }) }),
    readKeyFile: (f) => fs.readFileSync(f, 'utf8').trim(),
    stateDir, env: o.env || {},
  };
  const argvFull = o.noConfig ? [...argv] : ['--config', configFile, ...argv];
  const code = await main(argvFull, deps);
  const files = (f) => { try { return fs.readFileSync(path.join(stateDir, f), 'utf8'); } catch (_) { return ''; } };
  return { code, outs, errs, sleeps, clock, stateDir, keyFile, configFile, dir, log: files('log.jsonl'), state: files('state.json'), logLines: files('log.jsonl').split('\n').filter(Boolean).map(parseJson) };
}
const base = (to, text, extra = []) => ['--document', DOC, '--to', to, '--text', text, ...extra];

function defineCases(cases, S) {
  const rc = (id, name, fn) => cases.push({ id, name, fn });

  rc('R01', 'a REPLY target resolves to its PARENT (dry-run prints the parent, nothing is posted)', async () => {
    S.reset();
    const r = await runCli(S, base(REPLY, 'hello', ['--dry-run']));
    check(r.code === 0 && r.outs.length === 1 && r.outs[0] === `dry-run: root ${TOP}; nothing posted`, `code ${r.code} out ${r.outs.join('|')} err ${r.errs.join('|')}`);
  });

  rc('R02', 'a TOP-LEVEL target resolves to ITSELF and the reply is posted under it', async () => {
    S.reset();
    const r = await runCli(S, base(TOP2, 'reply to a top level comment'));
    check(r.code === 0 && r.outs.length === 1 && /^posted [0-9a-f-]{36} under 00000000-0000-4000-8000-000000000005$/.test(r.outs[0]), `code ${r.code} out ${r.outs.join('|')} err ${r.errs.join('|')}`);
    check(S.creates.length === 1 && S.creates[0].body.parent_id === TOP2 && S.creates[0].body.documentId === DOC && S.creates[0].body.body === 'reply to a top level comment', `create ${JSON.stringify(S.creates)}`);
  });

  rc('R03', 'replying to a REPLY posts under its parent: the one-level 400 never happens because the root is resolved first', async () => {
    S.reset();
    const r = await runCli(S, base(REPLY, 'answering a reply'));
    check(r.code === 0 && S.creates.length === 1 && S.creates[0].body.parent_id === TOP && !r.errs.some((e) => /one level/.test(e)), `code ${r.code} out ${r.outs.join('|')} err ${r.errs.join('|')}`);
    check(r.outs.length === 1 && r.outs[0].endsWith(` under ${TOP}`) && S.comments.get(r.outs[0].split(' ')[1]).parent_id === TOP, `out ${r.outs.join('|')}`);
    check(S.calls[0].p === '/documentsApi/listDocumentComments' && S.calls[1].p === '/documentsApi/createDocumentComment' && S.calls.length === 2, `calls ${S.calls.map((c) => c.p)}`);
  });

  rc('R04', 'key-like text is refused with exit 2 and NOTHING is sent (every pattern); ordinary words that merely contain "sk-" pass', async () => {
    const bads = ['my key is sk-abcdef1234567890', 'ghp_abcdefghij1234567890', 'AKIA' + 'ABCDEFGHIJKLMNOP', 'sbp_0123456789abcdef', `hash ${'a1b2c3d4e5'.repeat(4)}`, 'X-SPM-API-Key: abcdefghijklmnopqrstuv', 'Authorization: Bearer abcdefghijklmnop1234', `${FAKE_KEY}`, 'token eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJ4In0.sig', 'AI' + 'zaSyA-0123456789abcdefghijklmnop', 'github_pat_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6', 'xoxb-' + '1234567890-abcdefghij'];
    for (const t of bads) {
      S.reset();
      const r = await runCli(S, base(TOP, t));
      check(r.code === 2 && S.calls.length === 0 && r.outs.length === 0 && r.errs.some((e) => /refused/.test(e)), `text "${t.slice(0, 20)}": code ${r.code} calls ${S.calls.length} err ${r.errs.join('|')}`);
      const d = await runCli(S, base(TOP, t, ['--dry-run']));
      check(d.code === 2 && S.calls.length === 0, `dry-run "${t.slice(0, 20)}": code ${d.code}`);
    }
    S.reset();
    const ok = await runCli(S, base(TOP, 'a risk-based task-force, the X-SPM-API-Key header and the Bearer scheme, commit 220f869 and abc123'));
    check(ok.code === 0 && S.creates.length === 1, `benign text refused: code ${ok.code} err ${ok.errs.join('|')}`);
  });

  rc('R05', 'idempotence: an identical second post inside 10 minutes is refused (exit 3, earlier id printed, no second create); different text, other root, another agent and after 10 minutes go through', async () => {
    S.reset();
    const clock = { t: T0 }; const sd = path.join(RUN_DIR, 'idem-state');
    const a = await runCli(S, base(TOP, 'same words'), { stateDir: sd, clock });
    check(a.code === 0, `first: ${a.code} ${a.errs.join('|')}`);
    const firstId = a.outs[0].split(' ')[1];
    clock.t += 60000;
    const b = await runCli(S, base(REPLY, 'same words'), { stateDir: sd, clock });
    check(b.code === 3 && S.creates.length === 1 && b.outs.length === 1 && b.outs[0].includes(firstId), `second: code ${b.code} creates ${S.creates.length} out ${b.outs.join('|')}`);
    const c = await runCli(S, base(TOP, 'other words'), { stateDir: sd, clock });
    check(c.code === 0 && S.creates.length === 2, `different text: code ${c.code}`);
    const d = await runCli(S, base(TOP2, 'same words'), { stateDir: sd, clock });
    check(d.code === 0 && S.creates.length === 3, `other root: code ${d.code}`);
    const e = await runCli(S, base(TOP, 'same words'), { stateDir: sd, clock, name: 'Other agent', email: OTHER_EMAIL, key: OTHER_KEY });
    check(e.code === 0 && S.creates.length === 4, `other agent: code ${e.code} ${e.errs.join('|')}`);
    clock.t += 10 * 60 * 1000 + 1000;
    const f = await runCli(S, base(TOP, 'same words'), { stateDir: sd, clock });
    check(f.code === 0 && S.creates.length === 5, `after 10 minutes: code ${f.code} ${f.outs.join('|')}`);
  });

  rc('R06', 'the key value never reaches stdout, stderr, the log or the state file (success, refusal, failures, a server that echoes the key)', async () => {
    const sd = path.join(RUN_DIR, 'leak-state'); const clock = { t: T0 };
    const outputs = [];
    const keep = (r) => { outputs.push(r.outs.join('\n'), r.errs.join('\n'), r.log, r.state); return r; };
    S.reset();
    keep(await runCli(S, base(TOP, 'one'), { stateDir: sd, clock }));
    keep(await runCli(S, base(TOP, 'two', ['--dry-run']), { stateDir: sd, clock }));
    keep(await runCli(S, base(TOP, `leak ${FAKE_KEY}`), { stateDir: sd, clock }));
    S.over = { status: 500, body: { code: 'boom', error: FAKE_KEY, key: FAKE_KEY } };
    keep(await runCli(S, base(TOP, 'three'), { stateDir: sd, clock }));
    S.over = { destroy: true };
    keep(await runCli(S, base(TOP, 'four'), { stateDir: sd, clock }));
    S.over = null;
    keep(await runCli(S, base(TOP, 'five'), { stateDir: sd, clock, key: 'wrong-key-value-123456' }));
    keep(await runCli(S, base('00000000-0000-4000-8000-00000000000f', 'six'), { stateDir: sd, clock }));
    const all = outputs.join('\n');
    check(!all.includes(FAKE_KEY) && !all.includes('REPLYFAKEKEY') && !all.includes('9f3a1c7d5e2b'), 'the key (or a fragment) leaked');
    check(all.includes('posted') && all.includes('dry-run'), 'the leak run did not exercise success and dry-run');
    for (const f of fs.readdirSync(sd)) check(!fs.readFileSync(path.join(sd, f), 'utf8').includes('REPLYFAKEKEY'), `state dir file ${f} holds the key`);
  });

  rc('R07', 'the first non-200 or network error STOPS the run (exit 1, exactly one create, no retry); a definite error allows a retry, an unknown outcome does not', async () => {
    const sd = path.join(RUN_DIR, 'stop-state'); const clock = { t: T0 };
    S.reset(); S.over = { status: 500, body: { code: 'internal' } };
    const a = await runCli(S, base(TOP, 'will fail'), { stateDir: sd, clock });
    check(a.code === 1 && S.creates.length === 1 && a.outs.length === 0 && a.errs.some((e) => /HTTP 500 internal/.test(e) && /no retry/.test(e)), `500: code ${a.code} creates ${S.creates.length} err ${a.errs.join('|')}`);
    S.reset(); S.over = { status: 400, body: { code: 'validation_error' } };
    const b = await runCli(S, base(TOP, 'will fail'), { stateDir: sd, clock });
    check(b.code === 1 && S.creates.length === 1 && b.errs.some((e) => /HTTP 400/.test(e)), `a 500 earlier cleared the entry, so a retry reaches the server and gets 400: code ${b.code} creates ${S.creates.length}`);
    S.reset(); S.over = { destroy: true };
    const c = await runCli(S, base(TOP, 'network trouble'), { stateDir: sd, clock });
    check(c.code === 1 && S.creates.length === 1 && c.errs.some((e) => /network error/.test(e) && /may or may not exist/.test(e)), `network: code ${c.code} creates ${S.creates.length} err ${c.errs.join('|')}`);
    S.reset();
    const d = await runCli(S, base(TOP, 'network trouble'), { stateDir: sd, clock });
    check(d.code === 3 && S.creates.length === 0 && /may already exist/.test(d.outs.join('')), `unknown outcome is not retried blindly: code ${d.code} out ${d.outs.join('|')}`);
    S.reset(); S.over = { status: 200, body: { ok: true } };
    const e = await runCli(S, base(TOP, 'no id comes back'), { stateDir: sd, clock });
    check(e.code === 1 && /without a comment id/.test(e.errs.join('')), `200 without id: code ${e.code}`);
    S.reset();
    const f = await runCli(S, base(TOP, 'wrong key'), { stateDir: sd, clock, key: 'some-other-key-value-xxxxxxxx' });
    check(f.code === 1 && S.creates.length === 0 && /HTTP 401/.test(f.errs.join('')), `lookup 401: code ${f.code} err ${f.errs.join('|')}`);
  });

  rc('R08', 'dry-run posts nothing and writes no state, but it is logged as a dry-run', async () => {
    S.reset();
    const r = await runCli(S, base(TOP2, 'only looking', ['--dry-run']));
    check(r.code === 0 && S.creates.length === 0 && S.calls.length === 1 && S.calls[0].p === '/documentsApi/listDocumentComments', `code ${r.code} calls ${S.calls.map((c) => c.p)}`);
    check(r.state === '' && r.logLines.length === 1 && r.logLines[0].mode === 'dry-run' && r.logLines[0].root === TOP2 && r.logLines[0].outcome === 'dry_run', `state "${r.state}" log ${r.log}`);
    const again = await runCli(S, base(TOP2, 'only looking', ['--dry-run']), { stateDir: r.stateDir });
    check(again.code === 0, 'a second dry-run is never a duplicate');
  });

  rc('R10', 'two posts of one agent are at least 3.2 s apart (the state file holds the last post time)', async () => {
    S.reset();
    const sd = path.join(RUN_DIR, 'gap-state'); const clock = { t: T0 };
    const a = await runCli(S, base(TOP, 'first'), { stateDir: sd, clock });
    check(a.code === 0 && a.sleeps.length === 0, `first post waited ${a.sleeps}`);
    clock.t += 1000;
    const b = await runCli(S, base(TOP, 'second'), { stateDir: sd, clock });
    check(b.code === 0 && b.sleeps.length === 1 && b.sleeps[0] === 2200, `second waited ${b.sleeps}`);
    clock.t += 5000;
    const c = await runCli(S, base(TOP, 'third'), { stateDir: sd, clock });
    check(c.code === 0 && c.sleeps.length === 0, `third waited ${c.sleeps}`);
  });

  rc('R11', 'the log line: IST time, agent address, document, to, root, text hash (never the text), HTTP status, new comment id', async () => {
    S.reset();
    const text = 'a very distinctive sentence for the log check';
    const r = await runCli(S, base(REPLY, text));
    const l = r.logLines[0];
    check(r.logLines.length === 1 && l.t === '2026-10-04T17:30:00+05:30' && l.identity === AGENT_EMAIL && l.document === DOC && l.to === REPLY && l.root === TOP && l.text_sha256 === sha256(text) && l.http_status === 200 && l.comment_id === r.outs[0].split(' ')[1] && l.outcome === 'posted' && l.mode === 'post', `log ${r.log}`);
    check(!r.log.includes('distinctive') && !r.state.includes('distinctive'), 'the text reached the log or state file');
  });

  rc('R12', 'a comment that is not in the document stops the run (exit 1) before any post', async () => {
    S.reset();
    const r = await runCli(S, base('00000000-0000-4000-8000-00000000000f', 'lost'));
    check(r.code === 1 && S.creates.length === 0 && /not in document/.test(r.errs.join('')) && r.logLines[0].outcome === 'comment_not_found', `code ${r.code} err ${r.errs.join('|')}`);
    const w = await runCli(S, ['--document', '00000000-0000-4000-8000-000000000002', '--to', TOP, '--text', 'x']);
    check(w.code === 1 && S.creates.length === 0 && /HTTP 404/.test(w.errs.join('')), `wrong document: code ${w.code} err ${w.errs.join('|')}`);
  });

  rc('R13', 'requests: the list carries the key and email only; the create carries Origin, key and email; the key is the X-SPM-API-Key header', async () => {
    S.reset();
    await runCli(S, base(TOP, 'headers check'));
    check(same(S.calls[0].hdr.filter((h) => h.startsWith('x-spm') || h === 'origin' || h === 'authorization'), ['x-spm-api-key', 'x-spm-user-email']), `list headers ${S.calls[0].hdr}`);
    check(same(S.calls[1].hdr.filter((h) => h.startsWith('x-spm') || h === 'origin' || h === 'authorization'), ['origin', 'x-spm-api-key', 'x-spm-user-email']), `create headers ${S.calls[1].hdr}`);
    check(same(Object.keys(S.calls[1].body).sort(), ['body', 'documentId', 'parent_id']) && same(Object.keys(S.calls[0].body), ['documentId']), 'request bodies');
  });

  rc('R14', 'the allow-list refuses another host, path, method, extra header or body shape before any call', async () => {
    const H = { 'X-SPM-API-Key': 'k', 'X-SPM-User-Email': 'e@x' };
    const refuses = (u, m, h, b) => { try { guardRequest(u, m, h, b); return false; } catch (e) { return e instanceof GuardError; } };
    check(refuses(`https://example.com/documentsApi/listDocumentComments`, 'POST', H, { documentId: DOC }), 'another host');
    check(refuses('https://us-central1-litethink.cloudfunctions.net/documentsApi/listDocumentComments', 'POST', H, { documentId: DOC }) && refuses('https://evil.example.net/documentsApi/listDocumentComments', 'POST', H, { documentId: DOC }) && refuses(`https://${FN_HOST}.evil.com/documentsApi/listDocumentComments`, 'POST', H, { documentId: DOC }), 'a sibling or look-alike host');
    check(refuses(`https://${FN_HOST}/deleteComment`, 'POST', H, { documentId: DOC }), 'another path');
    check(refuses(`https://${FN_HOST}/documentsApi/listDocumentComments`, 'GET', H, { documentId: DOC }), 'GET');
    check(refuses(`http://${FN_HOST}/documentsApi/listDocumentComments`, 'POST', H, { documentId: DOC }), 'plain http');
    check(refuses(`https://${FN_HOST}/documentsApi/listDocumentComments`, 'POST', { ...H, Authorization: 'Bearer x' }, { documentId: DOC }), 'extra header');
    check(refuses(`https://${FN_HOST}/documentsApi/listDocumentComments`, 'POST', { ...H, Origin: ORIGIN }, { documentId: DOC }), 'Origin on the list');
    check(refuses(`https://${FN_HOST}/documentsApi/createDocumentComment`, 'POST', { ...H, Origin: ORIGIN }, { documentId: DOC, body: 'x' }), 'create without parent_id');
    check(refuses(`https://${FN_HOST}/documentsApi/createDocumentComment`, 'POST', { ...H, Origin: ORIGIN }, { documentId: DOC, body: 'x', parent_id: 'nope' }), 'create with a bad parent_id');
    check(!refuses(`https://${FN_HOST}/documentsApi/createDocumentComment`, 'POST', { ...H, Origin: ORIGIN }, { documentId: DOC, body: 'x', parent_id: TOP }), 'the real create is refused');
  });

  rc('R41', 'the warm router: the document list and the document post go to /documentsApi/ and are admitted; the bare /listDocumentComments and /createDocumentComment are refused before any call', async () => {
    const H = { 'X-SPM-API-Key': 'k', 'X-SPM-User-Email': 'e@x' }; const HP = { ...H, Origin: ORIGIN };
    const refuses = (u, m, h, b) => { try { guardRequest(u, m, h, b); return false; } catch (e) { return e instanceof GuardError; } };
    check(!refuses(`https://${FN_HOST}/documentsApi/listDocumentComments`, 'POST', H, { documentId: DOC }), 'the router list was refused');
    check(!refuses(`https://${FN_HOST}/documentsApi/createDocumentComment`, 'POST', HP, { documentId: DOC, body: 'x', parent_id: TOP }), 'the router create was refused');
    check(refuses(`https://${FN_HOST}/listDocumentComments`, 'POST', H, { documentId: DOC }), 'the bare list was admitted');
    check(refuses(`https://${FN_HOST}/createDocumentComment`, 'POST', HP, { documentId: DOC, body: 'x', parent_id: TOP }), 'the bare create was admitted');
  });

  rc('R15', 'usage errors exit 2 with nothing sent: both text flags, relative text file, bad uuid, duplicate flag, unknown flag, empty text', async () => {
    S.reset();
    const tf = path.join(RUN_DIR, 'reply.txt'); fs.writeFileSync(tf, 'text from a file\n');
    const bads = [
      [...base(TOP, 'x'), '--text-file', tf], ['--document', DOC, '--to', TOP, '--text-file', 'relative.txt'], ['--document', 'nope', '--to', TOP, '--text', 'x'],
      [...base(TOP, 'x'), '--dry-run', '--dry-run'], [...base(TOP, 'x'), '--bogus', '1'], base(TOP, '   '), ['--identity', 'root', '--document', DOC, '--to', TOP, '--text', 'x'], ['--document', DOC, '--text', 'x'],
    ];
    for (const a of bads) { const r = await runCli(S, a); check(r.code === 2 && S.calls.length === 0, `${a.slice(0, 7).join(' ')}: code ${r.code}`); }
    const rootR = await runCli(S, ['--identity', 'root', '--document', DOC, '--to', TOP, '--text', 'x']);
    check(rootR.code === 2 && /unknown or misplaced argument/.test(rootR.errs.join('')), `unknown identity refusal: code ${rootR.code} err ${rootR.errs.join('|').slice(0, 300)}`);
    const r = await runCli(S, ['--document', DOC, '--to', TOP, '--text-file', tf]);
    check(r.code === 0 && S.creates[0].body.body === 'text from a file', `--text-file: code ${r.code} body ${JSON.stringify(S.creates[0] && S.creates[0].body)}`);
  });

  // ==== BOARD (--task) AND MAP (--map) COMMENTS. The stand-in answers in the wire format of the two item routes.
  const baseT = (to, text, extra = []) => ['--task', TASK_ID, '--to', to, '--text', text, ...extra];
  const baseM = (to, text, extra = []) => ['--map', MAP_ID, '--to', to, '--text', text, ...extra];
  const sendHdr = (rec) => rec.hdr.filter((h) => h.startsWith('x-spm') || h === 'origin' || h === 'authorization' || h === 'content-type' || h === 'content-length');

  rc('R17', '--task: a REPLY target resolves to its PARENT (the root), the reply is posted by POST /boardsApi/tasks/<id>/comments { body, parent_id }, under the root, and the posted id is read from { comment }', async () => {
    S.reset();
    const r = await runCli(S, baseT(BREPLY, 'answering a reply on the task'));
    check(r.code === 0 && r.outs.length === 1 && /^posted [0-9a-f-]{36} under 00000000-0000-4000-8000-000000000009$/.test(r.outs[0]), `code ${r.code} out ${r.outs.join('|')} err ${r.errs.join('|')}`);
    check(S.calls.length === 2 && S.calls[0].m === 'GET' && S.calls[0].p === `/boardsApi/tasks/${TASK_ID}/comments` && S.calls[1].m === 'POST' && S.calls[1].p === `/boardsApi/tasks/${TASK_ID}/comments`, `calls ${S.calls.map((c) => c.m + c.p)}`);
    check(S.creates.length === 1 && S.creates[0].type === 'board' && same(Object.keys(S.calls[1].body), ['body', 'parent_id']) && S.calls[1].body.parent_id === BTOP && S.calls[1].body.body === 'answering a reply on the task', `create ${JSON.stringify(S.calls[1].body)}`);
    const id = r.outs[0].split(' ')[1];
    check(S.items.board.get(id).parent_id === BTOP && S.items.board.get(id).author_email === 'spm-example-agent@agents.invalid' && !r.errs.some((e) => /one level/.test(e)), 'the reply sits under the root, authored by the agent');
    check(r.logLines.length === 1 && r.logLines[0].task === TASK_ID && !('document' in r.logLines[0]) && r.logLines[0].root === BTOP && r.logLines[0].outcome === 'posted' && r.logLines[0].comment_id === id, `log ${r.log}`);
  });

  rc('R18', '--map: a REPLY target resolves to its parent, a TOP-LEVEL target to itself; the reply is posted by POST /mapsApi/maps/<id>/comments { body, parent_id }', async () => {
    S.reset();
    const a = await runCli(S, baseM(MREPLY, 'answering a reply on the map'));
    check(a.code === 0 && /^posted [0-9a-f-]{36} under 00000000-0000-4000-8000-00000000000c$/.test(a.outs[0] || ''), `code ${a.code} out ${a.outs.join('|')} err ${a.errs.join('|')}`);
    check(S.calls[0].m === 'GET' && S.calls[0].p === `/mapsApi/maps/${MAP_ID}/comments` && S.calls[1].m === 'POST' && S.calls[1].p === `/mapsApi/maps/${MAP_ID}/comments` && S.calls[1].body.parent_id === MTOP && same(Object.keys(S.calls[1].body), ['body', 'parent_id']), `calls ${JSON.stringify(S.calls.map((c) => [c.m, c.p, c.body]))}`);
    S.reset();
    const b = await runCli(S, baseM(MTOP2, 'answering a top level map comment'));
    check(b.code === 0 && S.creates.length === 1 && S.calls[1].body.parent_id === MTOP2 && b.outs[0].endsWith(` under ${MTOP2}`), `top level: code ${b.code} out ${b.outs.join('|')}`);
    check(b.logLines[0].map === MAP_ID && !('document' in b.logLines[0]) && !('task' in b.logLines[0]), `log ${b.log}`);
  });

  rc('R19', 'a --to that is not in the task or the map stops the run (exit 1) before any post, naming the item type; a task or map the key cannot open is the real 404', async () => {
    S.reset();
    const t = await runCli(S, baseT('00000000-0000-4000-8000-00000000000f', 'lost'));
    check(t.code === 1 && S.creates.length === 0 && /not in task/.test(t.errs.join('')) && t.logLines[0].outcome === 'comment_not_found', `task: code ${t.code} err ${t.errs.join('|')}`);
    const m = await runCli(S, baseM('00000000-0000-4000-8000-00000000000f', 'lost'));
    check(m.code === 1 && S.creates.length === 0 && /not in map/.test(m.errs.join('')), `map: code ${m.code} err ${m.errs.join('|')}`);
    const w = await runCli(S, ['--task', '00000000-0000-4000-8000-000000000002', '--to', BTOP, '--text', 'x']);
    check(w.code === 1 && S.creates.length === 0 && /HTTP 404 not_found/.test(w.errs.join('')), `wrong task: code ${w.code} err ${w.errs.join('|')}`);
    const w2 = await runCli(S, ['--map', '00000000-0000-4000-8000-000000000002', '--to', MTOP, '--text', 'x']);
    check(w2.code === 1 && S.creates.length === 0 && /HTTP 404 not_found/.test(w2.errs.join('')), `wrong map: code ${w2.code} err ${w2.errs.join('|')}`);
    const x = await runCli(S, baseT(MTOP, 'a map comment id given with --task'));
    check(x.code === 1 && S.creates.length === 0, `a map comment id under --task: code ${x.code}`);
  });

  rc('R20', 'exactly one of --document, --map, --task is required: none, two or three are refused (exit 2, nothing sent); each takes a uuid; the usage text names all three', async () => {
    S.reset();
    const D = ['--document', DOC]; const T = ['--task', TASK_ID]; const M = ['--map', MAP_ID];
    const head = []; const tail = ['--to', TOP, '--text', 'x'];
    const bads = [[...head, ...tail], [...head, ...D, ...M, ...tail], [...head, ...D, ...T, ...tail], [...head, ...M, ...T, ...tail], [...head, ...D, ...M, ...T, ...tail],
      [...head, '--task', 'not-a-uuid', ...tail], [...head, '--map', 'not-a-uuid', ...tail], [...head, '--task', TASK_ID, '--task', TASK_ID, ...tail], [...head, '--map', MAP_ID, '--map', MAP_ID, ...tail], [...head, ...T, '--to', 'nope', '--text', 'x'], [...head, ...M, '--text', 'x']];
    for (const a of bads) { const r = await runCli(S, a); check(r.code === 2 && S.calls.length === 0, `${a.slice(2, 8).join(' ')}: code ${r.code} calls ${S.calls.length}`); }
    const g = ['--selftest-never'];
    void g;
    check(USAGE.includes('--document <uuid>') && USAGE.includes('--map <uuid>') && USAGE.includes('--task <uuid>'), 'usage names the three flags');
    const p = parseArgs([...head, '--task', TASK_ID.toUpperCase(), '--to', BTOP.toUpperCase(), '--text', 'x']);
    check(p.ok && p.cfg.task === TASK_ID && p.cfg.to === BTOP && p.cfg.document === null && p.cfg.map === null, `task ids are lower-cased ${JSON.stringify(p)}`);
    const q = parseArgs([...head, '--map', MAP_ID, '--to', MTOP, '--text', 'x']);
    check(q.ok && q.cfg.map === MAP_ID && q.cfg.task === null && q.cfg.document === null, `map ${JSON.stringify(q)}`);
    const d = parseArgs([...head, '--document', DOC, '--to', TOP, '--text', 'x']);
    check(d.ok && d.cfg.document === DOC && d.cfg.task === null && d.cfg.map === null, `document ${JSON.stringify(d)}`);
  });

  rc('R21', 'the allow-list admits exactly the board and map reads and posts (GET list with the key and address only, POST with Origin, key, address and { body, parent_id }) and refuses every near-miss before the call', async () => {
    const H = { 'X-SPM-API-Key': 'k', 'X-SPM-User-Email': 'e@x' }; const HO = { ...H, Origin: ORIGIN };
    const refuses = (u, m, h, b) => { try { guardRequest(u, m, h, b); return false; } catch (e) { return e instanceof GuardError; } };
    const L = `https://${FN_HOST}`; const TL = `${L}/boardsApi/tasks/${TASK_ID}/comments`; const ML = `${L}/mapsApi/maps/${MAP_ID}/comments`;
    const post = { body: 'x', parent_id: BTOP };
    check(!refuses(TL, 'GET', H, undefined) && !refuses(ML, 'GET', H, undefined) && !refuses(TL, 'POST', HO, post) && !refuses(ML, 'POST', HO, post), 'a real item call is refused');
    const bad = [
      ['POST on the list', [TL, 'POST', H, { documentId: DOC }]], ['GET on the create', [TL, 'GET', HO, undefined]], ['PUT', [TL, 'PUT', HO, post]], ['DELETE', [ML, 'DELETE', H, undefined]], ['PATCH', [TL, 'PATCH', HO, post]],
      ['other function', [`${L}/otherApi/tasks/${TASK_ID}/comments`, 'GET', H, undefined]], ['itemsApi', [`${L}/itemsApi/tasks/${TASK_ID}/comments`, 'POST', HO, post]], ['accountApi', [`${L}/accountApi/maps/${MAP_ID}/comments`, 'GET', H, undefined]],
      ['tasks on mapsApi', [`${L}/mapsApi/tasks/${TASK_ID}/comments`, 'GET', H, undefined]], ['maps on boardsApi', [`${L}/boardsApi/maps/${MAP_ID}/comments`, 'POST', HO, post]],
      ['no function name', [`${L}/tasks/${TASK_ID}/comments`, 'GET', H, undefined]], ['another suffix', [`${L}/boardsApi/tasks/${TASK_ID}/activity`, 'GET', H, undefined]], ['comments by id', [`${L}/boardsApi/comments/${BTOP}`, 'GET', H, undefined]],
      ['the delete route', [`${L}/boardsApi/comments/${BTOP}`, 'DELETE', H, undefined]], ['resolve', [`${L}/boardsApi/comments/${BTOP}/resolve`, 'POST', HO, { resolved: true }]], ['reactions', [`${L}/mapsApi/map-comments/${MTOP}/reactions`, 'POST', HO, { emoji: 'x', op: 'add' }]],
      ['trailing slash', [`${TL}/`, 'GET', H, undefined]], ['query on the list', [`${TL}?x=1`, 'GET', H, undefined]], ['query on the create', [`${ML}?x=1`, 'POST', HO, post]], ['id not a uuid', [`${L}/boardsApi/tasks/nope/comments`, 'GET', H, undefined]],
      ['id upper-case', [`${L}/boardsApi/tasks/${TASK_ID.toUpperCase()}/comments`, 'GET', H, undefined]], ['us-central1 host', [`https://us-central1-litethink.cloudfunctions.net/boardsApi/tasks/${TASK_ID}/comments`, 'GET', H, undefined]],
      ['other host', [`https://evil.example.net/boardsApi/tasks/${TASK_ID}/comments`, 'GET', H, undefined]], ['look-alike host', [`https://${FN_HOST}.evil.com/mapsApi/maps/${MAP_ID}/comments`, 'GET', H, undefined]], ['http', [`http://${FN_HOST}/boardsApi/tasks/${TASK_ID}/comments`, 'GET', H, undefined]],
      ['port', [`https://${FN_HOST}:8443/boardsApi/tasks/${TASK_ID}/comments`, 'GET', H, undefined]], ['userinfo', [`https://u:p@${FN_HOST}/boardsApi/tasks/${TASK_ID}/comments`, 'GET', H, undefined]],
      ['Origin on the list', [TL, 'GET', HO, undefined]], ['bearer on the list', [TL, 'GET', { ...H, Authorization: 'Bearer x' }, undefined]], ['bearer on the create', [TL, 'POST', { ...HO, Authorization: 'Bearer x' }, post]], ['content-type on the list', [TL, 'GET', { ...H, 'Content-Type': 'application/json' }, undefined]],
      ['workspace header', [ML, 'GET', { ...H, 'X-SPM-Workspace': 'ws' }, undefined]], ['idempotency header on the create', [ML, 'POST', { ...HO, 'Idempotency-Key': 'ack-text:x' }, post]], ['no Origin on the create', [TL, 'POST', H, post]], ['another Origin on the task create', [TL, 'POST', { ...H, Origin: 'https://evil.example' }, post]], ['another Origin on the map create', [ML, 'POST', { ...H, Origin: ORIGIN + '.evil.com' }, post]], ['key missing', [TL, 'GET', { 'X-SPM-User-Email': 'e@x' }, undefined]], ['address missing', [TL, 'GET', { 'X-SPM-API-Key': 'k' }, undefined]],
      ['a body on the list', [TL, 'GET', H, {}]], ['create without parent_id', [TL, 'POST', HO, { body: 'x' }]], ['create with a bad parent_id', [TL, 'POST', HO, { body: 'x', parent_id: 'nope' }]], ['create with an extra key', [ML, 'POST', HO, { ...post, node_id: NODE_ID }]],
      ['create with documentId', [ML, 'POST', HO, { ...post, documentId: DOC }]], ['create with an empty text', [ML, 'POST', HO, { body: '   ', parent_id: MTOP }]], ['create with a non-string text', [ML, 'POST', HO, { body: 5, parent_id: MTOP }]], ['create without a body', [ML, 'POST', HO, undefined]],
      ['unparseable', ['not a url', 'GET', H, undefined]],
    ];
    for (const [name, c] of bad) check(refuses(...c), `item case "${name}" was allowed`);
    check(!refuses(`${L}/documentsApi/listDocumentComments`, 'POST', H, { documentId: DOC }) && !refuses(`${L}/documentsApi/createDocumentComment`, 'POST', HO, { documentId: DOC, body: 'x', parent_id: TOP }), 'the document calls are still admitted');
  });

  rc('R22', 'the key value never reaches stdout, stderr, the log or the state file on the task and map paths (success, refusal, failures, a server that echoes the key)', async () => {
    const sd = path.join(RUN_DIR, 'leak-items'); const clock = { t: T0 };
    const outputs = []; const keep = (r) => { outputs.push(r.outs.join('\n'), r.errs.join('\n'), r.log, r.state); return r; };
    S.reset();
    keep(await runCli(S, baseT(BTOP, 'one'), { stateDir: sd, clock })); keep(await runCli(S, baseM(MTOP, 'two'), { stateDir: sd, clock })); keep(await runCli(S, baseT(BTOP, 'three', ['--dry-run']), { stateDir: sd, clock }));
    keep(await runCli(S, baseT(BTOP, `leak ${FAKE_KEY}`), { stateDir: sd, clock }));
    S.over = { status: 500, body: { code: 'boom', error: FAKE_KEY, key: FAKE_KEY } }; keep(await runCli(S, baseM(MTOP, 'four'), { stateDir: sd, clock }));
    S.over = { destroy: true }; keep(await runCli(S, baseT(BTOP, 'five'), { stateDir: sd, clock })); S.over = null;
    keep(await runCli(S, baseM(MTOP, 'six'), { stateDir: sd, clock, key: 'wrong-key-value-123456' }));
    const all = outputs.join('\n');
    check(!all.includes(FAKE_KEY) && !all.includes('REPLYFAKEKEY') && !all.includes('9f3a1c7d5e2b'), 'the key (or a fragment) leaked');
    check(all.includes('posted') && all.includes('dry-run'), 'the leak run did not exercise success and dry-run');
  });

  rc('R23', 'failures on the item paths: a 500, a 400, a network error and a 200 without { comment: { id } } stop the run (exit 1, exactly one create, no retry); a definite error allows a retry, an unknown outcome does not', async () => {
    const sd = path.join(RUN_DIR, 'stop-items'); const clock = { t: T0 };
    S.reset(); S.over = { status: 500, body: { code: 'internal' } };
    const a = await runCli(S, baseT(BTOP, 'will fail'), { stateDir: sd, clock });
    check(a.code === 1 && S.creates.length === 1 && a.outs.length === 0 && a.errs.some((e) => /HTTP 500 internal/.test(e) && /no retry/.test(e)), `500: code ${a.code} creates ${S.creates.length} err ${a.errs.join('|')}`);
    S.reset(); S.over = { status: 400, body: { code: 'validation_error' } };
    const b = await runCli(S, baseT(BTOP, 'will fail'), { stateDir: sd, clock });
    check(b.code === 1 && S.creates.length === 1 && b.errs.some((e) => /HTTP 400/.test(e)), `retry after a definite error reaches the server: code ${b.code} creates ${S.creates.length}`);
    S.reset(); S.over = { destroy: true };
    const c = await runCli(S, baseM(MTOP, 'network trouble'), { stateDir: sd, clock });
    check(c.code === 1 && S.creates.length === 1 && c.errs.some((e) => /network error/.test(e) && /may or may not exist/.test(e)), `network: code ${c.code} creates ${S.creates.length} err ${c.errs.join('|')}`);
    S.reset();
    const d = await runCli(S, baseM(MTOP, 'network trouble'), { stateDir: sd, clock });
    check(d.code === 3 && S.creates.length === 0 && /may already exist/.test(d.outs.join('')), `unknown outcome is not retried blindly: code ${d.code} out ${d.outs.join('|')}`);
    S.reset(); S.over = { status: 200, body: { ok: true } };
    const e = await runCli(S, baseT(BTOP, 'no id comes back'), { stateDir: sd, clock });
    check(e.code === 1 && /without a comment id/.test(e.errs.join('')), `200 without id: code ${e.code} ${e.errs.join('|')}`);
    S.reset(); S.over = { status: 200, body: { id: crypto.randomUUID() } };
    const f = await runCli(S, baseM(MTOP, 'a document-shaped id is not a map reply'), { stateDir: sd, clock });
    check(f.code === 1 && /without a comment id/.test(f.errs.join('')), `a top-level id (the document shape) is not accepted on a map: code ${f.code} ${f.errs.join('|')}`);
    S.reset();
    const g = await runCli(S, baseT(BTOP, 'wrong key'), { stateDir: sd, clock, key: 'some-other-key-value-xxxxxxxx' });
    check(g.code === 1 && S.creates.length === 0 && /HTTP 401/.test(g.errs.join('')), `lookup 401: code ${g.code} err ${g.errs.join('|')}`);
  });

  rc('R24', 'idempotence and spacing on the item paths: an identical second post under one root inside 10 minutes is refused (exit 3, earlier id printed); other text, other root and after 10 minutes go through; two posts are at least 3.2 s apart', async () => {
    S.reset();
    const clock = { t: T0 }; const sd = path.join(RUN_DIR, 'idem-items');
    const a = await runCli(S, baseT(BTOP, 'same words'), { stateDir: sd, clock });
    check(a.code === 0 && a.sleeps.length === 0, `first: ${a.code} ${a.errs.join('|')}`);
    const firstId = a.outs[0].split(' ')[1];
    clock.t += 60000;
    const b = await runCli(S, baseT(BREPLY, 'same words'), { stateDir: sd, clock });
    check(b.code === 3 && S.creates.length === 1 && b.outs[0].includes(firstId), `second: code ${b.code} creates ${S.creates.length} out ${b.outs.join('|')}`);
    const c = await runCli(S, baseT(BTOP, 'other words'), { stateDir: sd, clock });
    check(c.code === 0 && S.creates.length === 2, `different text: code ${c.code}`);
    const d = await runCli(S, baseT(BTOP2, 'same words'), { stateDir: sd, clock });
    check(d.code === 0 && S.creates.length === 3, `other root: code ${d.code}`);
    clock.t += 10 * 60 * 1000 + 1000;
    const e = await runCli(S, baseT(BTOP, 'same words'), { stateDir: sd, clock });
    check(e.code === 0 && S.creates.length === 4, `after 10 minutes: code ${e.code}`);
    clock.t += 1000;
    const f = await runCli(S, baseM(MTOP, 'map words'), { stateDir: sd, clock });
    check(f.code === 0 && f.sleeps.length === 1 && f.sleeps[0] === 2200, `spacing: waited ${f.sleeps}`);
  });

  rc('R25', '--dry-run on a task and on a map prints the root and posts nothing (one GET, no state, logged as a dry-run); --text-file works on the item paths', async () => {
    S.reset();
    const t = await runCli(S, baseT(BREPLY, 'only looking', ['--dry-run']));
    check(t.code === 0 && t.outs.length === 1 && t.outs[0] === `dry-run: root ${BTOP}; nothing posted` && S.creates.length === 0 && S.calls.length === 1 && S.calls[0].m === 'GET', `task: code ${t.code} out ${t.outs.join('|')} calls ${S.calls.map((c) => c.m + c.p)}`);
    check(t.state === '' && t.logLines.length === 1 && t.logLines[0].mode === 'dry-run' && t.logLines[0].task === TASK_ID && t.logLines[0].outcome === 'dry_run', `state "${t.state}" log ${t.log}`);
    S.reset();
    const m = await runCli(S, baseM(MREPLY, 'only looking', ['--dry-run']));
    check(m.code === 0 && m.outs[0] === `dry-run: root ${MTOP}; nothing posted` && S.creates.length === 0 && S.calls.length === 1, `map: code ${m.code} out ${m.outs.join('|')}`);
    const tf = path.join(RUN_DIR, 'reply-item.txt'); fs.writeFileSync(tf, 'text from a file for a task\n');
    S.reset();
    const f = await runCli(S, ['--task', TASK_ID, '--to', BTOP, '--text-file', tf]);
    check(f.code === 0 && S.creates[0].body.body === 'text from a file for a task', `--text-file: code ${f.code} ${f.errs.join('|')}`);
  });

  rc('R26', 'requests: the list carries the key and address only (no Origin, no body); the create carries Origin, key and address; every request goes to the function named in the path', async () => {
    S.reset();
    await runCli(S, baseT(BTOP, 'headers check'));
    check(same(sendHdr(S.calls[0]), ['x-spm-api-key', 'x-spm-user-email']) && S.calls[0].body === null && S.calls[0].q === '', `list headers ${sendHdr(S.calls[0])}`);
    check(same(sendHdr(S.calls[1]), ['content-length', 'content-type', 'origin', 'x-spm-api-key', 'x-spm-user-email'].sort()) && S.calls[1].q === '', `create headers ${sendHdr(S.calls[1])}`);
    S.reset();
    await runCli(S, baseM(MTOP, 'headers check'));
    check(S.calls.every((c) => c.p === `/mapsApi/maps/${MAP_ID}/comments`) && same(sendHdr(S.calls[0]), ['x-spm-api-key', 'x-spm-user-email']), `map calls ${S.calls.map((c) => c.m + c.p)}`);
    S.reset();
    await runCli(S, base(TOP, 'a document reply still uses the document functions'));
    check(S.calls.every((c) => c.p === '/documentsApi/listDocumentComments' || c.p === '/documentsApi/createDocumentComment'), `document calls ${S.calls.map((c) => c.p)}`);
  });

  rc('R28', 'a reply posted under a REPLY is what the real route refuses (400 reply_to_reply): the tool never does it, even for --to a reply, because it posts under the root (the stand-in enforces the real rule)', async () => {
    S.reset();
    for (const [argv, root] of [[baseT(BREPLY, 'x1'), BTOP], [baseM(MREPLY, 'x2'), MTOP]]) {
      const r = await runCli(S, argv);
      check(r.code === 0 && !r.errs.some((e) => /reply_to_reply|one level/.test(e)) && r.outs[0].endsWith(` under ${root}`), `code ${r.code} out ${r.outs.join('|')} err ${r.errs.join('|')}`);
    }
    check(S.creates.every((c) => c.body.parent_id === BTOP || c.body.parent_id === MTOP), 'every post carried a root as parent_id');
    // the stand-in itself refuses what the real route refuses: a post under a REPLY is 400 reply_to_reply (so a tool that posted under the reply would fail here, not pass)
    const raw = (p, body) => new Promise((resolve, reject) => {
      const d = JSON.stringify(body);
      const q = http.request({ host: '127.0.0.1', port: S.port, method: 'POST', path: p, headers: { 'x-spm-api-key': FAKE_KEY, 'x-spm-user-email': 'spm-example-agent@agents.invalid', origin: ORIGIN, 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } }, (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: parseJson(Buffer.concat(ch).toString('utf8')) })); });
      q.on('error', reject); q.write(d); q.end();
    });
    const t = await raw(`/boardsApi/tasks/${TASK_ID}/comments`, { body: 'under a reply', parent_id: BREPLY });
    const m = await raw(`/mapsApi/maps/${MAP_ID}/comments`, { body: 'under a reply', parent_id: MREPLY });
    check(t.status === 400 && t.body.code === 'reply_to_reply' && m.status === 400 && m.body.code === 'reply_to_reply', `the stand-in accepted a reply under a reply: ${JSON.stringify([t, m])}`);
  });

  rc('R29', 'a document call keeps its exact requests and log line: the three document requests and the log line are pinned as literal strings', async () => {
    S.reset();
    const sd = path.join(RUN_DIR, 'pinned-doc'); const clock = { t: T0 };
    const r = await runCli(S, base(REPLY, 'a pinned reply'), { stateDir: sd, clock });
    check(r.code === 0 && S.calls.length === 2 && S.calls[0].p === '/documentsApi/listDocumentComments' && S.calls[0].m === 'POST' && JSON.stringify(S.calls[0].body) === `{"documentId":"${DOC}"}`, `list call ${JSON.stringify(S.calls[0])}`);
    check(S.calls[1].p === '/documentsApi/createDocumentComment' && S.calls[1].m === 'POST' && JSON.stringify(S.calls[1].body) === `{"documentId":"${DOC}","body":"a pinned reply","parent_id":"${TOP}"}`, `create call ${JSON.stringify(S.calls[1].body)}`);
    check(sendHdr(S.calls[0]).join() === 'content-length,content-type,x-spm-api-key,x-spm-user-email' && sendHdr(S.calls[1]).join() === 'content-length,content-type,origin,x-spm-api-key,x-spm-user-email', `document headers ${sendHdr(S.calls[0])} / ${sendHdr(S.calls[1])}`);
    const id = r.outs[0].split(' ')[1];
    check(r.log === `{"t":"2026-10-04T17:30:00+05:30","identity":"spm-example-agent@agents.invalid","document":"${DOC}","to":"${REPLY}","root":"${TOP}","text_sha256":"${sha256('a pinned reply')}","mode":"post","http_status":200,"comment_id":"${id}","outcome":"posted"}\n`, `log line ${r.log}`);
    check(r.outs[0] === `posted ${id} under ${TOP}`, `out ${r.outs[0]}`);
  });

  rc('R31', '--new posts ONE top-level comment: one create { documentId, body, parent_id: null }, the line ends with the FULL new id, the comment is top-level in the stand-in, no thread lookup at all, the same headers as a reply, the log line pinned (mode "new")', async () => {
    S.reset();
    const sd = path.join(RUN_DIR, 'new-basic'); const clock = { t: T0 };
    const text = 'a brand new top level comment';
    const r = await runCli(S, baseN(text), { stateDir: sd, clock });
    const id = r.outs[0] ? r.outs[0].slice(-36) : '';
    check(r.code === 0 && r.outs.length === 1 && UUID_RE.test(id) && r.outs[0] === NEW_LINE(id), `code ${r.code} out ${r.outs.join('|')} err ${r.errs.join('|')}`);
    check(S.calls.length === 1 && S.calls[0].p === '/documentsApi/createDocumentComment' && S.calls[0].m === 'POST', `calls ${S.calls.map((c) => c.p)}`);
    check(S.calls.filter((c) => c.p === '/documentsApi/listDocumentComments').length === 0, 'a --new looked a thread up');
    check(S.creates.length === 1 && same(Object.keys(S.creates[0].body).sort(), ['body', 'documentId', 'parent_id']) && S.creates[0].body.parent_id === null, `create ${JSON.stringify(S.creates)}`);
    check(JSON.stringify(S.calls[0].body) === `{"documentId":"${DOC}","body":"${text}","parent_id":null}`, `create body ${JSON.stringify(S.calls[0].body)}`);
    check(sendHdr(S.calls[0]).join() === 'content-length,content-type,origin,x-spm-api-key,x-spm-user-email', `headers ${sendHdr(S.calls[0])}`);
    const c = S.comments.get(id);
    check(c && c.parent_id === null && c.body === text && c.author_email === 'spm-example-agent@agents.invalid', `stored comment ${JSON.stringify(c)}`);
    check(r.log === `{"t":"2026-10-04T17:30:00+05:30","identity":"spm-example-agent@agents.invalid","document":"${DOC}","to":null,"root":null,"text_sha256":"${sha256(text)}","mode":"new","http_status":200,"comment_id":"${id}","outcome":"posted"}\n`, `log line ${r.log}`);
    check(!r.log.includes(text) && !r.state.includes(text) && !r.log.includes(FAKE_KEY), 'the text or the key reached the log or the state file');
    const st = JSON.parse(r.state);
    check(Object.keys(st.posts).length === 1 && Object.values(st.posts)[0].state === 'posted' && Object.values(st.posts)[0].id === id && st.last[AGENT_EMAIL] === T0, `state ${r.state}`);
    // --text-file works the same (one trailing newline stripped)
    const tf = path.join(RUN_DIR, 'new.txt'); fs.writeFileSync(tf, 'text from a file for a new comment\n');
    S.reset();
    const f = await runCli(S, ['--document', DOC, '--new', '--text-file', tf]);
    check(f.code === 0 && S.creates.length === 1 && S.creates[0].body.body === 'text from a file for a new comment' && S.creates[0].body.parent_id === null, `--text-file: code ${f.code} body ${JSON.stringify(S.creates[0] && S.creates[0].body)}`);
  });

  rc('R32', '--new usage: with --to, with --map or --task ("--new works on a document only"), given twice, with no item, with two items: exit 2, nothing sent; --new needs no --to; the usage text names --new', async () => {
    S.reset();
    const head = []; const tail = ['--text', 'x'];
    const bads = [
      [...head, '--document', DOC, '--new', '--to', TOP, ...tail], [...head, '--document', DOC, '--to', TOP, '--new', ...tail], [...head, '--document', DOC, '--new', '--new', ...tail], [...head, '--new', ...tail],
      [...head, '--map', MAP_ID, '--new', '--to', MTOP, ...tail], [...head, '--task', TASK_ID, '--new', '--to', BTOP, ...tail],
      [...head, '--document', DOC, '--map', MAP_ID, '--new', ...tail], [...head, '--document', 'nope', '--new', ...tail], [...head, '--document', DOC, '--new', '--text', 'x', '--text-file', '/abs.txt'], [...head, '--document', DOC, '--new', '--text', '   '],
    ];
    for (const a of bads) { const r = await runCli(S, a); check(r.code === 2 && S.calls.length === 0 && r.outs.length === 0, `${a.slice(0, 8).join(' ')}: code ${r.code} calls ${S.calls.length}`); }
    for (const a of [[...head, '--map', MAP_ID, '--new', ...tail], [...head, '--task', TASK_ID, '--new', ...tail]]) { const p = parseArgs(a); check(p.ok && p.cfg.isNew === true && p.cfg.to === null && (p.cfg.map === MAP_ID || p.cfg.task === TASK_ID), `task or map --new is refused: ${JSON.stringify(p)}`); }
    const both = await runCli(S, [...head, '--document', DOC, '--new', '--to', TOP, ...tail]); check(/--new/.test(both.errs.join('\n')) && /--to/.test(both.errs.join('\n')), `--new with --to reason: ${both.errs.join('|')}`);
    const p = parseArgs(baseN('x'));
    check(p.ok && p.cfg.isNew === true && p.cfg.to === null && p.cfg.document === DOC && p.cfg.dryRun === false, `--new parse ${JSON.stringify(p)}`);
    const q = parseArgs(base(TOP, 'x'));
    check(q.ok && q.cfg.isNew === false && q.cfg.to === TOP, `reply parse ${JSON.stringify(q)}`);
    check(USAGE.includes('--new') && USAGE.includes('600'), 'the usage text names --new and the limit');
  });

  rc('R33', 'the allow-list: a null parent_id is allowed ONLY for a --new request; a reply still refuses it; a --new request refuses a uuid, an omitted, an empty or a string parent_id, extra keys, a bad document, an empty body; the other guards hold in both modes', async () => {
    const H = { 'X-SPM-API-Key': 'k', 'X-SPM-User-Email': 'e@x' }; const HP = { ...H, Origin: ORIGIN };
    const url = `https://${FN_HOST}/documentsApi/createDocumentComment`;
    const refuses = (b, mode, u = url, h = HP) => { try { guardRequest(u, 'POST', h, b, mode); return false; } catch (e) { return e instanceof GuardError; } };
    const nul = { documentId: DOC, body: 'x', parent_id: null };
    check(refuses(nul) && refuses(nul, 'reply'), 'reply mode must refuse parent_id null');
    check(!refuses(nul, 'new'), 'the --new request { documentId, body, parent_id: null } was refused');
    check(!refuses({ documentId: DOC, body: 'x', parent_id: TOP }) && !refuses({ documentId: DOC, body: 'x', parent_id: TOP }, 'reply'), 'a real reply was refused');
    for (const [name, b] of [['a uuid parent', { documentId: DOC, body: 'x', parent_id: TOP }], ['an omitted parent_id', { documentId: DOC, body: 'x' }], ['an undefined parent_id', { documentId: DOC, body: 'x', parent_id: undefined }], ['an empty parent_id', { documentId: DOC, body: 'x', parent_id: '' }], ['the string null', { documentId: DOC, body: 'x', parent_id: 'null' }],
      ['an extra key', { documentId: DOC, body: 'x', parent_id: null, anchorSection: 's' }], ['a bad document', { documentId: 'nope', body: 'x', parent_id: null }], ['an empty body', { documentId: DOC, body: '  ', parent_id: null }], ['a non-string body', { documentId: DOC, body: 5, parent_id: null }], ['no body', { documentId: DOC, parent_id: null }], ['a non-object', 'x']]) check(refuses(b, 'new'), `--new request allowed: ${name}`);
    check(refuses(nul, 'new', `https://example.com/documentsApi/createDocumentComment`) && refuses(nul, 'new', `https://${FN_HOST}/deleteComment`) && refuses(nul, 'new', url, { ...HP, Authorization: 'Bearer x' }) && refuses(nul, 'new', `http://${FN_HOST}/documentsApi/createDocumentComment`), '--new: host, path, extra header or plain http allowed');
    try { guardRequest(`https://${FN_HOST}/documentsApi/createDocumentComment`, 'GET', HP, nul, 'new'); check(false, '--new: a GET was allowed'); } catch (e) { check(e instanceof GuardError, `--new GET: ${e && e.message}`); }
  });

  rc('R34', '--new duplicates: the same words twice on one document inside 10 minutes are refused (exit 3, earlier id printed, one create); a --new and a reply of the SAME words never block each other (either order, even when the reply target id equals the document id: the mode is part of the key); another document, other words, other identity (beta, alpha, gamma each their own slot) and 10 minutes later go through', async () => {
    S.reset();
    const sd = path.join(RUN_DIR, 'new-dup'); const clock = { t: T0 };
    const a = await runCli(S, baseN('same words'), { stateDir: sd, clock });
    check(a.code === 0 && S.creates.length === 1, `first: ${a.code} ${a.errs.join('|')}`);
    const id1 = a.outs[0].slice(-36);
    clock.t += 60000;
    const b = await runCli(S, baseN('same words'), { stateDir: sd, clock });
    check(b.code === 3 && S.creates.length === 1 && b.outs.length === 1 && b.outs[0].includes(id1) && b.outs[0].includes(DOC) && b.sleeps.length === 0, `second: code ${b.code} creates ${S.creates.length} out ${b.outs.join('|')}`);
    check(b.logLines[b.logLines.length - 1].outcome === 'duplicate' && b.logLines[b.logLines.length - 1].mode === 'new' && b.logLines[b.logLines.length - 1].comment_id === id1, `duplicate log ${b.log}`);
    // the SAME words as a reply under a comment: not a duplicate of the --new (and the reverse)
    const c = await runCli(S, base(TOP, 'same words'), { stateDir: sd, clock });
    check(c.code === 0 && S.creates.length === 2 && S.creates[1].body.parent_id === TOP, `reply after --new: code ${c.code} creates ${S.creates.length} err ${c.errs.join('|')}`);
    const d = await runCli(S, base(TOP2, 'cross words'), { stateDir: sd, clock });
    const e = await runCli(S, baseN('cross words'), { stateDir: sd, clock });
    check(d.code === 0 && e.code === 0 && S.creates.length === 4, `--new after a reply: ${d.code} ${e.code} creates ${S.creates.length} err ${e.errs.join('|')}`);
    const d2 = await runCli(S, base(TOP2, 'cross words'), { stateDir: sd, clock });
    const e2 = await runCli(S, baseN('cross words'), { stateDir: sd, clock });
    check(d2.code === 3 && e2.code === 3 && S.creates.length === 4, `each mode still guards its own duplicate: ${d2.code} ${e2.code}`);
    // the mode is part of the key: a reply whose target id is the document id (contrived, ids never collide for real) is still not the --new's duplicate
    S.comments.set(DOC, { id: DOC, parent_id: null, body: 'a comment whose id equals the document id', author_email: 'human@example.com' });
    const f = await runCli(S, baseN('collide words'), { stateDir: sd, clock });
    const g = await runCli(S, base(DOC, 'collide words'), { stateDir: sd, clock });
    check(f.code === 0 && g.code === 0 && S.creates.length === 6 && S.creates[5].body.parent_id === DOC, `mode part of the key: ${f.code} ${g.code} creates ${S.creates.length} err ${g.errs.join('|')}`);
    const stKeys = Object.keys(JSON.parse(g.state).posts);
    check(stKeys.some((k) => k.startsWith(`${AGENT_EMAIL}|${TOP}|${sha256('same words')}`)), `a reply key is agent|root|sha: ${stKeys}`);
    // another document and other words go through
    const h = await runCli(S, ['--document', DOC2, '--new', '--text', 'same words'], { stateDir: sd, clock });
    const i = await runCli(S, baseN('other words'), { stateDir: sd, clock });
    check(h.code === 0 && i.code === 0 && S.creates.length === 8 && S.creates[6].body.documentId === DOC2, `other document / other words: ${h.code} ${i.code} err ${h.errs.join('|')}`);
    // another agent (its own name, address and key) posts the same --new words: it has its own duplicate and its own gap slot
    const u = await runCli(S, baseN('same words'), { stateDir: sd, clock, name: 'Other agent', email: OTHER_EMAIL, key: OTHER_KEY });
    check(u.code === 0 && S.creates.length === 9 && S.creates[8].em === OTHER_EMAIL, `other agent: code ${u.code} creates ${S.creates.length} err ${u.errs.join('|')}`);
    const u2 = await runCli(S, baseN('same words'), { stateDir: sd, clock, name: 'Other agent', email: OTHER_EMAIL, key: OTHER_KEY });
    check(u2.code === 3 && S.creates.length === 9, `other agent own duplicate: ${u2.code}`);
    check(same(Object.keys(JSON.parse(u2.state).last).sort(), [AGENT_EMAIL, OTHER_EMAIL]), `gap slots per agent ${Object.keys(JSON.parse(u2.state).last)}`);
    // after 10 minutes the same --new posts again
    clock.t += 10 * 60 * 1000 + 1000;
    const j = await runCli(S, baseN('same words'), { stateDir: sd, clock });
    check(j.code === 0 && S.creates.length === 10, `after 10 minutes: code ${j.code} ${j.outs.join('|')}`);
  });

  rc('R35', '--new --dry-run: no request at all, exit 0, the line names the document, no state file, logged as a dry-run; a second dry-run is fine; a real --new of the same words right after posts at once (the dry-run reserved nothing); a missing key file and a secret are still caught', async () => {
    S.reset();
    const sd = path.join(RUN_DIR, 'new-dry'); const clock = { t: T0 };
    const r = await runCli(S, baseN('only looking', ['--dry-run']), { stateDir: sd, clock });
    check(r.code === 0 && S.calls.length === 0 && S.creates.length === 0 && r.outs.length === 1 && r.outs[0] === `dry-run: new top-level comment on ${DOC}; nothing posted`, `code ${r.code} calls ${S.calls.length} out ${r.outs.join('|')} err ${r.errs.join('|')}`);
    const l = r.logLines[0];
    check(r.state === '' && !fs.existsSync(path.join(sd, 'state.json')) && r.logLines.length === 1 && l.mode === 'new' && l.outcome === 'dry_run' && l.root === null && l.to === null && l.http_status === null && l.comment_id === null, `state "${r.state}" log ${r.log}`);
    const again = await runCli(S, baseN('only looking', ['--dry-run']), { stateDir: sd, clock });
    check(again.code === 0 && again.outs.length === 1 && S.calls.length === 0, `a second dry-run: code ${again.code}`);
    const real = await runCli(S, baseN('only looking'), { stateDir: sd, clock });
    check(real.code === 0 && real.sleeps.length === 0 && S.creates.length === 1, `a real --new after dry-runs: code ${real.code} waited ${real.sleeps} creates ${S.creates.length}`);
    S.reset();
    const nokey = await runCli(S, baseN('x', ['--dry-run']), { keyPath: '/nonexistent/dir/k.key', stateDir: path.join(RUN_DIR, 'new-dry-nokey') });
    check(nokey.code === 1 && S.calls.length === 0 && /cannot read the key file/.test(nokey.errs.join('')), `a dry-run tells the truth about a missing key file: code ${nokey.code} err ${nokey.errs.join('|')}`);
    const sec = await runCli(S, baseN('token sk-abcdef1234567890', ['--dry-run']));
    check(sec.code === 2 && S.calls.length === 0, `secret in a --new dry-run: code ${sec.code}`);
  });

  // ==== --new on a BOARD task and a MAP: one top-level create { body, parent_id: null }, no thread lookup, the same guard and duplicate rules keyed by the item.
  const baseN = (text, extra = []) => ['--document', DOC, '--new', '--text', text, ...extra];
  const NEW_LINE = (id, doc = DOC) => `posted new top-level comment on ${doc}: ${id}`;
  const LIMIT_MSG = (n) => `agent-reply: refused: the text is ${n} characters; the standing format allows 600`;
  const baseNT = (text, extra = []) => ['--task', TASK_ID, '--new', '--text', text, ...extra];
  const baseNM = (text, extra = []) => ['--map', MAP_ID, '--new', '--text', text, ...extra];

  rc('R42', '--task --new: ONE create to /boardsApi/tasks/<id>/comments with exactly { body, parent_id: null }, NO GET, the id printed is the new comment id, stored top-level on the task, the log line says mode "new" and task', async () => {
    S.reset();
    const sd = path.join(RUN_DIR, 'new-task'); const clock = { t: T0 };
    const text = 'a brand new task level comment';
    const r = await runCli(S, baseNT(text), { stateDir: sd, clock });
    const id = r.outs[0] ? r.outs[0].slice(-36) : '';
    check(r.code === 0 && r.outs.length === 1 && UUID_RE.test(id) && r.outs[0] === `posted new top-level comment on ${TASK_ID}: ${id}`, `code ${r.code} out ${r.outs.join('|')} err ${r.errs.join('|')}`);
    check(S.calls.length === 1 && S.calls[0].m === 'POST' && S.calls[0].p === `/boardsApi/tasks/${TASK_ID}/comments`, `calls ${S.calls.map((c) => `${c.m} ${c.p}`).join('|')}`);
    check(S.creates.length === 1 && S.creates[0].type === 'board' && JSON.stringify(S.calls[0].body) === JSON.stringify({ body: text, parent_id: null }), `create body ${JSON.stringify(S.calls[0].body)}`);
    const row = S.items.board.get(id);
    check(row && row.parent_id === null && row.body === text && row.author_email === 'spm-example-agent@agents.invalid', `stored ${JSON.stringify(row)}`);
    check(r.logLines.length === 1 && r.logLines[0].mode === 'new' && r.logLines[0].task === TASK_ID && !('document' in r.logLines[0]) && r.logLines[0].root === null && r.logLines[0].outcome === 'posted' && r.logLines[0].comment_id === id, `log ${r.log}`);
    check(!r.log.includes(text) && !r.state.includes(text), 'the text reached the log or state file');
  });

  rc('R43', '--map --new: ONE create to /mapsApi/maps/<id>/comments with exactly { body, parent_id: null }, NO GET, the id printed is the new comment id, stored top-level on the map, the log line says mode "new" and map', async () => {
    S.reset();
    const sd = path.join(RUN_DIR, 'new-map'); const clock = { t: T0 };
    const text = 'a brand new map level comment';
    const r = await runCli(S, baseNM(text), { stateDir: sd, clock });
    const id = r.outs[0] ? r.outs[0].slice(-36) : '';
    check(r.code === 0 && r.outs.length === 1 && UUID_RE.test(id) && r.outs[0] === `posted new top-level comment on ${MAP_ID}: ${id}`, `code ${r.code} out ${r.outs.join('|')} err ${r.errs.join('|')}`);
    check(S.calls.length === 1 && S.calls[0].m === 'POST' && S.calls[0].p === `/mapsApi/maps/${MAP_ID}/comments`, `calls ${S.calls.map((c) => `${c.m} ${c.p}`).join('|')}`);
    check(S.creates.length === 1 && S.creates[0].type === 'map' && JSON.stringify(S.calls[0].body) === JSON.stringify({ body: text, parent_id: null }), `create body ${JSON.stringify(S.calls[0].body)}`);
    const row = S.items.map.get(id);
    check(row && row.parent_id === null && row.body === text, `stored ${JSON.stringify(row)}`);
    check(r.logLines.length === 1 && r.logLines[0].mode === 'new' && r.logLines[0].map === MAP_ID && !('document' in r.logLines[0]) && !('task' in r.logLines[0]) && r.logLines[0].root === null && r.logLines[0].outcome === 'posted' && r.logLines[0].comment_id === id, `log ${r.log}`);
  });

  rc('R44', '--task --new --dry-run and --map --new --dry-run: no request at all, exit 0, the line names the item, no state file, logged as a dry-run', async () => {
    S.reset();
    const sd = path.join(RUN_DIR, 'new-item-dry'); const clock = { t: T0 };
    const t = await runCli(S, baseNT('only looking', ['--dry-run']), { stateDir: sd, clock });
    check(t.code === 0 && S.calls.length === 0 && S.creates.length === 0 && t.outs.length === 1 && t.outs[0] === `dry-run: new top-level comment on ${TASK_ID}; nothing posted`, `task dry-run: code ${t.code} calls ${S.calls.length} out ${t.outs.join('|')} err ${t.errs.join('|')}`);
    check(t.state === '' && !fs.existsSync(path.join(sd, 'state.json')) && t.logLines.length === 1 && t.logLines[0].outcome === 'dry_run' && t.logLines[0].task === TASK_ID, `task dry-run state "${t.state}" log ${t.log}`);
    const m = await runCli(S, baseNM('only looking', ['--dry-run']), { stateDir: path.join(RUN_DIR, 'new-item-dry-map'), clock });
    check(m.code === 0 && S.calls.length === 0 && m.outs.length === 1 && m.outs[0] === `dry-run: new top-level comment on ${MAP_ID}; nothing posted`, `map dry-run: code ${m.code} calls ${S.calls.length} out ${m.outs.join('|')}`);
    check(m.logLines.length === 1 && m.logLines[0].outcome === 'dry_run' && m.logLines[0].map === MAP_ID, `map dry-run log ${m.log}`);
  });

  rc('R45', '--new duplicates on the item paths: the same words twice on one task inside 10 minutes are refused (exit 3, earlier id printed, one create); the same words on a map or on a document are not duplicates (the stand-in knows one task, so no second task is tried)', async () => {
    S.reset();
    const sd = path.join(RUN_DIR, 'new-item-dup'); const clock = { t: T0 };
    const text = 'the same words on a task';
    const a = await runCli(S, baseNT(text), { stateDir: sd, clock });
    check(a.code === 0 && S.creates.length === 1, `first: code ${a.code} err ${a.errs.join('|')}`);
    const firstId = a.outs[0].slice(-36);
    clock.t += 60000;
    const b = await runCli(S, baseNT(text), { stateDir: sd, clock });
    check(b.code === 3 && S.creates.length === 1 && b.outs.length === 1 && b.outs[0].includes(firstId), `task duplicate: code ${b.code} creates ${S.creates.length} out ${b.outs.join('|')} err ${b.errs.join('|')}`);
    const d = await runCli(S, baseNM(text), { stateDir: sd, clock });
    check(d.code === 0 && S.creates.length === 2, `same words on a map: code ${d.code} creates ${S.creates.length} err ${d.errs.join('|')}`);
    const e = await runCli(S, ['--document', DOC, '--new', '--text', text], { stateDir: sd, clock });
    check(e.code === 0 && S.creates.length === 3, `same words on a document: code ${e.code} creates ${S.creates.length} err ${e.errs.join('|')}`);
  });

  rc('R46', 'the allow-list on the item paths: mode new admits exactly { body, parent_id: null } on the task and map routes; a uuid, omitted, empty or string parent_id, extra keys, an empty body or a GET with a body are refused; a null parent is refused in reply mode; a reply body with a uuid parent still passes', async () => {
    const H = { 'X-SPM-API-Key': 'k', 'X-SPM-User-Email': 'e@x' }; const HO = { ...H, Origin: ORIGIN };
    const TL = `https://${FN_HOST}/boardsApi/tasks/${TASK_ID}/comments`; const ML = `https://${FN_HOST}/mapsApi/maps/${MAP_ID}/comments`;
    const refuses = (u, m, h, b, mode) => { try { guardRequest(u, m, h, b, mode); return false; } catch (e) { return e instanceof GuardError; } };
    for (const u of [TL, ML]) {
      const nul = { body: 'x', parent_id: null };
      check(!refuses(u, 'POST', HO, nul, 'new'), `--new { body, parent_id: null } refused on ${u}`);
      check(refuses(u, 'POST', HO, nul, 'reply') && refuses(u, 'POST', HO, nul), `a null parent passed in reply mode on ${u}`);
      check(!refuses(u, 'POST', HO, { body: 'x', parent_id: REPLY }, 'reply'), `a reply refused on ${u}`);
      for (const [name, b] of [['a uuid parent', { body: 'x', parent_id: BTOP }], ['an omitted parent_id', { body: 'x' }], ['an empty parent_id', { body: 'x', parent_id: '' }], ['the string null', { body: 'x', parent_id: 'null' }], ['an extra key', { body: 'x', parent_id: null, mentions: [] }], ['an empty body', { body: '  ', parent_id: null }], ['a non-string body', { body: 5, parent_id: null }], ['a non-object', 'x']]) {
        check(refuses(u, 'POST', HO, b, 'new'), `--new request allowed on ${u}: ${name}`);
      }
      check(refuses(u, 'POST', H, nul, 'new'), `--new without the Origin header allowed on ${u}`);
      check(refuses(u, 'GET', H, { x: 1 }, 'new') && !refuses(u, 'GET', H, undefined, 'new'), `--new GET: the body rule on ${u}`);
      check(refuses(u, 'DELETE', HO, nul, 'new'), `--new DELETE allowed on ${u}`);
    }
  });

  rc('R36', 'the 600-character limit counts Unicode code points of the text as posted, in reply mode, in --new, and in --dry-run: 600 passes, 601 is refused (exit 2, one stderr line with N, nothing sent, no state, nothing reserved); 600 and 601 astral characters; a text file loses ONE trailing newline', async () => {
    const X = (n) => 'x'.repeat(n); const E = (n) => '\u{1F600}'.repeat(n); // x is not a hex digit, so the 40-hex secret pattern does not fire
    const modes = [['reply', (t, x = []) => base(TOP, t, x)], ['new', (t, x = []) => baseN(t, x)]];
    for (const [mname, mk] of modes) for (const dry of [false, true]) for (const [label, mkText] of [['ascii', X], ['emoji', E]]) {
      const tag = `${mname}${dry ? ' dry-run' : ''} ${label}`; const extra = dry ? ['--dry-run'] : [];
      S.reset();
      const ok = await runCli(S, mk(mkText(600), extra));
      check(ok.code === 0 && (dry ? S.creates.length === 0 : S.creates.length === 1 && S.creates[0].body.body === mkText(600)), `${tag} 600: code ${ok.code} creates ${S.creates.length} err ${ok.errs.join('|')}`);
      S.reset();
      const sd = path.join(RUN_DIR, `lim-${mname}-${dry}-${label}`);
      const no = await runCli(S, mk(mkText(601), extra), { stateDir: sd });
      check(no.code === 2 && S.calls.length === 0 && no.outs.length === 0 && same(no.errs, [LIMIT_MSG(601)]) && no.state === '' && !fs.existsSync(path.join(sd, 'state.json')), `${tag} 601: code ${no.code} calls ${S.calls.length} err ${no.errs.join('|')}`);
    }
    // N is printed as counted: 1000 characters; and an emoji is ONE character (601 emoji print 601, not 1202)
    S.reset();
    const big = await runCli(S, baseN(X(1000)));
    check(big.code === 2 && same(big.errs, [LIMIT_MSG(1000)]) && S.calls.length === 0, `1000: ${big.errs.join('|')}`);
    const bigE = await runCli(S, base(TOP, E(601), ['--dry-run']));
    check(bigE.code === 2 && same(bigE.errs, [LIMIT_MSG(601)]), `601 emoji: ${bigE.errs.join('|')}`);
    // a text file: ONE trailing newline is stripped (so 600 + newline passes); a second newline is part of the text as posted (601: refused)
    const f1 = path.join(RUN_DIR, 'lim-600.txt'); fs.writeFileSync(f1, `${X(600)}\n`);
    const f2 = path.join(RUN_DIR, 'lim-601.txt'); fs.writeFileSync(f2, `${X(600)}\n\n`);
    const f3 = path.join(RUN_DIR, 'lim-crlf.txt'); fs.writeFileSync(f3, `${X(600)}\r\n`);
    for (const [mname, mkf] of [['reply', (f) => ['--document', DOC, '--to', TOP, '--text-file', f]], ['new', (f) => ['--document', DOC, '--new', '--text-file', f]]]) {
      S.reset();
      const a = await runCli(S, mkf(f1)); const c = await runCli(S, mkf(f3), { stateDir: path.join(RUN_DIR, `lim-crlf-${mname}`) });
      check(a.code === 0 && c.code === 0 && S.creates.length === 2 && S.creates[0].body.body === X(600) && S.creates[1].body.body === X(600), `${mname} file 600: ${a.code} ${c.code} err ${a.errs.join('|')}${c.errs.join('|')}`);
      S.reset();
      const b = await runCli(S, mkf(f2));
      check(b.code === 2 && same(b.errs, [LIMIT_MSG(601)]) && S.calls.length === 0, `${mname} file 600 plus two newlines: ${b.code} ${b.errs.join('|')}`);
    }
    // a refused text reserves nothing: the next valid post at the same clock does not wait and the state holds exactly one entry
    for (const [mname, mk] of modes) {
      S.reset();
      const sd = path.join(RUN_DIR, `lim-slot-${mname}`); const clock = { t: T0 };
      const no = await runCli(S, mk(X(601)), { stateDir: sd, clock });
      const yes = await runCli(S, mk('a short one'), { stateDir: sd, clock });
      check(no.code === 2 && no.state === '' && yes.code === 0 && yes.sleeps.length === 0 && Object.keys(JSON.parse(yes.state).posts).length === 1, `${mname}: a refused text reserved a slot: refused ${no.code} state "${no.state}" next waited ${yes.sleeps}`);
      const no2 = await runCli(S, mk(X(601)), { stateDir: sd, clock });
      check(no2.code === 2 && no2.state === yes.state, `${mname}: a refused text changed the state`);
    }
  });

  rc('R37', 'the secret scan applies to --new text exactly as in reply mode: every pattern is refused (exit 2, nothing sent), also in --dry-run; ordinary words that merely contain "sk-" pass', async () => {
    const bads = ['my key is sk-abcdef1234567890', 'ghp_abcdefghij1234567890', 'AKIA' + 'ABCDEFGHIJKLMNOP', 'sbp_0123456789abcdef', `hash ${'a1b2c3d4e5'.repeat(4)}`, 'X-SPM-API-Key: abcdefghijklmnopqrstuv', 'Authorization: Bearer abcdefghijklmnop1234', `${FAKE_KEY}`, 'token eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJ4In0.sig', 'AI' + 'zaSyA-0123456789abcdefghijklmnop'];
    for (const t of bads) {
      S.reset();
      const r = await runCli(S, baseN(t));
      check(r.code === 2 && S.calls.length === 0 && r.outs.length === 0 && r.errs.some((e) => /refused/.test(e)), `--new text "${t.slice(0, 20)}": code ${r.code} calls ${S.calls.length} err ${r.errs.join('|')}`);
      const d = await runCli(S, baseN(t, ['--dry-run']));
      check(d.code === 2 && S.calls.length === 0, `--new dry-run "${t.slice(0, 20)}": code ${d.code}`);
    }
    S.reset();
    const ok = await runCli(S, baseN('a risk-based task-force, the X-SPM-API-Key header and the Bearer scheme, commit 220f869 and abc123'));
    check(ok.code === 0 && S.creates.length === 1, `benign --new text refused: code ${ok.code} err ${ok.errs.join('|')}`);
  });

  rc('R40', '--new keeps the 3.2 s spacing: two --new posts of one agent are at least 3.2 s apart, and a reply and a --new share that agent\'s ONE slot (either order); another agent has its own', async () => {
    S.reset();
    const sd = path.join(RUN_DIR, 'new-gap'); const clock = { t: T0 };
    const a = await runCli(S, baseN('first new'), { stateDir: sd, clock });
    check(a.code === 0 && a.sleeps.length === 0, `first --new waited ${a.sleeps}`);
    clock.t += 1000;
    const b = await runCli(S, baseN('second new'), { stateDir: sd, clock });
    check(b.code === 0 && b.sleeps.length === 1 && b.sleeps[0] === 2200, `second --new waited ${b.sleeps}`);
    clock.t += 1000;
    const c = await runCli(S, base(TOP, 'a reply right after'), { stateDir: sd, clock });
    check(c.code === 0 && c.sleeps.length === 1 && c.sleeps[0] === 2200, `reply after --new waited ${c.sleeps}`);
    clock.t += 1000;
    const d = await runCli(S, baseN('a new right after a reply'), { stateDir: sd, clock });
    check(d.code === 0 && d.sleeps.length === 1 && d.sleeps[0] === 2200, `--new after a reply waited ${d.sleeps}`);
    clock.t += 1000;
    const u = await runCli(S, baseN('other agent own slot'), { stateDir: sd, clock, name: 'Other agent', email: OTHER_EMAIL, key: OTHER_KEY });
    check(u.code === 0 && u.sleeps.length === 0, `other agent --new waited ${u.sleeps} (its own slot)`);
    clock.t += 5000;
    const e = await runCli(S, baseN('after the gap'), { stateDir: sd, clock });
    check(e.code === 0 && e.sleeps.length === 0, `after 5 s waited ${e.sleeps}`);
  });

  rc('R39', 'the stand-in itself applies the real top-level rule (no parent: null, absent or empty, and no anchor, is accepted and stored top-level; an anchor quote without a section, an unknown section, a reply to a reply, a missing parent and an unknown document are refused)', async () => {
    S.reset();
    const tr = makeTransport({ lib: http, resolveTarget: () => ({ hostname: '127.0.0.1', port: S.port }) });
    const post = async (b) => { const res = await tr('https://x.invalid/documentsApi/createDocumentComment', 'POST', { Origin: ORIGIN, 'X-SPM-API-Key': FAKE_KEY, 'X-SPM-User-Email': 'spm-example-agent@agents.invalid' }, b); return { status: res.status, json: parseJson(res.text) }; };
    for (const [name, b] of [['parent_id null', { documentId: DOC, body: 't1', parent_id: null }], ['parent_id absent', { documentId: DOC, body: 't2' }], ['parent_id empty', { documentId: DOC, body: 't3', parent_id: '' }]]) {
      const r = await post(b);
      check(r.status === 200 && r.json && r.json.parent_id === null && S.comments.get(r.json.id) && S.comments.get(r.json.id).parent_id === null, `${name}: ${r.status} ${JSON.stringify(r.json)}`);
    }
    for (const [name, b, st] of [['an anchor quote without a section', { documentId: DOC, body: 'x', parent_id: null, anchorQuote: 'q' }, 400], ['an unknown section', { documentId: DOC, body: 'x', parent_id: null, anchorSection: 's' }, 400], ['a reply to a reply', { documentId: DOC, body: 'x', parent_id: REPLY }, 400],
      ['a missing parent', { documentId: DOC, body: 'x', parent_id: '00000000-0000-4000-8000-00000000000f' }, 404], ['an unknown document', { documentId: '00000000-0000-4000-8000-000000000014', body: 'x', parent_id: null }, 400], ['an empty body', { documentId: DOC, body: ' ', parent_id: null }, 400]]) {
      const n = S.comments.size; const r = await post(b);
      check(r.status === st && S.comments.size === n, `${name}: expected ${st}, got ${r.status} (comments ${n} -> ${S.comments.size})`);
    }
    S.reset();
  });
  rc('C01', 'settings file: no --config and no SPM_AGENT_CONFIG: exit 2, one plain line on stderr, nothing sent', async () => {
    S.reset();
    const r = await runCli(S, base(TOP, 'x'), { noConfig: true, env: {} });
    check(r.code === 2 && S.calls.length === 0 && r.errs.length === 1 && r.errs[0] === 'agent-reply: no settings file: pass --config <absolute path> or set SPM_AGENT_CONFIG', `no config: code ${r.code} errs ${JSON.stringify(r.errs)}`);
  });
  rc('C02', 'settings file: a relative path, a missing file, bad JSON, a missing name and a non-agents.invalid address are each refused (exit 2, one line, nothing sent)', async () => {
    S.reset();
    const dir = path.join(RUN_DIR, 'c-bad'); fs.mkdirSync(dir, { recursive: true });
    const bad = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
    const cases2 = [
      [['--config', 'relative/agent.json', ...base(TOP, 'x')], 'the settings file path must be absolute'],
      [['--config', path.join(dir, 'missing.json'), ...base(TOP, 'x')], 'cannot read the settings file (ENOENT)'],
      [['--config', bad('not-json.json', '{ nope'), ...base(TOP, 'x')], 'the settings file is not valid JSON'],
      [['--config', bad('no-name.json', JSON.stringify({ agent: { email: AGENT_EMAIL }, key_file: '/abs/k.key' })), ...base(TOP, 'x')], 'agent.name is missing'],
      [['--config', bad('bad-mail.json', JSON.stringify({ agent: { name: 'Example agent', email: 'Someone@example.com' }, key_file: '/abs/k.key' })), ...base(TOP, 'x')], 'agent.email must be a lower-case address ending in @agents.invalid'],
    ];
    for (const [argv, want] of cases2) {
      const r = await runCli(S, argv, { noConfig: true, env: {} });
      check(r.code === 2 && S.calls.length === 0 && r.errs.length === 1 && r.errs[0] === `agent-reply: ${want}`, `want "${want}": code ${r.code} errs ${JSON.stringify(r.errs)}`);
    }
  });
  rc('C03', 'settings file: SPM_AGENT_CONFIG is used when --config is absent; --config wins when both are set', async () => {
    S.reset();
    const sd = path.join(RUN_DIR, 'c03-state');
    const first = await runCli(S, base(TOP, 'by the file'), { stateDir: sd });
    check(first.code === 0 && S.creates.length === 1, `file via --config: code ${first.code} ${first.errs.join('|')}`);
    const viaEnv = await runCli(S, base(TOP2, 'by the env'), { noConfig: true, env: { SPM_AGENT_CONFIG: first.configFile }, stateDir: sd });
    check(viaEnv.code === 0 && S.creates.length === 2 && S.creates[1].em === AGENT_EMAIL, `file via env: code ${viaEnv.code} ${viaEnv.errs.join('|')}`);
    const both = await runCli(S, base(TOP, 'both set'), { env: { SPM_AGENT_CONFIG: path.join(RUN_DIR, 'absent.json') }, stateDir: sd, clock: { t: T0 + 3600000 } });
    check(both.code === 0 && S.creates.length === 3, `--config beats the env: code ${both.code} ${both.errs.join('|')}`);
  });
  rc('C04', 'settings file: a config with no key_file is refused by a script that needs a key (exit 2, nothing sent), dry-run included', async () => {
    S.reset();
    const a = await runCli(S, base(TOP, 'x'), { noKeyFile: true });
    check(a.code === 2 && S.calls.length === 0 && a.errs.join('') === 'agent-reply: network-secret mode needs the Claude cloud proxy; set key_file to run elsewhere' && a.outs.length === 0, `no key_file: code ${a.code} errs ${a.errs.join('|')}`);
    const b = await runCli(S, base(TOP, 'x', ['--dry-run']), { noKeyFile: true });
    check(b.code === 2 && S.calls.length === 0, `no key_file, dry-run: code ${b.code}`);
  });
  rc('C06', 'network-secret mode: with a proxy set and no key_file, the post sends the placeholder as X-SPM-API-Key and reads no key file', async () => {
    S.reset();
    const saved = process.env.HTTPS_PROXY; process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    try {
      const a = await runCli(S, base(TOP, 'placeholder words'), { noKeyFile: true, env: { HTTPS_PROXY: 'http://127.0.0.1:9' } });
      check(S.calls.length >= 1 && S.calls.every((c) => c.key === NETWORK_SECRET_VALUE), `keys sent ${JSON.stringify(S.calls.map((c) => c.key))} code ${a.code} errs ${a.errs.join('|')}`);
    } finally { if (saved === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = saved; }
  });
  rc('C05', 'settings file: the agent name is shown in the log and the state is keyed by the address, so two agents never share a slot', async () => {
    S.reset();
    const sd = path.join(RUN_DIR, 'c05-state'); const clock = { t: T0 };
    const a = await runCli(S, base(TOP, 'one words'), { stateDir: sd, clock });
    const b = await runCli(S, base(TOP, 'one words'), { stateDir: sd, clock, name: 'Other agent', email: OTHER_EMAIL, key: OTHER_KEY });
    check(a.code === 0 && b.code === 0 && S.creates.length === 2, `two agents, same words: ${a.code} ${b.code} creates ${S.creates.length} ${b.errs.join('|')}`);
    const st = JSON.parse(b.state);
    check(same(Object.keys(st.last).sort(), [AGENT_EMAIL, OTHER_EMAIL].sort()), `state keys ${Object.keys(st.last)}`);
    check(b.logLines[b.logLines.length - 1].identity === OTHER_EMAIL && b.logLines[0].identity === AGENT_EMAIL, `log identity ${b.log}`);
  });
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- R1 selftest: a REAL local proxy on 127.0.0.1 records the first request line. The call goes through the real transport and a guarded lib that refuses any request without a proxy agent, so no direct production socket can open even when the code is wrong.
async function proxyRouteCase(withProxy) {
  const net = require('net');
  const hits = []; const seen = []; const unhandled = [];
  const proxy = net.createServer((s) => { s.on('error', () => {}); s.once('data', (d) => { hits.push(d.toString('latin1').split('\r\n')[0]); s.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); }); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy };
  const onUnhandled = (e) => unhandled.push(String((e && e.code) || (e && e.message) || e));
  process.on('uncaughtException', onUnhandled);
  const guardedLib = { request: (opts, cb) => { seen.push(opts.agent); if (!opts.agent) throw new Error('selftest refuses a direct production socket'); return https.request(opts, cb); } };
  try {
    for (const k of ['HTTPS_PROXY', 'https_proxy']) { if (withProxy) process.env[k] = `http://127.0.0.1:${proxy.address().port}`; else delete process.env[k]; }
    const transport = makeTransport({ lib: guardedLib, resolveTarget: (u) => ({ hostname: u.hostname, port: 443 }) });
    let outcome = null;
    try { await transport(`https://${FN_HOST}/documentsApi/listDocumentComments`, 'POST', { 'x-spm-api-key': 'selftest-fake-key', 'x-spm-user-email': 'selftest@agents.invalid' }, { documentId: '00000000-0000-4000-8000-000000000000' }, { timeoutMs: 3000 }); outcome = 'resolved'; } catch (e) { outcome = `rejected:${String((e && e.code) || (e && e.message)).slice(0, 40)}`; }
    await new Promise((r) => setTimeout(r, 150));
    check(unhandled.length === 0, `an unhandled error reached the process: ${unhandled.join(',')} (outcome ${outcome})`);
    if (withProxy) {
      check(hits.length === 1 && hits[0] === `CONNECT ${FN_HOST}:443 HTTP/1.1`, `the proxy received ${JSON.stringify(hits)}, want one CONNECT to ${FN_HOST}:443 (outcome ${outcome})`);
      check(seen.length === 1 && !!seen[0] && typeof seen[0] === 'object', 'the request did not go through a proxy agent');
    } else {
      check(hits.length === 0, `the proxy received ${JSON.stringify(hits)} with HTTPS_PROXY unset`);
      check(seen.length === 1 && seen[0] === false, `agent with HTTPS_PROXY unset is ${JSON.stringify(seen[0])}, want false (today's behaviour)`);
    }
  } finally {
    process.removeListener('uncaughtException', onUnhandled);
    for (const k of ['HTTPS_PROXY', 'https_proxy']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await new Promise((r) => proxy.close(r));
  }
}

async function selftest() {
  const say = (s) => process.stdout.write(s + '\n');
  say('FAKE: agent-reply selftest. A LOCAL real http server on 127.0.0.1 answers like the two production routes (a contract-faithful stand-in: production needs Postgres), a fake clock, a fake key. No production call, no real key file read.');
  RUN_DIR = path.join(os.tmpdir(), 'agent-reply-selftest', `${Date.now()}-${process.pid}`);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const S = makeStandIn();
  await S.start();
  const cases = [];
  defineCases(cases, S);
  cases.push({ id: 'P1a', name: 'R1: with HTTPS_PROXY set, a real call to the production host goes through the proxy as CONNECT to that host (no direct socket, no crash)', fn: () => proxyRouteCase(true) });
  cases.push({ id: 'P1b', name: 'R1: with HTTPS_PROXY unset, the call keeps agent:false and the proxy receives nothing', fn: () => proxyRouteCase(false) });
  let pass = 0; let fail = 0;
  try {
    for (const c of cases) {
      let err = null; const c0 = Date.now();
      try { await c.fn(); } catch (e) { err = e; }
      if (err) { fail++; say(`FAIL ${c.id} ${c.name}: ${String(err && err.message).slice(0, 300)} [${Date.now() - c0} ms]`); } else { pass++; say(`PASS ${c.id} ${c.name} [${Date.now() - c0} ms]`); }
    }
  } finally { await S.stop(); }
  say(`SELFTEST ${pass} passed, ${fail} failed (scratch folder ${RUN_DIR})`);
  return fail === 0 ? 0 : 1;
}

module.exports = { parseArgs, guardRequest, GuardError, firstKeyLike, makeTransport, run, main, realDeps, selftest, istIso };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const go = argv.length === 1 && argv[0] === '--selftest' ? selftest() : main(argv, realDeps());
  Promise.resolve(go).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`agent-reply: unexpected failure (${word(e && e.name)})\n`); process.exitCode = 1; });
}
