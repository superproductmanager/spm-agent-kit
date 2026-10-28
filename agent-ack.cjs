#!/usr/bin/env node
'use strict';
/**
 * agent-ack.cjs: a filter between the listener and the agent. It reads the listener's JSON lines on stdin and writes each line to stdout again,
 * in the same order, with a few keys added. It never drops a line; a failure only changes the keys it adds.
 *
 *   node agent-listen.cjs ... | node agent-ack.cjs --config <absolute path to settings file> [--mention "<name>" ...] [--self-id <uuid>] [--no-text-ack]
 *   node agent-ack.cjs --selftest     OFFLINE: a local http server stands in for the API; a fake key; no network call, no real key file is read.
 *
 * SETTINGS FILE. --config <path>, or the environment variable SPM_AGENT_CONFIG. It names the agent (agent.name is the agent's display name in SPM, and the
 * name it is mentioned by) and gives key_file. ignore_agents lists the names of other agents: a comment that names one of them, and not this agent, is not for this agent.
 *
 * ADDED KEYS. "addressed" (true or false) is always added. "acked" is true, false, or null (no reaction was tried). "ack_error" is added when the reaction failed:
 * http_<status>, network, timeout, rate_limited, bad_ids, no_key, guard, internal or lookup. "reason" is added only for "group" or "thread" (a line
 * addressed by name has no reason key). "text_acked" is last: true, false, or null (no text reply was tried). An input line's own keys with these names are replaced.
 * A line that is not a JSON object passes through unchanged. A failure never delays a line beyond its request timeout (8 s; the thread lookup 2 s).
 *
 * ADDRESSED RULE. addressed is true only for a human comment.created or comment.replied that either (a) names this agent (its name as "@<name>",
 * any case, runs of whitespace count as one space), or (b) names no agent and uses a group word: "both of you", "you both", "you two", "all agents",
 * "the agents" or "agents", as a standalone word. A comment that names another agent (from ignore_agents) and not this one is never addressed.
 * A comment written by an agent is never addressed.
 *
 * THREAD RULE (a reaction only; reason "thread"; addressed stays false). A human comment that is not addressed is reacted to when its thread was started
 * by this agent, or the most recent earlier comment of the thread is this agent's. This needs one listDocumentComments call per thread
 * (POST documentsApi/listDocumentComments { documentId }, with the key and address headers only). "This agent's" means the server's author_is_you flag,
 * or author_identity equal to --self-id. Answers are cached per thread for 60 s. A failed lookup gives no reaction and ack_error "lookup".
 *
 * REACTION. For an addressed line, or a thread-rule line of a document: POST documentsApi/reactToDocumentComment with Origin, the key and the address,
 * body { documentId, commentId, emoji, op: "add" } and the emoji eyes. Only HTTP 200 counts as acked. Each comment is reacted to once per process;
 * at most 30 requests per rolling minute per process.
 *
 * TEXT REPLY. For every addressed line (not for a thread-rule line, not for other agents' comments, not for an agent's comment), this script also posts
 * ONE reply: documentsApi/createDocumentComment (or the board or map comment route for item lines) with the text
 * "Seen by the <name> at HH:MM IST. Working on it; the answer follows in this thread." (IST, from the system clock). The reply goes under the thread root.
 * Document replies carry the Idempotency-Key "ack-text:<comment id>". The guard refuses any other text. Each comment is replied to once per process;
 * at most 10 replies per rolling minute per process. --no-text-ack turns the text reply off.
 *
 * BOARD AND MAP LINES. The listener's board and map lines carry item_type ("board" or "map") and item_id. An addressed board or map line gets the
 * text reply only (no reaction, no thread rule, no lookup): POST boardsApi/tasks/<task_id>/comments or mapsApi/maps/<item_id>/comments, with
 * body { body, parent_id }. No Idempotency-Key is sent on these routes.
 *
 * NOTICE LINES. The listener may also print kind "notice" lines (an inbox notice with item {type, id}, comment_id, thread_root_id, task_id and reason).
 * Only a mentioned human comment is answered: the eyes and the text reply on a document, the text reply only on a board or map.
 * A participant notice is answered only when it tags this agent.
 *
 * KEY. The key is read once at start from key_file and sent only as the X-SPM-API-Key header. It is never printed or written; any output line that
 * contains it is redacted. The server's reply body is discarded unread. If the key cannot be read, one notice goes to stderr, every addressed line is
 * printed with acked false and ack_error no_key, and nothing is sent.
 *
 * EXIT CODES. 0 when stdin ends (or SIGTERM or SIGINT after the lines in flight are printed); 2 usage or settings error.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { loadConfig, ConfigError } = require(path.join(__dirname, 'lib', 'config.cjs'));
const { keyMode, NETWORK_SECRET_VALUE } = require(path.join(__dirname, 'lib', 'key-mode.cjs')); // K-A3 item 1

const FN_HOST = 'asia-south1-litethink.cloudfunctions.net';
const FN_PATH = '/documentsApi/reactToDocumentComment';
const ENDPOINT_URL = `https://${FN_HOST}${FN_PATH}`;
const ORIGIN = 'https://app.superproductmanager.ai';
const EMOJI = '\u{1F440}'; // eyes
const MAX_PER_MINUTE = 30;
const REQUEST_TIMEOUT_MS = 8000;
const SEEN_CAP = 1000;
const LIST_PATH = '/documentsApi/listDocumentComments';
const LIST_URL = `https://${FN_HOST}${LIST_PATH}`;
const LOOKUP_TIMEOUT_MS = 2000;
const THREAD_CACHE_MS = 60000;
const THREAD_CAP = 500;
const LIST_MAX_BYTES = 8 * 1024 * 1024;
const CREATE_PATH = '/documentsApi/createDocumentComment';
const CREATE_URL = `https://${FN_HOST}${CREATE_PATH}`;
const TEXT_TIMEOUT_MS = 2000;
const TEXT_MAX_PER_MINUTE = 10;
const ITEM_PATH_RE = /^\/(?:boardsApi\/tasks|mapsApi\/maps)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/comments$/; // the board (task) and map comment routes (lower-case ids only; the line's ids are lower-cased first)
const IDEM_RE = /^ack-text:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The one comment text this script posts: "Seen by the <agent name> at HH:MM IST. Working on it; the answer follows in this thread." Built from the settings file's name (setAckName, called by main).
let ACK_TEXT_RE = null;
function setAckName(name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  ACK_TEXT_RE = new RegExp(`^Seen by the ${esc} at (?:[01]\\d|2[0-3]):[0-5]\\d IST\\. Working on it; the answer follows in this thread\\.$`);
}
const ackTextOk = (t) => ACK_TEXT_RE !== null && ACK_TEXT_RE.test(t);
// group words (matched on the normalised, lower-case text): standalone only, so agentic, agent's, sub-agents, AGENTS.md and an e-mail at agents.invalid do not count
const GROUP_RE = /(?<![a-z0-9_@-])@?(?:both of you|you both|you two|all agents|the agents|agents)(?![a-z0-9_-]|\.[a-z0-9])/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACK_KINDS = ['comment.created', 'comment.replied'];
const USAGE = 'usage: node agent-ack.cjs --config <absolute path> [--mention "<name>" ...] [--self-id <uuid>] [--no-text-ack]  (reads listener lines on stdin)  |  node agent-ack.cjs --selftest';

const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const word = (s) => (typeof s === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(s) ? s : 'unknown');
/** what kind of listener line: 'document' (no item_type key), 'board' or 'map' (item_type), or 'bad' (an item_type that is neither, or a line that carries both item_type and document_id) */
function lineKind(o) {
  if (!Object.prototype.hasOwnProperty.call(o, 'item_type')) return 'document';
  if ((o.item_type !== 'board' && o.item_type !== 'map') || Object.prototype.hasOwnProperty.call(o, 'document_id')) return 'bad';
  return o.item_type;
}
/** the ids of a board or map line, lower-cased, or null when one is malformed (a board line needs task_id too); root is null when thread_root_id is missing or malformed (nothing to reply under) */
function itemIds(o, kind) {
  const ok = (v) => typeof v === 'string' && UUID_RE.test(v);
  if (!ok(o.item_id) || !ok(o.comment_id) || (kind === 'board' && !ok(o.task_id))) return null;
  return { item: o.item_id.toLowerCase(), comment: o.comment_id.toLowerCase(), task: kind === 'board' ? o.task_id.toLowerCase() : null, root: ok(o.thread_root_id) ? o.thread_root_id.toLowerCase() : null };
}

// ---------------------------------------------------------------- arguments
// argv is the command line WITHOUT --config (main strips it). Reads nothing.
function parseArgs(argv) {
  const bad = (msg) => ({ ok: false, msg });
  const o = { mentions: [], selfId: null, noTextAck: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-text-ack') { if (o.noTextAck) return bad('--no-text-ack given twice'); o.noTextAck = true; continue; }
    if (!['--mention', '--self-id'].includes(a)) return bad(`unknown argument ${JSON.stringify(String(a).slice(0, 40))}`);
    if (i + 1 >= argv.length) return bad(`${a} needs a value`);
    const v = argv[++i];
    if (a === '--mention') o.mentions.push(v);
    else { if (o.selfId !== null) return bad('--self-id given twice'); o.selfId = v; }
  }
  if (o.selfId !== null && !UUID_RE.test(o.selfId)) return bad('--self-id must be a uuid');
  for (const n of o.mentions) if (typeof n !== 'string' || norm(n) === '' || n.length > 80) return bad('--mention must be a non-empty name of at most 80 characters');
  return { ok: true, cfg: { selfId: o.selfId !== null ? o.selfId.toLowerCase() : null, textAck: !o.noTextAck, mentions: o.mentions } };
}
// ---------------------------------------------------------------- the addressed rule
/** a human comment of a kind we react to (comment.created / comment.replied); the same gate for the name rule, the group words and the thread rule */
function eligible(o) {
  if (o.author_kind !== 'human') return false;
  if (!ACK_KINDS.includes(o.kind)) return false;
  return true;
}
/** 'named' (this agent's name), 'other' (only OTHER agents are named), 'group' (group words, nobody named), or null */
function addressedReason(o, mentions, others) {
  if (!eligible(o)) return null;
  const text = typeof o.body === 'string' ? o.body : (typeof o.excerpt === 'string' ? o.excerpt : '');
  const t = norm(text);
  if (mentions.some((m) => t.includes(m))) return 'named';
  if ((others || []).some((m) => t.includes(m))) return 'other';
  if (GROUP_RE.test(t)) return 'group';
  return null;
}
function isAddressed(o, mentions, others) {
  const why = addressedReason(o, mentions, others);
  return why === 'named' || why === 'group';
}
/** an inbox NOTICE line (agent-listen.cjs, kind "notice") as the listener line its comment stands for, or null when it is not ours: ONLY a MENTIONED human comment.created / comment.replied on a document, a map, or a board with a task_id, with well-formed ids. A notice carries no text, so no name or group rule applies. */
function noticeAsLine(o) {
  if (o.reason !== 'mentioned' || !ACK_KINDS.includes(o.verb) || o.actor_kind !== 'human') return null;
  const ok = (v) => typeof v === 'string' && UUID_RE.test(v);
  const it = o.item;
  if (!isPlainObject(it) || !ok(it.id) || !ok(o.comment_id)) return null;
  if (it.type === 'document') return { document_id: it.id, comment_id: o.comment_id, thread_root_id: o.thread_root_id };
  if (it.type === 'map') return { item_type: 'map', item_id: it.id, comment_id: o.comment_id, task_id: null, thread_root_id: o.thread_root_id };
  if (it.type === 'board' && ok(o.task_id)) return { item_type: 'board', item_id: it.id, comment_id: o.comment_id, task_id: o.task_id, thread_root_id: o.thread_root_id };
  return null;
}
/** the thread's comments (the root and its direct replies, in list order = created_at ASC) from a listDocumentComments reply, each marked "mine" when the server says author_is_you or author_identity is selfId */
function snapshotOf(r, root, selfId, withText) {
  if (!r || r.status !== 200 || !isPlainObject(r.json) || !Array.isArray(r.json.comments)) return { ok: false };
  const thread = [];
  for (const c of r.json.comments) {
    if (!isPlainObject(c) || typeof c.id !== 'string') continue;
    const id = c.id.toLowerCase();
    const parent = typeof c.parent_id === 'string' ? c.parent_id.toLowerCase() : null;
    if (id !== root && parent !== root) continue;
    thread.push({ id, mine: c.author_is_you === true || (selfId !== null && typeof c.author_identity === 'string' && c.author_identity.toLowerCase() === selfId), ...(withText ? { body: c.body, author_kind: c.author_kind } : {}) });
  }
  const first = thread.find((c) => c.id === root);
  return { ok: true, thread, rootMine: Boolean(first && first.mine) };
}
/** the thread rule's answer for one comment, from a thread snapshot: true (the thread's root is ours, or the comment just before this one is), false, or null (a failed list, or the comment is not in it) */
function verdictOf(snap, me) {
  if (!snap.ok) return null;
  if (snap.rootMine) return true;
  const idx = snap.thread.findIndex((c) => c.id === me);
  if (idx < 0) return null;
  const prev = idx > 0 ? snap.thread[idx - 1] : null;
  return prev !== null && prev.mine;
}

// ---------------------------------------------------------------- the transport (real https in a run; plain http to a local stand-in in the selftest: the SAME guard and code either way)
class GuardError extends Error { constructor(m) { super(m); this.name = 'GuardError'; } }
function guardRequest(urlStr, method, headers, bodyStr) {
  const fail = (m) => { throw new GuardError(m); };
  let u; try { u = new URL(urlStr); } catch { fail('bad url'); }
  if (u.protocol !== 'https:' || u.hostname !== FN_HOST || u.port !== '' || u.pathname !== FN_PATH || u.search !== '' || u.hash !== '') fail('only POST ' + ENDPOINT_URL + ' is allowed');
  if (method !== 'POST') fail('method');
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  if (names.join(',') !== 'origin,x-spm-api-key,x-spm-user-email') fail('header names');
  let b; try { b = JSON.parse(bodyStr); } catch { fail('body not json'); }
  if (!isPlainObject(b) || Object.keys(b).sort().join(',') !== 'commentId,documentId,emoji,op') fail('body keys');
  if (b.op !== 'add') fail('op must be add');
  if (b.emoji !== EMOJI) fail('emoji');
  if (!UUID_RE.test(b.documentId) || !UUID_RE.test(b.commentId)) fail('ids');
}
// ---------------------------------------------------------------- the proxy: a real https call goes through HTTPS_PROXY (or https_proxy) when one is set, by Node's proxyEnv agent (one per proxy address, made lazily). Unset, and for the selftest's local http stand-in, no agent key is added (today's global agent). The target host never changes: the proxy only carries the request.
let PROXY_AGENT = null; let PROXY_AGENT_FOR = null;
function proxyAgentFor(lib) {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (lib === http || !p) return false;
  if (PROXY_AGENT === null || PROXY_AGENT_FOR !== p) { PROXY_AGENT = new https.Agent({ proxyEnv: { HTTPS_PROXY: p } }); PROXY_AGENT_FOR = p; } // only the proxy URL reaches the agent: no other variable
  return PROXY_AGENT;
}
function proxyOpt(lib) { const a = proxyAgentFor(lib); return a ? { agent: a } : {}; }
/** rewrite (selftest only, never reachable from the command line): { hostname, port } of a local stand-in; the request is still guarded against the production URL first. */
function makeTransport(rewrite, lib = https) {
  return function transport(urlStr, method, headers, bodyStr, timeoutMs) {
    guardRequest(urlStr, method, headers, bodyStr);
    return new Promise((resolve) => {
      let settled = false; let timer = null; let req = null;
      const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
      const u = new URL(urlStr);
      const opts = { method, path: u.pathname, hostname: rewrite ? rewrite.hostname : u.hostname, port: rewrite ? rewrite.port : 443, ...(rewrite ? {} : proxyOpt(lib)), headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } };
      try {
        req = (rewrite ? http : lib).request(opts, (res) => { finish({ status: res.statusCode }); res.resume(); });
      } catch { finish({ err: 'network' }); return; }
      timer = setTimeout(() => { finish({ err: 'timeout' }); req.destroy(); }, timeoutMs);
      req.on('error', () => finish({ err: 'network' }));
      req.write(bodyStr);
      req.end();
    });
  };
}

// ---------------------------------------------------------------- the API transport (read only: POST listDocumentComments { documentId } with the two key headers, the same way as the reply script; its own allow-list)
function guardList(urlStr, method, headers, bodyObj) {
  const fail = (m) => { throw new GuardError(m); };
  let u; try { u = new URL(urlStr); } catch { fail('bad url'); }
  if (u.protocol !== 'https:' || u.port !== '' || u.pathname !== LIST_PATH || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '' || u.hostname !== FN_HOST) fail('only POST ' + LIST_URL + ' is allowed');
  if (method !== 'POST') fail('method');
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  if (names.join(',') !== 'x-spm-api-key,x-spm-user-email') fail('header names');
  if (!isPlainObject(bodyObj) || Object.keys(bodyObj).join(',') !== 'documentId' || typeof bodyObj.documentId !== 'string' || !UUID_RE.test(bodyObj.documentId)) fail('body');
}
/** the one comment this script ever posts: POST createDocumentComment { documentId, body: the ack text, parent_id: the thread root } with Origin, the two key headers and Idempotency-Key ack-text:<comment id> */
function guardCreate(urlStr, method, headers, bodyObj) {
  const fail = (m) => { throw new GuardError(m); };
  let u; try { u = new URL(urlStr); } catch { fail('bad url'); }
  if (u.protocol !== 'https:' || u.port !== '' || u.pathname !== CREATE_PATH || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '' || u.hostname !== FN_HOST) fail('only POST ' + CREATE_URL + ' is allowed');
  if (method !== 'POST') fail('create method');
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  if (names.join(',') !== 'idempotency-key,origin,x-spm-api-key,x-spm-user-email') fail('create header names');
  const h = {}; for (const k of Object.keys(headers)) h[k.toLowerCase()] = headers[k];
  if (h.origin !== ORIGIN) fail('create origin');
  if (typeof h['idempotency-key'] !== 'string' || !IDEM_RE.test(h['idempotency-key'])) fail('create idempotency key');
  if (!isPlainObject(bodyObj) || Object.keys(bodyObj).sort().join(',') !== 'body,documentId,parent_id') fail('create body keys');
  if (typeof bodyObj.documentId !== 'string' || typeof bodyObj.parent_id !== 'string' || !UUID_RE.test(bodyObj.documentId) || !UUID_RE.test(bodyObj.parent_id)) fail('create ids');
  if (typeof bodyObj.body !== 'string' || !ackTextOk(bodyObj.body)) fail('create text');
}
/** the one comment this script ever posts on a board task or a map: POST boardsApi/tasks/<uuid>/comments or mapsApi/maps/<uuid>/comments { body: the ack text, parent_id } with Origin and the two key headers ONLY (no Idempotency-Key: these routes have none) */
function guardItemCreate(urlStr, method, headers, bodyObj) {
  const fail = (m) => { throw new GuardError(m); };
  let u; try { u = new URL(urlStr); } catch { fail('bad url'); }
  if (u.protocol !== 'https:' || u.port !== '' || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '' || u.hostname !== FN_HOST || !ITEM_PATH_RE.test(u.pathname)) fail('only POST boardsApi/tasks/<uuid>/comments or mapsApi/maps/<uuid>/comments on ' + FN_HOST + ' is allowed');
  if (method !== 'POST') fail('item create method');
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  if (names.join(',') !== 'origin,x-spm-api-key,x-spm-user-email') fail('item create header names');
  const h = {}; for (const k of Object.keys(headers)) h[k.toLowerCase()] = headers[k];
  if (h.origin !== ORIGIN) fail('item create origin');
  if (!isPlainObject(bodyObj) || Object.keys(bodyObj).sort().join(',') !== 'body,parent_id') fail('item create body keys');
  if (typeof bodyObj.parent_id !== 'string' || !UUID_RE.test(bodyObj.parent_id)) fail('item create parent');
  if (typeof bodyObj.body !== 'string' || !ackTextOk(bodyObj.body)) fail('item create text');
}
function guardApi(urlStr, method, headers, bodyObj) {
  let u; try { u = new URL(urlStr); } catch { throw new GuardError('bad url'); }
  if (u.pathname === CREATE_PATH) return guardCreate(urlStr, method, headers, bodyObj);
  if (ITEM_PATH_RE.test(u.pathname)) return guardItemCreate(urlStr, method, headers, bodyObj);
  return guardList(urlStr, method, headers, bodyObj); // any other path fails the list guard's path check
}
/** rewrite (selftest only): { hostname, port } of a local stand-in. Resolves { status, json } or { err } (timeout, network, toobig); the reply is parsed here and only ids and flags are ever read from it. */
function makeApi(rewrite, lib = https) {
  return function api(urlStr, method, headers, bodyObj, timeoutMs) {
    guardApi(urlStr, method, headers, bodyObj);
    const bodyStr = JSON.stringify(bodyObj);
    return new Promise((resolve) => {
      let settled = false; let timer = null; let req = null;
      const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
      const u = new URL(urlStr);
      const opts = { method, path: u.pathname, hostname: rewrite ? rewrite.hostname : u.hostname, port: rewrite ? rewrite.port : 443, ...(rewrite ? {} : proxyOpt(lib)), headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } };
      try {
        req = (rewrite ? http : lib).request(opts, (res) => {
          const chunks = []; let size = 0;
          res.on('data', (c) => { size += c.length; if (size > LIST_MAX_BYTES) { finish({ err: 'toobig' }); req.destroy(); return; } chunks.push(c); });
          res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; } finish({ status: res.statusCode, json }); });
          res.on('aborted', () => finish({ err: 'network' }));
          res.on('error', () => finish({ err: 'network' }));
        });
      } catch { finish({ err: 'network' }); return; }
      timer = setTimeout(() => { req.destroy(); finish({ err: 'timeout' }); }, timeoutMs);
      req.on('error', () => finish({ err: 'network' }));
      req.write(bodyStr);
      req.end();
    });
  };
}

// ---------------------------------------------------------------- the acker
/** cfg: { key, email, mentions (normalised), others?, selfId?, timeoutMs?, lookupTimeoutMs?, maxPerMinute? }; deps: { transport, api?, now }. handleLine never rejects. */
function createAcker(cfg, deps) {
  const now = deps.now || Date.now;
  const timeoutMs = cfg.timeoutMs || REQUEST_TIMEOUT_MS;
  const cap = cfg.maxPerMinute || MAX_PER_MINUTE;
  const seen = new Map(); // "<doc>/<comment>" -> Promise<{acked, error?}>  (in flight or acked; a failure is removed again)
  const stamps = [];
  const selfId = cfg.selfId || null;
  const lookupMs = cfg.lookupTimeoutMs || LOOKUP_TIMEOUT_MS;
  const textOn = cfg.textAck !== false;
  const label = cfg.label || 'agent';
  const textMs = cfg.textTimeoutMs || TEXT_TIMEOUT_MS;
  const textStamps = [];
  const texts = new Map(); // "<doc>#<comment>" -> Promise<boolean> (in flight or posted; a failure is removed again, so the next line for the comment tries again with the SAME Idempotency-Key)
  const threads = new Map(); // "<doc>|<thread root>" -> { at, p: Promise<snapshot> } (in flight, or answered within THREAD_CACHE_MS; a failed lookup is removed again)

  const ackText = (t) => `Seen by the ${label} at ${new Date(t + 19800000).toISOString().slice(11, 16)} IST. Working on it; the answer follows in this thread.`;

  function send(documentId, commentId) {
    const t = now();
    while (stamps.length && t - stamps[0] >= 60000) stamps.shift();
    if (stamps.length >= cap) return Promise.resolve({ acked: false, error: 'rate_limited' });
    stamps.push(t);
    const headers = { Origin: ORIGIN, 'X-SPM-API-Key': cfg.key, 'X-SPM-User-Email': cfg.email };
    const body = JSON.stringify({ documentId, commentId, emoji: EMOJI, op: 'add' });
    let p;
    try { p = Promise.resolve(deps.transport(ENDPOINT_URL, 'POST', headers, body, timeoutMs)); } catch (e) { return Promise.resolve({ acked: false, error: e instanceof GuardError ? 'guard' : 'internal' }); }
    return p.then((r) => {
      if (r && r.status === 200) return { acked: true };
      if (r && r.err) return { acked: false, error: word(r.err) };
      return { acked: false, error: r && Number.isInteger(r.status) ? `http_${r.status}` : 'internal' };
    }, () => ({ acked: false, error: 'internal' }));
  }

  function ack(documentId, commentId) {
    if (typeof documentId !== 'string' || typeof commentId !== 'string' || !UUID_RE.test(documentId) || !UUID_RE.test(commentId)) return Promise.resolve({ acked: false, error: 'bad_ids' });
    if (!cfg.key) return Promise.resolve({ acked: false, error: 'no_key' });
    const k = `${documentId.toLowerCase()}/${commentId.toLowerCase()}`;
    const prior = seen.get(k);
    if (prior) return prior;
    const p = send(documentId, commentId).then((r) => { if (!r.acked) seen.delete(k); return r; });
    seen.set(k, p);
    if (seen.size > SEEN_CAP) seen.delete(seen.keys().next().value);
    return p;
  }

  /** ONE reply under the thread root: "Seen by the <label> at HH:MM IST. ..." (IST from the clock). true = posted, replayed (HTTP 200 with the comment id) or already posted earlier (422 idempotency_key_reused). */
  function postText(documentId, commentId, root) {
    const t = now();
    while (textStamps.length && t - textStamps[0] >= 60000) textStamps.shift();
    if (textStamps.length >= TEXT_MAX_PER_MINUTE) return Promise.resolve(false);
    textStamps.push(t);
    const headers = { 'X-SPM-User-Email': cfg.email, Origin: ORIGIN, 'Idempotency-Key': `ack-text:${commentId.toLowerCase()}`, 'X-SPM-API-Key': cfg.key };
    const body = { documentId, body: ackText(t), parent_id: root };
    let p;
    try { p = Promise.resolve(deps.api(CREATE_URL, 'POST', headers, body, textMs)); } catch { return Promise.resolve(false); }
    return p.then((r) => Boolean(r && isPlainObject(r.json) && ((r.status === 200 && typeof r.json.id === 'string') || (r.status === 422 && r.json.error === 'idempotency_key_reused'))), () => false);
  }
  /** true / false for an addressed line that has a thread root; null when no text reply applies (switched off, no api or key, bad ids, no root, the comment is itself an ack) */
  function textAck(o) {
    if (!textOn || !deps.api || !cfg.key) return Promise.resolve(null);
    const documentId = o.document_id; const commentId = o.comment_id; const rootId = o.thread_root_id;
    if (typeof documentId !== 'string' || typeof commentId !== 'string' || typeof rootId !== 'string' || !UUID_RE.test(documentId) || !UUID_RE.test(commentId) || !UUID_RE.test(rootId)) return Promise.resolve(null);
    const raw = typeof o.body === 'string' ? o.body : (typeof o.excerpt === 'string' ? o.excerpt : '');
    if (norm(raw).startsWith('seen by the')) return Promise.resolve(null);
    const tk = `${documentId.toLowerCase()}#${commentId.toLowerCase()}`;
    const earlier = texts.get(tk);
    if (earlier) return earlier;
    const p = postText(documentId, commentId, rootId.toLowerCase()).then((ok) => { if (!ok) texts.delete(tk); return ok; });
    texts.set(tk, p);
    if (texts.size > SEEN_CAP) texts.delete(texts.keys().next().value);
    return p;
  }

  /** ONE reply under the thread root of a board or map comment (the same text, the same shared cap; no Idempotency-Key: the route has none). true only on HTTP 200 with { comment: { id } }. */
  function postItemText(kind, ids) {
    const t = now();
    while (textStamps.length && t - textStamps[0] >= 60000) textStamps.shift();
    if (textStamps.length >= TEXT_MAX_PER_MINUTE) return Promise.resolve(false);
    textStamps.push(t);
    const headers = { Origin: ORIGIN, 'X-SPM-API-Key': cfg.key, 'X-SPM-User-Email': cfg.email };
    const url = kind === 'board' ? `https://${FN_HOST}/boardsApi/tasks/${ids.task}/comments` : `https://${FN_HOST}/mapsApi/maps/${ids.item}/comments`;
    let p;
    try { p = Promise.resolve(deps.api(url, 'POST', headers, { body: ackText(t), parent_id: ids.root }, textMs)); } catch { return Promise.resolve(false); }
    return p.then((r) => Boolean(r && r.status === 200 && isPlainObject(r.json) && isPlainObject(r.json.comment) && typeof r.json.comment.id === 'string'), () => false);
  }
  /** true / false for an addressed board or map line that has a thread root; null when no text reply applies (switched off, no api or key, no root, the comment is itself an ack) */
  function itemTextAck(o, kind, ids) {
    if (!textOn || !deps.api || !cfg.key || ids.root === null) return Promise.resolve(null);
    const raw = typeof o.body === 'string' ? o.body : (typeof o.excerpt === 'string' ? o.excerpt : '');
    if (norm(raw).startsWith('seen by the')) return Promise.resolve(null);
    const tk = `${kind}#${ids.item}#${ids.comment}`;
    const earlier = texts.get(tk);
    if (earlier) return earlier;
    const p = postItemText(kind, ids).then((ok) => { if (!ok) texts.delete(tk); return ok; });
    texts.set(tk, p);
    if (texts.size > SEEN_CAP) texts.delete(texts.keys().next().value);
    return p;
  }

  /** One listDocumentComments lookup for a thread, cached for THREAD_CACHE_MS (the in-flight promise is shared). A failure is not kept. */
  function lookupThread(documentId, root) {
    const tkey = `${documentId.toLowerCase()}|${root}`;
    const headers = { 'X-SPM-User-Email': cfg.email, 'X-SPM-API-Key': cfg.key };
    let p;
    try { p = Promise.resolve(deps.api(LIST_URL, 'POST', headers, { documentId }, lookupMs)); } catch { p = Promise.resolve(null); }
    const q = p.then((r) => snapshotOf(r, root, selfId), () => ({ ok: false }));
    const entry = { at: now(), p: q };
    threads.set(tkey, entry);
    if (threads.size > THREAD_CAP) threads.delete(threads.keys().next().value);
    q.then((snap) => { if (!snap.ok && threads.get(tkey) === entry) threads.delete(tkey); });
    return { tkey, entry };
  }

  /** The thread rule: react (true) when the thread's root was written by this agent or the most recent EARLIER comment of the thread was; false when not; null when the lookup failed or the comment is not in the list. */
  async function threadVerdict(o) {
    if (!eligible(o)) return false;
    if (!deps.api || !cfg.key) return false;
    const documentId = o.document_id; const commentId = o.comment_id; const rootId = o.thread_root_id;
    if (typeof documentId !== 'string' || typeof commentId !== 'string' || typeof rootId !== 'string' || !UUID_RE.test(documentId) || !UUID_RE.test(commentId) || !UUID_RE.test(rootId)) return false;
    const root = rootId.toLowerCase(); const me = commentId.toLowerCase();
    if (root === me) return false; // a top-level comment starts its own thread: nothing of ours is in it
    const tkey = `${documentId.toLowerCase()}|${root}`;
    let entry = threads.get(tkey);
    let fresh = false;
    if (!entry || now() - entry.at >= THREAD_CACHE_MS) { entry = lookupThread(documentId, root).entry; fresh = true; }
    let snap = await entry.p;
    if (snap.ok && !snap.rootMine && !fresh && !snap.thread.some((c) => c.id === me)) { snap = await lookupThread(documentId, root).entry.p; } // the cached list is older than this comment: look once more
    return verdictOf(snap, me);
  }

  /** ONE listDocumentComments call for a participant notice's thread, never from the thread cache (the comment's own text is needed, and the cache keeps none). A failed call gives { ok: false }. */
  async function freshThread(documentId, root) {
    const headers = { 'X-SPM-User-Email': cfg.email, 'X-SPM-API-Key': cfg.key };
    let r = null;
    try { r = await deps.api(LIST_URL, 'POST', headers, { documentId }, lookupMs); } catch { r = null; }
    return snapshotOf(r, root, selfId, true);
  }

  /** A PARTICIPANT notice (reason participant: a human reply that tags this agent inside a thread the agent already wrote in). Judged as the listener line of the same comment is: ONE list call for its thread, the comment found by comment_id, its body and author kind taken from the list, the name and group rule on that body, then the thread rule from the same answer. Only a human document comment with well-formed ids and a key makes the call; any other participant notice gets nothing and no call. */
  async function participantOutcome(o) {
    const none = { addressed: false, acked: null, error: null, textAcked: null };
    const ok = (v) => typeof v === 'string' && UUID_RE.test(v);
    if (o.actor_kind !== 'human' || !ACK_KINDS.includes(o.verb) || !isPlainObject(o.item) || o.item.type !== 'document') return none;
    if (!ok(o.item.id) || !ok(o.comment_id) || !ok(o.thread_root_id) || !deps.api || !cfg.key) return none;
    const documentId = o.item.id; const me = o.comment_id.toLowerCase(); const root = o.thread_root_id.toLowerCase();
    const snap = await freshThread(documentId, root);
    const row = snap.ok ? snap.thread.find((c) => c.id === me) : undefined;
    if (row === undefined) return { ...none, error: 'lookup' };
    const line = { document_id: documentId, comment_id: o.comment_id, thread_root_id: o.thread_root_id, body: row.body, author_kind: row.author_kind, kind: o.verb };
    const why = addressedReason(line, cfg.mentions, cfg.others);
    if (why === 'named' || why === 'group') {
      const [r, tx] = await Promise.all([ack(documentId, o.comment_id), textAck(line)]);
      return { addressed: true, acked: r.acked, error: r.error || null, textAcked: tx };
    }
    if (why === 'other') return none; // another agent is named: nothing, as for a listener line
    const verdict = root !== me && eligible(line) ? verdictOf(snap, me) : false;
    if (verdict === true) { const r = await ack(documentId, o.comment_id); return { ...none, acked: r.acked, error: r.error || null }; }
    return none;
  }

  const scrub = (s) => (cfg.key ? s.split(cfg.key).join('[redacted]') : s);

  async function handleLine(raw) {
    let o;
    try { o = JSON.parse(raw); } catch { return scrub(raw); }
    if (!isPlainObject(o)) return scrub(raw);
    const notice = o.kind === 'notice';
    let addressed = false; let acked = null; let error = null; let reason = null; let textAcked = null;
    try {
      if (notice && o.reason === 'participant') {
        // a participant notice is judged from its comment's text: one list call, then the name, group and thread rules (see participantOutcome); it gets no reason key of its own
        ({ addressed, acked, error, textAcked } = await participantOutcome(o));
      } else {
        // a notice (inbox mode) stands for the listener line of its comment, or null when it is not ours; a listener line is judged as before
        const line = notice ? noticeAsLine(o) : o;
        const why = notice ? (line === null ? null : 'notice') : addressedReason(o, cfg.mentions, cfg.others);
        addressed = why === 'named' || why === 'group' || why === 'notice';
        const kind = line === null ? 'document' : lineKind(line);
        if (addressed && kind !== 'document') {
          // a board or map line: the text reply only (no reaction route, no thread rule); a malformed line or no key is reported the way a document line reports it
          if (why === 'group') reason = 'group';
          const ids = kind === 'bad' ? null : itemIds(line, kind);
          if (!ids) { acked = false; error = 'bad_ids'; }
          else if (!cfg.key) { acked = false; error = 'no_key'; }
          else textAcked = await itemTextAck(line, kind, ids);
        }
        else if (addressed) { if (why === 'group') reason = 'group'; const [r, tx] = await Promise.all([ack(line.document_id, line.comment_id), textAck(line)]); acked = r.acked; error = r.error || null; textAcked = tx; }
        else if (!notice && why !== 'other' && kind === 'document') {
          const verdict = await threadVerdict(o);
          if (verdict === true) { reason = 'thread'; const r = await ack(o.document_id, o.comment_id); acked = r.acked; error = r.error || null; }
          else if (verdict === null) error = 'lookup';
        }
      }
    } catch { acked = addressed ? false : null; error = addressed ? 'internal' : null; }
    const out = { ...o, addressed, acked };
    delete out.ack_error;
    if (!notice) delete out.reason; // a notice keeps its own reason (mentioned, participant or follower); this script adds none to a notice
    delete out.text_acked;
    if (error) out.ack_error = error;
    if (reason) out.reason = reason;
    out.text_acked = textAcked;
    return scrub(JSON.stringify(out));
  }
  return { handleLine, ack };
}

// ---------------------------------------------------------------- main
function readKeyFile(file) {
  const k = fs.readFileSync(file, 'utf8').trim();
  if (!k || /[\r\n]/.test(k) || k.length > 512) throw Object.assign(new Error('bad key file'), { code: 'EBADKEY' });
  return k;
}
// The settings file names the agent (see the header). A missing or invalid file stops the run before anything is read or sent.
function withoutConfig(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--config') i++; else out.push(argv[i]); }
  return out;
}
async function main(argv, deps) {
  const err = (s) => deps.stderr.write(s + '\n');
  let config;
  try { config = loadConfig({ argv, env: deps.env || process.env }); } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    err(`agent-ack: ${e.message}`); return 2;
  }
  const parsed = parseArgs(withoutConfig(argv));
  if (!parsed.ok) { err(`agent-ack: ${parsed.msg}`); err(USAGE); return 2; }
  const mode = keyMode(config, deps.env || process.env); // K-A3 item 1: no key_file means network-secret mode, which needs the proxy
  if (mode.mode === 'refused') { err(`agent-ack: ${mode.message}`); return 2; }
  setAckName(config.name);
  const mentions = parsed.cfg.mentions.length ? parsed.cfg.mentions : [`@${config.name}`];
  const cfg = {
    keyFile: config.keyFile, email: config.email, label: config.name, selfId: parsed.cfg.selfId, textAck: parsed.cfg.textAck,
    mentions: mentions.map(norm), others: config.ignoreAgents.map((n) => norm(`@${n}`)), key: null,
    timeoutMs: deps.timeoutMs, lookupTimeoutMs: deps.lookupTimeoutMs, textTimeoutMs: deps.textTimeoutMs,
  };
  if (mode.mode === 'secret') cfg.key = NETWORK_SECRET_VALUE; // the placeholder; no key file is read in this mode
  else try { cfg.key = deps.readKey(cfg.keyFile); } catch (e) { err(`agent-ack: key file not readable (${word(e && e.code)}); reactions are off, lines still pass through`); }
  const acker = createAcker(cfg, { transport: deps.transport, api: deps.api, now: deps.now });
  const rl = readline.createInterface({ input: deps.stdin, crlfDelay: Infinity });
  let dead = false; let chain = Promise.resolve();
  deps.stdout.on('error', () => { dead = true; rl.close(); });
  rl.on('line', (line) => {
    const p = acker.handleLine(line); // the ack starts NOW; only the printing waits its turn
    chain = chain.then(() => p).then((out) => { if (!dead) deps.stdout.write(out + '\n'); });
  });
  const onSig = () => rl.close();
  if (deps.signals) { process.once('SIGTERM', onSig); process.once('SIGINT', onSig); }
  await new Promise((resolve) => rl.on('close', resolve));
  await chain;
  if (deps.signals) { process.removeListener('SIGTERM', onSig); process.removeListener('SIGINT', onSig); }
  if (typeof deps.stdin.destroy === 'function') deps.stdin.destroy();
  return 0;
}
function realDeps() {
  return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, transport: makeTransport(null), api: makeApi(null), now: Date.now, readKey: readKeyFile, timeoutMs: REQUEST_TIMEOUT_MS, lookupTimeoutMs: LOOKUP_TIMEOUT_MS, textTimeoutMs: TEXT_TIMEOUT_MS, signals: true };
}
/** Runs in a CHILD process of the selftest: the same main() on real stdin/stdout, the transport pointed at the local stand-in. Not reachable from the command line. */
function runChild(c) {
  return main(c.argv, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, transport: makeTransport({ hostname: '127.0.0.1', port: c.port }), api: makeApi({ hostname: '127.0.0.1', port: c.port }), now: Date.now, readKey: readKeyFile, timeoutMs: c.timeoutMs, lookupTimeoutMs: c.lookupTimeoutMs, textTimeoutMs: c.textTimeoutMs, signals: true });
}

// ================================================================ SELFTEST
const FAKE_KEY = 'spm_k_test_ack_agent_key_0123456789abcdef';
const FAKE_EMAIL = 'spm-example-agent@agents.invalid';
const DOC = '00000000-0000-4000-8000-000000010001';
const SELF_ID = '00000000-0000-4000-8000-0000000000a1'; // the agent's own author id on the server (synthetic)
const OTHER_ID = '00000000-0000-4000-8000-0000000000a2'; // another agent's author id (synthetic)
const HUMAN_ID = '00000000-0000-4000-8000-0000000000f1';
const BOARD_ID = '00000000-0000-4000-8000-000000010002'; const TASK_ID = '00000000-0000-4000-8000-0000000000ab'; const MAP_ID = '00000000-0000-4000-8000-000000010003'; const NODE_ID = '00000000-0000-4000-8000-000000010005';
const cid =(n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanLine = (n, text, extra) => JSON.stringify({ t: '2026-10-04T16:50:15+05:30', document_id: DOC, seq: 100 + n, kind: 'comment.replied', comment_id: cid(n), author_kind: 'human', author_name: 'Example person', excerpt: text.slice(0, 160), via: 'marker', ...extra });

/** A real http server on 127.0.0.1 that implements the reactToDocumentComment CONTRACT :
 *  trusted Origin else 403 untrusted_origin; X-SPM-API-Key + X-SPM-User-Email else 401; body {documentId, commentId, emoji, op}; non-empty emoji of at most 16 UTF-16 units and op add|remove else 400;
 *  unknown document or a comment not in it -> 404; add is an idempotent upsert (UNIQUE comment, emoji, reactor); 200 {"ok":true}. A CONTRACT-FAITHFUL STAND-IN: production needs Postgres. */
function makeStandIn() {
  const st = { requests: [], lists: [], posts: [], itemReqs: [], itemComments: { board: new Map(), map: new Map() }, idem: new Map(), comments: [], callerIdentity: SELF_ID, isYouOff: false, reactions: new Set(), behave: null, server: null, port: 0 };
  st.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const isList = req.url === '/documentsApi/listDocumentComments'; // lists go to st.lists, comment posts to st.posts, reactions to st.requests (the old counts keep meaning "reaction requests")
      const isPost = req.url === '/documentsApi/createDocumentComment';
      const im = /^\/(boardsApi|mapsApi)\/([^/]+)\/([^/]+)\/comments$/.exec(req.url); // the board and map comment routes (no query is ever sent)
      const sink = im ? st.itemReqs : isList ? st.lists : isPost ? st.posts : st.requests;
      const rec = { t: Date.now(), method: req.method, url: req.url, headers: { ...req.headers }, raw: Buffer.concat(chunks).toString('utf8'), n: sink.length + 1, list: isList, post: isPost, itemPost: Boolean(im) && req.method === 'POST' };
      sink.push(rec);
      const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      const b = st.behave ? st.behave(rec) : null;
      if (b && b.delayMs) await sleep(b.delayMs);
      if (b && b.destroy) { req.socket.destroy(); return; }
      if (b && b.hang) return;
      if (b && b.raw !== undefined) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(b.raw); }
      if (b && b.status) return send(b.status, { error: 'forced', echoedKey: rec.headers['x-spm-api-key'] });
      if (im) return itemRequest(rec, im, send);
      if (isPost) {
        // POST createDocumentComment with the Idempotency-Key header, as the reply script calls it: Origin + x-spm-api-key + x-spm-user-email,
        // body { documentId, body, parent_id }; the parent must exist and be top level; a present Idempotency-Key (1-255 printable ASCII) scopes to (document, caller): the SAME request replays the original comment
        // (200 + Idempotent-Replayed: true, no second row), a DIFFERENT request is 422 { error: idempotency_key_reused }; 200 with the new comment row.
        if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
        if (rec.headers.origin !== ORIGIN) return send(403, { code: 'origin_not_allowed' });
        if (rec.headers['x-spm-api-key'] !== FAKE_KEY || rec.headers['x-spm-user-email'] !== FAKE_EMAIL) return send(401, { error: 'unauthorized', echoedKey: rec.headers['x-spm-api-key'] });
        const ikRaw = rec.headers['idempotency-key'];
        const ik = ikRaw === undefined ? null : String(ikRaw).trim();
        if (ik !== null && !/^[\x20-\x7E]{1,255}$/.test(ik)) return send(400, { code: 'invalid_idempotency_key', error: 'invalid_idempotency_key' });
        let cb; try { cb = JSON.parse(rec.raw); } catch { return send(400, { error: 'bad json' }); }
        if (!cb || cb.documentId !== DOC) return send(404, { error: 'document not found' });
        if (typeof cb.body !== 'string' || !cb.body.trim()) return send(400, { code: 'validation_error' });
        if (cb.parent_id) {
          const parent = st.comments.find((c) => c.id === cb.parent_id);
          if (!parent) return send(404, { error: 'parent comment not found' });
          if (parent.parent_id) return send(400, { error: 'replies are one level deep only — cannot reply to a reply' });
        }
        const hash = JSON.stringify([cb.documentId, cb.body, cb.parent_id || null]);
        if (ik !== null && st.idem.has(ik)) {
          const prior = st.idem.get(ik);
          if (prior.hash !== hash) return send(422, { error: 'idempotency_key_reused', idempotency_key: ik });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Idempotent-Replayed': 'true' }); return res.end(JSON.stringify(prior.row));
        }
        const row = { id: crypto.randomUUID(), document_id: DOC, author_identity: st.callerIdentity, parent_id: cb.parent_id || null, body: cb.body, created_at: new Date().toISOString(), author_email: FAKE_EMAIL, author_kind: 'agent', author_display_name: 'Fake agent', reactions: {} };
        st.comments.push(row);
        if (ik !== null) st.idem.set(ik, { hash, row });
        return send(200, row);
      }
      if (isList) {
        // POST listDocumentComments as the reply script calls it: x-spm-api-key + x-spm-user-email (no Origin needed), body { documentId };
        // 200 { comments: [ the row (id, document_id, author_identity, parent_id, body, created_at, ...) + author_email + author_is_you (FOR THIS CALLER) + author_kind + author_display_name + reactions ], total, signal_id }
        if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
        if (rec.headers['x-spm-api-key'] !== FAKE_KEY || rec.headers['x-spm-user-email'] !== FAKE_EMAIL) return send(401, { error: 'unauthorized', echoedKey: rec.headers['x-spm-api-key'] });
        let lb; try { lb = JSON.parse(rec.raw); } catch { return send(400, { error: 'bad json' }); }
        if (!lb || lb.documentId !== DOC) return send(404, { error: 'document not found' });
        const comments = st.comments.map((row) => ({ ...row, author_is_you: !st.isYouOff && row.author_identity === st.callerIdentity }));
        return send(200, { comments, total: comments.length, signal_id: 'f'.repeat(64) });
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (req.method !== 'POST' || !req.url.startsWith(FN_PATH)) return send(404, { error: 'not found' });
      if (rec.headers.origin !== ORIGIN) return send(403, { error: 'not a trusted origin', code: 'untrusted_origin' });
      if (rec.headers['x-spm-api-key'] !== FAKE_KEY || rec.headers['x-spm-user-email'] !== FAKE_EMAIL) return send(401, { error: 'unauthorized', echoedKey: rec.headers['x-spm-api-key'] });
      let body; try { body = JSON.parse(rec.raw); } catch { return send(400, { error: 'bad json' }); }
      if (body.documentId !== DOC) return send(404, { error: 'document not found' });
      if (typeof body.emoji !== 'string' || !body.emoji.trim() || body.emoji.length > 16) return send(400, { error: 'bad emoji' });
      if (body.op !== 'add' && body.op !== 'remove') return send(400, { error: 'bad op' });
      if (typeof body.commentId !== 'string' || !body.commentId.startsWith('00000000-0000-4000-8000-')) return send(404, { error: 'comment not found' });
      const k = `${body.commentId}|${body.emoji}|${FAKE_EMAIL}`;
      if (body.op === 'add') st.reactions.add(k); else st.reactions.delete(k);
      return send(200, { ok: true });
    });
  });
  // ---- GET/POST /boardsApi/tasks/<id>/comments and /mapsApi/maps/<id>/comments in the wire format (auth first, route, item, parent)
  const errBody = (code, message) => ({ error: code, code, message });
  const itemWire = (type, c, caller) => {
    const tail = { author_kind: c.author_kind, author_is_you: c.author_email === caller, parent_id: c.parent_id, resolved_at: null, resolved_by_email: null, reactions: {}, mentions: [], can_resolve: false, can_delete: c.author_email === caller };
    if (type === 'board') return { id: c.id, task_id: TASK_ID, author_email: c.author_email, body: c.body, created_at: c.created_at, updated_at: null, author_display_name: c.author_display_name, ...tail };
    return { id: c.id, map_id: MAP_ID, node_id: NODE_ID, author_email: c.author_email, author_display_name: c.author_display_name, body: c.body, created_at: c.created_at, updated_at: null, ...tail };
  };
  function itemRequest(rec, m, send) {
    const [, fn, seg, rawId] = m; const type = fn === 'boardsApi' ? 'board' : 'map';
    const out = (name, status, body) => send(status, body);
    if (rec.headers['x-spm-api-key'] !== FAKE_KEY) return out('board.events.bad-key', 401, errBody('unauthenticated', 'invalid or revoked API key'));
    if (rec.headers['x-spm-user-email'] !== FAKE_EMAIL) return out('board.events.owner-mismatch', 403, errBody('api_key_owner_mismatch', 'this API key can only act as its owner'));
    if (seg !== (type === 'board' ? 'tasks' : 'maps') || rec.method !== 'POST') return out('board.events.unknown-route', 404, errBody('unknown_route', `${rec.method} ${rec.url} is not a route`));
    if (rawId.toLowerCase() !== (type === 'board' ? TASK_ID : MAP_ID)) return out(`${type}.comments.create.not-found`, 404, errBody('not_found', 'not found'));
    let body; try { body = JSON.parse(rec.raw); } catch { return send(400, errBody('invalid_request', 'bad json')); }
    const store = st.itemComments[type];
    if (!body || typeof body.body !== 'string' || !body.body.trim()) return send(400, errBody('validation_error', 'body is required'));
    if (!body.parent_id) return send(400, errBody('validation_error', 'the stand-in only takes replies'));
    const parent = store.get(body.parent_id);
    if (!parent) return out(`${type}.comments.create.parent-not-found`, 404, errBody('not_found', 'not found'));
    if (parent.parent_id) return out(`${type}.comments.create.reply-to-reply.refused`, 400, errBody('reply_to_reply', 'replies are one level deep only: cannot reply to a reply'));
    const row = { id: crypto.randomUUID(), parent_id: body.parent_id, body: body.body, author_email: FAKE_EMAIL, author_kind: 'agent', author_display_name: 'Fake agent', created_at: new Date().toISOString() };
    store.set(row.id, row);
    return out(`${type}.comments.create.reply`, 200, { comment: itemWire(type, row, FAKE_EMAIL) });
  }
  st.start = () => new Promise((resolve) => st.server.listen(0, '127.0.0.1', () => { st.port = st.server.address().port; resolve(); }));
  st.stop = () => new Promise((resolve) => { st.server.closeAllConnections?.(); st.server.close(() => resolve()); });
  st.reset = () => { st.requests.length = 0; st.lists.length = 0; st.posts.length = 0; st.itemReqs.length = 0; st.itemComments = { board: new Map(), map: new Map() }; st.idem.clear(); st.comments = []; st.callerIdentity = SELF_ID; st.isYouOff = false; st.reactions.clear(); st.behave = null; };
  return st;
}
/** One comment row in the list wire shape (authors by identity: 'agent' = this agent, 'other' = some other identity, 'human'); parent = a number (a cid) or undefined for a top-level comment. */
function mk(n, by, parent) {
  const ident = by === 'agent' ? SELF_ID : by === 'other' ? OTHER_ID : HUMAN_ID;
  return { id: cid(n), document_id: DOC, author_identity: ident, parent_id: parent === undefined ? null : cid(parent), body: `comment ${n}`, anchor_section: null, created_at: new Date(Date.UTC(2026, 9, 4, 11, 0, n % 60)).toISOString(), updated_at: null, resolved_at: null, resolved_by: null,
    author_email: by === 'human' ? 'person@example.com' : 'spm-example-agent@agents.invalid', author_kind: by === 'human' ? 'human' : 'agent', author_display_name: by === 'human' ? 'Example person' : 'Example agent', reactions: {} };
}
/** a listener line for a comment inside a thread (the listener adds parent_id, thread_root_id and body after via). root = the cid number of the thread root. */
const threadLine = (n, text, root, extra) => humanLine(n, text, { parent_id: root === n ? null : cid(root), thread_root_id: cid(root), body: text, ...extra });

const LIVE = new Set(); // every child the selftest started; whatever is still alive when the run ends is killed (a failed case must never leave a child holding the process open)
function spawnAck(env, o = {}) {
  const cfg = { argv: ['--config', o.keyFile !== undefined ? env.writeConfig({ key_file: o.keyFile }) : env.configFile, ...(o.args || [])], port: o.port !== undefined ? o.port : env.standIn.port, timeoutMs: o.timeoutMs, lookupTimeoutMs: o.lookupTimeoutMs, textTimeoutMs: o.textTimeoutMs };
  const code = 'const m=require(process.argv[1]);m.runChild(JSON.parse(process.argv[2])).then((c)=>{process.exitCode=c;});';
  const child = spawn(process.execPath, ['-e', code, __filename, JSON.stringify(cfg)], { cwd: env.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  LIVE.add(child); child.on('close', () => LIVE.delete(child));
  const h = { child, stdout: '', stderr: '', waiters: [], exited: null };
  child.stdout.on('data', (c) => { h.stdout += c; h.waiters.forEach((w) => w()); });
  child.stderr.on('data', (c) => { h.stderr += c; });
  h.exit = new Promise((resolve) => child.on('close', (code, sig) => { h.exited = { code, sig }; h.waiters.forEach((w) => w()); resolve(h.exited); }));
  h.lines = () => { const s = h.stdout; const parts = s.split('\n'); if (parts[parts.length - 1] === '') parts.pop(); return parts; };
  h.write = (line) => child.stdin.write(line + '\n');
  h.end = () => child.stdin.end();
  h.waitLines = (n, ms = 3000) => new Promise((resolve, reject) => {
    const t0 = Date.now(); const poll = () => { if (h.lines().length >= n) { clearInterval(iv); resolve(h.lines()); } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`timed out waiting for ${n} output lines, got ${h.lines().length}`)); } };
    const iv = setInterval(poll, 5); poll();
  });
  h.finish = async (ms = 4000) => { const t = setTimeout(() => child.kill('SIGKILL'), ms); const r = await h.exit; clearTimeout(t); return r; };
  return h;
}
/** feed all lines, end stdin, wait for exit; returns { out (parsed or raw lines), raw, code, stderr } */
async function runAll(env, lines, o) {
  const h = spawnAck(env, o);
  for (const l of lines) h.write(l);
  h.end();
  const r = await h.finish();
  const raw = h.lines();
  return { raw, out: raw.map((l) => { try { return JSON.parse(l); } catch { return l; } }), code: r.code, stderr: h.stderr, stdout: h.stdout };
}
const check = (cond, msg) => { if (!cond) throw new Error(msg || 'check failed'); };
const headerNames = (rec) => Object.keys(rec.headers).filter((k) => ['origin', 'x-spm-api-key', 'x-spm-user-email'].includes(k)).sort().join(',');

function defineCases(cases, env) {
  const si = env.standIn;
  const T = (id, name, fn) => cases.push({ id, name, fn: async () => { si.reset(); await fn(); } });

  T('T01', 'addressed human reply: exactly one reaction request, right body, three header names, eyes, line gets addressed true acked true', async () => {
    const text = '@Example agent please look at this again';
    const r = await runAll(env, [humanLine(1, text)]);
    check(r.code === 0 && si.requests.length === 1, `requests ${si.requests.length} exit ${r.code}`);
    const q = si.requests[0];
    check(q.method === 'POST' && q.url === '/documentsApi/reactToDocumentComment', `${q.method} ${q.url}`);
    check(headerNames(q) === 'origin,x-spm-api-key,x-spm-user-email', headerNames(q));
    check(q.headers.origin === 'https://app.superproductmanager.ai' && q.headers['x-spm-api-key'] === FAKE_KEY && q.headers['x-spm-user-email'] === FAKE_EMAIL, 'header values');
    check(!('authorization' in q.headers), 'no bearer token');
    const b = JSON.parse(q.raw);
    check(JSON.stringify(b) === JSON.stringify({ documentId: DOC, commentId: cid(1), emoji: '\u{1F440}', op: 'add' }), q.raw);
    check(si.reactions.size === 1, 'the stand-in holds one reaction');
    const o = r.out[0];
    check(o.addressed === true && o.acked === true && !('ack_error' in o), r.raw[0]);
    const orig = JSON.parse(humanLine(1, text));
    check(Object.keys(o).slice(0, Object.keys(orig).length).join() === Object.keys(orig).join() && Object.keys(orig).every((k) => o[k] === orig[k]), 'original keys, order and values kept');
    check(Object.keys(o).slice(-3).join() === 'addressed,acked,text_acked' && o.text_acked === null, 'addressed and acked are appended first, text_acked last (null: no thread_root_id on this line, so no text reply was tried)');
  });

  T('T02', 'comment.created is addressed too; both default names work', async () => {
    const r = await runAll(env, [
      humanLine(2, '@Example agent hello', { kind: 'comment.created' }),
      humanLine(3, 'hey @Example agent, one more', { kind: 'comment.created' }),
    ]);
    check(si.requests.length === 2 && r.out.every((o) => o.addressed === true && o.acked === true), r.raw.join(' | '));
  });

  T('T03', 'comment addressed to the OTHER agent: no reaction, addressed false, acked null', async () => {
    const r = await runAll(env, [humanLine(4, '@Other agent please fix the banner'), humanLine(5, '@Other agent too')]);
    check(si.requests.length === 0, `requests ${si.requests.length}`);
    check(r.out.every((o) => o.addressed === false && o.acked === null && !('ack_error' in o)), r.raw.join(' | '));
  });

  T('T04', 'human comment with no mention: no reaction', async () => {
    const r = await runAll(env, [humanLine(6, 'Example person, can you check the release notes?'), humanLine(7, 'the example agent should know this')]);
    check(si.requests.length === 0 && r.out.every((o) => o.addressed === false && o.acked === null), r.raw.join(' | '));
  });

  T('T05', 'agent-authored comment (including one naming this agent): never addressed, no reaction', async () => {
    const r = await runAll(env, [humanLine(8, '@Example agent see this', { author_kind: 'agent' }), humanLine(9, '@Example agent', { author_kind: null }), humanLine(10, '@Example agent', { author_kind: 'Human' })]);
    check(si.requests.length === 0 && r.out.every((o) => o.addressed === false && o.acked === null), r.raw.join(' | '));
  });

  T('T06', 'other event kinds (reacted, updated, deleted, resolved) by a human with the mention: no reaction', async () => {
    const kinds = ['comment.reacted', 'comment.updated', 'comment.deleted', 'comment.resolved', 'comment.reopened', undefined];
    const r = await runAll(env, kinds.map((k, i) => humanLine(11 + i, '@Example agent', k === undefined ? { kind: undefined } : { kind: k })));
    check(si.requests.length === 0 && r.out.every((o) => o.addressed === false && o.acked === null), r.raw.join(' | '));
  });

  T('T07', 'mention match is case-insensitive and tolerant of spacing; a near-miss is not a mention', async () => {
    const r = await runAll(env, [
      humanLine(20, '@example AGENT: ping'),
      humanLine(21, 'x @Example  agent y'),
      humanLine(22, '@Example\nagent'),
      humanLine(23, '@Example-agent no'),
      humanLine(24, 'Example agent without the at sign'),
    ]);
    check(r.out.slice(0, 3).every((o) => o.addressed === true && o.acked === true), r.raw.slice(0, 3).join(' | '));
    check(r.out.slice(3).every((o) => o.addressed === false), r.raw.slice(3).join(' | '));
    check(si.requests.length === 3, `requests ${si.requests.length}`);
  });

  T('T08', 'excerpt is used when body is missing; body is preferred when present', async () => {
    const long = 'x'.repeat(200) + ' @Example agent at the very end';
    const r = await runAll(env, [
      humanLine(30, '@Example agent only in the excerpt'), // no body key
      humanLine(31, 'short excerpt without a name', { body: long }), // the mention is only in the body, beyond the 160-char excerpt
      humanLine(32, '@Example agent only in the excerpt', { body: 'the full body has no name' }), // body wins: not addressed
      humanLine(33, '@Example agent only in the excerpt', { body: undefined }), // body key absent in JSON
    ]);
    check(r.out[0].addressed === true && r.out[1].addressed === true && r.out[2].addressed === false && r.out[3].addressed === true, r.raw.map((l) => l.slice(-60)).join(' | '));
    check(si.requests.length === 3, `requests ${si.requests.length}`);
  });

  T('T09', 'server 500, 401 and 404: the line still prints, acked false, short ack_error, no reply body shown', async () => {
    si.behave = (rec) => (rec.n === 1 ? { status: 500 } : null);
    const r = await runAll(env, [humanLine(40, '@Example agent a'), humanLine(41, '@Example agent b', { document_id: '00000000-0000-4000-8000-000000010004' })]);
    check(r.out[0].addressed === true && r.out[0].acked === false && r.out[0].ack_error === 'http_500', r.raw[0]);
    check(r.out[1].acked === false && r.out[1].ack_error === 'http_404', r.raw[1]);
    check(r.out.length === 2 && !r.stdout.includes('forced') && !r.stdout.includes(FAKE_KEY), 'no reply body, no key');
    si.reset(); si.behave = () => ({ status: 401 });
    const r2 = await runAll(env, [humanLine(42, '@Example agent c')]);
    check(r2.out[0].ack_error === 'http_401' && r2.out[0].acked === false && !r2.stdout.includes(FAKE_KEY), r2.raw[0]);
  });

  T('T10', 'network error (connection refused) and timeout: the line still prints, acked false', async () => {
    const dead = makeStandIn(); await dead.start(); const port = dead.port; await dead.stop();
    const r = await runAll(env, [humanLine(43, '@Example agent a')], { port });
    check(r.code === 0 && r.out[0].addressed === true && r.out[0].acked === false && r.out[0].ack_error === 'network', r.raw[0]);
    si.behave = () => ({ hang: true });
    const t0 = Date.now();
    const r2 = await runAll(env, [humanLine(44, '@Example agent b')], { timeoutMs: 300 });
    check(r2.out[0].acked === false && r2.out[0].ack_error === 'timeout' && Date.now() - t0 < 5000, `${r2.raw[0]} after ${Date.now() - t0} ms`);
    si.reset(); si.behave = () => ({ destroy: true });
    const r3 = await runAll(env, [humanLine(45, '@Example agent c')]);
    check(r3.out[0].acked === false && r3.out[0].ack_error === 'network', r3.raw[0]);
  });

  T('T11', 'malformed lines pass through byte for byte; non-object JSON too; blank lines too', async () => {
    const lines = ['{"t":"x","kind":', 'not json at all', '[1,2,3]', '"just a string"', '42', 'null', '', '   ', '{"t":"2026-10-04T16:00:00+05:30","fallback":true}'];
    const r = await runAll(env, lines);
    check(si.requests.length === 0, 'no request');
    check(r.raw.length === lines.length, `lines out ${r.raw.length} vs in ${lines.length}`);
    for (let i = 0; i < lines.length - 1; i++) check(r.raw[i] === lines[i], `line ${i} changed: ${JSON.stringify(r.raw[i])}`);
    const last = JSON.parse(r.raw[lines.length - 1]);
    check(last.t === '2026-10-04T16:00:00+05:30' && last.fallback === true && last.addressed === false && last.acked === null, 'a non-comment event object gets the two keys');
  });

  T('T12', 'order and count: one output line per input line, same order, even when an early request is slow', async () => {
    si.behave = (rec) => ({ delayMs: rec.n === 1 ? 400 : rec.n === 2 ? 200 : 0 });
    const lines = [];
    for (let i = 0; i < 12; i++) lines.push(i % 4 === 3 ? 'garbage ' + i : humanLine(50 + i, i % 4 === 2 ? 'nobody named here' : '@Example agent #' + i));
    const r = await runAll(env, lines);
    check(r.raw.length === 12, `out ${r.raw.length}`);
    for (let i = 0; i < 12; i++) {
      if (i % 4 === 3) check(r.raw[i] === lines[i], `garbage line ${i} moved`);
      else check(r.out[i].comment_id === cid(50 + i) && r.out[i].addressed === (i % 4 !== 2) && r.out[i].acked === (i % 4 === 2 ? null : true), `position ${i}: ${r.raw[i]}`);
    }
    check(si.requests.length === 6, `requests ${si.requests.length}`);
  });

  T('T13', 'latency: the request reaches the server within 500 ms of the input line', async () => {
    const h = spawnAck(env);
    h.write(humanLine(70, 'warm up, nobody named'));
    await h.waitLines(1);
    const t0 = Date.now();
    h.write(humanLine(71, '@Example agent now'));
    for (let i = 0; i < 100 && si.requests.length === 0; i++) await sleep(5);
    check(si.requests.length === 1, 'the request arrived');
    const dt = si.requests[0].t - t0;
    h.end(); await h.finish();
    check(dt < 500, `request after ${dt} ms`);
    check(JSON.parse(h.lines()[1]).acked === true, 'acked');
  });

  T('T14', 'no key value on stdout, stderr or in any file; a line that carries the key is redacted; the reply body (which echoes the key) is never printed', async () => {
    si.behave = (rec) => (rec.n === 2 ? { status: 401 } : null);
    const r = await runAll(env, [humanLine(80, '@Example agent a'), humanLine(81, '@Example agent b'), `junk with ${FAKE_KEY} inside`, humanLine(82, `nobody named but ${FAKE_KEY}`)]);
    check(r.raw.length === 4 && r.out[1].ack_error === 'http_401', r.raw.join(' | '));
    check(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY), 'key found in stdout or stderr');
    check(r.raw[2] === 'junk with [redacted] inside' && r.out[3].excerpt.includes('[redacted]'), `redaction: ${r.raw[2]} / ${r.raw[3]}`);
    const leftovers = fs.readdirSync(env.cwd);
    check(leftovers.length === 0, `the working folder is not empty: ${leftovers.join(',')}`);
    for (const f of fs.readdirSync(env.runDir)) { if (f === 'fake.key' || f === 'cwd' || f === 'unreadable.key') continue; check(!fs.readFileSync(path.join(env.runDir, f), 'utf8').includes(FAKE_KEY), `key in file ${f}`); }
    const src = fs.readFileSync(__filename, 'utf8');
    check(!/writeFile|appendFile|createWriteStream|writeSync|copyFile|rename/.test(src.split('// ================================================================ SELFTEST')[0].replace(/\/\*[\s\S]*?\*\//g, '')), 'the script writes no files');
  });

  T('T15', 'once per comment per process: a repeat sends no second request; a concurrent repeat shares the one in flight; a failed try is retried; a second process repeats harmlessly', async () => {
    const r = await runAll(env, [humanLine(90, '@Example agent a'), humanLine(90, '@Example agent a'), humanLine(90, '@Example agent a', { kind: 'comment.created' })]);
    check(si.requests.length === 1 && r.out.every((o) => o.acked === true), `requests ${si.requests.length}: ${r.raw.join(' | ')}`);
    si.reset(); si.behave = () => ({ delayMs: 300 });
    const r2 = await runAll(env, [humanLine(91, '@Example agent a'), humanLine(91, '@Example agent a')]);
    check(si.requests.length === 1 && r2.out.every((o) => o.acked === true), `concurrent: requests ${si.requests.length}`);
    si.reset(); si.behave = (rec) => (rec.n === 1 ? { status: 500 } : null);
    const h = spawnAck(env); h.write(humanLine(93, '@Example agent a')); await h.waitLines(1); h.write(humanLine(93, '@Example agent a')); await h.waitLines(2); h.end(); await h.finish();
    const o = h.lines().map((l) => JSON.parse(l));
    check(o[0].acked === false && o[0].ack_error === 'http_500' && o[1].acked === true && si.requests.length === 2, `after a failure the next line for the same comment tries again: ${h.lines().join(' | ')}`);
    si.reset();
    await runAll(env, [humanLine(94, '@Example agent a')]);
    const r4 = await runAll(env, [humanLine(94, '@Example agent a')]);
    check(si.requests.length === 2 && si.reactions.size === 1 && r4.out[0].acked === true, 'second process: HTTP 200 on the repeat, one reaction row (idempotent upsert)');
  });

  T('T16', 'rate cap: at most 30 requests in a rolling minute; the 31st is acked false rate_limited; a repeat does not count; the window slides', async () => {
    let t = 1000000; const clock = () => t;
    const acker = createAcker({ key: FAKE_KEY, email: FAKE_EMAIL, mentions: ['@example agent'] }, { transport: makeTransport({ hostname: '127.0.0.1', port: si.port }), now: clock });
    const outs = [];
    for (let i = 0; i < 31; i++) outs.push(JSON.parse(await acker.handleLine(humanLine(200 + i, '@Example agent'))));
    check(si.requests.length === 30, `requests ${si.requests.length}`);
    check(outs.slice(0, 30).every((o) => o.acked === true) && outs[30].acked === false && outs[30].ack_error === 'rate_limited', 'the 31st is limited');
    const again = JSON.parse(await acker.handleLine(humanLine(200, '@Example agent')));
    check(again.acked === true && si.requests.length === 30, 'a repeat of an acked comment sends nothing and is fine');
    t += 59999;
    const still = JSON.parse(await acker.handleLine(humanLine(231, '@Example agent')));
    check(still.ack_error === 'rate_limited', 'still limited at 59.999 s');
    t += 2;
    const later = JSON.parse(await acker.handleLine(humanLine(231, '@Example agent')));
    check(later.acked === true && si.requests.length === 31, 'the window slid after 60 s (the limited one was not remembered as acked)');
  });

  T('T17', 'usage errors exit 2 and read nothing; a missing settings file is one plain line; the mention and self-id values are read', async () => {
    const run = (args) => new Promise((resolve) => { const c = spawn(process.execPath, [__filename, ...args], { cwd: env.cwd, stdio: ['pipe', 'pipe', 'pipe'] }); let e = ''; c.stderr.on('data', (d) => { e += d; }); c.on('close', (code) => resolve({ code, e })); c.stdin.end('{"kind":"comment.created"}\n'); });
    const missing = await run([]);
    check(missing.code === 2 && missing.e.trim() === 'agent-ack: no settings file: pass --config <absolute path> or set SPM_AGENT_CONFIG', `missing config: exit ${missing.code} err ${JSON.stringify(missing.e)}`);
    const c = ['--config', env.configFile];
    const bads = [['--identity', 'backend'], ['--key-file', env.keyFile], ['--email', FAKE_EMAIL], ['--bogus', 'x'], ['--mention', '', ...[]], ['--mention', '   '], ['--no-text-ack', '--no-text-ack'], ['--self-id', 'nope'], ['--self-id', OTHER_ID, '--self-id', OTHER_ID], ['--self-id'], ['stray']];
    for (const a of bads) { const r = await run([...c, ...a]); check(r.code === 2 && r.e.includes('usage:') && !r.e.includes(FAKE_KEY), `args ${JSON.stringify(a)} -> exit ${r.code}`); }
    const bad = await run(['--config', 'relative/agent.json']);
    check(bad.code === 2 && bad.e.trim() === 'agent-ack: the settings file path must be absolute', `relative config: ${JSON.stringify(bad.e)}`);
    const m = parseArgs(['--mention', '@Pat', '--mention', '@Pat Two']);
    check(m.ok && m.cfg.mentions.join('|') === '@Pat|@Pat Two', 'repeated --mention is kept (main lower-cases it)');
  });
  T('T18', 'key file unreadable or empty: lines still pass through, one stderr notice, addressed lines get acked false no_key, no request', async () => {
    const h = spawnAck(env, { keyFile: path.join(env.runDir, 'missing.key') });
    h.write(humanLine(300, '@Example agent a')); h.write(humanLine(301, 'nobody')); h.write('garbage'); h.end();
    const r = await h.finish();
    const o = h.lines();
    check(r.code === 0 && o.length === 3 && JSON.parse(o[0]).ack_error === 'no_key' && JSON.parse(o[0]).acked === false && JSON.parse(o[1]).acked === null && o[2] === 'garbage', o.join(' | '));
    check(si.requests.length === 0 && h.stderr.includes('key file not readable') && h.stderr.trim().split('\n').length === 1 && !h.stderr.includes(env.runDir), `stderr: ${h.stderr}`);
    const e = spawnAck(env, { keyFile: env.emptyKeyFile }); e.write(humanLine(302, '@Example agent a')); e.end(); await e.finish();
    check(JSON.parse(e.lines()[0]).ack_error === 'no_key' && si.requests.length === 0, 'an empty key file counts as no key');
  });

  T('T19', 'request guard: production URL pinned; only POST of the three header names and an add body; nothing else gets out', async () => {
    check(ENDPOINT_URL === 'https://asia-south1-litethink.cloudfunctions.net/documentsApi/reactToDocumentComment', ENDPOINT_URL);
    const rd = realDeps();
    check(rd.timeoutMs === 8000 && rd.signals === true && typeof rd.transport === 'function', 'real run: 8 s request timeout, signals handled');
    const tr = makeTransport({ hostname: '127.0.0.1', port: si.port });
    const hdr = { Origin: ORIGIN, 'X-SPM-API-Key': FAKE_KEY, 'X-SPM-User-Email': FAKE_EMAIL };
    const body = JSON.stringify({ documentId: DOC, commentId: cid(1), emoji: '\u{1F440}', op: 'add' });
    const bad = [
      ['https://us-central1-litethink.cloudfunctions.net/documentsApi/reactToDocumentComment', 'POST', hdr, body], ['https://evil.example/documentsApi/reactToDocumentComment', 'POST', hdr, body], ['http://asia-south1-litethink.cloudfunctions.net/documentsApi/reactToDocumentComment', 'POST', hdr, body],
      [ENDPOINT_URL + '?x=1', 'POST', hdr, body], [ENDPOINT_URL.replace('react', 'delete'), 'POST', hdr, body], [ENDPOINT_URL, 'GET', hdr, body], [ENDPOINT_URL, 'POST', { ...hdr, Authorization: 'Bearer x' }, body],
      [ENDPOINT_URL, 'POST', { Origin: ORIGIN, 'X-SPM-API-Key': FAKE_KEY }, body], [ENDPOINT_URL, 'POST', hdr, body.replace('"add"', '"remove"')], [ENDPOINT_URL, 'POST', hdr, body.replace('}', ',"x":1}')],
      [ENDPOINT_URL, 'POST', hdr, body.replace('\u{1F440}', 'x')], [ENDPOINT_URL, 'POST', hdr, body.replace(DOC, '../../etc')], [ENDPOINT_URL, 'POST', hdr, 'nope'],
    ];
    for (const a of bad) { let threw = null; try { await tr(...a, 1000); } catch (e) { threw = e; } check(threw instanceof GuardError, `not blocked: ${a[0]} ${a[1]} ${a[3].slice(0, 40)}`); }
    check(si.requests.length === 0, 'nothing reached the stand-in');
    const ok = await tr(ENDPOINT_URL, 'POST', hdr, body, 2000);
    check(ok.status === 200 && si.requests.length === 1, 'a good request goes through (to the stand-in)');
  });

  T('T20', 'addressed line with missing or malformed ids: no request, acked false bad_ids', async () => {
    const r = await runAll(env, [
      humanLine(310, '@Example agent a', { comment_id: undefined }), humanLine(311, '@Example agent a', { comment_id: 'not-a-uuid' }), humanLine(312, '@Example agent a', { document_id: null }),
      humanLine(313, '@Example agent a', { document_id: '../x' }), humanLine(314, '@Example agent a', { comment_id: 5 }),
    ]);
    check(si.requests.length === 0 && r.out.every((o) => o.addressed === true && o.acked === false && o.ack_error === 'bad_ids'), r.raw.join(' | '));
  });

  T('T21', 'SIGTERM with a request in flight: the pending line is printed, exit 0', async () => {
    si.behave = () => ({ delayMs: 400 });
    const h = spawnAck(env);
    h.write(humanLine(320, '@Example agent a'));
    for (let i = 0; i < 100 && si.requests.length === 0; i++) await sleep(5);
    h.child.kill('SIGTERM');
    const r = await h.finish(5000);
    const o = h.lines();
    check(r.code === 0 && o.length === 1 && JSON.parse(o[0]).acked === true, `exit ${JSON.stringify(r)} lines ${o.join(' | ')}`);
  });

  T('T22', 'last line without a newline is processed; CRLF input is handled; the process exits promptly after EOF', async () => {
    const h = spawnAck(env);
    h.child.stdin.write(humanLine(330, 'nobody named') + '\r\n' + humanLine(331, '@Example agent z'));
    h.end();
    const t0 = Date.now();
    const r = await h.finish(5000);
    const o = h.lines().map((l) => JSON.parse(l));
    check(r.code === 0 && o.length === 2 && o[0].addressed === false && o[1].acked === true && Date.now() - t0 < 3000, `${h.lines().join(' | ')} in ${Date.now() - t0} ms`);
  });

  T('T23', 'keys the input already had (addressed, acked, ack_error) are replaced, never duplicated; JSON stays valid one object per line', async () => {
    const r = await runAll(env, [humanLine(340, 'nobody', { addressed: true, acked: true, ack_error: 'old' }), humanLine(341, '@Example agent', { acked: false, ack_error: 'old' })]);
    check(r.out[0].addressed === false && r.out[0].acked === null && !('ack_error' in r.out[0]), r.raw[0]);
    check(r.out[1].addressed === true && r.out[1].acked === true && !('ack_error' in r.out[1]), r.raw[1]);
    check(r.raw.every((l) => (l.match(/"addressed"/g) || []).length === 1 && (l.match(/"acked"/g) || []).length === 1), 'no duplicate keys');
  });


  const lastKeys = (o, n) => Object.keys(o).slice(-n).join();
  const listHeaderNames = (rec) => Object.keys(rec.headers).filter((k) => ['origin', 'x-spm-api-key', 'x-spm-user-email', 'authorization'].includes(k)).sort().join(',');

  T('T25', 'group words (both of you, you both, you two, all agents, the agents, agents) address a comment that names nobody: reacted, reason group; look-alikes (agentic, agent\'s, sub-agents, AGENTS.md, bothofyou, you bothered) do not', async () => {
    const pos = ['both of you please check', 'you both are right', 'You   TWO, thanks', 'all agents: stand by', 'what do the agents think?', 'agents?', 'hey @agents', 'Both of you', 'BOTH OF YOU', 'agents\' work is good'];
    const neg = ['the agentic workflow is slow', 'the agent\'s reply was fine', 'the sub-agents file', 'see AGENTS.md for details', 'ask an agent', 'ping x@agents.invalid', 'bothofyou', 'both of your plans', 'you bothered me', 'agentsmith'];
    const r = await runAll(env, [...pos.map((t, i) => humanLine(400 + i, t)), ...neg.map((t, i) => humanLine(420 + i, t))]);
    check(r.out.length === pos.length + neg.length && si.requests.length === pos.length && si.lists.length === 0, `requests ${si.requests.length} lists ${si.lists.length}`);
    r.out.slice(0, pos.length).forEach((o, i) => check(o.addressed === true && o.acked === true && o.reason === 'group' && !('ack_error' in o) && lastKeys(o, 4) === 'addressed,acked,reason,text_acked', `positive ${JSON.stringify(pos[i])}: ${r.raw[i]}`));
    r.out.slice(pos.length).forEach((o, i) => check(o.addressed === false && o.acked === null && !('reason' in o) && !('ack_error' in o), `negative ${JSON.stringify(neg[i])}: ${r.raw[pos.length + i]}`));
  });

  T('T26', 'group words never override a name: only the OTHER agent named stays addressed false (T03 behaviour); this agent named is addressed by name (no reason key)', async () => {
    const r = await runAll(env, [
      humanLine(440, '@Other agent and the agents'), humanLine(441, '@Other agent, both of you'), humanLine(442, '@Other agent you both'),
      humanLine(443, '@Example agent and both of you'), humanLine(444, '@Other agent and @Example agent, you both'), humanLine(445, '@Other agent only'),
    ]);
    check(r.out[0].addressed === false && r.out[1].addressed === false && r.out[2].addressed === false && r.out[5].addressed === false, r.raw.join(' | '));
    check([0, 1, 2, 5].every((i) => r.out[i].acked === null && !('reason' in r.out[i]) && !('ack_error' in r.out[i])), 'no reaction, no reason for the other-agent-only comments');
    check(r.out[3].addressed === true && r.out[3].acked === true && !('reason' in r.out[3]) && r.out[4].addressed === true && r.out[4].acked === true && !('reason' in r.out[4]), 'named lines carry no reason');
    check(si.requests.length === 2 && si.lists.length === 0, `requests ${si.requests.length} lists ${si.lists.length}`);
  });

  T('T27', 'output contract: addressed and acked stay the last two keys of a named line; reason follows them (after ack_error when there is one); an input reason key is replaced, never kept or duplicated', async () => {
    si.behave = (rec) => (!rec.list && rec.n === 2 ? { status: 500 } : null);
    const r = await runAll(env, [humanLine(450, 'both of you'), humanLine(451, 'all agents'), humanLine(452, '@Example agent', { reason: 'old' }), humanLine(453, 'nobody named', { reason: 'old', text_acked: true }), humanLine(454, 'both of you', { reason: 'old' })]);
    check(lastKeys(r.out[0], 4) === 'addressed,acked,reason,text_acked' && r.out[0].reason === 'group', r.raw[0]);
    check(r.out[1].acked === false && r.out[1].ack_error === 'http_500' && lastKeys(r.out[1], 5) === 'addressed,acked,ack_error,reason,text_acked' && r.out[1].reason === 'group', r.raw[1]);
    check(lastKeys(r.out[2], 3) === 'addressed,acked,text_acked' && !('reason' in r.out[2]), `named line keeps the old contract: ${r.raw[2]}`);
    check(!('reason' in r.out[3]) && r.out[3].text_acked === null && lastKeys(r.out[3], 3) === 'addressed,acked,text_acked' && r.out[4].reason === 'group', `${r.raw[3]} / ${r.raw[4]}`);
    check(r.raw.every((l) => (l.match(/"reason"/g) || []).length <= 1), 'no duplicate keys');
  });

  T('T28', 'thread started by THIS agent: a human comment in it is reacted to without waking the AI (addressed false, acked true, reason thread); one list lookup of the right shape; also when a human replied in between', async () => {
    si.comments = [mk(500, 'agent'), mk(501, 'human', 500), mk(502, 'human', 500)];
    const r = await runAll(env, [threadLine(501, 'ok thanks, looks good', 500)]);
    check(si.lists.length === 1 && si.requests.length === 1, `lists ${si.lists.length} reactions ${si.requests.length}`);
    const q = si.lists[0];
    check(q.method === 'POST' && q.url === '/documentsApi/listDocumentComments' && JSON.stringify(JSON.parse(q.raw)) === JSON.stringify({ documentId: DOC }), `${q.method} ${q.url} ${q.raw}`);
    check(listHeaderNames(q) === 'x-spm-api-key,x-spm-user-email' && q.headers['x-spm-api-key'] === FAKE_KEY && q.headers['x-spm-user-email'] === FAKE_EMAIL, `headers ${listHeaderNames(q)}`);
    check(JSON.stringify(JSON.parse(si.requests[0].raw)) === JSON.stringify({ documentId: DOC, commentId: cid(501), emoji: '\u{1F440}', op: 'add' }), si.requests[0].raw);
    const o = r.out[0];
    check(o.addressed === false && o.acked === true && o.reason === 'thread' && !('ack_error' in o) && lastKeys(o, 4) === 'addressed,acked,reason,text_acked', r.raw[0]);
    check(o.kind === 'comment.replied' && o.thread_root_id === cid(500) && o.body === 'ok thanks, looks good', 'the listener keys are kept');
    // the agent started the thread, a human replied (501), and the NEXT human comment follows a HUMAN one: only the thread-started rule applies
    si.reset(); si.comments = [mk(500, 'agent'), mk(501, 'human', 500), mk(502, 'human', 500)];
    const r2 = await runAll(env, [threadLine(502, 'and another thing', 500, { kind: 'comment.created' })]);
    check(r2.out[0].addressed === false && r2.out[0].acked === true && r2.out[0].reason === 'thread' && si.requests.length === 1, r2.raw[0]);
  });

  T('T29', 'thread started by a human and every comment human: no reaction, addressed false, acked null, no reason, no error (one lookup, a negative)', async () => {
    si.comments = [mk(510, 'human'), mk(511, 'human', 510), mk(512, 'human', 510)];
    const r = await runAll(env, [threadLine(511, 'one', 510), threadLine(512, 'two', 510)]);
    check(si.requests.length === 0 && si.lists.length === 1, `reactions ${si.requests.length} lists ${si.lists.length}`);
    check(r.out.every((o) => o.addressed === false && o.acked === null && !('reason' in o) && !('ack_error' in o)), r.raw.join(' | '));
  });

  T('T30', 'the MOST RECENT EARLIER comment decides: a human comment right after this agent\'s reply is reacted to; one before it, or two after it, are not', async () => {
    si.comments = [mk(520, 'human'), mk(521, 'human', 520), mk(522, 'agent', 520), mk(523, 'human', 520), mk(524, 'human', 520)];
    const r = await runAll(env, [threadLine(521, 'before the reply', 520), threadLine(523, 'right after the reply', 520), threadLine(524, 'second after the reply', 520)]);
    check(r.out[0].acked === null && r.out[1].acked === true && r.out[1].reason === 'thread' && r.out[2].acked === null, r.raw.join(' | '));
    check(r.out.every((o) => o.addressed === false), 'addressed false for all three');
    check(si.requests.length === 1 && JSON.parse(si.requests[0].raw).commentId === cid(523) && si.lists.length === 1, `reactions ${si.requests.length} lists ${si.lists.length}`);
  });

  T('T31', 'who is "this agent": the server\'s author_is_you flag, or author_identity equal to --self-id; another agent\'s comments never count', async () => {
    // (i) author_is_you only: the caller (the key's identity) is OTHER_ID and wrote the root
    si.comments = [mk(530, 'other'), mk(531, 'human', 530)]; si.callerIdentity = OTHER_ID;
    const a = await runAll(env, [threadLine(531, 'x', 530)]);
    check(a.out[0].acked === true && a.out[0].reason === 'thread', `author_is_you: ${a.raw[0]}`);
    // (ii) author_identity only: the flag is off, the root carries the id given by --self-id
    si.reset(); si.comments = [mk(532, 'agent'), mk(533, 'human', 532)]; si.isYouOff = true;
    const b = await runAll(env, [threadLine(533, 'x', 532)], { args: ['--self-id', SELF_ID] });
    check(b.out[0].acked === true && b.out[0].reason === 'thread', `author_identity with --self-id: ${b.raw[0]}`);
    // (iii) neither: another agent wrote the root, the flag is off
    si.reset(); si.comments = [mk(534, 'other'), mk(535, 'human', 534)]; si.isYouOff = true;
    const c = await runAll(env, [threadLine(535, 'x', 534)]);
    check(c.out[0].acked === null && c.out[0].addressed === false && si.requests.length === 0 && si.lists.length === 1, `neither: ${c.raw[0]}`);
    // (iv) --self-id names that other agent (upper case accepted)
    si.reset(); si.comments = [mk(536, 'other'), mk(537, 'human', 536)]; si.isYouOff = true;
    const d = await runAll(env, [threadLine(537, 'x', 536)], { args: ['--self-id', OTHER_ID.toUpperCase()] });
    check(d.out[0].acked === true && d.out[0].reason === 'thread', `--self-id: ${d.raw[0]}`);
    // (v) no --self-id and the flag is off: the agent's own comment is not recognised, so no reaction
    si.reset(); si.comments = [mk(538, 'agent'), mk(539, 'human', 538)]; si.isYouOff = true;
    const e = await runAll(env, [threadLine(539, 'x', 538)]);
    check(e.out[0].acked === null && si.requests.length === 0, `no self id, flag off: ${e.raw[0]}`);
    si.reset(); si.comments = [mk(540, 'agent'), mk(541, 'human', 540)];
    const f = await runAll(env, [threadLine(541, 'x', 540)]);
    check(f.out[0].acked === true && f.out[0].reason === 'thread', `the server flag: ${f.raw[0]}`);
  });
  T('T32', '--self-id: no default id, upper case is lowered, a non-uuid or a repeat is a usage error (exit 2)', async () => {
    const b = parseArgs([]);
    check(b.ok && b.cfg.selfId === null, `no default self id ${b.ok && b.cfg.selfId}`);
    const o = parseArgs(['--self-id', OTHER_ID.toUpperCase()]);
    check(o.ok && o.cfg.selfId === OTHER_ID, 'upper case lowered');
    check(parseArgs(['--self-id', 'nope']).ok === false && parseArgs(['--self-id', OTHER_ID, '--self-id', OTHER_ID]).ok === false && parseArgs(['--self-id']).ok === false, 'a bad or repeated --self-id is refused');
  });
  T('T33', 'thread lookup fails (500, 401 that echoes the key, dropped connection, hang past the lookup timeout, not JSON, no comments array, comment missing from the list): NO reaction, no crash, the line still prints with acked null and ack_error lookup, within the timeout', async () => {
    const line = threadLine(531, 'thanks', 530);
    const modes = [{ name: '500', b: { status: 500 } }, { name: '401', b: { status: 401 } }, { name: 'destroy', b: { destroy: true } }, { name: 'hang', b: { hang: true }, ms: 300 }, { name: 'not json', b: { raw: 'this is not json' } }, { name: 'no array', b: { raw: '{"comments":"x"}' } }, { name: 'array of junk, comment absent', b: { raw: '{"comments":[1,null,"x",{}]}' } }, { name: 'empty list', b: { raw: '{"comments":[]}' } }];
    for (const m of modes) {
      si.reset(); si.comments = [mk(530, 'agent'), mk(531, 'human', 530)]; si.behave = (rec) => (rec.list ? m.b : null);
      const t0 = Date.now();
      const r = await runAll(env, [line], { lookupTimeoutMs: m.ms || 2000 });
      const o = r.out[0];
      check(r.code === 0 && r.out.length === 1 && o.addressed === false && o.acked === null && o.ack_error === 'lookup' && !('reason' in o) && si.requests.length === 0, `${m.name}: ${r.raw[0]} reactions ${si.requests.length}`);
      check(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY) && Date.now() - t0 < 3500, `${m.name}: key or time (${Date.now() - t0} ms)`);
    }
    // a failure is NOT cached: the next comment of the thread looks again, and reacts when the server is back; order and pass-through kept around the failure
    si.reset(); si.comments = [mk(530, 'agent'), mk(531, 'human', 530), mk(532, 'human', 530)]; si.behave = (rec) => (rec.list && rec.n === 1 ? { status: 500 } : null);
    const h = spawnAck(env);
    h.write(threadLine(531, 'first', 530)); await h.waitLines(1); h.write('garbage in between'); h.write(threadLine(532, 'second', 530)); h.write(humanLine(533, '@Example agent named')); await h.waitLines(4); h.end(); await h.finish();
    const o2 = h.lines().map((l) => { try { return JSON.parse(l); } catch { return l; } });
    check(o2[0].acked === null && o2[0].ack_error === 'lookup' && o2[1] === 'garbage in between' && o2[2].acked === true && o2[2].reason === 'thread' && o2[3].acked === true && o2[3].comment_id === cid(533), `after a failure: ${h.lines().join(' | ')}`);
    check(si.lists.length === 2 && si.requests.length === 2, `lists ${si.lists.length} reactions ${si.requests.length}`);
  });

  T('T34', 'cache (fake clock, in-process): one lookup per thread for 60 s, negatives cached too; a comment missing from the cached list forces ONE refresh (the real "human replies right after the agent" case); a repeat reacts once', async () => {
    let t = 5000000; const clock = () => t;
    const rw = { hostname: '127.0.0.1', port: si.port };
    const acker = createAcker({ key: FAKE_KEY, email: FAKE_EMAIL, mentions: ['@example agent'], others: ['@other agent'], selfId: SELF_ID }, { transport: makeTransport(rw), api: makeApi(rw), now: clock });
    const run = async (line) => JSON.parse(await acker.handleLine(line));
    // negative cached: two human comments, a third look 59 s later, a fourth after 61 s
    si.comments = [mk(540, 'human'), mk(541, 'human', 540), mk(542, 'human', 540)];
    const n1 = await run(threadLine(541, 'a', 540)); const n2 = await run(threadLine(542, 'b', 540));
    check(n1.acked === null && n2.acked === null && si.lists.length === 1, `negative: lists ${si.lists.length}`);
    t += 59000; await run(threadLine(542, 'b', 540));
    check(si.lists.length === 1, `still cached at 59 s: lists ${si.lists.length}`);
    t += 2000; await run(threadLine(542, 'b', 540));
    check(si.lists.length === 2, `looked again after 61 s: lists ${si.lists.length}`);
    // positive cached, and a repeat of a reacted comment sends no second reaction
    si.comments = [mk(550, 'agent'), mk(551, 'human', 550), mk(552, 'human', 550)];
    const p1 = await run(threadLine(551, 'a', 550)); const p2 = await run(threadLine(552, 'b', 550)); const p3 = await run(threadLine(551, 'a', 550));
    check(p1.acked === true && p2.acked === true && p3.acked === true && si.lists.length === 3 && si.requests.length === 2, `positive: lists ${si.lists.length} reactions ${si.requests.length}`);
    // snapshot miss: the cached list predates the agent's reply and the person's next comment
    si.comments = [mk(560, 'human'), mk(561, 'human', 560)];
    const m1 = await run(threadLine(561, 'before', 560));
    check(m1.acked === null && si.lists.length === 4, 'first look');
    si.comments.push(mk(562, 'agent', 560), mk(563, 'human', 560)); t += 5000;
    const m2 = await run(threadLine(563, 'right after the agent reply', 560));
    check(m2.acked === true && m2.reason === 'thread' && si.lists.length === 5, `refresh on a miss: ${JSON.stringify(m2)} lists ${si.lists.length}`);
  });

  T('T35', 'a comment that names the OTHER agent inside a thread this agent started: no reaction and no lookup; one that names this agent or says both of you is handled by name or group with no lookup', async () => {
    si.comments = [mk(570, 'agent'), mk(571, 'human', 570), mk(572, 'human', 570), mk(573, 'human', 570)];
    const r = await runAll(env, [threadLine(571, '@Other agent please do this', 570), threadLine(572, '@Example agent please do that', 570), threadLine(573, 'both of you, thanks', 570)]);
    check(r.out[0].addressed === false && r.out[0].acked === null && !('reason' in r.out[0]), r.raw[0]);
    check(r.out[1].addressed === true && r.out[1].acked === true && !('reason' in r.out[1]) && r.out[2].addressed === true && r.out[2].reason === 'group', `${r.raw[1]} / ${r.raw[2]}`);
    check(si.lists.length === 0 && si.requests.length === 2, `lists ${si.lists.length} reactions ${si.requests.length}`);
  });

  T('T36', 'a comment written by an agent, or any kind other than comment.created / comment.replied, in a thread this agent started: never reacted to, no lookup', async () => {
    si.comments = [mk(580, 'agent'), mk(581, 'human', 580)];
    const lines = [threadLine(581, 'x', 580, { author_kind: 'agent' }), threadLine(581, 'x', 580, { author_kind: 'Human' }), threadLine(581, 'x', 580, { author_kind: null }), threadLine(581, 'x', 580, { author_kind: undefined })];
    for (const k of ['comment.reacted', 'comment.updated', 'comment.deleted', 'comment.resolved', 'comment.reopened']) lines.push(threadLine(581, 'x', 580, { kind: k }));
    lines.push(threadLine(581, 'x', 580, { kind: undefined }));
    const r = await runAll(env, lines);
    check(r.out.length === lines.length && r.out.every((o) => o.addressed === false && o.acked === null && !('reason' in o) && !('ack_error' in o)), r.raw.join(' | '));
    check(si.lists.length === 0 && si.requests.length === 0, `lists ${si.lists.length} reactions ${si.requests.length}`);
  });

  T('T37', 'no lookup when the thread cannot matter: a top-level human comment (it starts its own thread), thread_root_id null / not a uuid / absent, a bad document or comment id, or no key', async () => {
    si.comments = [mk(590, 'human'), mk(591, 'human', 590)];
    const r = await runAll(env, [
      threadLine(590, 'top level', 590), humanLine(591, 'no root key'), humanLine(591, 'null root', { thread_root_id: null, parent_id: null }), threadLine(591, 'x', 590, { thread_root_id: 'not-a-uuid' }),
      threadLine(591, 'x', 590, { document_id: '../x' }), threadLine(591, 'x', 590, { comment_id: 'nope' }), threadLine(591, 'x', 590, { comment_id: undefined }),
    ]);
    check(r.out.length === 7 && r.out.every((o) => o.addressed === false && o.acked === null && !('ack_error' in o) && !('reason' in o)), r.raw.join(' | '));
    check(si.lists.length === 0 && si.requests.length === 0, `lists ${si.lists.length} reactions ${si.requests.length}`);
    si.reset(); si.comments = [mk(592, 'agent'), mk(593, 'human', 592)];
    const h = spawnAck(env, { keyFile: path.join(env.runDir, 'missing.key') }); h.write(threadLine(593, 'x', 592)); h.end(); await h.finish();
    const o = JSON.parse(h.lines()[0]);
    check(o.addressed === false && o.acked === null && si.lists.length === 0 && si.requests.length === 0 && !h.stdout.includes(FAKE_KEY), `no key: ${h.lines()[0]}`);
  });

  T('T38', 'order and count preserved around slow lookups: one output line per input line, same order, garbage untouched; the reaction reaches the server within 500 ms of the line', async () => {
    si.comments = [mk(600, 'agent'), mk(601, 'human', 600), mk(610, 'human'), mk(611, 'human', 610), mk(620, 'agent'), mk(621, 'human', 620)];
    si.behave = (rec) => (rec.list ? { delayMs: rec.n === 1 ? 400 : rec.n === 2 ? 200 : 0 } : null);
    const lines = [threadLine(601, 'one', 600), 'garbage 1', threadLine(611, 'two', 610), humanLine(612, '@Example agent named'), threadLine(621, 'three', 620), 'garbage 2'];
    const r = await runAll(env, lines);
    check(r.raw.length === 6 && r.raw[1] === 'garbage 1' && r.raw[5] === 'garbage 2', `lines ${r.raw.length}`);
    check(r.out[0].comment_id === cid(601) && r.out[0].reason === 'thread' && r.out[2].comment_id === cid(611) && r.out[2].acked === null && r.out[3].comment_id === cid(612) && r.out[3].acked === true && r.out[4].comment_id === cid(621) && r.out[4].reason === 'thread', r.raw.join(' | '));
    si.reset(); si.comments = [mk(630, 'agent'), mk(631, 'human', 630)];
    const h = spawnAck(env);
    h.write(humanLine(632, 'warm up, nobody named')); await h.waitLines(1);
    const t0 = Date.now(); h.write(threadLine(631, 'now', 630));
    for (let i = 0; i < 100 && si.requests.length === 0; i++) await sleep(5);
    check(si.requests.length === 1, 'the reaction arrived');
    const dt = si.requests[0].t - t0; h.end(); await h.finish();
    check(dt < 500, `reaction after ${dt} ms`);
  });

  T('T39', 'the lookup guard: only POST https://asia-south1-litethink.cloudfunctions.net/documentsApi/listDocumentComments with exactly the two key headers and a { documentId } body; 2 s default lookup timeout; production URL pinned', async () => {
    check(LIST_URL === 'https://asia-south1-litethink.cloudfunctions.net/documentsApi/listDocumentComments', LIST_URL);
    const rd = realDeps();
    check(rd.lookupTimeoutMs === 2000 && typeof rd.api === 'function', 'real run: 2 s lookup timeout, an api');
    const rw = { hostname: '127.0.0.1', port: si.port }; const rdr = makeApi(rw);
    const hdr = { 'X-SPM-API-Key': FAKE_KEY, 'X-SPM-User-Email': FAKE_EMAIL };
    const body = { documentId: DOC };
    const bad = [
      ['https://us-central1-litethink.cloudfunctions.net/documentsApi/listDocumentComments', 'POST', hdr, body], ['https://evil.example/documentsApi/listDocumentComments', 'POST', hdr, body], ['http://asia-south1-litethink.cloudfunctions.net/documentsApi/listDocumentComments', 'POST', hdr, body],
      [LIST_URL + '?x=1', 'POST', hdr, body], [LIST_URL.replace('list', 'delete'), 'POST', hdr, body], [LIST_URL, 'GET', hdr, body], [LIST_URL, 'POST', { ...hdr, Authorization: 'Bearer x' }, body], [LIST_URL, 'POST', { ...hdr, Origin: ORIGIN }, body],
      [LIST_URL, 'POST', { 'X-SPM-API-Key': FAKE_KEY }, body], [LIST_URL, 'POST', hdr, { documentId: DOC, extra: 1 }], [LIST_URL, 'POST', hdr, {}], [LIST_URL, 'POST', hdr, { documentId: '../../etc' }], [LIST_URL, 'POST', hdr, 'nope'], [LIST_URL, 'POST', hdr, [DOC]],
    ];
    for (const a of bad) { let threw = null; try { await rdr(...a, 1000); } catch (e) { threw = e; } check(threw instanceof GuardError, `not blocked: ${a[0]} ${a[1]} ${JSON.stringify(a[3]).slice(0, 40)}`); }
    check(si.lists.length === 0 && si.requests.length === 0, 'nothing reached the stand-in');
    si.comments = [mk(640, 'agent')];
    const ok = await rdr(LIST_URL, 'POST', hdr, body, 2000);
    check(ok.status === 200 && Array.isArray(ok.json.comments) && ok.json.comments.length === 1 && ok.json.comments[0].author_is_you === true && si.lists.length === 1, `a good lookup goes through (to the stand-in): ${JSON.stringify(ok).slice(0, 120)}`);
    si.behave = () => ({ hang: true });
    const slow = await rdr(LIST_URL, 'POST', hdr, body, 200);
    check(slow.err === 'timeout', `a hung server times out: ${JSON.stringify(slow)}`);
  });

  const postHeaderNames = (rec) => Object.keys(rec.headers).filter((k) => ['origin', 'x-spm-api-key', 'x-spm-user-email', 'idempotency-key', 'authorization'].includes(k)).sort().join(',');
  const ACK_TEXT_RE = /^Seen by the (Example agent) at (\d\d):(\d\d) IST\. Working on it; the answer follows in this thread\.$/;
  const istMinutes = (ms) => { const d = new Date(ms + 19800000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const nearNow = (hh, mm) => { const diff = Math.abs(istMinutes(Date.now()) - (Number(hh) * 60 + Number(mm))); return Math.min(diff, 1440 - diff) <= 2; };

  T('T40', 'text reply for a NAMED line: one POST createDocumentComment under the thread root (not under a reply), right headers incl. Idempotency-Key ack-text:<comment id>, right text with the Example agent label and an IST time, text_acked true (last key); the stand-in holds one new agent comment', async () => {
    si.comments = [mk(700, 'human'), mk(701, 'human', 700)];
    const r = await runAll(env, [threadLine(701, '@Example agent please look at this', 700)]);
    check(si.requests.length === 1 && si.posts.length === 1, `reactions ${si.requests.length} posts ${si.posts.length}`);
    const q = si.posts[0];
    check(q.method === 'POST' && q.url === '/documentsApi/createDocumentComment', `${q.method} ${q.url}`);
    check(postHeaderNames(q) === 'idempotency-key,origin,x-spm-api-key,x-spm-user-email' && q.headers.origin === ORIGIN && q.headers['x-spm-api-key'] === FAKE_KEY && q.headers['x-spm-user-email'] === FAKE_EMAIL, `headers ${postHeaderNames(q)}`);
    check(q.headers['idempotency-key'] === `ack-text:${cid(701)}`, `Idempotency-Key ${q.headers['idempotency-key']}`);
    const b = JSON.parse(q.raw);
    check(Object.keys(b).sort().join() === 'body,documentId,parent_id' && b.documentId === DOC && b.parent_id === cid(700), `body ${q.raw}`);
    const m = ACK_TEXT_RE.exec(b.body);
    check(m && m[1] === 'Example agent' && nearNow(m[2], m[3]), `text ${JSON.stringify(b.body)}`);
    const o = r.out[0];
    check(o.addressed === true && o.acked === true && o.text_acked === true && !('reason' in o) && lastKeys(o, 3) === 'addressed,acked,text_acked', r.raw[0]);
    const mine = si.comments.filter((c) => c.author_identity === SELF_ID && c.body === b.body && c.parent_id === cid(700));
    check(mine.length === 1, 'the stand-in holds exactly one new agent comment under the root');
    // a top-level named comment is its own root
    si.reset(); si.comments = [mk(702, 'human')];
    const r2 = await runAll(env, [threadLine(702, '@Example agent hi', 702, { kind: 'comment.created' })]);
    check(si.posts.length === 1 && JSON.parse(si.posts[0].raw).parent_id === cid(702) && r2.out[0].text_acked === true, r2.raw[0]);
  });

  T('T41', 'text reply for a GROUP-words line too (reason group, then text_acked last); nothing for a thread-only reaction', async () => {
    si.comments = [mk(710, 'human'), mk(711, 'human', 710)];
    const r = await runAll(env, [threadLine(711, 'both of you, please', 710)]);
    check(si.posts.length === 1 && si.requests.length === 1, `posts ${si.posts.length} reactions ${si.requests.length}`);
    const o = r.out[0];
    check(o.addressed === true && o.acked === true && o.reason === 'group' && o.text_acked === true && lastKeys(o, 4) === 'addressed,acked,reason,text_acked', r.raw[0]);
    // thread-only: the thread was started by this agent, a human wrote in it, nobody named: eyes, no text
    si.reset(); si.comments = [mk(720, 'agent'), mk(721, 'human', 720)];
    const r2 = await runAll(env, [threadLine(721, 'thanks', 720)]);
    check(r2.out[0].reason === 'thread' && r2.out[0].acked === true && r2.out[0].text_acked === null && si.posts.length === 0 && si.requests.length === 1, `thread only: ${r2.raw[0]} posts ${si.posts.length}`);
  });

  T('T42', 'no text reply: agent author, other event kinds, other agent named, a body starting "Seen by the", no thread_root_id, an invalid id, a missing key', async () => {
    si.comments = [mk(730, 'human'), mk(731, 'human', 730)];
    const lines = [
      threadLine(731, '@Example agent x', 730, { author_kind: 'agent' }), threadLine(731, '@Example agent x', 730, { kind: 'comment.updated' }), threadLine(731, '@Other agent please', 730),
      threadLine(731, 'Seen by the Other agent at 10:00 IST. @Example agent you take this one', 730), threadLine(731, '  seen BY the   other agent @Example agent', 730),
      humanLine(731, '@Example agent no root key'), humanLine(731, '@Example agent null root', { thread_root_id: null, parent_id: null }), threadLine(731, '@Example agent bad root', 730, { thread_root_id: 'not-a-uuid' }),
    ];
    const r = await runAll(env, lines);
    check(r.out.length === lines.length && r.out.every((o) => o.text_acked === null), r.raw.map((l) => JSON.parse(l).text_acked).join());
    check(si.posts.length === 0, `posts ${si.posts.length}`);
    check(r.out[3].addressed === true && r.out[3].acked === true && r.out[4].addressed === true, 'the "Seen by the" lines are still reacted to by eyes (named), only the text reply is withheld');
    si.reset(); si.comments = [mk(732, 'human')];
    const h = spawnAck(env, { keyFile: path.join(env.runDir, 'missing.key') }); h.write(threadLine(732, '@Example agent x', 732, { kind: 'comment.created' })); h.end(); await h.finish();
    const o = JSON.parse(h.lines()[0]);
    check(o.text_acked === null && o.ack_error === 'no_key' && si.posts.length === 0, h.lines()[0]);
  });

  T('T43', 'idempotent: a repeat line in one process posts once; a restart (second acker) replays or gets 422 idempotency_key_reused and both count as posted; the stand-in never holds two replies (fake clock, exact time in the text)', async () => {
    const t0 = Date.UTC(2026, 9, 4, 18, 21, 0); // 23:51 IST
    let t = t0; const rw = { hostname: '127.0.0.1', port: si.port };
    const mkAcker = (clock) => createAcker({ key: FAKE_KEY, email: FAKE_EMAIL, mentions: ['@example agent'], others: ['@other agent'], selfId: SELF_ID, label: 'Example agent' }, { transport: makeTransport(rw), api: makeApi(rw), now: clock });
    si.comments = [mk(740, 'human'), mk(741, 'human', 740)];
    const line = threadLine(741, '@Example agent please', 740);
    const a = mkAcker(() => t);
    const x1 = JSON.parse(await a.handleLine(line)); const x2 = JSON.parse(await a.handleLine(line));
    check(x1.text_acked === true && x2.text_acked === true && si.posts.length === 1, `one process, two lines: posts ${si.posts.length}`);
    check(JSON.parse(si.posts[0].raw).body === 'Seen by the Example agent at 23:51 IST. Working on it; the answer follows in this thread.', `text ${JSON.parse(si.posts[0].raw).body}`);
    const same = JSON.parse(await mkAcker(() => t).handleLine(line)); // a restart in the same minute: the same request replays
    check(same.text_acked === true && si.posts.length === 2 && si.comments.filter((c) => c.author_identity === SELF_ID).length === 1, `replay: posts ${si.posts.length}`);
    t = t0 + 5 * 60000; // a restart five minutes later: the text differs (HH:MM), the key is the same: 422 idempotency_key_reused, counted as posted
    const later = JSON.parse(await mkAcker(() => t).handleLine(line));
    check(later.text_acked === true && si.posts.length === 3 && si.comments.filter((c) => c.author_identity === SELF_ID).length === 1, `422 path: posts ${si.posts.length} rows ${si.comments.filter((c) => c.author_identity === SELF_ID).length}`);
    // concurrent lines for one comment share ONE request
    si.reset(); si.comments = [mk(742, 'human'), mk(743, 'human', 742)]; si.behave = (rec) => (rec.post ? { delayMs: 200 } : null);
    const line2 = threadLine(743, '@Example agent please', 742);
    const both = await Promise.all([mkAcker(() => t).handleLine(line2)]);
    const acker2 = mkAcker(() => t); const pair = await Promise.all([acker2.handleLine(line2), acker2.handleLine(line2)]);
    check(JSON.parse(both[0]).text_acked === true && pair.every((l) => JSON.parse(l).text_acked === true) && si.comments.filter((c) => c.author_identity === SELF_ID).length === 1, `concurrent: posts ${si.posts.length}`);
    check(si.posts.length === 2, `the concurrent pair made one request (plus the first acker's): ${si.posts.length}`);
  });

  T('T44', '--no-text-ack turns the text reply off (eyes unchanged, text_acked null); default is on; given twice is a usage error', async () => {
    si.comments = [mk(750, 'human'), mk(751, 'human', 750)];
    const r = await runAll(env, [threadLine(751, '@Example agent', 750)], { args: ['--no-text-ack'] });
    check(si.posts.length === 0 && si.requests.length === 1 && r.out[0].acked === true && r.out[0].text_acked === null, r.raw[0]);
    const a = parseArgs([]); const b = parseArgs(['--no-text-ack']);
    check(a.ok && a.cfg.textAck === true && b.ok && b.cfg.textAck === false, 'defaults');
    check(parseArgs(['--no-text-ack', '--no-text-ack']).ok === false, 'twice refused');
  });

  T('T45', 'text reply failure (500, 403, dropped connection, hang past the timeout, 200 without an id, 200 not JSON): text_acked false, the eyes still sent, the line still printed in order, no crash, within the bound; a failure is retried on the next line of that comment', async () => {
    const modes = [{ name: '500', b: { status: 500 } }, { name: 'destroy', b: { destroy: true } }, { name: 'hang', b: { hang: true }, ms: 300 }, { name: '200 no id', b: { raw: '{"ok":true}' } }, { name: '200 not json', b: { raw: 'nope' } }];
    for (const m of modes) {
      si.reset(); si.comments = [mk(760, 'human'), mk(761, 'human', 760)]; si.behave = (rec) => (rec.post ? m.b : null);
      const t0 = Date.now();
      const r = await runAll(env, [threadLine(761, '@Example agent', 760)], { textTimeoutMs: m.ms || 2000 });
      const o = r.out[0];
      check(r.code === 0 && r.out.length === 1 && o.addressed === true && o.acked === true && o.text_acked === false && !('ack_error' in o) && Date.now() - t0 < 3500, `${m.name}: ${r.raw[0]} (${Date.now() - t0} ms)`);
      check(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY), `${m.name}: key`);
    }
    si.reset(); si.comments = [mk(760, 'human'), mk(761, 'human', 760), mk(762, 'human', 760)]; si.behave = (rec) => (rec.post && rec.n === 1 ? { status: 500 } : null);
    const h = spawnAck(env);
    h.write(threadLine(761, '@Example agent one', 760)); await h.waitLines(1); h.write('garbage'); h.write(threadLine(761, '@Example agent one', 760)); h.write(threadLine(762, '@Example agent two', 760)); await h.waitLines(4); h.end(); await h.finish();
    const o2 = h.lines().map((l) => { try { return JSON.parse(l); } catch { return l; } });
    check(o2[0].text_acked === false && o2[1] === 'garbage' && o2[2].text_acked === true && o2[2].comment_id === cid(761) && o2[3].text_acked === true && o2[3].comment_id === cid(762), `retry: ${h.lines().join(' | ')}`);
    check(si.posts.length === 3 && si.comments.filter((c) => c.author_identity === SELF_ID).length === 2 && si.posts[0].headers['idempotency-key'] === si.posts[1].headers['idempotency-key'], `posts ${si.posts.length}`);
  });


  T('T47', 'the comment-post guard: only POST createDocumentComment with Origin + the two key headers + an ack-text Idempotency-Key, a { documentId, body, parent_id } body, and the exact ack text; any other text, header, host or parent is refused', async () => {
    const rw = { hostname: '127.0.0.1', port: si.port }; const api = makeApi(rw);
    const URL_ = `https://${'asia-south1-litethink.cloudfunctions.net'}/documentsApi/createDocumentComment`;
    const hdr = { Origin: ORIGIN, 'X-SPM-API-Key': FAKE_KEY, 'X-SPM-User-Email': FAKE_EMAIL, 'Idempotency-Key': `ack-text:${cid(1)}` };
    const body = { documentId: DOC, body: 'Seen by the Example agent at 23:51 IST. Working on it; the answer follows in this thread.', parent_id: cid(2) };
    const bad = [
      ['https://us-central1-litethink.cloudfunctions.net/documentsApi/createDocumentComment', 'POST', hdr, body], ['https://evil.example/documentsApi/createDocumentComment', 'POST', hdr, body], [URL_.replace('https:', 'http:'), 'POST', hdr, body], [URL_ + '?x=1', 'POST', hdr, body], [URL_, 'GET', hdr, body],
      [URL_, 'POST', { ...hdr, Authorization: 'Bearer x' }, body], [URL_, 'POST', { 'X-SPM-API-Key': FAKE_KEY, 'X-SPM-User-Email': FAKE_EMAIL, 'Idempotency-Key': hdr['Idempotency-Key'] }, body], [URL_, 'POST', { ...hdr, Origin: 'https://evil.example' }, body],
      [URL_, 'POST', { ...hdr, 'Idempotency-Key': 'whatever' }, body], [URL_, 'POST', { ...hdr, 'Idempotency-Key': 'ack-text:nope' }, body], [URL_, 'POST', { Origin: ORIGIN, 'X-SPM-API-Key': FAKE_KEY, 'X-SPM-User-Email': FAKE_EMAIL }, body],
      [URL_, 'POST', hdr, { ...body, body: 'a different text entirely' }], [URL_, 'POST', hdr, { ...body, body: body.body + ' extra' }], [URL_, 'POST', hdr, { ...body, body: 'Seen by the Example agent at 99:99 IST. Working on it; the answer follows in this thread.' }],
      [URL_, 'POST', hdr, { ...body, body: 'Seen by the Boss at 10:00 IST. Working on it; the answer follows in this thread.' }], [URL_, 'POST', hdr, { ...body, extra: 1 }], [URL_, 'POST', hdr, { documentId: DOC, body: body.body }], [URL_, 'POST', hdr, { ...body, parent_id: '../x' }], [URL_, 'POST', hdr, { ...body, documentId: 'nope' }], [URL_, 'POST', hdr, 'nope'],
    ];
    for (const a of bad) { let threw = null; try { await api(...a, 1000); } catch (e) { threw = e; } check(threw instanceof GuardError, `not blocked: ${a[0]} ${a[1]} ${JSON.stringify(a[3]).slice(0, 70)}`); }
    check(si.posts.length === 0 && si.lists.length === 0 && si.requests.length === 0, 'nothing reached the stand-in');
    const rd = realDeps();
    check(rd.textTimeoutMs === 2000, 'real run: 2 s text reply timeout');
    si.comments = [mk(2, 'human')];
    const ok = await api(URL_, 'POST', hdr, body, 2000);
    check(ok.status === 200 && ok.json && typeof ok.json.id === 'string' && si.posts.length === 1, `a good post goes through (to the stand-in): ${JSON.stringify(ok).slice(0, 100)}`);
    const ok2 = await api(URL_, 'POST', hdr, body, 2000);
    check(ok2.status === 200 && ok2.json.id === ok.json.id && si.comments.filter((c) => c.author_identity === SELF_ID).length === 1, 'the same request replays (the stand-in mirrors the idempotency contract)');
    const re = await api(URL_, 'POST', hdr, { ...body, body: 'Seen by the Example agent at 23:52 IST. Working on it; the answer follows in this thread.' }, 2000);
    check(re.status === 422 && re.json.error === 'idempotency_key_reused', `a different request with the same key is 422: ${JSON.stringify(re)}`);
  });

  T('T47b', 'the warm router: the document list, the document post and the eyes go to /documentsApi/ and are admitted; the bare /listDocumentComments, /createDocumentComment and /reactToDocumentComment are refused before any call', async () => {
    const hdr = { 'X-SPM-API-Key': FAKE_KEY, 'X-SPM-User-Email': 'spm-example-agent@agents.invalid' };
    const refused = (fn) => { try { fn(); return false; } catch (e) { return e instanceof GuardError; } };
    check(!refused(() => guardList(`https://${FN_HOST}/documentsApi/listDocumentComments`, 'POST', hdr, { documentId: DOC })), 'the router list was refused');
    check(refused(() => guardList(`https://${FN_HOST}/listDocumentComments`, 'POST', hdr, { documentId: DOC })), 'the bare list was admitted');
    const react = JSON.stringify({ documentId: DOC, commentId: DOC, emoji: '\u{1F440}', op: 'add' });
    check(!refused(() => guardRequest(`https://${FN_HOST}/documentsApi/reactToDocumentComment`, 'POST', { Origin: ORIGIN, ...hdr }, react)), 'the router eyes post was refused');
    check(refused(() => guardRequest(`https://${FN_HOST}/reactToDocumentComment`, 'POST', { Origin: ORIGIN, ...hdr }, react)), 'the bare eyes post was admitted');
  });

  T('T48', 'text replies are capped at 10 per rolling minute per process (the 11th is text_acked false, no request); the window slides; the eyes are not affected (fake clock)', async () => {
    let t = 9000000; const rw = { hostname: '127.0.0.1', port: si.port };
    const acker = createAcker({ key: FAKE_KEY, email: FAKE_EMAIL, mentions: ['@example agent'], others: ['@other agent'], selfId: SELF_ID, label: 'Example agent' }, { transport: makeTransport(rw), api: makeApi(rw), now: () => t });
    si.comments = [mk(800, 'human')];
    for (let i = 0; i < 12; i++) si.comments.push(mk(801 + i, 'human', 800));
    const outs = [];
    for (let i = 0; i < 11; i++) outs.push(JSON.parse(await acker.handleLine(threadLine(801 + i, '@Example agent', 800))));
    check(outs.slice(0, 10).every((o) => o.text_acked === true) && outs[10].text_acked === false && outs[10].acked === true && si.posts.length === 10 && si.requests.length === 11, `posts ${si.posts.length} reactions ${si.requests.length}: ${JSON.stringify(outs[10])}`);
    t += 59999; const still = JSON.parse(await acker.handleLine(threadLine(812, '@Example agent', 800)));
    check(still.text_acked === false, 'still capped at 59.999 s');
    t += 2; const later = JSON.parse(await acker.handleLine(threadLine(812, '@Example agent', 800)));
    check(later.text_acked === true && si.posts.length === 11, 'the window slid after 60 s (the capped try was not remembered)');
  });



  // ==== BOARD AND MAP LINES : the listener's item lines (item_type, item_id, board lines also task_id) get the same instant text acknowledgement, through the reply paths of the reply script.
  // The stand-in answers in the wire format of the item routes. An item line gets NO eyes reaction and no thread rule (acked stays null): only the text reply.
  const itemRow = (n, by, parent) => ({ id: cid(n), parent_id: parent === undefined ? null : cid(parent), body: `comment ${n}`, author_email: by === 'human' ? 'person@example.com' : FAKE_EMAIL, author_kind: by === 'human' ? 'human' : 'agent', author_display_name: by === 'human' ? 'Example person' : 'Fake agent', created_at: new Date(Date.UTC(2026, 9, 5, 11, 0, n % 60)).toISOString() });
  const seedItem = (type, ...rows) => { for (const r of rows) si.itemComments[type].set(r.id, r); };
  const boardLine = (n, text, root, extra) => JSON.stringify({ t: '2026-10-05T20:00:00+05:30', item_type: 'board', item_id: BOARD_ID, seq: 100 + n, kind: root === n ? 'comment.created' : 'comment.replied', comment_id: cid(n), author_kind: 'human', author_name: 'Example person', excerpt: text.slice(0, 160), via: 'marker', parent_id: root === n ? null : cid(root), thread_root_id: cid(root), task_id: TASK_ID, body: text, ...extra });
  const mapLine = (n, text, root, extra) => JSON.stringify({ t: '2026-10-05T20:00:00+05:30', item_type: 'map', item_id: MAP_ID, seq: 100 + n, kind: root === n ? 'comment.created' : 'comment.replied', comment_id: cid(n), author_kind: 'human', author_name: 'Example person', excerpt: text.slice(0, 160), via: 'marker', parent_id: root === n ? null : cid(root), thread_root_id: cid(root), body: text, ...extra });
  const itemHeaderNames = (rec) => Object.keys(rec.headers).filter((k) => ['origin', 'x-spm-api-key', 'x-spm-user-email', 'idempotency-key', 'authorization', 'content-type', 'content-length'].includes(k)).sort().join(',');
  const AGENT_TEXT_RE = /^Seen by the (Example agent) at (\d\d):(\d\d) IST\. Working on it; the answer follows in this thread\.$/;

  T('T60', 'a NAMED BOARD line: exactly one POST /boardsApi/tasks/<task_id>/comments { body, parent_id } under the thread root with Origin, key and address (no Idempotency-Key, the route has none), the ack text, text_acked true; NO reaction, NO list lookup; acked stays null', async () => {
    seedItem('board', itemRow(1000, 'human'), itemRow(1001, 'human', 1000));
    const r = await runAll(env, [boardLine(1001, '@Example agent please look at this task', 1000)]);
    check(si.itemReqs.length === 1 && si.requests.length === 0 && si.posts.length === 0 && si.lists.length === 0, `item requests ${si.itemReqs.length} reactions ${si.requests.length} document posts ${si.posts.length} lists ${si.lists.length}`);
    const q = si.itemReqs[0];
    check(q.method === 'POST' && q.url === `/boardsApi/tasks/${TASK_ID}/comments`, `${q.method} ${q.url}`);
    check(itemHeaderNames(q) === 'content-length,content-type,origin,x-spm-api-key,x-spm-user-email' && q.headers.origin === ORIGIN && q.headers['x-spm-api-key'] === FAKE_KEY && q.headers['x-spm-user-email'] === FAKE_EMAIL, `headers ${itemHeaderNames(q)}`);
    const b = JSON.parse(q.raw);
    check(Object.keys(b).join() === 'body,parent_id' && b.parent_id === cid(1000), `body ${q.raw}`);
    const m = AGENT_TEXT_RE.exec(b.body);
    check(m && m[1] === 'Example agent' && nearNow(m[2], m[3]), `text ${JSON.stringify(b.body)}`);
    const o = r.out[0];
    check(o.addressed === true && o.acked === null && o.text_acked === true && !('ack_error' in o) && !('reason' in o) && lastKeys(o, 3) === 'addressed,acked,text_acked', r.raw[0]);
    const orig = JSON.parse(boardLine(1001, '@Example agent please look at this task', 1000));
    check(Object.keys(o).slice(0, Object.keys(orig).length).join() === Object.keys(orig).join() && Object.keys(orig).every((k) => o[k] === orig[k]), 'original keys, order and values kept (item_type, item_id, task_id included)');
    check([...si.itemComments.board.values()].filter((c) => c.author_email === FAKE_EMAIL && c.body === b.body && c.parent_id === cid(1000)).length === 1, 'the stand-in holds exactly one new agent comment under the root');
  });

  T('T61', 'a NAMED MAP line: POST /mapsApi/maps/<item_id>/comments under the thread root, text_acked true, acked null, no reaction; a top-level named comment is its own root', async () => {
    seedItem('map', itemRow(1100, 'human'), itemRow(1101, 'human', 1100), itemRow(1102, 'human'));
    const r = await runAll(env, [mapLine(1101, '@Example agent look at the map', 1100), mapLine(1102, '@Example agent top level', 1102)]);
    check(si.itemReqs.length === 2 && si.itemReqs.every((q) => q.url === `/mapsApi/maps/${MAP_ID}/comments`) && si.requests.length === 0 && si.lists.length === 0, `item requests ${si.itemReqs.map((q) => q.url)}`);
    check(JSON.parse(si.itemReqs[0].raw).parent_id === cid(1100) && JSON.parse(si.itemReqs[1].raw).parent_id === cid(1102), 'parent ids');
    check(r.out.every((o) => o.addressed === true && o.acked === null && o.text_acked === true && lastKeys(o, 3) === 'addressed,acked,text_acked'), r.raw.join(' | '));
  });

  T('T62', 'a REPLY line (kind comment.replied) is answered under its ROOT, never under the reply; the stand-in refuses a reply under a reply exactly as the real route does', async () => {
    seedItem('board', itemRow(1200, 'human'), itemRow(1201, 'human', 1200));
    seedItem('map', itemRow(1210, 'human'), itemRow(1211, 'human', 1210));
    const r = await runAll(env, [boardLine(1201, '@Example agent reply on a task', 1200), mapLine(1211, '@Example agent reply on a map', 1210)]);
    check(r.out.every((o) => o.text_acked === true) && JSON.parse(si.itemReqs[0].raw).parent_id === cid(1200) && JSON.parse(si.itemReqs[1].raw).parent_id === cid(1210), r.raw.join(' | '));
    // a line whose thread_root_id is itself a reply (a malformed line): the real route would refuse (400 reply_to_reply): text_acked false, nothing posted, no crash
    si.reset(); seedItem('board', itemRow(1220, 'human'), itemRow(1221, 'human', 1220));
    const bad = await runAll(env, [boardLine(1221, '@Example agent root is a reply', 1221, { thread_root_id: cid(1221) })]);
    check(bad.out[0].text_acked === false && si.itemComments.board.size === 2, `malformed root: ${bad.raw[0]}`);
  });

  T('T63', 'group words address item lines too (reason group, then text_acked last); a comment naming only the OTHER agent (or the other agents) gets nothing; the other kinds, agent authors and "Seen by the" bodies are never answered', async () => {
    seedItem('board', itemRow(1300, 'human'), itemRow(1301, 'human', 1300));
    seedItem('map', itemRow(1310, 'human'));
    const lines = [boardLine(1301, 'both of you, please', 1300), mapLine(1310, 'the agents should look', 1310), boardLine(1301, '@Other agent only', 1300), boardLine(1301, '@Other agent only', 1300), mapLine(1310, 'nobody here', 1310)];
    const r = await runAll(env, lines);
    check(r.out[0].addressed === true && r.out[0].reason === 'group' && r.out[0].text_acked === true && lastKeys(r.out[0], 4) === 'addressed,acked,reason,text_acked', r.raw[0]);
    check(r.out[1].addressed === true && r.out[1].reason === 'group' && r.out[1].text_acked === true, r.raw[1]);
    check(r.out.slice(2).every((o) => o.addressed === false && o.acked === null && o.text_acked === null && !('reason' in o)), r.raw.slice(2).join(' | '));
    check(si.itemReqs.length === 2, `posts ${si.itemReqs.length}`);
    si.reset(); seedItem('board', itemRow(1320, 'human'));
    const none = [boardLine(1320, '@Example agent x', 1320, { author_kind: 'agent' }), boardLine(1320, '@Example agent x', 1320, { kind: 'comment.updated' }), boardLine(1320, '@Example agent x', 1320, { kind: 'comment.deleted' }),
      boardLine(1320, 'Seen by the Other agent at 10:00 IST. @Example agent you take this', 1320), boardLine(1320, '  seen BY the   other agent @Example agent', 1320), boardLine(1320, '@Example agent x', 1320, { author_kind: 'Human' })];
    const r2 = await runAll(env, none);
    check(si.itemReqs.length === 0 && r2.out.every((o) => o.text_acked === null), `no ack expected: ${r2.raw.join(' | ')}`);
    check(r2.out[3].addressed === true && r2.out[4].addressed === true && r2.out[3].acked === null, 'the "Seen by the" lines are addressed (by name) but their text reply is withheld');
    // a line that names only the other agent is not for this agent, and gets no text reply
    si.reset(); seedItem('map', itemRow(1330, 'human'));
    const other = await runAll(env, [mapLine(1330, '@Other agent only', 1330)]);
    check(other.out[0].addressed === false && other.out[0].text_acked === null && si.itemReqs.length === 0, `other only: ${other.raw[0]}`);
  });

  T('T64', 'de-duplication on items: the same line twice in one process posts once; concurrent repeats share one request; another comment posts again; a failed try is retried on the next line of that comment; the key is per item type and id (a board and a map line with the same comment id do not collide)', async () => {
    seedItem('board', itemRow(1400, 'human'), itemRow(1401, 'human', 1400));
    seedItem('map', itemRow(1400, 'human'), itemRow(1411, 'human', 1400));
    const line = boardLine(1401, '@Example agent please', 1400);
    const r = await runAll(env, [line, line]);
    check(r.out.every((o) => o.text_acked === true) && si.itemReqs.length === 1, `same line twice: requests ${si.itemReqs.length} ${r.raw.join(' | ')}`);
    si.reset(); seedItem('board', itemRow(1400, 'human'), itemRow(1401, 'human', 1400)); si.behave = (rec) => (rec.itemPost ? { delayMs: 200 } : null);
    const c = await runAll(env, [line, line, line]);
    check(c.out.every((o) => o.text_acked === true) && si.itemReqs.length === 1, `concurrent: requests ${si.itemReqs.length}`);
    si.reset(); seedItem('board', itemRow(1400, 'human'), itemRow(1401, 'human', 1400), itemRow(1402, 'human', 1400));
    const two = await runAll(env, [line, boardLine(1402, '@Example agent two', 1400)]);
    check(si.itemReqs.length === 2 && two.out.every((o) => o.text_acked === true), `two comments: ${si.itemReqs.length}`);
    si.reset(); seedItem('board', itemRow(1400, 'human'), itemRow(1401, 'human', 1400)); si.behave = (rec) => (rec.itemPost && rec.n === 1 ? { status: 500 } : null);
    const h = spawnAck(env); h.write(line); await h.waitLines(1); h.write(line); await h.waitLines(2); h.end(); await h.finish();
    const f = h.lines().map((l) => JSON.parse(l));
    check(f[0].text_acked === false && f[1].text_acked === true && si.itemReqs.length === 2, `a failed try is retried: ${h.lines().join(' | ')}`);
    si.reset(); seedItem('board', itemRow(1400, 'human'), itemRow(1401, 'human', 1400)); seedItem('map', itemRow(1400, 'human'), itemRow(1411, 'human', 1400));
    const k = await runAll(env, [boardLine(1401, '@Example agent x', 1400), mapLine(1401, '@Example agent x', 1400, { parent_id: cid(1400) })]);
    check(si.itemReqs.length === 2 && k.out.every((o) => o.text_acked === true) && si.itemReqs[0].url.startsWith('/boardsApi/') && si.itemReqs[1].url.startsWith('/mapsApi/'), `board and map with one comment id: ${si.itemReqs.map((q) => q.url)}`);
  });

  T('T65', 'the rate cap is shared: at most 10 text replies per rolling minute per process across documents, boards and maps (the 11th is text_acked false, no request); the window slides (fake clock)', async () => {
    let t = 9000000; const rw = { hostname: '127.0.0.1', port: si.port };
    const acker = createAcker({ key: FAKE_KEY, email: FAKE_EMAIL, mentions: ['@example agent'], others: ['@other agent'], selfId: SELF_ID, label: 'Example agent' }, { transport: makeTransport(rw), api: makeApi(rw), now: () => t });
    seedItem('board', itemRow(1500, 'human')); seedItem('map', itemRow(1600, 'human'));
    for (let i = 0; i < 12; i++) { seedItem('board', itemRow(1501 + i, 'human', 1500)); seedItem('map', itemRow(1601 + i, 'human', 1600)); }
    const outs = [];
    for (let i = 0; i < 11; i++) outs.push(JSON.parse(await acker.handleLine(i % 2 ? mapLine(1601 + i, '@Example agent', 1600) : boardLine(1501 + i, '@Example agent', 1500))));
    check(outs.slice(0, 10).every((o) => o.text_acked === true) && outs[10].text_acked === false && si.itemReqs.length === 10, `requests ${si.itemReqs.length}: ${JSON.stringify(outs[10])}`);
    t += 60001; const later = JSON.parse(await acker.handleLine(boardLine(1501 + 10, '@Example agent', 1500)));
    check(later.text_acked === true && si.itemReqs.length === 11, 'the window slid');
  });

  T('T66', 'malformed item lines never post: no task_id (or null, or not a uuid) on a board line, a bad item_id, a bad comment_id or thread_root_id, an unknown item_type, no thread_root_id: acked/text_acked per the document rules, no crash, the line printed', async () => {
    seedItem('board', itemRow(1700, 'human'), itemRow(1701, 'human', 1700)); seedItem('map', itemRow(1710, 'human'));
    const lines = [
      boardLine(1701, '@Example agent', 1700, { task_id: null }), boardLine(1701, '@Example agent', 1700, { task_id: 'not-a-uuid' }), JSON.stringify({ ...JSON.parse(boardLine(1701, '@Example agent', 1700)), task_id: undefined }),
      boardLine(1701, '@Example agent', 1700, { item_id: 'nope' }), mapLine(1710, '@Example agent', 1710, { item_id: null }), boardLine(1701, '@Example agent', 1700, { comment_id: 'nope' }), boardLine(1701, '@Example agent', 1700, { thread_root_id: null }),
      boardLine(1701, '@Example agent', 1700, { thread_root_id: 'nope' }), boardLine(1701, '@Example agent', 1700, { item_type: 'task' }), mapLine(1710, '@Example agent', 1710, { item_type: 'document' }), boardLine(1701, '@Example agent', 1700, { item_type: undefined }),
      boardLine(1701, '@Example agent', 1700, { document_id: '00000000-0000-4000-8000-000000010001' }),
    ];
    const r = await runAll(env, lines);
    check(r.out.length === lines.length && r.code === 0, `lines ${r.raw.length} exit ${r.code}`);
    check(si.itemReqs.length === 0 && si.posts.length === 0 && si.requests.length === 0, `requests: item ${si.itemReqs.length} document posts ${si.posts.length} reactions ${si.requests.length}`);
    check(r.out.every((o) => o.text_acked === null || o.text_acked === false), r.raw.join(' | '));
    // the two lines without a usable thread root have nothing to reply under (nothing tried, nothing reported); every other malformed line is reported as bad_ids, the way a document line with bad ids is
    check(r.out.every((o, i) => ([6, 7].includes(i) ? (o.acked === null && o.text_acked === null && !('ack_error' in o)) : (o.acked === false && o.ack_error === 'bad_ids' && o.text_acked === null))), `acked / ack_error per malformed line: ${r.raw.map((l) => { const o = JSON.parse(l); return `${o.acked}/${o.ack_error}`; }).join(' ')}`);
  });

  T('T67', 'no key, --no-text-ack and a missing key file on item lines: --no-text-ack leaves text_acked null and posts nothing; an unreadable key file gives acked false, ack_error no_key, nothing posted, the line still printed', async () => {
    seedItem('board', itemRow(1800, 'human'), itemRow(1801, 'human', 1800));
    const a = await runAll(env, [boardLine(1801, '@Example agent', 1800)], { args: ['--no-text-ack'] });
    check(si.itemReqs.length === 0 && a.out[0].addressed === true && a.out[0].acked === null && a.out[0].text_acked === null, a.raw[0]);
    const h = spawnAck(env, { keyFile: path.join(env.runDir, 'missing.key') }); h.write(boardLine(1801, '@Example agent', 1800)); h.end(); await h.finish();
    const o = JSON.parse(h.lines()[0]);
    check(o.addressed === true && o.acked === false && o.ack_error === 'no_key' && o.text_acked === null && si.itemReqs.length === 0, h.lines()[0]);
  });

  T('T68', 'a document line keeps its exact output: six input lines and their six output lines are pinned as literal strings (named, group, other agent, no mention, garbage, repeat)', async () => {
    si.comments = [mk(900, 'human'), mk(901, 'human', 900), mk(902, 'human')];
    const IN = [
      '{"t":"2026-10-04T16:50:15+05:30","document_id":"00000000-0000-4000-8000-000000010001","seq":1001,"kind":"comment.replied","comment_id":"00000000-0000-4000-8000-000000000901","author_kind":"human","author_name":"Person Fake","excerpt":"@Example agent please look at this","via":"marker","parent_id":"00000000-0000-4000-8000-000000000900","thread_root_id":"00000000-0000-4000-8000-000000000900","body":"@Example agent please look at this"}',
      '{"t":"2026-10-04T16:50:15+05:30","document_id":"00000000-0000-4000-8000-000000010001","seq":1002,"kind":"comment.created","comment_id":"00000000-0000-4000-8000-000000000902","author_kind":"human","author_name":"Person Fake","excerpt":"both of you, please","via":"marker","parent_id":null,"thread_root_id":"00000000-0000-4000-8000-000000000902","body":"both of you, please"}',
      '{"t":"2026-10-04T16:50:15+05:30","document_id":"00000000-0000-4000-8000-000000010001","seq":1003,"kind":"comment.replied","comment_id":"00000000-0000-4000-8000-000000000903","author_kind":"human","author_name":"Person Fake","excerpt":"@Other agent only","via":"marker"}',
      '{"t":"2026-10-04T16:50:15+05:30","document_id":"00000000-0000-4000-8000-000000010001","seq":1004,"kind":"comment.replied","comment_id":"00000000-0000-4000-8000-000000000904","author_kind":"human","author_name":"Person Fake","excerpt":"no mention here","via":"marker"}',
      'garbage line',
      '{"t":"2026-10-04T16:50:15+05:30","document_id":"00000000-0000-4000-8000-000000010001","seq":1001,"kind":"comment.replied","comment_id":"00000000-0000-4000-8000-000000000901","author_kind":"human","author_name":"Person Fake","excerpt":"@Example agent again","via":"marker","parent_id":"00000000-0000-4000-8000-000000000900","thread_root_id":"00000000-0000-4000-8000-000000000900","body":"@Example agent again"}',
    ];
    const OUT = [
      '{"t":"2026-10-04T16:50:15+05:30","document_id":"00000000-0000-4000-8000-000000010001","seq":1001,"kind":"comment.replied","comment_id":"00000000-0000-4000-8000-000000000901","author_kind":"human","author_name":"Person Fake","excerpt":"@Example agent please look at this","via":"marker","parent_id":"00000000-0000-4000-8000-000000000900","thread_root_id":"00000000-0000-4000-8000-000000000900","body":"@Example agent please look at this","addressed":true,"acked":true,"text_acked":true}',
      '{"t":"2026-10-04T16:50:15+05:30","document_id":"00000000-0000-4000-8000-000000010001","seq":1002,"kind":"comment.created","comment_id":"00000000-0000-4000-8000-000000000902","author_kind":"human","author_name":"Person Fake","excerpt":"both of you, please","via":"marker","parent_id":null,"thread_root_id":"00000000-0000-4000-8000-000000000902","body":"both of you, please","addressed":true,"acked":true,"reason":"group","text_acked":true}',
      '{"t":"2026-10-04T16:50:15+05:30","document_id":"00000000-0000-4000-8000-000000010001","seq":1003,"kind":"comment.replied","comment_id":"00000000-0000-4000-8000-000000000903","author_kind":"human","author_name":"Person Fake","excerpt":"@Other agent only","via":"marker","addressed":false,"acked":null,"text_acked":null}',
      '{"t":"2026-10-04T16:50:15+05:30","document_id":"00000000-0000-4000-8000-000000010001","seq":1004,"kind":"comment.replied","comment_id":"00000000-0000-4000-8000-000000000904","author_kind":"human","author_name":"Person Fake","excerpt":"no mention here","via":"marker","addressed":false,"acked":null,"text_acked":null}',
      'garbage line',
      '{"t":"2026-10-04T16:50:15+05:30","document_id":"00000000-0000-4000-8000-000000010001","seq":1001,"kind":"comment.replied","comment_id":"00000000-0000-4000-8000-000000000901","author_kind":"human","author_name":"Person Fake","excerpt":"@Example agent again","via":"marker","parent_id":"00000000-0000-4000-8000-000000000900","thread_root_id":"00000000-0000-4000-8000-000000000900","body":"@Example agent again","addressed":true,"acked":true,"text_acked":true}',
    ];
    const r = await runAll(env, IN);
    check(JSON.stringify(r.raw) === JSON.stringify(OUT), `document output changed:\n${r.raw.join('\n')}`);
    check(si.itemReqs.length === 0 && si.posts.length === 2 && si.requests.length === 2, `document paths only: item ${si.itemReqs.length} posts ${si.posts.length} reactions ${si.requests.length}`);
  });

  T('T69', 'the item create guard: only POST /boardsApi/tasks/<uuid>/comments or /mapsApi/maps/<uuid>/comments with Origin, key and address exactly, a { body, parent_id } body, and the exact ack text; any other text, header, host, path, method, query or parent is refused before the call', async () => {
    const rw = { hostname: '127.0.0.1', port: si.port }; const api = makeApi(rw);
    const H = 'asia-south1-litethink.cloudfunctions.net';
    const TU = `https://${H}/boardsApi/tasks/${TASK_ID}/comments`; const MU = `https://${H}/mapsApi/maps/${MAP_ID}/comments`;
    const hdr = { Origin: ORIGIN, 'X-SPM-API-Key': FAKE_KEY, 'X-SPM-User-Email': FAKE_EMAIL };
    const body = { body: 'Seen by the Example agent at 23:51 IST. Working on it; the answer follows in this thread.', parent_id: cid(2) };
    const bad = [
      ['http', TU.replace('https:', 'http:'), 'POST', hdr, body], ['us-central1', `https://us-central1-litethink.cloudfunctions.net/boardsApi/tasks/${TASK_ID}/comments`, 'POST', hdr, body], ['other host', `https://evil.example/boardsApi/tasks/${TASK_ID}/comments`, 'POST', hdr, body],
      ['look-alike host', `https://${H}.evil.com/boardsApi/tasks/${TASK_ID}/comments`, 'POST', hdr, body], ['query', TU + '?x=1', 'POST', hdr, body], ['port', `https://${H}:8443/boardsApi/tasks/${TASK_ID}/comments`, 'POST', hdr, body], ['GET', TU, 'GET', hdr, body],
      ['PUT', MU, 'PUT', hdr, body], ['DELETE', MU, 'DELETE', hdr, body], ['other function', `https://${H}/otherApi/tasks/${TASK_ID}/comments`, 'POST', hdr, body], ['itemsApi', `https://${H}/itemsApi/maps/${MAP_ID}/comments`, 'POST', hdr, body],
      ['tasks on mapsApi', `https://${H}/mapsApi/tasks/${TASK_ID}/comments`, 'POST', hdr, body], ['maps on boardsApi', `https://${H}/boardsApi/maps/${MAP_ID}/comments`, 'POST', hdr, body], ['not a uuid', `https://${H}/boardsApi/tasks/nope/comments`, 'POST', hdr, body],
      ['upper-case id', `https://${H}/boardsApi/tasks/${TASK_ID.toUpperCase()}/comments`, 'POST', hdr, body], ['trailing slash', TU + '/', 'POST', hdr, body], ['the delete route', `https://${H}/boardsApi/comments/${cid(1)}`, 'POST', hdr, body], ['resolve', `https://${H}/boardsApi/comments/${cid(1)}/resolve`, 'POST', hdr, { resolved: true }],
      ['reactions', `https://${H}/mapsApi/map-comments/${cid(1)}/reactions`, 'POST', hdr, { emoji: 'x', op: 'add' }],
      ['bearer', TU, 'POST', { ...hdr, Authorization: 'Bearer x' }, body], ['Idempotency-Key', TU, 'POST', { ...hdr, 'Idempotency-Key': `ack-text:${cid(1)}` }, body], ['no Origin', TU, 'POST', { 'X-SPM-API-Key': FAKE_KEY, 'X-SPM-User-Email': FAKE_EMAIL }, body],
      ['other Origin', TU, 'POST', { ...hdr, Origin: 'https://evil.example' }, body], ['workspace header', TU, 'POST', { ...hdr, 'X-SPM-Workspace': 'ws' }, body],
      ['a different text', TU, 'POST', hdr, { ...body, body: 'a different text entirely' }], ['extra text', TU, 'POST', hdr, { ...body, body: body.body + ' extra' }], ['bad time', TU, 'POST', hdr, { ...body, body: 'Seen by the Example agent at 99:99 IST. Working on it; the answer follows in this thread.' }],
      ['other label', TU, 'POST', hdr, { ...body, body: 'Seen by the Boss at 10:00 IST. Working on it; the answer follows in this thread.' }], ['extra key', TU, 'POST', hdr, { ...body, extra: 1 }], ['node_id', MU, 'POST', hdr, { ...body, node_id: NODE_ID }], ['documentId', TU, 'POST', hdr, { ...body, documentId: DOC }],
      ['no parent_id', TU, 'POST', hdr, { body: body.body }], ['bad parent_id', TU, 'POST', hdr, { ...body, parent_id: '../x' }], ['body is not an object', TU, 'POST', hdr, 'nope'], ['no body', TU, 'POST', hdr, undefined],
    ];
    for (const [name, ...a] of bad) { let threw = null; try { await api(...a, 1000); } catch (e) { threw = e; } check(threw instanceof GuardError, `not blocked: ${name}`); }
    check(si.itemReqs.length === 0 && si.posts.length === 0 && si.lists.length === 0 && si.requests.length === 0, 'nothing reached the stand-in');
    seedItem('board', itemRow(2, 'human')); seedItem('map', itemRow(2, 'human'));
    const okT = await api(TU, 'POST', hdr, body, 2000); const okM = await api(MU, 'POST', hdr, body, 2000);
    check(okT.status === 200 && okT.json && okT.json.comment && typeof okT.json.comment.id === 'string' && okM.status === 200 && okM.json.comment.parent_id === cid(2), `a good post goes through (to the stand-in): ${JSON.stringify(okT).slice(0, 120)}`);
    check(si.itemReqs.length === 2, 'two requests');
  });

  T('T70', 'failures on item posts (500, 403, dropped connection, hang past the 2 s bound, 200 without { comment: { id } }, 200 not JSON, a document-shaped { id }): text_acked false, the line still printed in order, no crash, the key never printed', async () => {
    const modes = [{ name: '500', b: { status: 500 } }, { name: 'destroy', b: { destroy: true } }, { name: 'hang', b: { hang: true }, ms: 300 }, { name: '200 no id', b: { raw: '{"ok":true}' } }, { name: '200 not json', b: { raw: 'nope' } }, { name: 'document-shaped id', b: { raw: JSON.stringify({ id: crypto.randomUUID() }) } }];
    for (const m of modes) {
      si.reset(); seedItem('board', itemRow(1900, 'human'), itemRow(1901, 'human', 1900)); si.behave = (rec) => (rec.itemPost ? m.b : null);
      const t0 = Date.now();
      const r = await runAll(env, [boardLine(1901, '@Example agent', 1900), 'garbage after'], { textTimeoutMs: m.ms || 2000 });
      check(r.code === 0 && r.out.length === 2 && r.raw[1] === 'garbage after' && r.out[0].addressed === true && r.out[0].text_acked === false && !('ack_error' in r.out[0]) && Date.now() - t0 < 3500, `${m.name}: ${r.raw[0]} (${Date.now() - t0} ms)`);
      check(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY), `${m.name}: key`);
    }
  });

  T('T71', 'the key never reaches stdout or stderr on item lines, even when the server echoes it or the line itself carries it', async () => {
    seedItem('map', itemRow(2000, 'human'), itemRow(2001, 'human', 2000)); si.behave = (rec) => (rec.itemPost ? { status: 500 } : null);
    const r = await runAll(env, [mapLine(2001, `@Example agent here is ${FAKE_KEY}`, 2000), mapLine(2001, '@Example agent again', 2000)]);
    check(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY) && r.stdout.includes('[redacted]'), `output: ${r.stdout.slice(0, 200)}`);
  });


  T('T73', 'an item line needs no thread lookup and gets no reaction: a human reply in a thread the agent started is NOT answered (the thread rule is documents only), and no list call is ever made for an item', async () => {
    seedItem('board', itemRow(2200, 'agent'), itemRow(2201, 'human', 2200));
    const r = await runAll(env, [boardLine(2201, 'thanks, that works', 2200)]);
    check(r.out[0].addressed === false && r.out[0].acked === null && r.out[0].text_acked === null && !('reason' in r.out[0]) && !('ack_error' in r.out[0]), r.raw[0]);
    check(si.itemReqs.length === 0 && si.lists.length === 0 && si.requests.length === 0, `requests: item ${si.itemReqs.length} lists ${si.lists.length} reactions ${si.requests.length}`);
    // a malformed line that carries BOTH item_type and a valid document_id, in a thread this agent started: it is no document line, so the thread rule must not look anything up or react
    si.reset(); si.comments = [mk(2300, 'agent'), mk(2301, 'human', 2300)];
    const both = await runAll(env, [boardLine(2301, 'thanks, that works', 2300, { document_id: DOC })]);
    check(both.out[0].addressed === false && both.out[0].acked === null && !('reason' in both.out[0]) && si.lists.length === 0 && si.requests.length === 0, `item_type plus document_id: ${both.raw[0]} lists ${si.lists.length} reactions ${si.requests.length}`);
  });

  T('T74', 'ordering and count are preserved around slow item posts (one output line per input line, same order, garbage untouched), and the post reaches the server within 500 ms of the line', async () => {
    seedItem('board', itemRow(2300, 'human'), itemRow(2301, 'human', 2300)); seedItem('map', itemRow(2310, 'human'), itemRow(2311, 'human', 2310));
    si.behave = (rec) => (rec.itemPost ? { delayMs: rec.n === 1 ? 400 : 0 } : null);
    const h = spawnAck(env); const t0 = Date.now();
    h.write(boardLine(2301, '@Example agent one', 2300)); h.write('garbage 1'); h.write(mapLine(2311, 'both of you', 2310)); h.write(humanLine(2312, 'nobody here')); h.write('garbage 2');
    const lines = await h.waitLines(5, 5000); h.end(); await h.finish();
    const out = lines.map((l) => { try { return JSON.parse(l); } catch { return l; } });
    check(lines.length === 5 && out[1] === 'garbage 1' && out[4] === 'garbage 2' && out[0].comment_id === cid(2301) && out[2].comment_id === cid(2311) && out[3].comment_id === cid(2312), lines.join(' | '));
    check(out[0].text_acked === true && out[2].text_acked === true && out[3].text_acked === null && si.itemReqs.length === 2 && si.itemReqs[0].t - t0 < 1500, `posts ${si.itemReqs.length}`);
  });

  T('T75', 'the header comment and usage document the item lines; the item routes use only the text acknowledgement', async () => {
    const src = fs.readFileSync(__filename, 'utf8');
    const head = src.slice(0, src.indexOf("const fs = require('node:fs')"));
    check(head.includes('item_type') && head.includes('task_id') && head.includes('boardsApi/tasks') && head.includes('mapsApi/maps'), 'the header comment documents the item lines and the two routes');
    check(/no Idempotency-Key/i.test(head) && /no reaction/i.test(head), 'the header says what an item line does NOT get (no reaction, no Idempotency-Key)');
  });


  // ==== NOTICE LINES: the listener's inbox notices (kind notice)
  const NOTICE_TEXT_RE = /^Seen by the Example agent at (?:[01]\d|2[0-3]):[0-5]\d IST\. Working on it; the answer follows in this thread\.$/;
  const noticeLine = (n, root, over) => JSON.stringify({ kind: 'notice', t: '2026-10-13T10:00:00+05:30', notification_id: `ntf-${n}`, seq: 500 + n, reason: 'mentioned', verb: 'comment.created', item: { type: 'document', id: DOC }, comment_id: cid(n), thread_root_id: cid(root), task_id: null, target: 'a comment', item_seq: 500 + n, actor_kind: 'human', ...over });



  T('T82', 'notice line, document: a MENTIONED human comment gets one reaction (documentId and commentId from the notice) and one text reply under its thread root (Idempotency-Key ack-text:<comment>); no thread lookup; the notice keys stay, addressed, acked and text_acked are appended, and its own reason "mentioned" is kept', async () => {
    si.comments = [mk(900, 'human'), mk(901, 'human', 900)];
    const lines = [noticeLine(900, 900), noticeLine(901, 900, { verb: 'comment.replied' })];
    const r = await runAll(env, lines);
    check(r.code === 0 && si.requests.length === 2 && si.posts.length === 2 && si.lists.length === 0, `reactions ${si.requests.length} posts ${si.posts.length} lists ${si.lists.length} stderr ${r.stderr}`);
    for (const n of [900, 901]) {
      const q = si.requests.find((x) => JSON.parse(x.raw).commentId === cid(n));
      check(q && q.url === '/documentsApi/reactToDocumentComment' && JSON.stringify(JSON.parse(q.raw)) === JSON.stringify({ documentId: DOC, commentId: cid(n), emoji: '\u{1F440}', op: 'add' }), `reaction for ${n}: ${q && q.raw}`);
      const p = si.posts.find((x) => x.headers['idempotency-key'] === `ack-text:${cid(n)}`);
      const b = p && JSON.parse(p.raw);
      check(p && b.documentId === DOC && b.parent_id === cid(900) && NOTICE_TEXT_RE.test(b.body), `text for ${n}: ${p && p.raw}`);
    }
    r.out.forEach((o, i) => {
      const orig = JSON.parse(lines[i]);
      check(o.addressed === true && o.acked === true && o.text_acked === true && !('ack_error' in o), r.raw[i]);
      check(Object.keys(o).slice(0, Object.keys(orig).length).join() === Object.keys(orig).join() && Object.keys(orig).every((k) => JSON.stringify(o[k]) === JSON.stringify(orig[k])), `original keys and values kept: ${r.raw[i]}`);
      check(Object.keys(o).slice(-3).join() === 'addressed,acked,text_acked' && o.reason === 'mentioned', `keys and own reason: ${r.raw[i]}`);
    });
  });

  T('T83', 'notice line, board: a mentioned human comment gets the text reply only, through the task route (boardsApi/tasks/<task_id>/comments) under its thread root; no reaction, no list lookup; acked null, text_acked true', async () => {
    seedItem('board', itemRow(910, 'human'));
    const r = await runAll(env, [noticeLine(910, 910, { item: { type: 'board', id: BOARD_ID }, task_id: TASK_ID })]);
    check(r.code === 0 && si.requests.length === 0 && si.lists.length === 0 && si.itemReqs.length === 1, `reactions ${si.requests.length} lists ${si.lists.length} item posts ${si.itemReqs.length} stderr ${r.stderr}`);
    const q = si.itemReqs[0]; const b = JSON.parse(q.raw);
    check(q.method === 'POST' && q.url === `/boardsApi/tasks/${TASK_ID}/comments` && itemHeaderNames(q) === 'content-length,content-type,origin,x-spm-api-key,x-spm-user-email', `${q.method} ${q.url} ${itemHeaderNames(q)}`);
    check(b.parent_id === cid(910) && NOTICE_TEXT_RE.test(b.body), `board text ${q.raw}`);
    const o = r.out[0];
    check(o.addressed === true && o.acked === null && o.text_acked === true && !('ack_error' in o), r.raw[0]);
  });

  T('T84', 'notice line, map: a mentioned human comment gets the text reply only, through the map route (mapsApi/maps/<item_id>/comments); no reaction, no list lookup; acked null, text_acked true', async () => {
    seedItem('map', itemRow(920, 'human'));
    const r = await runAll(env, [noticeLine(920, 920, { item: { type: 'map', id: MAP_ID } })]);
    check(r.code === 0 && si.requests.length === 0 && si.lists.length === 0 && si.itemReqs.length === 1, `reactions ${si.requests.length} lists ${si.lists.length} item posts ${si.itemReqs.length} stderr ${r.stderr}`);
    const q = si.itemReqs[0]; const b = JSON.parse(q.raw);
    check(q.method === 'POST' && q.url === `/mapsApi/maps/${MAP_ID}/comments` && itemHeaderNames(q) === 'content-length,content-type,origin,x-spm-api-key,x-spm-user-email', `${q.method} ${q.url} ${itemHeaderNames(q)}`);
    check(b.parent_id === cid(920) && NOTICE_TEXT_RE.test(b.body), `map text ${q.raw}`);
    const o = r.out[0];
    check(o.addressed === true && o.acked === null && o.text_acked === true && !('ack_error' in o), r.raw[0]);
  });

  T('T85', 'notice lines that must do NOTHING: a participant from an agent actor or on a board, follower, an agent actor, comment.edited, an unknown item type, a malformed comment_id, a board notice with no task_id; each is printed back with addressed false, acked null, text_acked null, and no request of any kind is made', async () => {
    si.comments = [mk(930, 'human')];
    seedItem('board', itemRow(931, 'human'));
    const bad = [
      noticeLine(930, 930, { reason: 'participant', actor_kind: 'agent' }),
      noticeLine(931, 931, { reason: 'participant', item: { type: 'board', id: BOARD_ID }, task_id: TASK_ID }),
      noticeLine(930, 930, { reason: 'follower' }),
      noticeLine(930, 930, { actor_kind: 'agent' }),
      noticeLine(930, 930, { verb: 'comment.edited' }),
      noticeLine(930, 930, { item: { type: 'file', id: DOC } }),
      noticeLine(930, 930, { comment_id: 'not-a-uuid' }),
      noticeLine(931, 931, { item: { type: 'board', id: BOARD_ID }, task_id: null }),
    ];
    const r = await runAll(env, bad);
    check(r.code === 0 && r.raw.length === bad.length, `lines ${r.raw.length} of ${bad.length} stderr ${r.stderr}`);
    r.out.forEach((o, i) => check(o.addressed === false && o.acked === null && o.text_acked === null && !('ack_error' in o), `line ${i}: ${r.raw[i]}`));
    check(si.requests.length === 0 && si.lists.length === 0 && si.posts.length === 0 && si.itemReqs.length === 0, `requests ${si.requests.length} lists ${si.lists.length} posts ${si.posts.length} item posts ${si.itemReqs.length}`);
  });

  T('T86', 'a notice line and a listener line for the SAME comment in one process: one reaction and one text reply in total, in either order', async () => {
    si.comments = [mk(940, 'human')];
    const r1 = await runAll(env, [noticeLine(941, 940, { verb: 'comment.replied' }), threadLine(941, '@Example agent please look', 940)]);
    check(si.requests.length === 1 && si.posts.length === 1, `notice first: reactions ${si.requests.length} posts ${si.posts.length}`);
    check(r1.out[0].acked === true && r1.out[1].acked === true && r1.out[0].text_acked === true && r1.out[1].text_acked === true, `notice first: ${r1.raw.join(' | ')}`);
    si.reset(); si.comments = [mk(940, 'human')];
    const r2 = await runAll(env, [threadLine(942, '@Example agent please look', 940), noticeLine(942, 940, { verb: 'comment.replied' })]);
    check(si.requests.length === 1 && si.posts.length === 1, `listener first: reactions ${si.requests.length} posts ${si.posts.length}`);
    check(r2.out[0].acked === true && r2.out[1].acked === true && r2.out[0].text_acked === true && r2.out[1].text_acked === true, `listener first: ${r2.raw.join(' | ')}`);
  });

  T('T87', 'a baseline line and a notice that is not addressed pass through printed back with addressed false and null keys; no request of any kind', async () => {
    const r = await runAll(env, [JSON.stringify({ kind: 'baseline', t: '2026-10-13T10:00:00+05:30', seq: 1 }), JSON.stringify({ kind: 'notice' })]);
    check(r.out[0].kind === 'baseline' && r.out[0].addressed === false && r.out[0].acked === null && r.out[0].text_acked === null, r.raw[0]);
    check(r.out[1].kind === 'notice' && r.out[1].addressed === false && r.out[1].acked === null && r.out[1].text_acked === null, r.raw[1]);
    check(si.requests.length + si.lists.length + si.posts.length + si.itemReqs.length === 0, 'a request was made');
  });




  // ==== PARTICIPANT NOTICES : a human reply that TAGS this agent inside a thread the agent already wrote in arrives as a notice with reason "participant" (the server's strongest reason for an agent there). It is judged from its comment's text, from ONE list call.
  const partNotice = (n, root, over) => noticeLine(n, root, { reason: 'participant', verb: 'comment.replied', ...over });
  const tagged = (n, root, body) => ({ ...mk(n, 'human', root), body });

  T('T89', 'participant notice tagged at the END of a human reply in an agent-started thread: exactly one list call, eyes plus the exact text reply under the thread root (Idempotency-Key ack-text:<comment>), addressed true, the notice keeps its own reason and adds no key', async () => {
    si.comments = [mk(960, 'agent'), tagged(961, 960, 'the spacing looks off, can you check it @Example agent')];
    const r = await runAll(env, [partNotice(961, 960)]);
    check(r.code === 0 && si.lists.length === 1, `lists ${si.lists.length} stderr ${r.stderr}`);
    check(si.requests.length === 1 && si.posts.length === 1, `reactions ${si.requests.length} posts ${si.posts.length}`);
    check(JSON.stringify(JSON.parse(si.requests[0].raw)) === JSON.stringify({ documentId: DOC, commentId: cid(961), emoji: '\u{1F440}', op: 'add' }), si.requests[0].raw);
    const q = si.posts[0]; const b = JSON.parse(q.raw);
    check(q.headers['idempotency-key'] === `ack-text:${cid(961)}` && b.parent_id === cid(960) && b.documentId === DOC && NOTICE_TEXT_RE.test(b.body), `text: ${q.raw}`);
    const o = r.out[0];
    check(o.addressed === true && o.acked === true && o.text_acked === true && o.reason === 'participant' && !('ack_error' in o), r.raw[0]);
    check(Object.keys(o).slice(-3).join() === 'addressed,acked,text_acked', r.raw[0]);
  });

  T('T89b', 'a common shape: a HUMAN root that tagged the agent, the agent\'s answer, then a human reply tagged at the END (participant notice): one list call, eyes plus the text reply under the human root, addressed true; the same reply with NO tag gets the eyes only (the comment just before it is the agent\'s); a later untagged human reply after another human gets nothing', async () => {
    si.comments = [mk(970, 'human'), mk(971, 'agent', 970), tagged(972, 970, 'ok but why is it still untitled? @Example agent')];
    let r = await runAll(env, [partNotice(972, 970)]);
    check(r.code === 0 && si.lists.length === 1 && si.requests.length === 1 && si.posts.length === 1, `tagged: lists ${si.lists.length} reactions ${si.requests.length} posts ${si.posts.length} stderr ${r.stderr}`);
    const b = JSON.parse(si.posts[0].raw);
    check(si.posts[0].headers['idempotency-key'] === `ack-text:${cid(972)}` && b.parent_id === cid(970) && NOTICE_TEXT_RE.test(b.body), `text: ${si.posts[0].raw}`);
    check(r.out[0].addressed === true && r.out[0].acked === true && r.out[0].text_acked === true && r.out[0].reason === 'participant', r.raw[0]);
    si.reset();
    si.comments = [mk(973, 'human'), mk(974, 'agent', 973), mk(975, 'human', 973), mk(976, 'human', 973)];
    r = await runAll(env, [partNotice(975, 973), partNotice(976, 973)]);
    check(si.lists.length === 2 && si.requests.length === 1 && si.posts.length === 0, `untagged: lists ${si.lists.length} reactions ${si.requests.length} posts ${si.posts.length}`);
    check(JSON.parse(si.requests[0].raw).commentId === cid(975), si.requests[0].raw);
    check(r.out[0].addressed === false && r.out[0].acked === true && r.out[0].text_acked === null && r.out[1].addressed === false && r.out[1].acked === null, r.raw.join(' | '));
  });
  T('T90', 'participant notice WITHOUT a tag: the thread rule answers (eyes only when the thread is ours, its root or the comment just before this one is the agent\'s), never a text line, addressed false; a human-only thread gets nothing; exactly one list call each', async () => {
    si.comments = [mk(970, 'agent'), tagged(971, 970, 'thanks, that helps'), mk(972, 'human'), tagged(973, 972, 'and the header too'), mk(974, 'agent', 972), tagged(975, 972, 'one more point')];
    const r = await runAll(env, [partNotice(971, 970), partNotice(973, 972), partNotice(975, 972)]);
    check(r.code === 0 && si.lists.length === 3, `lists ${si.lists.length} stderr ${r.stderr}`);
    check(si.posts.length === 0 && si.requests.length === 2, `reactions ${si.requests.length} posts ${si.posts.length}`);
    check(si.requests.map((q) => JSON.parse(q.raw).commentId).sort().join() === [cid(971), cid(975)].sort().join(), si.requests.map((q) => q.raw).join(' | '));
    check(r.out[0].addressed === false && r.out[0].acked === true && r.out[0].text_acked === null, r.raw[0]);
    check(r.out[1].addressed === false && r.out[1].acked === null && r.out[1].text_acked === null, r.raw[1]);
    check(r.out[2].addressed === false && r.out[2].acked === true && r.out[2].text_acked === null, r.raw[2]);
    check(r.out.every((o) => o.reason === 'participant' && !('ack_error' in o)), r.raw.join(' | '));
  });

  T('T91', 'participant notice naming only ANOTHER agent gets nothing, even inside an agent-started thread; group words ("both of you") get the full acknowledgement (eyes and text), addressed true', async () => {
    si.comments = [mk(980, 'agent'), tagged(981, 980, 'the other agent should look at this @Other agent'), tagged(982, 980, 'both of you, what do you think')];
    const r = await runAll(env, [partNotice(981, 980), partNotice(982, 980)]);
    check(r.code === 0 && si.lists.length === 2, `lists ${si.lists.length} stderr ${r.stderr}`);
    check(si.requests.length === 1 && JSON.parse(si.requests[0].raw).commentId === cid(982), `reactions ${si.requests.map((q) => q.raw).join(' | ')}`);
    check(si.posts.length === 1 && si.posts[0].headers['idempotency-key'] === `ack-text:${cid(982)}`, `posts ${si.posts.map((q) => q.raw).join(' | ')}`);
    check(r.out[0].addressed === false && r.out[0].acked === null && r.out[0].text_acked === null && !('ack_error' in r.out[0]), r.raw[0]);
    check(r.out[1].addressed === true && r.out[1].acked === true && r.out[1].text_acked === true && r.out[1].reason === 'participant', r.raw[1]);
  });

  T('T92', 'participant notice, lookup failed: a list answer that is not 200 gives acked null and ack_error lookup, no reaction and no text; a comment missing from the list the same; without a key no list call is made', async () => {
    si.comments = [mk(990, 'agent'), tagged(991, 990, '@Example agent are you there')];
    si.behave = (rec) => (rec.list ? { status: 500 } : null);
    const r = await runAll(env, [partNotice(991, 990)]);
    check(si.lists.length === 1 && si.requests.length === 0 && si.posts.length === 0, `lists ${si.lists.length} reactions ${si.requests.length} posts ${si.posts.length}`);
    check(r.out[0].addressed === false && r.out[0].acked === null && r.out[0].text_acked === null && r.out[0].ack_error === 'lookup', r.raw[0]);
    si.reset(); si.comments = [mk(990, 'agent')];
    const m = await runAll(env, [partNotice(991, 990)]);
    check(si.lists.length === 1 && si.requests.length === 0 && si.posts.length === 0 && m.out[0].ack_error === 'lookup' && m.out[0].acked === null, `missing from list: lists ${si.lists.length} ${m.raw[0]}`);
    si.reset(); si.comments = [mk(990, 'agent'), tagged(991, 990, '@Example agent are you there')];
    const k = await runAll(env, [partNotice(991, 990)], { keyFile: env.emptyKeyFile });
    check(si.lists.length === 0 && si.requests.length === 0 && k.out[0].addressed === false && k.out[0].acked === null && !('ack_error' in k.out[0]), `no key: lists ${si.lists.length} ${k.raw[0]}`);
  });

  T('T93', 'participant notices from an AGENT actor, on a BOARD and on a MAP: nothing, and NO list call, no reaction, no text', async () => {
    seedItem('board', itemRow(1100, 'human'), itemRow(1101, 'human', 1100));
    seedItem('map', itemRow(1110, 'human'));
    si.comments = [mk(1000, 'agent'), tagged(1001, 1000, '@Example agent hello')];
    const r = await runAll(env, [partNotice(1001, 1000, { actor_kind: 'agent' }), partNotice(1101, 1100, { item: { type: 'board', id: BOARD_ID }, task_id: TASK_ID }), partNotice(1110, 1110, { item: { type: 'map', id: MAP_ID } })]);
    check(r.code === 0 && r.raw.length === 3, `lines ${r.raw.length} stderr ${r.stderr}`);
    check(si.lists.length === 0 && si.requests.length === 0 && si.posts.length === 0 && si.itemReqs.length === 0, `lists ${si.lists.length} reactions ${si.requests.length} posts ${si.posts.length} item posts ${si.itemReqs.length}`);
    r.out.forEach((o, i) => check(o.addressed === false && o.acked === null && o.text_acked === null && !('ack_error' in o), `line ${i}: ${r.raw[i]}`));
  });

  T('T94', 'a participant notice and the listener line of the SAME comment, in one process, in either order: one reaction and one text reply in total', async () => {
    si.comments = [mk(1200, 'agent'), tagged(1201, 1200, '@Example agent please look')];
    const r1 = await runAll(env, [partNotice(1201, 1200), threadLine(1201, '@Example agent please look', 1200)]);
    check(si.lists.length === 1 && si.requests.length === 1 && si.posts.length === 1, `notice first: lists ${si.lists.length} reactions ${si.requests.length} posts ${si.posts.length}`);
    check(r1.out[0].addressed === true && r1.out[0].text_acked === true && r1.out[1].acked === true && r1.out[1].text_acked === true, r1.raw.join(' | '));
    si.reset(); si.comments = [mk(1200, 'agent'), tagged(1201, 1200, '@Example agent please look')];
    const r2 = await runAll(env, [threadLine(1201, '@Example agent please look', 1200), partNotice(1201, 1200)]);
    check(si.requests.length === 1 && si.posts.length === 1, `listener first: reactions ${si.requests.length} posts ${si.posts.length}`);
    check(r2.out[0].acked === true && r2.out[0].text_acked === true && r2.out[1].addressed === true && r2.out[1].acked === true && r2.out[1].text_acked === true, r2.raw.join(' | '));
  });




}

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
    const transport = makeTransport(null, guardedLib);
    const body = { commentId: '00000000-0000-4000-8000-000000000001', documentId: '00000000-0000-4000-8000-000000000000', emoji: EMOJI, op: 'add' };
    let outcome = null;
    try { await transport(ENDPOINT_URL, 'POST', { origin: ORIGIN, 'x-spm-api-key': 'selftest-fake-key', 'x-spm-user-email': 'selftest@agents.invalid' }, JSON.stringify(body), 3000); outcome = 'resolved'; } catch (e) { outcome = `rejected:${String((e && e.code) || (e && e.message)).slice(0, 40)}`; }
    await new Promise((r) => setTimeout(r, 150));
    check(unhandled.length === 0, `an unhandled error reached the process: ${unhandled.join(',')} (outcome ${outcome})`);
    if (withProxy) {
      check(hits.length === 1 && hits[0] === `CONNECT ${FN_HOST}:443 HTTP/1.1`, `the proxy received ${JSON.stringify(hits)}, want one CONNECT to ${FN_HOST}:443 (outcome ${outcome})`);
      check(seen.length === 1 && !!seen[0] && typeof seen[0] === 'object', 'the request did not go through a proxy agent');
    } else {
      check(hits.length === 0, `the proxy received ${JSON.stringify(hits)} with HTTPS_PROXY unset`);
      check(seen.length === 1 && seen[0] === undefined, `agent with HTTPS_PROXY unset is ${JSON.stringify(seen[0])}, want none (today's global agent)`);
    }
  } finally {
    process.removeListener('uncaughtException', onUnhandled);
    for (const k of ['HTTPS_PROXY', 'https_proxy']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await new Promise((r) => proxy.close(r));
  }
}

async function selftest() {
  setAckName('Example agent'); // the in-process guard checks use the same name as the synthetic settings file
  const say = (s) => process.stdout.write(s + '\n');
  say('STAND-IN: agent-ack selftest. A real http server on 127.0.0.1 implements the reactToDocumentComment contract It is a contract-faithful stand-in because the real endpoint needs Postgres. No production call, fake key, fake agent.');
  const runDir = path.join(os.tmpdir(), 'agent-ack-selftest', `${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(runDir, 'cwd'), { recursive: true });
  const keyFile = path.join(runDir, 'fake.key'); fs.writeFileSync(keyFile, FAKE_KEY + '\n', { mode: 0o600 });
  const emptyKeyFile = path.join(runDir, 'empty.key'); fs.writeFileSync(emptyKeyFile, '\n');
  const standIn = makeStandIn(); await standIn.start();
  let cfgN = 0;
  const baseConfig = { agent: { name: 'Example agent', email: FAKE_EMAIL }, key_file: keyFile, ignore_agents: ['Other agent'] };
  const writeConfig = (over) => { const p = path.join(runDir, `agent-${++cfgN}.config.json`); fs.writeFileSync(p, JSON.stringify({ ...baseConfig, ...over })); return p; };
  const configFile = writeConfig({});
  const env = { standIn, runDir, keyFile, emptyKeyFile, cwd: path.join(runDir, 'cwd'), configFile, writeConfig };
  const cases = []; defineCases(cases, env);
  cases.push({ id: 'P1a', name: 'R1: with HTTPS_PROXY set, a real call to the production host goes through the proxy as CONNECT to that host (no direct socket, no crash)', fn: () => proxyRouteCase(true) });
  cases.push({ id: 'P1b', name: 'R1: with HTTPS_PROXY unset, the call keeps the global agent and the proxy receives nothing', fn: () => proxyRouteCase(false) });
  let pass = 0; let fail = 0;
  try {
    for (const c of cases) {
      let e = null; const c0 = Date.now(); let cap = null;
      try { await Promise.race([c.fn(), new Promise((_, rej) => { cap = setTimeout(() => rej(new Error('case timed out after 30 s')), 30000); })]); } catch (x) { e = x; } finally { clearTimeout(cap); }
      if (e) { fail++; say(`FAIL ${c.id} ${c.name}: ${String(e && e.message).slice(0, 300)} [${Date.now() - c0} ms]`); } else { pass++; say(`PASS ${c.id} ${c.name} [${Date.now() - c0} ms]`); }
    }
  } finally { for (const c of LIVE) c.kill('SIGKILL'); await standIn.stop(); }
  say(`SELFTEST ${pass} passed, ${fail} failed (scratch folder ${runDir})`);
  return fail === 0 ? 0 : 1;
}

module.exports = { parseArgs, isAddressed, addressedReason, guardRequest, guardList, guardCreate, guardApi, GuardError, makeTransport, makeApi, createAcker, readKeyFile, main, realDeps, runChild, selftest, ENDPOINT_URL, LIST_URL, CREATE_URL, EMOJI, setAckName };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const run = argv.length === 1 && argv[0] === '--selftest' ? selftest() : main(argv, realDeps());
  Promise.resolve(run).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`agent-ack: unexpected failure (${word(e && e.name)})\n`); process.exitCode = 1; });
}
