#!/usr/bin/env node
'use strict';
/**
 * agent-listen.cjs -- the AGENT LISTENER: wakes an agent when a comment arrives, from the live Firebase signal.
 * One script for any agent. Each run reads its own settings file (--config), so one copy serves every agent.
 *
 *   node agent-listen.cjs --config <abs path> [--document <uuid>[,<uuid>...]] [--board <uuid>[,<uuid>...]] [--map <uuid>[,<uuid>...]] --cursor-file <abs path>
 *
 *
 *                         [--mode once|stream] [--self-actor-skip true|false]
 *   (INBOX MODE, --inbox: event-driven, reads the feed only when its signal moves. See below.)
 *   GOAL PIPELINE: node agent-listen.cjs --config <abs path> --inbox --cursor-file <abs path> --mode once | node agent-ack.cjs --config <abs path> (exits after the first notice, having posted the Seen ack)
 *   node agent-listen.cjs --selftest OFFLINE: local FAKE servers on 127.0.0.1 only, a fake clock, fake secrets; no production call, no real key file read.
 * TRANSPORT (settings key "transport"): "node" (default: the Node build of the Firebase Firestore SDK, the same calls as always) or "webchannel" (the browser build, loaded by its absolute path, with long polling, for a cloud proxy that resets the Node build's gRPC). webchannel also adds firestore.googleapis.com to the SDK's fetch allow-list (node mode keeps the two sign-in hosts only); with HTTPS_PROXY set it needs NODE_USE_ENV_PROXY=1 at start, else it exits 2 before any call (start.sh sets it).
 *
 * INBOX MODE. --inbox listens to the agent's OWN notice feed instead of a fixed list of items: no per-item list, no 20-item limit, and a tag on an item the
 * agent has never seen wakes it (the server routes a notice for every tag of the agent on an item it can open: INBOX_ROUTING_KINDS=agent). --inbox is EXCLUSIVE with --document, --board and --map (both is a usage
 * error, exit 2; so is giving none of the four). --fallback-s and --safety-s do not apply to it (usage error). It needs no marker of its own: it listens to the signal the feed names (signal_id, the same listen as item mode) and reads the feed only when that signal moves, never on a timer:
 *   GET https://asia-south1-litethink.cloudfunctions.net/accountApi/notifications?since=<seq>&limit=100&state=all (headers X-SPM-API-Key and X-SPM-User-Email only; the agent's personal key)
 * The reply is { notifications: [rows, ascending seq], cursor, latest, has_more, signal_id } (contract ; the shapes are captured from the real route into agent-listen-inbox-feed.fixture.json and the
 * selftest mock serves exactly those). A row the feed leaves out (the agent lost access to the item) is simply absent and the cursor still moves past it.
 * OUTPUT, one JSON object per line, per new row (never any comment text: a row has none, the agent reads the text through the item's own access-checked read; an actor's name is not printed either):
 *   { "t": <IST>, "kind": "notice", "notification_id", "seq", "reason" (mentioned | participant | follower), "lane", "verb" (comment.created | comment.replied | comment.edited), "item": { "type": "document"|"board"|"map", "id" },
 *     "comment_id", "thread_root_id", "task_id" (a BOARD row only, else null), "target" ({ "type", "id" } or null), "item_seq", "actor_kind": "human"|"agent" }
 * WHICH FIELD FEEDS WHICH agent-reply.cjs FLAG (always --to <comment_id>; the reply goes under thread_root_id by itself): a DOCUMENT row: --document <item.id>; a BOARD row: --task <task_id> (item.id is the board; board comments
 * hang on tasks); a MAP row: --map <item.id>. To READ the text first, use the item's own comment-events read with since = item_seq - 1 (documents: listDocumentCommentEvents, boards and maps: .../comment-events).
 * FIRST RUN: one read with state=unresolved (since=0). It prints the unresolved notices of the last 24 hours, at most 20, as notice lines, then the cursor is the feed's latest and the stream goes on. A feed reply with no signal_id is fatal.
 * CURSOR FILE: its own file { "inbox_seq": <last seq> } (written atomically AFTER the lines are printed: at least once, never lost). A file that holds per-item cursors (a document, board or map listener's file) is refused
 * with a plain message, exit 2, before any call (and a per-item listener refuses an inbox file the same way). --mode once: wait for the first batch that printed a notice, print it, exit 0; stream: keep going.
 * POLL: none. --poll-ms is refused for --inbox (exit 2). Reads happen on a marker bump (one read in flight; a bump during a read re-runs it once), on the first server snapshot after each subscription, and never on a timer, except the RE-RAISE pass (stream mode, below) and the retry after a failed read (5 s, 15 s, 45 s, then every 120 s, until one read succeeds; a bump reads at once and cancels that wait). ERRORS: 401, 403, 400 or 404 print ONE clear line and exit 1 (no retry); 429 waits Retry-After seconds (1 to 3600, else 60); a network failure or a 5xx
 * retries with the script's backoff (1 s doubling to 30 s). THE LISTENER ONLY READS: it never marks a row read, never acts on it and never resolves it.
 * --self-actor-skip is accepted and validated like the other modes, but there is nothing for it to skip: the server never writes a row for the author of an event (the author is skipped by identity id), and a row
 * carries no address to compare, so a row about the agent's own comment cannot reach the feed. A row whose ACTOR is another agent IS printed (a tag by another agent is a tag).
 *
 * RE-RAISE. The notices are read once and the cursor moves past them, so a notice the agent did not act on (its chat was compacted, say) would never come back.
 * So every 5 minutes (REraise_MS) the stream also makes ONE read, GET ...?since=0&limit=100&state=unresolved, and prints again each unresolved notice older than 5 minutes and younger than 24 hours: the same notice line plus "reraise": <n> (1 on the first re-raise of that id in this process, then 2, 3 ...).
 * At most 20 lines a pass, oldest first; the rest wait for a later pass. The pass never moves the cursor and never POSTs. A failed read prints one stderr line and the next pass tries again. Once mode has no re-raise pass.
 * FLOW. (1) POST getRealtimeToken (asia-south1) with X-SPM-API-Key and the typed X-SPM-User-Email, body {}, no Origin. (2) Sign in through the Firebase SDK (signInWithCustomToken, the same Referer and web API key source as the canary). The refresh token lives in memory only;
 * the SDK refreshes the ID token itself. A failed mint or sign-in retries with backoff, and the listens start only after the sign-in works. (3) Per document, ONE
 * events read with a cursor above any seq answers { reset: true, latest, signal_id }: the signal id and the current max seq. A reply with no signal id stops the listener with one clear line and exit 1. The cursor file holds
 * { "<key>": <last_seq> } with key = the bare document uuid for a document (an existing cursor file works unchanged), "board:<uuid>" for a board and "map:<uuid>" for a map (a document, a board and a map
 * that share one uuid keep three cursors); an unknown item starts at the current max (history is never replayed); a known item that is behind is read at once.
 * The events read of a DOCUMENT is POST listDocumentCommentEvents { documentId, since }; of a BOARD GET https://asia-south1-litethink.cloudfunctions.net/boardsApi/boards/<uuid>/comment-events?since=<int>; of a MAP GET .../mapsApi/maps/<uuid>/comment-events?since=<int>
 * (no body; the same two headers as the document read: X-SPM-API-Key and the typed X-SPM-User-Email, no Origin; the reply is { events, latest, has_more, signal_id } or { reset, latest, signal_id } exactly as for documents, each event carrying the CURRENT comment in the board or map wire).
 * (4) Each item listens to signals/<signal_id> through the SDK's onSnapshot with includeMetadataChanges. A marker with seq above the cursor means "read the events since my cursor"; the marker is never trusted for content.
 * A cached-only snapshot is ignored and never reads. The first server snapshot after a (re)subscription triggers ONE catch-up read (via "safety"). Per item only one events read is in flight; a trigger that arrives during a read sets a dirty flag, and the listener reads again when it ends. A failed read retries with backoff.
 * Own events are dropped (--self-actor-skip, decided by the event's actor_email against this identity's typed address, never printed); one JSON line per remaining event goes to stdout; then the new cursor is written atomically (temp file in the same folder, fsync, rename). Print first, then save: a crash between the two repeats events (at least once), never loses one.
 * (5) A dead signal stream listens again after 1 s, doubling, up to 30 s: a retry of the listen, not a poll of the events route. A wall-clock check every 5 s, with no request, notices a jump of more than 60 s (a wake from sleep or a network switch) and resubscribes every item with a catch-up read.
 * The signal id can change (a rotated secret, seen in a read): the listener listens to the new id. A rotation during a healthy stream is followed only after a reconnect or a restart. (6) once: exit 0 right after the first batch that printed a line. stream: keep running.
 * (7) SIGTERM and SIGINT stop cleanly: the cursor is saved, every signal listen is cancelled, terminate(db) then deleteApp(app) run, and the process ends by itself with no forced exit.
 *
 * BOARD AND MAP LINES: a DOCUMENT line is exactly as before. A board or map line has the same keys in the same order with document_id replaced by item_type ("board" or "map") and item_id (the board or map uuid):
 * { t, item_type, item_id, seq, kind, comment_id, author_kind, author_name, excerpt, via, parent_id, thread_root_id, [task_id,] body[, body_truncated] }; a BOARD line also carries task_id, right after thread_root_id: the task the
 * comment is on (the comment the same events read returns carries it; null for a deleted comment, whose comment is gone), the id to post a reply under with agent-reply.cjs --task. A MAP line has no task_id: item_id is the map
 * (agent-reply.cjs --map). A reset line is { t, item_type, item_id, reset: true, latest }. Everything below about document lines holds for item lines too.
 *
 * OUTPUT LINES (stdout, one JSON object per line): an event { t, document_id, seq, kind, comment_id, author_kind, author_name, excerpt, via, parent_id, thread_root_id, body[, body_truncated] } (kind = the event verb; author_kind = the
 * ACTOR's kind (events carry actor_type even for deletes); author_name = the comment author's display name only when that author is the actor, else null; excerpt = the first 160
 * characters of the current comment body, "" when the comment no longer exists; via = which path found the event: "marker" (read after a marker bump), "safety" (the catch-up read: the first server snapshot after a (re)subscription, a clock jump, or a document that was behind at the start));
 * REPLY WIRING: parent_id = the comment's parent comment id, or null
 * for a top-level comment; thread_root_id = the parent_id when the comment is a reply, else the comment's own id (the id to post a reply UNDER: replies are one level deep only);
 * thread_root_id is null when it cannot be known, for example a DELETED comment (the events read returns no current comment, so parent_id is null too and body is ""); body = the FULL
 * comment text, redacted exactly like the whole line (key, tokens and token-shaped strings become [redacted]) BEFORE it is cut to 4000 code points, and body_truncated: true is added
 * (as the last key) only when the cut removed something. The excerpt stays the first 160 characters, unchanged;
 * { t, document_id, reset: true, latest } when the listener was more than 100 events behind (it then
 * resumes from the newest 100). t is IST with a +05:30 offset. stderr: short notices, never a key, token, uid, address or reply body.
 * EXIT CODES: 0 an event batch was delivered (once) or a clean stop; 1 unrecoverable error (message without secrets); 2 usage.
 *
 * SAFETY. Hosts: asia-south1-litethink.cloudfunctions.net (POST getRealtimeToken and listDocumentCommentEvents, and the two GET comment-events reads above, each with the id a uuid and the query exactly since=<non-negative integer>, only), the Firebase SDK's two sign-in hosts identitytoolkit.googleapis.com and securetoken.googleapis.com, and the SDK's Firestore listen of one signals/<64 hex> document (no REST call). Every request is checked (scheme, host, port, method, path, query, body shape, header names) BEFORE the call;
 * a redirect is never followed. There is no env variable or flag that names another base; the selftest reaches its fakes through the injected transport only. The key is read inside
 * the process from the key file named by key_file in the settings file, and sent only as X-SPM-API-Key. Everything printed is scrubbed of the key, the tokens and token-shaped strings.
 * One cursor file per listener process (two processes on one file would overwrite each other).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { loadConfig } = require('./lib/config.cjs');
const { keyMode, NETWORK_SECRET_VALUE } = require('./lib/key-mode.cjs'); // K-A3 item 1

// The Firebase SDK is installed by cloud-agent-setup.sh into this folder (SPM_AGENT_RUNTIME_DIR overrides it).
const RUNTIME_DIR = process.env.SPM_AGENT_RUNTIME_DIR || path.join(os.homedir(), '.spm-agent-runtime');
const PROJECT = 'litethink';
const REFERER = 'https://app.superproductmanager.ai/';
const FN_HOST = 'asia-south1-litethink.cloudfunctions.net';
const IDT_HOST = 'identitytoolkit.googleapis.com';
const FS_HOST = 'firestore.googleapis.com';
const FS_ROOT = `/v1/projects/${PROJECT}/databases/(default)/documents`;
const FUTURE_SINCE = 2147483647; // a cursor above any real seq: the events route answers { reset: true, latest, signal_id } after one primary-key lookup (canary H3)
const DEFAULTS = { mode: 'once', selfSkip: true };
const DEFAULT_WAIT_S = 60;
const EXCERPT_CHARS = 160;
const BODY_CHARS = 4000;
const MAX_DOCUMENTS = 20; // the cap on the TOTAL of documents, boards and maps one listener watches
const ITEM_EVENTS_RE = new RegExp('^/(?:boardsApi/boards|mapsApi/maps)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/comment-events$');
const USAGE = 'usage: node agent-listen.cjs --config <abs path> [--document <uuid>[,<uuid>...]] [--board <uuid>[,<uuid>...]] [--map <uuid>[,<uuid>...]] (at least one of the three, at most 20 items in all) --cursor-file <abs path> (each listener needs its OWN --cursor-file) [--mode once|stream] [--self-actor-skip true|false]  |  node agent-listen.cjs --selftest';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// INBOX MODE (--inbox): the agent's own notice feed. Its own defaults and floor; its own cursor file key (never the per-item cursor format).
const INBOX_PATH = '/accountApi/notifications';
const INBOX_LIMIT = 100;
const INBOX_CURSOR_KEY = 'inbox_seq';
const INBOX_QUERY_RE = /^\?since=(?:0|[1-9]\d{0,15})&limit=(?:[1-9]\d?|100)&state=(?:all|unread|unresolved)$/;

const sleepReal = (ms, signal) => new Promise((resolve) => {
  if (signal && signal.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); resolve(); }
  if (signal) signal.addEventListener('abort', done, { once: true });
});
const parseJson = (text) => { try { return JSON.parse(text); } catch (_) { return null; } };
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
const word = (x) => (typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(x) ? x : 'none');
const istIso = (ms) => new Date(ms + 19800000).toISOString().slice(0, 19) + '+05:30';

// ==== IMPLEMENTATION-BEGIN
class GuardError extends Error { constructor(msg) { super(msg); this.name = 'GuardError'; this.code = 'allowlist_refused'; } }
class Fatal extends Error { constructor(msg) { super(msg); this.name = 'Fatal'; } }

// ---------------------------------------------------------------- the command line
function parseArgs(argv) {
  const bad = (why) => ({ ok: false, error: why });
  const known = ['--config', '--document', '--board', '--map', '--cursor-file', '--mode', '--self-actor-skip'];
  // : --inbox is a flag with no value; it selects the event-driven notices listener (its own checks below)
  let inbox = false; const pairs = [];
  for (const a of argv) { if (a === '--inbox') { if (inbox) return bad('--inbox given twice'); inbox = true; } else pairs.push(a); }
  const v = {};
  for (let i = 0; i < pairs.length; i += 2) {
    const f = pairs[i];
    if (f === '--poll-ms' || f === '--fallback-s' || f === '--safety-s') return bad(`${f} is refused: the listener holds a Firestore snapshot and never polls`);
    if (!known.includes(f)) return bad('unknown or misplaced argument');
    if (i + 1 >= pairs.length) return bad(`${f} needs a value`);
    if (Object.prototype.hasOwnProperty.call(v, f)) return bad(`${f} given twice`);
    v[f] = String(pairs[i + 1]);
  }
  if (!Object.prototype.hasOwnProperty.call(v, '--cursor-file')) return bad('--cursor-file is required');
  if (inbox) return parseInboxArgs(v, bad);
  const idList = (flag) => (Object.prototype.hasOwnProperty.call(v, flag) ? v[flag].split(',').map((d) => d.trim().toLowerCase()) : []);
  const documents = idList('--document'); const boards = idList('--board'); const maps = idList('--map');
  for (const [flag, ids] of [['--document', documents], ['--board', boards], ['--map', maps]]) {
    if (Object.prototype.hasOwnProperty.call(v, flag) && !ids.every((d) => UUID_RE.test(d))) return bad(`${flag} must be one or more comma-separated uuids`);
    if (new Set(ids).size !== ids.length) return bad(`${flag} lists the same uuid twice`);
  }
  if (documents.length + boards.length + maps.length === 0) return bad('--inbox, --document, --board or --map is required (at least one of the four)');
  if (documents.length + boards.length + maps.length > MAX_DOCUMENTS) return bad(`--document, --board and --map take at most ${MAX_DOCUMENTS} items in all`);
  const cursorFile = v['--cursor-file'];
  if (!path.isAbsolute(cursorFile) || path.normalize(cursorFile) !== cursorFile || cursorFile.endsWith(path.sep)) return bad('--cursor-file must be a normalized absolute path to a file');
  const mode = Object.prototype.hasOwnProperty.call(v, '--mode') ? v['--mode'] : DEFAULTS.mode;
  if (mode !== 'once' && mode !== 'stream') return bad('--mode must be once or stream');
  let selfSkip = DEFAULTS.selfSkip;
  if (Object.prototype.hasOwnProperty.call(v, '--self-actor-skip')) {
    if (v['--self-actor-skip'] !== 'true' && v['--self-actor-skip'] !== 'false') return bad('--self-actor-skip must be true or false');
    selfSkip = v['--self-actor-skip'] === 'true';
  }
  return { ok: true, cfg: { documents, boards, maps, cursorFile, mode, selfSkip } };
}

/** The command line of --inbox: event-driven, so no poll flags exist; the item flags are refused. `v` already holds --cursor-file. */
function parseInboxArgs(v, bad) {
  const has = (flag) => Object.prototype.hasOwnProperty.call(v, flag);
  for (const flag of ['--document', '--board', '--map']) if (has(flag)) return bad(`--inbox listens to your own notices: it cannot be combined with ${flag}`);
  const file = v['--cursor-file'];
  if (!path.isAbsolute(file) || path.normalize(file) !== file || file.endsWith(path.sep)) return bad('--cursor-file must be a normalized absolute path to a file');
  const mode = has('--mode') ? v['--mode'] : DEFAULTS.mode;
  if (mode !== 'once' && mode !== 'stream') return bad('--mode must be once or stream');
  let selfSkip = DEFAULTS.selfSkip;
  if (has('--self-actor-skip')) {
    if (v['--self-actor-skip'] !== 'true' && v['--self-actor-skip'] !== 'false') return bad('--self-actor-skip must be true or false');
    selfSkip = v['--self-actor-skip'] === 'true';
  }
  return { ok: true, cfg: { inbox: true, documents: [], boards: [], maps: [], cursorFile: file, mode, selfSkip } };
}

// ---------------------------------------------------------------- the allow-list: checked before EVERY call
function guardRequest(url, method, headers, body) {
  let u;
  try { u = new URL(url); } catch (_) { throw new GuardError('refused: unparseable url'); }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '' || u.hash !== '') throw new GuardError('refused: scheme, port or credentials in the url');
  const names = Object.keys(headers || {}).map((h) => h.toLowerCase());
  const only = (allowed) => { if (!names.every((n) => allowed.includes(n))) throw new GuardError('refused: a header that does not belong on this host'); };
  const p = u.pathname; const q = u.search;
  const keys = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? Object.keys(b).sort().join(',') : null);
  if (u.hostname === FN_HOST && method === 'POST' && q === '' && p === '/getRealtimeToken') {
    only(['x-spm-api-key', 'x-spm-user-email']);
    if (keys(body) !== '') throw new GuardError('refused: the token request body must be {}');
  } else if (u.hostname === FN_HOST && method === 'POST' && q === '' && p === '/documentsApi/listDocumentCommentEvents') {
    only(['x-spm-api-key', 'x-spm-user-email']);
    if (keys(body) !== 'documentId,since' || typeof body.documentId !== 'string' || !UUID_RE.test(body.documentId) || !Number.isSafeInteger(body.since) || body.since < 0) throw new GuardError('refused: the events request body');
  } else if (u.hostname === FN_HOST && method === 'GET' && ITEM_EVENTS_RE.test(p)) { // the board and map comment-events reads: GET only, no body, the key and the typed address and nothing else
    if (!/^\?since=(?:0|[1-9]\d{0,15})$/.test(q) || !Number.isSafeInteger(Number(q.slice(7)))) throw new GuardError('refused: the query must be exactly since=<non-negative integer>');
    if (names.length !== 2 || !names.includes('x-spm-api-key') || !names.includes('x-spm-user-email')) throw new GuardError('refused: the events read carries exactly the key and the typed address');
    if (body !== undefined) throw new GuardError('refused: a GET carries no body');
  } else if (u.hostname === FN_HOST && method === 'GET' && p === INBOX_PATH) { // the agent's own notice feed: GET only, no body, the key and the typed address and nothing else, a query of exactly since, limit and state
    if (!INBOX_QUERY_RE.test(q) || !Number.isSafeInteger(Number(q.slice(7, q.indexOf('&'))))) throw new GuardError('refused: the notices query must be exactly since=<non-negative integer>&limit=<1..100>&state=<all|unread|unresolved>');
    const exact = names.length === 2 && names.includes('x-spm-api-key') && names.includes('x-spm-user-email');
    if (!exact) throw new GuardError('refused: the notices read carries exactly the key and the typed address');
    if (body !== undefined) throw new GuardError('refused: the notices read is a GET and carries no body');
  } else throw new GuardError('refused: host, method or path is not on the allow-list');
}

// ---------------------------------------------------------------- the proxy: a real https call goes through HTTPS_PROXY (or https_proxy) when one is set, by Node's proxyEnv agent (one per proxy address, made lazily). Unset, and for the selftest's local http fakes, it stays agent:false as before. The target host never changes: the proxy only carries the request.
let PROXY_AGENT = null; let PROXY_AGENT_FOR = null;
function proxyAgentFor(lib) {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (lib === http || !p) return false;
  if (PROXY_AGENT === null || PROXY_AGENT_FOR !== p) { PROXY_AGENT = new https.Agent({ proxyEnv: { HTTPS_PROXY: p } }); PROXY_AGENT_FOR = p; } // only the proxy URL reaches the agent: no other variable
  return PROXY_AGENT;
}
// ---------------------------------------------------------------- the transport (real https in a run; plain http to local fakes in the selftest: the SAME code either way)
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
function makeTransport({ lib, resolveTarget }) {
  return function transport(url, method, headers, bodyObj, opts = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const t = resolveTarget(u);
      const data = bodyObj !== undefined ? JSON.stringify(bodyObj) : null;
      const h = { ...headers, host: u.host, accept: 'application/json' };
      if (data) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
      const ms = opts.timeoutMs || 30000;
      let settled = false; let hard = null; let req = null;
      const done = (f, v) => { if (settled) return; settled = true; clearTimeout(hard); if (opts.signal) opts.signal.removeEventListener('abort', onAbort); f(v); };
      const fail = (code) => { if (settled) return; if (req) req.destroy(); done(reject, Object.assign(new Error(code), { code })); };
      function onAbort() { fail('ABORTED'); }
      if (opts.signal) { if (opts.signal.aborted) return reject(Object.assign(new Error('ABORTED'), { code: 'ABORTED' })); opts.signal.addEventListener('abort', onAbort, { once: true }); }
      req = lib.request({ hostname: t.hostname, port: t.port, path: u.pathname + u.search, method, agent: proxyAgentFor(lib), headers: h }, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (c) => { size += c.length; if (size > MAX_REPLY_BYTES) return fail('TOOBIG'); chunks.push(c); });
        res.on('end', () => done(resolve, { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('aborted', () => fail('ECONNRESET'));
        res.on('error', () => fail('ECONNRESET'));
        res.on('close', () => fail('ECONNRESET'));
      });
      req.setTimeout(ms, () => fail('ETIMEDOUT'));
      hard = setTimeout(() => fail('ETIMEDOUT'), ms * 2); // the idle timer never fires on a dead socket: an absolute backstop
      req.on('error', (e) => fail(word(e && e.code) === 'none' ? 'ECONNRESET' : e.code));
      if (data) req.write(data);
      req.end();
    });
  };
}

// ---------------------------------------------------------------- the cursor file
function readCursorFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw new Fatal(`cannot read the cursor file (${word(e && e.code)})`);
  }
  const j = parseJson(text);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Fatal('the cursor file is not a JSON object: fix or move it (it is never overwritten silently)');
  for (const v of Object.values(j)) if (!Number.isSafeInteger(v) || v < 0) throw new Fatal('the cursor file holds a value that is not a non-negative integer: fix or move it');
  return j;
}
let tmpCounter = 0;
/** Temp file in the SAME folder, fsync, rename: a crash at any point leaves the old file or the new one, never half of either. */
function writeCursorAtomic(file, obj, hooks = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${++tmpCounter}.tmp`);
  const data = JSON.stringify(obj) + '\n';
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    if (hooks.beforeRename) hooks.beforeRename(tmp);
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* gone */ } }
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to remove */ }
    throw e;
  }
  try { const d = fs.openSync(dir, 'r'); fs.fsyncSync(d); fs.closeSync(d); } catch (_) { /* best effort: the rename itself is atomic */ }
}

// ---------------------------------------------------------------- key sources (names only; values are never printed)
/** The PUBLIC Firebase web API key (the app id): env VITE_FIREBASE_API_KEY or FIREBASE_API_KEY. Nothing else is read. */
// The env var wins; the settings file's app_id (optional, may be null) is the fallback.
function loadWebKeyFrom(env, appId) {
  const k = env.VITE_FIREBASE_API_KEY || env.FIREBASE_API_KEY;
  if (k) return k;
  if (appId) return appId;
  throw new Error('no firebase web api key found');
}
/** The one read of an identity's key file, inside this process. */
function readKeyFile(file) {
  const k = fs.readFileSync(file, 'utf8').trim();
  if (!k) throw new Error('empty key file');
  return k;
}
// ---------------------------------------------------------------- the Firebase SDK. Loaded LAZILY, only by a real listener: the selftest and the variant copies never load it.
const SIGNIN_HOSTS = [IDT_HOST, 'securetoken.googleapis.com'];
let SDK = null; // { app, auth, fs, appInst, authInst, db } once loaded
// : the first of the checkout's package.json and the cloud runtime folder's that resolves the SDK; null when neither does.
function sdkPackageJson() {
  const pj = path.join(RUNTIME_DIR, 'package.json');
  try { createRequire(pj).resolve('@firebase/firestore'); return pj; } catch (_) { return null; }
}
function sdkMissing() {
  return sdkPackageJson() ? null : `agent-listen: the Firebase SDK is not installed in ${RUNTIME_DIR} (nothing was called; run cloud-agent-setup.sh --apply first)`;
}

// the transport check, before any call: webchannel with a proxy needs NODE_USE_ENV_PROXY=1 at process start (the Node proxy agent reads it then)
function transportRefusal(transport, env) {
  if (transport !== 'webchannel') return null;
  if ((env.HTTPS_PROXY || env.https_proxy) && env.NODE_USE_ENV_PROXY !== '1') return 'agent-listen: transport webchannel needs NODE_USE_ENV_PROXY=1 at start (start.sh sets it)';
  return null;
}
function loadSdk(transport) {
  if (SDK) return SDK;
  // : the emulator and defaults variables go before the first require of any firebase module
  delete process.env.__FIREBASE_DEFAULTS__; delete process.env.FIRESTORE_EMULATOR_HOST; delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  // : default-deny. Only the two Google sign-in hosts pass, each with the script's Referer and no redirects; any other fetch throws. Auth captures fetch at load, so this runs first.
  const realFetch = globalThis.fetch;
  const allowed = transport === 'webchannel' ? [...SIGNIN_HOSTS, FS_HOST] : SIGNIN_HOSTS;
  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    let host = null;
    try { host = new URL(url).hostname; } catch (_) { host = null; }
    if (!allowed.includes(host)) return Promise.reject(new Error('refused: the SDK may only reach the sign-in hosts'));
    const h = new Headers(init.headers || {}); h.set('Referer', REFERER);
    return realFetch(input, { ...init, headers: h, redirect: 'error' });
  };
  const req = createRequire(sdkPackageJson());
  const app = req('@firebase/app'); const auth = req('@firebase/auth');
  // webchannel: the browser build of Firestore, loaded by its absolute path (long polling survives a cloud proxy that resets the Node build's gRPC)
  const fsdk = transport === 'webchannel' ? require(path.join(path.dirname(req.resolve('@firebase/firestore/package.json')), 'dist', 'index.cjs.js')) : req('@firebase/firestore');
  for (const m of [app, fsdk]) if (typeof m.setLogLevel === 'function') m.setLogLevel('silent');
  SDK = { app, auth, fs: fsdk, appInst: null, authInst: null, db: null };
  return SDK;
}
function realDeps() {
  const d = {
    io: { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') },
    proc: process,
    now: () => Date.now(),
    sleep: sleepReal,
    http: makeTransport({ lib: https, resolveTarget: (u) => ({ hostname: u.hostname, port: 443 }) }),
    requestTimeoutMs: 30000,
    readKey: (keyFile) => readKeyFile(keyFile),
    loadWebKey: (appId) => loadWebKeyFrom(process.env, appId),
    sdkMissing,
    // the SDK sign-in with the custom token
    signIn: async (customToken, webKey) => {
      const s = loadSdk(d.transport);
      if (!s.appInst) {
        s.appInst = s.app.initializeApp({ apiKey: webKey, projectId: PROJECT }, 'agent-listen');
        s.authInst = s.auth.initializeAuth(s.appInst, { persistence: s.auth.inMemoryPersistence });
        s.db = d.transport === 'webchannel' ? s.fs.initializeFirestore(s.appInst, { experimentalForceLongPolling: true, useFetchStreams: true }) : s.fs.getFirestore(s.appInst);
      }
      await s.auth.signInWithCustomToken(s.authInst, customToken);
    },
    // onSnapshot on signals/<sid> with metadata changes; returns the unsubscribe
    listen: (sid, onNext, onError) => { const s = loadSdk(d.transport); return s.fs.onSnapshot(s.fs.doc(s.db, 'signals', sid), { includeMetadataChanges: true }, onNext, onError); },
    // : the stream and the Auth timers end here, so the process can exit by itself
    close: async () => { const s = SDK; if (!s || !s.appInst) return; await s.fs.terminate(s.db).catch(() => {}); await s.app.deleteApp(s.appInst).catch(() => {}); },
    // : the one local clock check (a timer that makes no request; it only compares Date.now)
    interval: (fn, ms) => { const h = setInterval(fn, ms); return () => clearInterval(h); },
  };
  return d;
}

// : the SDK close gets a hard limit. A close that never resolves (an SDK handle left open) can no longer hold a finished run: after CLOSE_LIMIT_MS the run ends anyway. The cursor is saved before the close, so nothing is lost.
const CLOSE_LIMIT_MS = 3000;
async function closeWithLimit(deps) {
  if (typeof deps.close !== 'function') return;
  const limit = new AbortController();
  const timer = deps.sleep(CLOSE_LIMIT_MS, limit.signal);
  try { await Promise.race([Promise.resolve().then(() => deps.close()).catch(() => {}), timer]); } finally { limit.abort(); }
}

// ---------------------------------------------------------------- the listener
/** The marker of one signal document as the SDK shapes it (exists, data). { seq: null } when no marker is written yet (the same as a 404); null when the shape is not a marker. */
function markerOf(snap) {
  if (!snap || typeof snap.exists !== 'function') return null;
  if (!snap.exists()) return { seq: null, sig: null };
  const d = obj(snap.data());
  if (!Number.isSafeInteger(d.seq) || d.seq < 0) return null;
  const at = d.at && typeof d.at.toMillis === 'function' ? d.at.toMillis() : d.at;
  return { seq: d.seq, sig: `${d.seq}|${at === undefined || at === null ? '' : String(at)}` };
}
/** The items one listener watches, in a fixed order: documents, then boards, then maps. key = the cursor file key and the key of every per-item table: the bare uuid for a document (an existing cursor file works unchanged), board:<uuid>, map:<uuid>. */
function itemsOf(cfg) {
  if (cfg.items) return cfg.items;
  return [
    ...(cfg.documents || []).map((id) => ({ type: 'document', id, key: id })),
    ...(cfg.boards || []).map((id) => ({ type: 'board', id, key: `board:${id}` })),
    ...(cfg.maps || []).map((id) => ({ type: 'map', id, key: `map:${id}` })),
  ];
}
const WALL_TICK_MS = 5000; // A4: the one local clock check (no request): it compares Date.now() with the last tick
const WAKE_JUMP_MS = 60000; // a clock jump longer than this is a wake from sleep (or a network switch)
const LISTEN_BACKOFF_MAX_MS = 30000; // A3: a dead signal stream listens again after 1 s, doubling, up to 30 s
function createListener(cfg, deps) {
  const ac = new AbortController();
  const ITEMS = itemsOf(cfg);
  const KEYS = ITEMS.map((i) => i.key);
  const byKey = new Map(ITEMS.map((i) => [i.key, i]));
  const short = (doc) => byKey.get(doc).id.slice(0, 8);
  const idKeys = (doc) => { const it = byKey.get(doc); return it.type === 'document' ? { document_id: it.id } : { item_type: it.type, item_id: it.id }; };
  const io = deps.io;
  const reqMs = deps.requestTimeoutMs || 30000;
  const ownEmail = cfg.email.toLowerCase();
  let resolveFinished = null;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  const S = {
    cursor: {}, loaded: false, sid: new Map(), baselined: new Set(), pending: new Set(), handledSig: new Map(),
    subs: new Map(), catchUp: new Set(), listenFails: new Map(), busy: new Set(), dirty: new Map(),
    loginFails: 0, loginRetryAt: 0, signedIn: false, eventsFails: new Map(), noted: new Set(), stopped: false, error: null, lastTick: 0,
  };
  const now = () => deps.now();
  const scrub = (text) => {
    let t = String(text);
    for (const s of [cfg.key, cfg.webKey]) if (typeof s === 'string' && s.length >= 8) t = t.split(s).join('[redacted]');
    return t.replace(/eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)*/g, '[redacted]').replace(/spm_k_[A-Za-z0-9_-]+/g, '[redacted]').replace(/AIza[0-9A-Za-z_-]{10,}/g, '[redacted]').replace(/AMf-v[A-Za-z0-9_-]+/g, '[redacted]');
  };
  const out = (o) => io.out(scrub(JSON.stringify(o)));
  const note = (key, msg) => { if (S.stopped || S.noted.has(key)) return; S.noted.add(key); io.err(scrub(`agent-listen: ${msg}`)); };
  const clearNote = (key) => { S.noted.delete(key); };
  const stop = (reason) => { if (S.stopped) return; S.stopped = true; S.stopReason = reason; ac.abort(); resolveFinished(); };
  const fail = (msg) => { if (!S.error) S.error = msg; io.err(scrub(`agent-listen: ${msg}`)); stop('fatal'); };
  const failWith = (e) => fail(e instanceof Fatal ? e.message : `unexpected failure (${word(e && e.name)} ${word(e && e.code)})`);
  const nap = (ms) => deps.sleep(ms, ac.signal);
  const agentHeaders = () => ({ 'X-SPM-API-Key': cfg.key, 'X-SPM-User-Email': cfg.email });
  const retryWaitMs = (r) => {
    const v = r.headers && r.headers['retry-after'];
    const n = typeof v === 'string' && /^\d{1,4}$/.test(v.trim()) ? Number(v.trim()) : NaN;
    return (n >= 1 && n <= 3600 ? n : DEFAULT_WAIT_S) * 1000;
  };
  function save() {
    try { writeCursorAtomic(cfg.cursorFile, S.cursor); } catch (e) { throw new Fatal(`cannot write the cursor file (${word(e && e.code)})`); }
  }
  async function call(url, method, headers, body) {
    guardRequest(url, method, headers, body);
    let res;
    try { res = await deps.http(url, method, headers, body, { signal: ac.signal, timeoutMs: reqMs }); } catch (e) { return { status: null, json: null, headers: {}, err: word(e && e.code) }; }
    return { status: res.status, json: parseJson(res.text), headers: res.headers || {}, err: null };
  }

  // ---- (1) and (2): the mint, then the sign-in through the SDK.
  function loginFail(why, waitMs) {
    S.loginFails++;
    S.loginRetryAt = now() + (waitMs || Math.min(60000, 5000 * 2 ** (S.loginFails - 1)));
    note('login', `realtime login failed (${why}); retrying`);
    return false;
  }
  async function login() {
    const t = await call(`https://${FN_HOST}/getRealtimeToken`, 'POST', agentHeaders(), {});
    if (t.status === 429) return loginFail('token_429', retryWaitMs(t));
    if (t.status !== 200 || !t.json || typeof t.json.token !== 'string' || !t.json.token) return loginFail(`token_${t.status === null ? t.err : t.status}`, 0);
    try { await deps.signIn(t.json.token, cfg.webKey); } catch (e) { return loginFail(`exchange_${word(e && typeof e.code === 'string' ? e.code.replace('/', '-') : null)}`, 0); }
    S.loginFails = 0; S.loginRetryAt = 0; S.signedIn = true; clearNote('login');
    return true;
  }
  async function signInNow() {
    for (;;) {
      if (S.stopped || S.signedIn) return S.signedIn;
      if (now() >= S.loginRetryAt && await login()) return true;
      await nap(Math.max(0, S.loginRetryAt - now()));
    }
  }

  // ---- the events route (agent key only; no Firebase needed)
  async function eventsRead(doc, since) {
    const it = byKey.get(doc);
    const r = it.type === 'document'
      ? await call(`https://${FN_HOST}/documentsApi/listDocumentCommentEvents`, 'POST', agentHeaders(), { documentId: it.id, since })
      : await call(`https://${FN_HOST}/${it.type === 'board' ? 'boardsApi/boards' : 'mapsApi/maps'}/${it.id}/comment-events?since=${since}`, 'GET', agentHeaders(), undefined);
    if (r.status === 200 && r.json && typeof r.json === 'object' && !Array.isArray(r.json)) {
      const sid = r.json.signal_id;
      if (typeof sid !== 'string' || !/^[0-9a-f]{64}$/.test(sid)) throw new Fatal(`the ${it.type} ${it.id.slice(0, 8)} reply has no signal id (the signal secret is not set, or the signal is off): the listener stops; fix that and start it again`);
      S.sid.set(doc, sid);
      return { ok: true, j: r.json };
    }
    if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404) throw new Fatal(`the events read for ${it.type} ${it.id.slice(0, 8)} was refused (${r.status} ${word(r.json && r.json.code)}): check the key, the ${it.type} id and the grant`);
    if (r.status === 429) return { ok: false, why: '429', wait: retryWaitMs(r) };
    return { ok: false, why: r.status === null ? r.err : String(r.status), wait: 0 };
  }
  // a failed read: the wait before the next try (the existing backoff, 1 s doubling to 30 s, unless the server asked for a Retry-After)
  function eventsFailed(doc, why, waitMs) {
    const n = (S.eventsFails.get(doc) || 0) + 1;
    S.eventsFails.set(doc, n);
    note(`events-${doc}`, `events read for ${short(doc)} failed (${why}); retrying`);
    return waitMs || Math.min(30000, 1000 * 2 ** (n - 1));
  }
  function eventsOk(doc) { S.eventsFails.delete(doc); clearNote(`events-${doc}`); }
  const isOwn = (ev) => typeof ev.actor_email === 'string' && ev.actor_email.toLowerCase() === ownEmail;
  function lineFor(doc, ev, via) {
    const it = byKey.get(doc);
    const c = ev.comment && typeof ev.comment === 'object' ? ev.comment : null;
    const body = c && typeof c.body === 'string' ? c.body : '';
    const authorIsActor = !!c && typeof ev.actor_email === 'string' && typeof c.author_email === 'string' && c.author_email.toLowerCase() === ev.actor_email.toLowerCase();
    return {
      t: istIso(now()), ...idKeys(doc), seq: ev.seq, kind: typeof ev.verb === 'string' ? ev.verb : null, comment_id: typeof ev.object_id === 'string' ? ev.object_id : null,
      author_kind: typeof ev.actor_type === 'string' ? ev.actor_type : (authorIsActor && typeof c.author_kind === 'string' ? c.author_kind : null),
      author_name: authorIsActor && typeof c.author_display_name === 'string' ? c.author_display_name : null,
      excerpt: Array.from(body).slice(0, EXCERPT_CHARS).join(''),
      via,
      ...(it.type === 'board' ? withTaskId(replyWiring(ev, c, body), c) : replyWiring(ev, c, body)),
    };
  }
  // a BOARD line also carries task_id (the task the comment is on, from the comment the same events read returns; null for a deleted comment), right after thread_root_id
  function withTaskId(w, c) {
    return { parent_id: w.parent_id, thread_root_id: w.thread_root_id, task_id: c && typeof c.task_id === 'string' ? c.task_id : null, body: w.body, ...(w.body_truncated ? { body_truncated: true } : {}) };
  }
  // : what a wake-up needs to answer with nothing to look up. The body is redacted FIRST and cut second, so a key that straddles the cut can never leave a fragment.
  function replyWiring(ev, c, body) {
    const parentId = c && typeof c.parent_id === 'string' && c.parent_id ? c.parent_id : null;
    const ownId = typeof ev.object_id === 'string' ? ev.object_id : null;
    const chars = Array.from(scrub(body));
    const w = { parent_id: parentId, thread_root_id: c ? (parentId || ownId) : null, body: chars.slice(0, BODY_CHARS).join('') };
    if (chars.length > BODY_CHARS) w.body_truncated = true;
    return w;
  }

  // ---- (3): the baseline of one document: its signal id and its current max seq. Unknown document: starts there. Known and behind: read at once (pending). Returns 0 when done, else the wait before the next try.
  async function baseline(doc) {
    const e = await eventsRead(doc, FUTURE_SINCE);
    if (!e.ok) return eventsFailed(doc, e.why, e.wait);
    const j = e.j;
    if (j.reset !== true || !Number.isSafeInteger(j.latest) || j.latest < 0) return eventsFailed(doc, 'unexpected_reply', 0);
    eventsOk(doc);
    if (!Object.prototype.hasOwnProperty.call(S.cursor, doc)) { S.cursor[doc] = j.latest; save(); }
    else if (S.cursor[doc] > j.latest) { S.cursor[doc] = j.latest; save(); note(`stale-${doc}`, `the stored cursor of ${short(doc)} was ahead of the stream: moved back to the latest`); }
    else if (S.cursor[doc] < j.latest) S.pending.add(doc);
    S.baselined.add(doc);
    return 0;
  }

  // ---- (4): read the events since the cursor, print one line per remaining event, then save the cursor. Returns { ok, printed, wait }; printed counts the lines of this read, even when it failed part way.
  async function fetchEvents(doc, via) {
    let since = S.cursor[doc]; let resets = 0; let printed = 0;
    for (let page = 0; page < 50; page++) {
      const e = await eventsRead(doc, since);
      if (!e.ok) return { ok: false, printed, wait: eventsFailed(doc, e.why, e.wait) };
      const j = e.j;
      if (j.reset === true) {
        if (!Number.isSafeInteger(j.latest) || j.latest < 0) return { ok: false, printed, wait: eventsFailed(doc, 'unexpected_reply', 0) };
        if (since > j.latest) { S.cursor[doc] = j.latest; save(); eventsOk(doc); note(`stale-${doc}`, `the cursor of ${short(doc)} was ahead of the stream: moved back to the latest`); break; }
        if (resets++ >= 1) return { ok: false, printed, wait: eventsFailed(doc, 'reset_loop', 0) };
        out({ t: istIso(now()), ...idKeys(doc), reset: true, latest: j.latest }); // too far behind to page (more than 100): resume from the newest 100
        since = Math.max(0, j.latest - 100);
        continue;
      }
      if (!Array.isArray(j.events) || !Number.isSafeInteger(j.latest)) return { ok: false, printed, wait: eventsFailed(doc, 'unexpected_reply', 0) };
      let last = since; const lines = [];
      for (const ev of j.events) {
        if (!ev || typeof ev !== 'object' || !Number.isSafeInteger(ev.seq) || ev.seq <= last) return { ok: false, printed, wait: eventsFailed(doc, 'unexpected_reply', 0) };
        last = ev.seq;
        if (cfg.selfSkip && isOwn(ev)) continue;
        lines.push(lineFor(doc, ev, via));
      }
      for (const l of lines) out(l); // print first, then save: a crash between the two repeats events, it never loses one
      printed += lines.length;
      const hasMore = j.has_more === true && j.events.length > 0;
      let next = j.events.length ? last : since;
      if (!hasMore) next = Math.max(next, j.latest);
      if (next > S.cursor[doc]) { S.cursor[doc] = next; save(); }
      eventsOk(doc);
      if (!hasMore) break;
      since = next;
    }
    return { ok: true, printed, wait: 0 };
  }

  // : one read in flight per item. A request that comes during a read marks the item dirty and the read runs again after it. A failed read retries with the backoff until it succeeds. A printed line in --mode once ends the run.
  async function readItem(doc, via) {
    let v = via;
    for (;;) {
      let r;
      for (;;) {
        if (S.stopped) return;
        r = await fetchEvents(doc, v);
        if (r.printed && cfg.mode === 'once') { stop('delivered'); return; }
        if (r.ok) break;
        await nap(r.wait);
      }
      const sub = S.subs.get(doc);
      if (sub && S.sid.get(doc) !== sub.sid) { note(`resignal-${doc}`, `the signal of ${short(doc)} changed: listening to the new one`); resubscribe(doc, false); } // A5: the reply carries the id; a new id is followed at once
      if (!S.dirty.has(doc)) return;
      v = S.dirty.get(doc);
      S.dirty.delete(doc);
    }
  }
  function requestRead(doc, via) {
    if (S.stopped) return Promise.resolve();
    if (S.busy.has(doc)) { if (!S.dirty.has(doc)) S.dirty.set(doc, via); return Promise.resolve(); }
    S.busy.add(doc);
    return readItem(doc, via).catch(failWith).finally(() => { S.busy.delete(doc); });
  }

  // ---- (5): one signal subscription per item: onSnapshot with includeMetadataChanges. A snapshot error ENDS the subscription, so the listener subscribes again after a backoff.
  function onSnap(doc, sub, snap) {
    if (S.stopped || !sub.live) return;
    if (!snap || !snap.metadata || snap.metadata.fromCache) return; // a cached-only snapshot never reads
    S.listenFails.delete(doc); clearNote(`signal-${doc}`);
    if (S.catchUp.has(doc)) { S.catchUp.delete(doc); requestRead(doc, 'safety'); return; } // the first server snapshot after a (re)subscription: ONE catch-up read
    const m = markerOf(snap);
    if (m === null) { note(`shape-${doc}`, `the signal of ${short(doc)} has a shape the listener does not know`); return; }
    // the same marker (same seq and time) is asked for once: a read started after it sees every event it covers, so a repeat of it adds nothing
    if (m.seq !== null && m.seq > S.cursor[doc] && m.sig !== S.handledSig.get(doc)) { S.handledSig.set(doc, m.sig); requestRead(doc, 'marker'); }
  }
  function onListenError(doc, sub, err) {
    if (!sub.live || S.stopped) return;
    sub.live = false; S.subs.delete(doc);
    const n = (S.listenFails.get(doc) || 0) + 1;
    S.listenFails.set(doc, n);
    const wait = Math.min(LISTEN_BACKOFF_MAX_MS, 1000 * 2 ** (n - 1));
    note(`signal-${doc}`, `signal stream for ${short(doc)} failed (${word(err && err.code)}); listening again in ${wait / 1000} s`);
    (async () => { await nap(wait); if (!S.stopped && !S.subs.has(doc)) subscribe(doc, true); })();
  }
  function subscribe(doc, catchUp) {
    const sub = { sid: S.sid.get(doc), live: true, unsub: null };
    S.subs.set(doc, sub);
    if (catchUp) S.catchUp.add(doc);
    try {
      sub.unsub = deps.listen(sub.sid, (snap) => onSnap(doc, sub, snap), (err) => onListenError(doc, sub, err));
    } catch (e) { onListenError(doc, sub, e); }
  }
  function unsubscribe(doc) {
    const sub = S.subs.get(doc);
    if (!sub) return;
    sub.live = false; S.subs.delete(doc);
    try { if (sub.unsub) sub.unsub(); } catch (_) { /* the SDK already ended it */ }
  }
  function resubscribe(doc, catchUp) { unsubscribe(doc); subscribe(doc, catchUp); }

  // ---- : the one local clock check. A jump of more than 60 s between two ticks is a wake from sleep (or a network switch): every item listens again and reads once.
  function wallTick() {
    const t = now(); const jump = t - S.lastTick; S.lastTick = t;
    if (S.stopped || jump <= WAKE_JUMP_MS) return;
    clearNote('wake');
    note('wake', `the clock jumped ${Math.round(jump / 1000)} s (a wake from sleep?): listening again`);
    for (const d of KEYS) if (S.baselined.has(d)) resubscribe(d, true);
  }

  async function run() {
    let code = 0; let cancelTick = null;
    try {
      S.cursor = readCursorFile(cfg.cursorFile);
      S.loaded = true;
      save();
      if (!cfg.webKey) throw new Fatal('no Firebase web API key found: the listener cannot hear the signal (fix the key sources and start it again)');
      await login(); // (1), (2): one attempt; a failure keeps the login backoff. The events reads need only the agent key, so they run either way.
      for (const d of KEYS) { while (!S.stopped && !S.baselined.has(d)) { const w = await baseline(d); if (w) await nap(w); } }
      for (const d of KEYS) if (S.pending.has(d)) { S.pending.delete(d); await requestRead(d, 'marker'); } // the start catch-up is read before the signal listens, so no snapshot races it
      await signInNow(); // the listen needs the sign-in: retried with the login backoff until it works
      for (const d of KEYS) { if (S.stopped) break; subscribe(d, false); }
      S.lastTick = now();
      cancelTick = deps.interval(wallTick, WALL_TICK_MS);
      await finished;
    } catch (e) {
      code = 1;
      if (!S.error) io.err(scrub(e instanceof Fatal ? `agent-listen: ${e.message}` : `agent-listen: unexpected failure (${word(e && e.name)} ${word(e && e.code)})`));
    } finally {
      stop('done');
      if (cancelTick) cancelTick();
      for (const d of [...S.subs.keys()]) unsubscribe(d);
      if (S.loaded) { try { writeCursorAtomic(cfg.cursorFile, S.cursor); } catch (_) { /* reported above when it was the cause */ } } // the cursor is saved on every way out, before the SDK is closed
      await closeWithLimit(deps); // E1: the SDK close has a hard limit (see closeWithLimit)
    }
    return S.error ? 1 : code;
  }
  return { run, stop };
}
/** Tells which cursor file this is: 'none' (absent or empty), 'inbox' ({ inbox_seq }), 'items' (a document, board or map listener's per-item cursors), 'mixed' (both: refused by both modes), 'unreadable' (not an object: the listener reports it). */
function cursorKindOf(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? 'none' : 'unreadable'; }
  const j = parseJson(text);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return 'unreadable';
  const keys = Object.keys(j);
  if (keys.length === 0) return 'none';
  const inbox = keys.includes(INBOX_CURSOR_KEY);
  if (inbox && keys.length === 1) return 'inbox';
  return inbox ? 'mixed' : 'items';
}
/** One feed row -> one notice line (a fixed list of keys: nothing else of the row can reach stdout), or null when the row is not shaped like a real row. */
function noticeLine(row, tMs) {
  const r = obj(row);
  const item = obj(r.item); const object = obj(r.object);
  const target = r.target && typeof r.target === 'object' && !Array.isArray(r.target) ? r.target : null;
  const uuid = (x) => typeof x === 'string' && UUID_RE.test(x);
  if (!uuid(r.id) || !Number.isSafeInteger(r.seq) || r.seq < 0 || !['document', 'board', 'map'].includes(item.type) || !uuid(item.id) || typeof r.reason !== 'string' || typeof r.lane !== 'string') return null;
  const targetOk = target !== null && typeof target.type === 'string' && uuid(target.id);
  return {
    t: istIso(tMs),
    kind: 'notice',
    notification_id: r.id,
    seq: r.seq,
    reason: word(r.reason),
    lane: word(r.lane),
    verb: typeof r.verb === 'string' && /^[a-z_.]{1,40}$/.test(r.verb) ? r.verb : null,
    item: { type: item.type, id: item.id },
    comment_id: object.type === 'comment' && uuid(object.id) ? object.id : null,
    thread_root_id: uuid(r.thread_id) ? r.thread_id : null,
    task_id: item.type === 'board' && targetOk && target.type === 'task' ? target.id : null,
    target: targetOk ? { type: word(target.type), id: target.id } : null,
    item_seq: Number.isSafeInteger(r.item_seq) ? r.item_seq : null,
    actor_kind: obj(r.actor).kind === 'agent' ? 'agent' : 'human',
  };
}
/** The inbox listener: EVENT-DRIVEN, on the same signal machinery as the item listener. One feed read gives the caller's signal_id; the listener holds
 * signals/<signal_id>. The feed is read only when the marker's seq is above the cursor (a marker
 * signature already asked is not asked again: ), plus ONE catch-up read on the first server snapshot after each (re)subscription. One read in flight; a bump during a read
 * re-runs it once. No timer reads anything except the RE-RAISE pass and the retry after a failed read: a FAILED read is retried after 5 s, 15 s, 45 s, then every 120 s, until one read succeeds; a bump reads at once and cancels that wait. The first run with no cursor prints the
 * unresolved notices of the last 24 hours (at most 20) as catch-up lines, then streams. */
const INBOX_CATCHUP_MS = 24 * 60 * 60 * 1000;
const INBOX_CATCHUP_MAX = 20;
const INBOX_RETRY_MS = [5000, 15000, 45000]; // R-P2: the waits after the 1st, 2nd and 3rd failed read in a row
const INBOX_RETRY_LAST_MS = 120000; // then every 120 s until one read succeeds
// RE-RAISE. Stream mode only: every REraise_MS one feed read; a row older than REraise_MS and younger than 24 h is printed again.
const REraise_MS = 300000;
const RERAISE_MAX_LINES = 20;
function createInboxListener(cfg, deps) {
  const ac = new AbortController();
  const io = deps.io;
  const reqMs = deps.requestTimeoutMs || 30000;
  const now = () => deps.now();
  const reraiseMs = deps.reraiseMs || REraise_MS; // the test seam
  const reraised = new Map(); // notification id -> how many times this process has re-raised it
  const S = { cursor: null, loaded: false, sid: null, sub: null, catchUp: false, handledSig: null, busy: false, dirty: false, listenFails: 0, loginFails: 0, loginRetryAt: 0, signedIn: false, noted: new Set(), stopped: false, resolveFinished: null, retryCtl: null, failStreak: 0 };
  const finished = new Promise((resolve) => { S.resolveFinished = resolve; });
  const scrub = (text) => {
    let t = String(text);
    for (const s of [cfg.key, cfg.webKey]) if (typeof s === 'string' && s.length >= 8) t = t.split(s).join('[redacted]');
    return t.replace(/eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)*/g, '[redacted]').replace(/spm_k_[A-Za-z0-9_-]+/g, '[redacted]').replace(/AIza[0-9A-Za-z_-]{10,}/g, '[redacted]');
  };
  const emit = (o) => io.out(scrub(JSON.stringify(o)));
  const say = (key, msg) => { if (S.stopped || S.noted.has(key)) return; S.noted.add(key); io.err(scrub(`agent-listen: ${msg}`)); };
  const unsay = (key) => { S.noted.delete(key); };
  const stop = (reason) => { if (S.stopped) return; S.stopped = true; S.stopReason = reason; ac.abort(); cancelRetry(); S.resolveFinished(); };
  const fail = (msg) => { if (S.stopped) return; io.err(scrub(`agent-listen: ${msg}`)); S.error = msg; stop('fatal'); };
  const nap = (ms) => deps.sleep(ms, ac.signal);
  const headers = () => ({ 'X-SPM-API-Key': cfg.key, 'X-SPM-User-Email': cfg.email });
  const retryWaitMs = (r) => {
    const raw = r.headers && r.headers['retry-after'];
    const waitS = typeof raw === 'string' && /^\d{1,4}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    return (waitS >= 1 && waitS <= 3600 ? waitS : DEFAULT_WAIT_S) * 1000;
  };
  function save() {
    try { writeCursorAtomic(cfg.cursorFile, { [INBOX_CURSOR_KEY]: S.cursor }); } catch (e) { throw new Fatal(`cannot write the cursor file (${word(e && e.code)})`); }
  }
  async function call(url, method, hdrs, body) {
    guardRequest(url, method, hdrs, body);
    let res;
    try { res = await deps.http(url, method, hdrs, body, { signal: ac.signal, timeoutMs: reqMs }); } catch (e) { return { status: null, json: null, headers: {}, err: word(e && e.code) }; }
    return { status: res.status, json: parseJson(res.text), headers: res.headers || {}, err: null };
  }
  // ---- the sign-in, exactly as the item listener does it (the mint, then the SDK's custom-token exchange); a failed sign-in is retried later
  async function login() {
    const t = await call(`https://${FN_HOST}/getRealtimeToken`, 'POST', headers(), {});
    if (t.status === 429) { S.loginRetryAt = now() + retryWaitMs(t); S.loginFails++; return false; }
    if (t.status !== 200 || !t.json || typeof t.json.token !== 'string' || !t.json.token) { S.loginFails++; S.loginRetryAt = now() + Math.min(60000, 5000 * 2 ** (S.loginFails - 1)); say('login', `realtime login failed (token_${t.status === null ? t.err : t.status}); retrying`); return false; }
    try { await deps.signIn(t.json.token, cfg.webKey); } catch (e) { S.loginFails++; S.loginRetryAt = now() + Math.min(60000, 5000 * 2 ** (S.loginFails - 1)); say('login', `realtime login failed (exchange_${word(e && typeof e.code === 'string' ? e.code.replace('/', '-') : null)}); retrying`); return false; }
    S.loginFails = 0; S.loginRetryAt = 0; S.signedIn = true; unsay('login');
    return true;
  }
  async function signInNow() {
    while (!S.stopped && !S.signedIn) {
      if (now() >= S.loginRetryAt && await login()) break;
      await nap(Math.max(0, S.loginRetryAt - now()));
    }
    return S.signedIn;
  }
  // ---- the notices feed: GET only, the key and the typed address; a reply that is not the real shape is a failure, a refused key or address is fatal
  async function readFeed(since, state) {
    const url = `https://${FN_HOST}${INBOX_PATH}?since=${since}&limit=${INBOX_LIMIT}&state=${state}`;
    guardRequest(url, 'GET', headers(), undefined);
    let res;
    try { res = await deps.http(url, 'GET', headers(), undefined, { signal: ac.signal, timeoutMs: reqMs }); } catch (e) { return { ok: false, why: word(e && e.code), wait: 0 }; }
    const json = parseJson(res.text);
    if (res.status === 200 && json && typeof json === 'object' && !Array.isArray(json)) return { ok: true, j: json };
    if (res.status === 401 || res.status === 403 || res.status === 400 || res.status === 404) throw new Fatal(`the notices read was refused (${res.status} ${word(json && json.code)}): check the key and the address in the settings file`);
    if (res.status === 429) return { ok: false, why: '429', wait: retryWaitMs(res) };
    return { ok: false, why: String(res.status), wait: 0 };
  }
  const sidOf = (j) => (typeof j.signal_id === 'string' && /^[0-9a-f]{64}$/.test(j.signal_id) ? j.signal_id : null);
  /** Reads the rows after the cursor, prints one line per row, saves the cursor (print first, then save). Returns { ok, printed }. */
  async function fetchRows() {
    let since = S.cursor; let printed = 0;
    for (let page = 0; page < 50; page++) {
      const e = await readFeed(since, 'all');
      if (!e.ok) { say('feed', `notices read failed (${e.why}); it is retried`); return { ok: false, printed, wait: e.wait }; }
      const j = e.j;
      const sid = sidOf(j);
      if (sid) S.lastSid = sid;
      if (j.reset === true) { // the stored cursor is ahead of the stream (a reset database, a copied file): move back to the latest, replay nothing
        if (!Number.isSafeInteger(j.latest) || j.latest < 0) { say('feed', 'notices read failed (unexpected_reply); it is retried'); return { ok: false, printed }; }
        S.cursor = j.latest; save(); unsay('feed');
        say('stale', 'the stored cursor was ahead of the stream: moved back to the latest');
        break;
      }
      if (!Array.isArray(j.notifications) || !Number.isSafeInteger(j.cursor) || !Number.isSafeInteger(j.latest) || typeof j.has_more !== 'boolean') { say('feed', 'notices read failed (unexpected_reply); it is retried'); return { ok: false, printed }; }
      let last = since; const lines = [];
      for (const row of j.notifications) {
        const line = noticeLine(row, now());
        if (!line || line.seq <= last) { say('feed', 'notices read failed (unexpected_reply); it is retried'); return { ok: false, printed }; }
        last = line.seq;
        lines.push(line);
      }
      for (const l of lines) emit(l);
      printed += lines.length;
      const next = Math.max(j.cursor, last); // the feed's cursor passes a row it left out (access lost)
      if (next > S.cursor) { S.cursor = next; save(); }
      unsay('feed');
      if (!j.has_more || next <= since) break;
      since = next;
    }
    return { ok: true, printed };
  }
  /** FIRST RUN (no cursor): the unresolved notices of the last 24 hours, at most 20 of them, printed as catch-up lines; then the cursor is the feed's latest. */
  async function firstRun() {
    const e = await readFeed(0, 'unresolved');
    if (!e.ok) return { ok: false, wait: e.wait };
    const j = e.j;
    if (sidOf(j)) S.lastSid = sidOf(j);
    if (!Array.isArray(j.notifications) || !Number.isSafeInteger(j.latest) || j.latest < 0) { say('feed', 'notices read failed (unexpected_reply); retrying'); return { ok: false }; }
    const cutoff = now() - INBOX_CATCHUP_MS;
    const recent = j.notifications.filter((r) => { const ms = r && typeof r.created_at === 'string' ? Date.parse(r.created_at) : NaN; return Number.isFinite(ms) && ms >= cutoff; });
    const lines = recent.slice(-INBOX_CATCHUP_MAX).map((row) => noticeLine(row, now())).filter(Boolean);
    for (const l of lines) emit(l);
    S.cursor = j.latest; save(); unsay('feed');
    return { ok: true, printed: lines.length };
  }
  /** One read, as the bump asked for it. { ok, wait }: a failed read reports the Retry-After wait of a 429 (ms, 0 otherwise); armRetry then waits the larger of the ladder step and that (R-P2, F2). */
  async function readOnce() {
    const r = S.cursor === null ? await firstRun() : await fetchRows();
    if (!r.ok) return { ok: false, wait: r.wait || 0 };
    if (r.printed > 0 && cfg.mode === 'once') stop('delivered');
    return { ok: true, wait: 0 };
  }
  // ---- the retry after a FAILED read: after 5 s, 15 s, 45 s, then every 120 s, until one read succeeds. Only a failed read arms it; a bump or a success cancels it. The wait is the listener's own sleep (no new timer site).
  function nextRetryMs() { S.failStreak += 1; return S.failStreak <= INBOX_RETRY_MS.length ? INBOX_RETRY_MS[S.failStreak - 1] : INBOX_RETRY_LAST_MS; }
  function cancelRetry() { if (S.retryCtl) { const c = S.retryCtl; S.retryCtl = null; c.abort(); } }
  function armRetry(wait = 0) {
    if (S.stopped || S.retryCtl) return;
    const ctl = new AbortController(); S.retryCtl = ctl;
    deps.sleep(Math.max(nextRetryMs(), wait || 0), ctl.signal).then(() => { if (S.retryCtl !== ctl) return; S.retryCtl = null; requestRead(); }).catch(() => {});
  }
  function requestRead() {
    if (S.stopped) return;
    cancelRetry(); // R-P2: a bump reads at once and cancels a pending retry
    if (S.busy) { S.dirty = true; return; } // A7: one read in flight; a bump during it runs the read once more
    S.busy = true;
    (async () => {
      let ok = true; let wait = 0;
      try {
        do {
          S.dirty = false;
          const r = await readOnce(); ok = r.ok; wait = r.wait;
          if (S.stopped) break;
        } while (S.dirty && !S.stopped);
      } catch (e) { fail(e instanceof Fatal ? e.message : `unexpected failure (${word(e && e.name)} ${word(e && e.code)})`); } finally { S.busy = false; }
      if (!S.stopped) { if (ok) S.failStreak = 0; else armRetry(wait); }
      if (!S.stopped && S.lastSid && S.sid && S.lastSid !== S.sid) resubscribe(S.lastSid);
    })();
  }
  // ---- the signal: onSnapshot on signals/<sid> with metadata changes; a snapshot error ends the subscription and it is listened to again after a backoff
  function onSnap(sub, snap) {
    if (S.stopped || !sub.live || S.sub !== sub) return;
    if (!snap || !snap.metadata || snap.metadata.fromCache) return; // a cached-only snapshot never reads
    S.listenFails = 0; unsay('signal');
    const m = markerOf(snap);
    if (m === null) { say('shape', 'the inbox signal has a shape the listener does not know'); return; }
    if (S.catchUp) { S.catchUp = false; S.handledSig = m.sig; requestRead(); return; } // the first server snapshot after a (re)subscription: ONE catch-up read
    // the same marker (same seq and time) is asked for once: a read started after it sees every row it covers
    if (m.seq !== null && m.seq > (S.cursor === null ? -1 : S.cursor) && m.sig !== S.handledSig) { S.handledSig = m.sig; requestRead(); }
  }
  function onListenError(sub, err) {
    if (!sub.live || S.stopped) return;
    sub.live = false; if (S.sub === sub) S.sub = null;
    S.listenFails += 1;
    const wait = Math.min(LISTEN_BACKOFF_MAX_MS, 1000 * 2 ** (S.listenFails - 1));
    say('signal', `signal stream failed (${word(err && err.code)}); listening again in ${wait / 1000} s`);
    (async () => { await nap(wait); if (!S.stopped && !S.sub && S.sid) subscribe(S.sid, true); })().catch(() => {});
  }
  function subscribe(sid, catchUp) {
    const sub = { sid, live: true, unsub: null };
    S.sub = sub; S.sid = sid; S.catchUp = catchUp;
    try { sub.unsub = deps.listen(sid, (snap) => onSnap(sub, snap), (err) => onListenError(sub, err)); } catch (e) { onListenError(sub, e); }
  }
  function resubscribe(sid) {
    say('resignal', 'the inbox signal changed: listening to the new one');
    if (S.sub) { S.sub.live = false; try { if (S.sub.unsub) S.sub.unsub(); } catch (_) { /* the SDK's own close */ } S.sub = null; }
    subscribe(sid, true);
  }
  /** RE-RAISE pass: one read since=0 state=unresolved. Each row older than reraiseMs and younger than 24 h is printed again as its normal line plus "reraise": n, oldest first, at most RERAISE_MAX_LINES a pass. Never moves the cursor, never POSTs. A failed read is one stderr line; the next pass tries again. */
  const quitting = () => S.stopped || ac.signal.aborted;
  async function reraisePass() {
    let j = null;
    try {
      const e = await readFeed(0, 'unresolved');
      if (quitting()) return;
      if (!e.ok) { say('reraise', `re-raise read failed (${e.why}); the next pass tries again`); return; }
      j = e.j;
    } catch (err) {
      if (quitting()) return;
      say('reraise', err instanceof Fatal ? err.message : `re-raise read failed (${word(err && err.name)}); the next pass tries again`);
      return;
    }
    if (!Array.isArray(j.notifications)) { say('reraise', 're-raise read failed (unexpected_reply); the next pass tries again'); return; }
    unsay('reraise');
    const at = now();
    const lines = [];
    for (const row of j.notifications) {
      const ms = row && typeof row.created_at === 'string' ? Date.parse(row.created_at) : NaN;
      if (!Number.isFinite(ms)) continue;
      const age = at - ms;
      if (!(age > reraiseMs && age < INBOX_CATCHUP_MS)) continue;
      const line = noticeLine(row, at);
      if (line) lines.push(line);
    }
    lines.sort((a, b) => a.seq - b.seq);
    for (const l of lines.slice(0, RERAISE_MAX_LINES)) {
      const n = (reraised.get(l.notification_id) || 0) + 1;
      reraised.set(l.notification_id, n);
      emit({ ...l, reraise: n });
    }
  }
  /** Stream mode only: a re-raise pass every reraiseMs until the run stops (the wait is aborted by stop, so nothing is left running). */
  async function reraiseLoop() {
    while (!quitting()) {
      await nap(reraiseMs);
      if (quitting()) return;
      await reraisePass();
    }
  }
  /** Start: read until one read succeeds (the feed gives signal_id); a reply with no signal id is fatal. */
  async function start() {
    for (;;) {
      if (S.stopped) return;
      const r = S.cursor === null ? await firstRun() : await fetchRows();
      if (r.ok) { S.failStreak = 0; if (r.printed > 0 && cfg.mode === 'once') { stop('delivered'); return; } break; }
      await nap(Math.max(nextRetryMs(), r.wait || 0)); // R-P2: a failed read at start waits on the same ladder as any failed read (F2: or its Retry-After)
    }
    if (S.stopped) return;
    if (!S.lastSid) throw new Fatal(`the notices reply has no signal id (the inbox signal is not set up for this agent): the listener stops; fix that and start it again`);
    subscribe(S.lastSid, true);
  }
  async function run() {
    let code = 0;
    try {
      const file = readCursorFile(cfg.cursorFile);
      if (Object.keys(file).some((k) => k !== INBOX_CURSOR_KEY)) throw new Fatal('the cursor file holds per-item cursors: an --inbox listener needs its OWN cursor file');
      S.cursor = Object.prototype.hasOwnProperty.call(file, INBOX_CURSOR_KEY) ? file[INBOX_CURSOR_KEY] : null;
      S.loaded = true;
      if (!(await signInNow())) return 1;
      await start();
      if (cfg.mode === 'stream' && !S.stopped) reraiseLoop(); // RE-RAISE: not awaited; it ends when the run stops
      await finished;
    } catch (e) {
      code = 1;
      const why = e instanceof Fatal ? e.message : `unexpected failure (${word(e && e.name)} ${word(e && e.code)})`;
      io.err(scrub(`agent-listen: ${why}`));
    } finally {
      ac.abort(); // ends the re-raise loop (and any read it has open) on every way out
      if (S.sub) { S.sub.live = false; try { if (S.sub.unsub) S.sub.unsub(); } catch (_) { /* closed */ } }
      if (S.loaded && S.cursor !== null) { try { writeCursorAtomic(cfg.cursorFile, { [INBOX_CURSOR_KEY]: S.cursor }); } catch (_) { /* reported above when it was the cause */ } } // the cursor is saved on every way out
      await closeWithLimit(deps); // E1 (b3d7b994): inbox mode closes the SDK too, with the same hard limit (it never did before, so an open SDK handle held the process)
    }
    return code;
  }
  return { run, stop };
}

/** : ends the process with the run's code once the run is over. Stdout and stderr are flushed first, so every printed line reaches the pipe; then process.exit, so a handle the SDK left open can never keep a finished listener alive (the 26 Oct notice sat 4+ minutes). */
function exitWhenDone(run, proc = process) {
  return Promise.resolve(run)
    .then((code) => code, (e) => { proc.stderr.write(`agent-listen: unexpected failure (${word(e && e.name)})\n`); return 1; })
    .then((code) => new Promise((resolve) => { proc.stdout.write('', () => proc.stderr.write('', () => resolve(code))); }))
    .then((code) => { proc.exitCode = code; proc.exit(code); });
}
function installSignalHandlers(proc, listener) {
  const hs = {};
  for (const sig of ['SIGTERM', 'SIGINT']) { hs[sig] = () => listener.stop(sig); proc.on(sig, hs[sig]); }
  return () => { for (const sig of Object.keys(hs)) proc.removeListener(sig, hs[sig]); };
}
async function main(argv, deps) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) { deps.io.err(`agent-listen: ${parsed.error}`); deps.io.err(USAGE); return 2; }
  let conf;
  try { conf = loadConfig({ argv }); } catch (e) { deps.io.err(`agent-listen: ${e.message}`); return 2; }
  const mode = keyMode(conf, { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy }); // K-A3 item 1: no key_file means network-secret mode, which needs the proxy
  if (mode.mode === 'refused') { deps.io.err(`agent-listen: ${mode.message}`); return 2; }
  deps.transport = conf.transport; // realDeps' sign-in and listen read it
  const tRefusal = transportRefusal(conf.transport, { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY }); // refused before any key read or call
  if (tRefusal) { deps.io.err(tRefusal); return 2; }
  const cfg = parsed.cfg;
  const kind = cursorKindOf(cfg.cursorFile); // before any key read or call: a cursor file of the other kind is refused (exit 2), never overwritten
  if (cfg.inbox ? (kind === 'items' || kind === 'mixed') : (kind === 'inbox' || kind === 'mixed')) {
    deps.io.err(`agent-listen: ${cfg.inbox ? 'this cursor file holds per-item cursors (a document, board or map listener\'s file)' : 'this cursor file is an inbox cursor ({ "inbox_seq": ... }) or mixes both kinds'}: each listener needs its OWN --cursor-file`);
    return 2;
  }
  if (deps.sdkMissing) { const why = deps.sdkMissing(); if (why) { deps.io.err(why); return 2; } } // D1: refused before any key read or call
  let key;
  if (mode.mode === 'secret') key = NETWORK_SECRET_VALUE; // the placeholder; no key file is read in this mode
  else { try { key = deps.readKey(conf.keyFile); } catch (_) { key = null; } }
  if (typeof key !== 'string' || !key) { deps.io.err('agent-listen: cannot read the key file named in the settings file'); return 1; }
  let webKey = null;
  try { webKey = deps.loadWebKey(conf.appId) || null; } catch (_) { webKey = null; } // B10: the inbox listener signs in with the SDK too (the same as item mode)
  const listener = (cfg.inbox ? createInboxListener : createListener)({ ...cfg, email: conf.email, key, webKey }, deps);
  const off = installSignalHandlers(deps.proc, listener);
  try { return await listener.run(); } finally { off(); }
}
// ==== IMPLEMENTATION-END

// ============================================================================ SELFTEST (fake servers, fake clock, fake secrets; nothing here touches production)
const T0 = Date.UTC(2026, 9, 4, 6, 0, 0); // 2026-10-04T06:00:00Z, 11:30 IST: the fake clock starts here
const TEST_IDENTITIES = {
  alpha: { name: 'Alpha agent', email: 'spm-alpha-agent@agents.invalid' },
  beta: { name: 'Beta agent', email: 'spm-beta-agent@agents.invalid' },
  gamma: { name: 'Gamma agent', email: 'spm-gamma-agent@agents.invalid' },
  delta: { name: 'Delta agent', email: 'spm-delta-agent@agents.invalid' },
  epsilon: { name: 'Epsilon agent', email: 'spm-epsilon-agent@agents.invalid' },
  zeta: { name: 'Zeta agent', email: 'spm-zeta-agent@agents.invalid' },
};
// Each synthetic identity gets a settings file and a key file of its own in a temp folder (the selftest never reads a real key).
const cfgFiles = {};
function cfgFile(label) {
  if (!cfgFiles[label]) {
    const id = TEST_IDENTITIES[label];
    const dir = path.join(os.tmpdir(), 'agent-listen-selftest-config');
    fs.mkdirSync(dir, { recursive: true });
    const key = path.join(dir, `${label}.key`); fs.writeFileSync(key, FAKE.key + '\n');
    const file = path.join(dir, `${label}.json`);
    fs.writeFileSync(file, JSON.stringify({ agent: { name: id.name, email: id.email }, key_file: key }));
    cfgFiles[label] = file;
  }
  return cfgFiles[label];
}
const BACKEND_EMAIL = TEST_IDENTITIES.alpha.email;
const UI_EMAIL = TEST_IDENTITIES.beta.email;
const FAKE = {
  key: 'spm_k_test_fakekey0123456789abcdef0123',
  webKey: 'example-web-app-id-0000000000000000',
  refresh: 'AMf-vBFAKEREFRESHTOKEN0123456789abcdef',
  uid: 'fakeuid000000000000000001',
  humanEmail: 'person@example.com',
};
// an upper-case uuid for the case rule: the last digit becomes a letter (the synthetic ids are digits only)
const upperCase = (u) => u.replace(/[0-9]$/, (d) => 'ABCDEFGHIJ'[Number(d)]);
const DOC_A = '00000000-0000-4000-8000-000000000001';
const DOC_B = '00000000-0000-4000-8000-000000000002';
const BOARD_A = '00000000-0000-4000-8000-000000000003';
const BOARD_B = '00000000-0000-4000-8000-000000000004';
const MAP_A = '00000000-0000-4000-8000-000000000005';
const MAP_B = '00000000-0000-4000-8000-000000000006';
const TASK_A = '00000000-0000-4000-8000-000000000007';
const NODE_A = '00000000-0000-4000-8000-000000000008';
const bkey = (id) => `board:${id}`; // the cursor key of a board
const mkey = (id) => `map:${id}`; // the cursor key of a map
// The notice feed reply shapes come from agent-listen-inbox-feed.fixture.json (synthetic values). The mock builds every row from a row of that file and checks its key order.
let INBOX_FX = null;
const inboxFixture = () => (INBOX_FX || (INBOX_FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-listen-inbox-feed.fixture.json'), 'utf8'))));
const keysOf = (o) => Object.keys(o).join(',');
function inboxShapeProblem(body) {
  // : the reply carries the caller's own signal_id (also on a reset reply); it is checked here and then left out of the key comparison
  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'signal_id')) {
    if (typeof body.signal_id !== 'string' || !/^[0-9a-f]{64}$/.test(body.signal_id)) return 'signal_id is not a 64-character hex id';
    const { signal_id: _sid, ...rest } = body; body = rest;
  }
  const fx = inboxFixture();
  const real = fx.document.feed; const tpl = real.notifications[0];
  const want = body && body.reset === true ? `${keysOf(real)},reset` : keysOf(real);
  if (!body || typeof body !== 'object' || keysOf(body) !== want) return `reply keys ${body && typeof body === 'object' ? keysOf(body) : typeof body}, the real route: ${want}`;
  for (const r of body.notifications) {
    if (keysOf(r) !== keysOf(tpl)) return `row keys ${keysOf(r)}, the real route: ${keysOf(tpl)}`;
    for (const k of ['actor', 'item', 'object']) if (keysOf(r[k]) !== keysOf(tpl[k])) return `row.${k} keys ${keysOf(r[k])}, the real route: ${keysOf(tpl[k])}`;
    if (r.target !== null && keysOf(r.target) !== 'type,id') return `row.target keys ${keysOf(r.target)}`;
  }
  return null;
}
const HUMAN = { email: FAKE.humanEmail, kind: 'human', name: 'Person Fake' };
const OWN = { email: BACKEND_EMAIL, kind: 'agent', name: 'Alpha agent' };
const OTHER = { email: UI_EMAIL, kind: 'agent', name: 'Beta agent' };
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const fakeJwt = (pl) => `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u(pl)}.${b64u('FAKESIGNATURE-not-a-real-signature')}`;
const sidFor = (doc) => crypto.createHash('sha256').update('fake-signal-secret|' + doc).digest('hex');
const INBOX_SID = sidFor('fake-inbox-signal'); // B10: the caller's own inbox signal (the feed reply carries it; the marker is published on it)
const ISO_IST_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/;
const BOARD_KEYS = ['t', 'item_type', 'item_id', 'seq', 'kind', 'comment_id', 'author_kind', 'author_name', 'excerpt', 'via', 'parent_id', 'thread_root_id', 'task_id', 'body']; // body_truncated follows body only when cut
const MAP_KEYS = ['t', 'item_type', 'item_id', 'seq', 'kind', 'comment_id', 'author_kind', 'author_name', 'excerpt', 'via', 'parent_id', 'thread_root_id', 'body'];
const EVENT_KEYS = ['t', 'document_id', 'seq', 'kind', 'comment_id', 'author_kind', 'author_name', 'excerpt', 'via', 'parent_id', 'thread_root_id', 'body']; // body_truncated follows body only when the body was cut

function newWorld() {
  const W = {
    clock: { t: T0 }, docs: new Map(), markers: new Map(), over: {}, count: { token: 0, exchange: 0, marker: 0, events: 0 }, log: [], sched: [], mints: [], idTokens: new Map(),
    issued: [], expired401: 0, noSignalId: false, pageSize: 100, hostsSeen: new Set(), outLog: [], watchdog: false, stalled: [], salt: '', violations: [],
  };
  W.rel = () => W.clock.t - T0;
  // the fake of the Firebase SDK's onSnapshot: one subscription per signal id. A marker write (W.addEvent) or a hook below delivers a snapshot shaped like a DocumentSnapshot.
  W.subs = new Set(); W.cacheOnly = false; W.listens = [];
  W.snapOf = (sid) => { const d = W.markers.get(sid); return { metadata: { fromCache: W.cacheOnly, hasPendingWrites: false }, exists: () => !!d, data: () => (d ? { seq: d.seq, at: d.at } : undefined) }; };
  W.notify = (sid) => { for (const s of [...W.subs]) if (s.live && (sid === undefined || s.sid === sid)) s.onNext(W.snapOf(s.sid)); };
  W.failSignal = (code) => { for (const s of [...W.subs]) { if (!s.live) continue; s.live = false; W.subs.delete(s); s.onError({ code }); } }; // the SDK ends a listener after its error callback
  W.goOffline = () => { W.cacheOnly = true; W.notify(); };
  W.comeBack = () => { W.cacheOnly = false; W.notify(); };
  W.inbox = { rows: [], hidden: new Set(), plant: null, hook: null }; W.inboxCalls = []; W.inboxWrites = []; W.count.inbox = 0;
  // one notice row of the agent's feed, built from a REAL row of the fixture (kind: document | board | map)
  W.addNotice = (kind, o = {}) => {
    const tpl = inboxFixture()[kind].feed.notifications[0];
    const row = JSON.parse(JSON.stringify(tpl));
    const seq = W.inbox.rows.length ? W.inbox.rows[W.inbox.rows.length - 1].seq + 1 : 1;
    const commentId = o.commentId || crypto.randomUUID();
    row.id = crypto.randomUUID(); row.seq = seq; row.verb = o.verb || tpl.verb; row.reason = o.reason || tpl.reason; row.lane = o.lane || tpl.lane; row.created_at = new Date(W.clock.t).toISOString();
    row.actor = { kind: o.actorKind || 'human', name: o.actorName || tpl.actor.name };
    row.item = { type: kind, id: o.itemId || tpl.item.id };
    row.object = { type: 'comment', id: commentId };
    row.thread_id = o.threadId || commentId;
    row.item_seq = o.itemSeq || seq;
    row.target = kind === 'document' ? null : { type: tpl.target.type, id: o.targetId || tpl.target.id };
    W.inbox.rows.push(row);
    if (!W.inbox.silent) { W.markers.set(INBOX_SID, { seq, at: new Date(W.clock.t).toISOString() }); W.notify(INBOX_SID); }
    return row;
  };
  W.addDoc = (id, n = 0) => {
    const d = { id, key: id, type: 'document', events: [], comments: new Map(), nextSeq: 1 };
    W.docs.set(id, d);
    for (let i = 0; i < n; i++) W.addEvent(id, { actor: HUMAN, body: `history ${i + 1}`, publish: i === n - 1 });
    return d;
  };
  // a board (target = its task) or a map (target = its box): kept in the same table under the cursor key (board:<id>, map:<id>), so W.addEvent(key, ...) serves all three kinds
  W.addItem = (type, id, n = 0, o = {}) => {
    const key = `${type}:${id}`;
    const d = { id, key, type, target: o.target || (type === 'board' ? TASK_A : NODE_A), events: [], comments: new Map(), nextSeq: 1 };
    W.docs.set(key, d);
    for (let i = 0; i < n; i++) W.addEvent(key, { actor: HUMAN, body: `history ${i + 1}`, publish: i === n - 1 });
    return d;
  };
  W.addEvent = (docId, o = {}) => {
    const d = W.docs.get(docId);
    const seq = d.nextSeq++;
    const verb = o.verb || 'comment.created';
    const actor = o.actor || HUMAN;
    const cid = o.commentId || crypto.randomUUID();
    if (verb === 'comment.deleted') d.comments.delete(cid);
    else if (!d.comments.has(cid)) d.comments.set(cid, { id: cid, body: o.body === undefined ? 'x' : o.body, resolved_at: null, parent_id: o.parent || null, author_email: actor.email, author_kind: actor.kind, author_display_name: actor.name || null, reactions: {}, ...(d.type === 'document' ? {} : { target: o.target || d.target, created_at: new Date(W.clock.t).toISOString() }) });
    d.events.push({ seq, verb, at: new Date(W.clock.t).toISOString(), actor_email: actor.email, actor_type: actor.kind, object_id: cid, parent_object_id: o.parent || null, details: {} });
    if (o.publish !== false) { const sid = sidFor(docId + W.salt); W.markers.set(sid, { seq: o.markerSeq === undefined ? seq : o.markerSeq, at: new Date(W.clock.t).toISOString() }); W.notify(sid); }
    return seq;
  };
  // one fake timer queue: test events (W.at) and the listener's sleeps share it; the pump in runCase moves the clock
  W.schedAbs = (at, fn) => { const e = { at, fn }; let i = W.sched.length; while (i > 0 && W.sched[i - 1].at > at) i--; W.sched.splice(i, 0, e); return e; };
  W.at = (ms, fn) => { W.schedAbs(T0 + ms, fn); };
  W.stepTo = (target) => {
    for (;;) {
      const s = W.sched[0];
      if (!s || s.at > target) break;
      W.sched.shift();
      if (s.at > W.clock.t) W.clock.t = s.at;
      s.fn(W);
    }
    if (target > W.clock.t) W.clock.t = target;
  };
  W.advance = (ms) => W.stepTo(W.clock.t + ms);
  // a wake from sleep: the clock moves on at once; the timers it skipped fire late, one by one, at the new time (no event fires in between)
  W.jumpClock = (ms) => { W.clock.t += ms; };
  return W;
}

function makeFakeServers() {
  let W = null;
  const send = (res, status, body, headers) => {
    const h = { ...(headers || {}) };
    let text = '';
    if (body !== undefined && body !== '') {
      if (typeof body === 'string') text = body;
      else { text = JSON.stringify(body); h['content-type'] = 'application/json'; }
    }
    res.writeHead(status, h);
    res.end(text);
  };
  const over = (route, n, res) => {
    const o = W.over[route];
    const spec = typeof o === 'function' ? o(n) : (o || null);
    if (!spec) return false;
    if (spec.stall) { W.stalled.push(res); return true; }
    if (spec.destroy) { res.socket.destroy(); return true; }
    send(res, spec.status, spec.body === undefined ? {} : spec.body, spec.headers);
    return true;
  };
  const who = (req, res) => {
    const h = req.headers;
    if (!h['x-spm-api-key']) { send(res, 401, { code: 'missing_credential' }); return null; }
    if (h['x-spm-api-key'] !== FAKE.key) { send(res, 401, { code: 'invalid_credential' }); return null; }
    const em = String(h['x-spm-user-email'] || '').toLowerCase();
    if (!em) { send(res, 400, { code: 'user_email_required' }); return null; }
    if (!Object.values(TEST_IDENTITIES).map((x) => x.email).includes(em)) { send(res, 403, { code: 'api_key_owner_mismatch' }); return null; }
    return em;
  };
  const wire = (c, caller) => (c ? { ...c, author_email: c.author_email, author_is_you: c.author_email === caller } : null);
  // ---- the board and map comment-events routes (GET /boardsApi/boards/<id>/comment-events?since=<n>, GET /mapsApi/maps/<id>/comment-events?since=<n>): bodies in the REAL wire, checked against the frozen real shapes
  const sendShaped = (res, name, status, body) => send(res, status, body);; // shapeHook: a case makes the fake return a WRONG shape to prove the check fails
  const errBody = (code, message) => ({ error: code, code, message });
  const itemWire = (d, c, caller) => {
    if (!c) return null;
    const tail = { author_kind: c.author_kind, author_is_you: c.author_email === caller, parent_id: c.parent_id, resolved_at: null, resolved_by_email: null, reactions: {}, mentions: [], can_resolve: false, can_delete: c.author_email === caller };
    if (d.type === 'board') return { id: c.id, task_id: c.target, author_email: c.author_email, body: c.body, created_at: c.created_at, updated_at: null, author_display_name: c.author_display_name, ...tail };
    return { id: c.id, map_id: d.id, node_id: c.target, author_email: c.author_email, author_display_name: c.author_display_name, body: c.body, created_at: c.created_at, updated_at: null, ...tail };
  };
  function itemEvents(req, res, p) {
    const n = ++W.count.events;
    if (over('events', n, res)) return;
    const fnName = /^\/(boardsApi|mapsApi)\//.exec(p)[1];
    const type = fnName === 'boardsApi' ? 'board' : 'map';
    const hk = req.headers['x-spm-api-key'];
    if (!hk || hk !== FAKE.key) return sendShaped(res, 'board.events.bad-key', 401, errBody('unauthenticated', 'invalid or revoked API key'));
    const em = String(req.headers['x-spm-user-email'] || '').toLowerCase();
    if (!Object.values(TEST_IDENTITIES).map((x) => x.email).includes(em)) return sendShaped(res, 'board.events.owner-mismatch', 403, errBody('api_key_owner_mismatch', 'this API key can only act as its owner'));
    const m = new RegExp(`^/${fnName}/${type === 'board' ? 'boards' : 'maps'}/([^/]+)/comment-events$`).exec(p);
    if (!m || req.method !== 'GET') return sendShaped(res, 'board.events.unknown-route', 404, errBody('unknown_route', `${req.method} ${p} is not a route`));
    const id = m[1].toLowerCase();
    const d = UUID_RE.test(id) ? W.docs.get(`${type}:${id}`) : null;
    if (!d) return sendShaped(res, `${type}.events.not-found`, 404, errBody('not_found', 'not found'));
    const sinceRaw = new URL(req.url, 'http://x').searchParams.get('since');
    if (sinceRaw === null || !/^\d{1,16}$/.test(sinceRaw)) return sendShaped(res, `${type}.events.bad-since`, 400, errBody('invalid_since', 'since must be an integer >= 0: the seq of the last event you have seen'));
    const since = Number(sinceRaw);
    const latest = d.events.length ? d.events[d.events.length - 1].seq : 0;
    const sg = W.noSignalId ? {} : { signal_id: sidFor(d.key + W.salt) };
    if (since > latest || latest - since > 100) return sendShaped(res, `${type}.events.reset`, 200, { reset: true, latest, ...sg });
    if (since === latest) return sendShaped(res, `${type}.events.fast`, 200, { events: [], latest, has_more: false, ...sg });
    const rest = d.events.filter((e) => e.seq > since);
    const page = rest.slice(0, W.pageSize).map((e) => ({ ...e, comment: itemWire(d, d.comments.get(e.object_id), em) }));
    const name = page.some((e) => e.comment === null) ? `${type}.events.page.with-delete` : `${type}.events.page`;
    return sendShaped(res, name, 200, { events: page, latest: Math.max(latest, page[page.length - 1].seq), has_more: rest.length > page.length, ...sg });
  }
  // ---- the agent's own notice feed: GET /accountApi/notifications?since=&limit=&state= (the real route). Replies are built in the real shapes and held to them (inboxShapeProblem); a POST or any
  // other path under it is recorded in W.inboxWrites (the listener must never send one).
  function inboxRoute(req, res, p) {
    const n = ++W.count.inbox;
    const u = new URL(req.url, 'http://x');
    W.inboxCalls.push({ m: req.method, p, q: u.search, hdr: Object.keys(req.headers).sort(), t: W.rel(), cur: W.cursorFile && fs.existsSync(W.cursorFile) ? fs.readFileSync(W.cursorFile, 'utf8') : null }); // cur: the cursor file as it was when this read arrived
    if (over('inbox', n, res)) return;
    const fx = inboxFixture();
    if (req.method !== 'GET' || p !== '/accountApi/notifications') { W.inboxWrites.push(`${req.method} ${p}`); return send(res, 404, { error: 'unknown_route', code: 'unknown_route', message: `${req.method} ${p} is not a route` }); }
    const hk = req.headers['x-spm-api-key'];
    if (!hk) return send(res, fx.refusals.no_key.status, fx.refusals.no_key.body);
    if (hk !== FAKE.key) return send(res, fx.refusals.wrong_key.status, fx.refusals.wrong_key.body);
    const typed = req.headers['x-spm-user-email'];
    if (typed !== undefined && !Object.values(TEST_IDENTITIES).map((x) => x.email).includes(String(typed).trim().toLowerCase())) return send(res, fx.refusals.address_mismatch.status, fx.refusals.address_mismatch.body);
    const sinceRaw = u.searchParams.get('since'); const limitRaw = u.searchParams.get('limit'); const stateRaw = u.searchParams.get('state');
    if (sinceRaw === null || sinceRaw === '') return send(res, 400, { error: 'since_required', code: 'since_required', message: 'since is required' });
    if (!/^\d{1,16}$/.test(sinceRaw)) return send(res, 400, { error: 'invalid_since', code: 'invalid_since', message: 'since must be an integer >= 0' });
    const limit = limitRaw === null || limitRaw === '' ? 50 : (/^\d{1,6}$/.test(limitRaw) ? Number(limitRaw) : NaN);
    if (!(limit >= 1 && limit <= 100)) return send(res, 400, { error: 'invalid_limit', code: 'invalid_limit', message: 'limit must be an integer from 1 to 100' });
    if (stateRaw !== null && !['all', 'unread', 'unresolved'].includes(stateRaw)) return send(res, 400, { error: 'invalid_state', code: 'invalid_state', message: 'state must be one of all, unread, unresolved' });
    const since = Number(sinceRaw);
    const rows = W.inbox.rows;
    const latest = rows.length ? rows[rows.length - 1].seq : 0;
    let body;
    if (since > latest) body = { notifications: [], cursor: latest, latest, has_more: false, reset: true };
    else if (since === latest) body = { notifications: [], cursor: latest, latest, has_more: false };
    else {
      const pool = stateRaw === 'unresolved' ? rows.filter((r) => r.resolved_at === null || r.resolved_at === undefined) : rows; // the real route: state=unresolved leaves out resolved notices
      const rest = pool.filter((r) => r.seq > since);
      const page = rest.slice(0, limit);
      body = { notifications: page.filter((r) => !W.inbox.hidden.has(r.seq)), cursor: page[page.length - 1].seq, latest, has_more: rest.length > page.length }; // a hidden row (access lost) is left out, the cursor still passes it
    }
    if (!W.inbox.noSignalId) body = { ...body, signal_id: INBOX_SID };
    if (W.inbox.hook) body = W.inbox.hook(body);
    const problem = inboxShapeProblem(body);
    if (problem) W.violations.push(`inbox.feed: ${problem}`);
    const shown = W.inbox.plant ? { ...body, notifications: body.notifications.map((r) => ({ ...r, ...W.inbox.plant })) } : body; // planted extras are added AFTER the shape check
    return send(res, 200, shown);
  }
  function fnHandler(req, res, raw) {
    const p = new URL(req.url, 'http://x').pathname;
    const body = raw ? parseJson(raw) : undefined;
    W.log.push({ h: 'fn', m: req.method, p, q: new URL(req.url, 'http://x').search, t: W.rel(), hdr: Object.keys(req.headers).sort(), body });
    if (p === '/getRealtimeToken') {
      const n = ++W.count.token;
      if (over('token', n, res)) return;
      if (req.method !== 'POST') return send(res, 405, { code: 'method_not_allowed' }, { allow: 'POST' });
      const em = who(req, res);
      if (!em) return;
      if (!/^application\/json/.test(req.headers['content-type'] || '') || !body || Object.keys(body).length !== 0) return send(res, 400, { code: 'unexpected_field' });
      W.mints.push({ t: W.rel(), email: em });
      const iat = Math.floor(W.clock.t / 1000);
      const token = fakeJwt({ iss: 'fake-sa', sub: 'fake-sa', aud: 'https://identitytoolkit.googleapis.com/x', iat, exp: iat + 3600, uid: FAKE.uid, claims: { spm: true, kind: 'agent' } });
      W.issued.push(token);
      return send(res, 200, { token, expires_in: 3600 }, { 'cache-control': 'no-store' });
    }
    if (p === '/documentsApi/listDocumentCommentEvents') {
      const n = ++W.count.events;
      if (over('events', n, res)) return;
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      const em = who(req, res);
      if (!em) return;
      if (!body || JSON.stringify(Object.keys(body).sort()) !== '["documentId","since"]') return send(res, 400, { code: 'unexpected_field' });
      const d = W.docs.get(String(body.documentId).toLowerCase());
      if (!d) return send(res, 404, { error: 'document not found' });
      if (!Number.isSafeInteger(body.since) || body.since < 0) return send(res, 400, { error: 'since must be an integer >= 0' });
      const latest = d.events.length ? d.events[d.events.length - 1].seq : 0;
      const sg = W.noSignalId ? {} : { signal_id: sidFor(d.id + W.salt) };
      if (body.since > latest || latest - body.since > 100) return send(res, 200, { reset: true, latest, ...sg });
      if (body.since === latest) return send(res, 200, { events: [], latest, has_more: false, ...sg });
      const rest = d.events.filter((e) => e.seq > body.since);
      const page = rest.slice(0, W.pageSize).map((e) => ({ ...e, comment: wire(d.comments.get(e.object_id), em) }));
      return send(res, 200, { events: page, latest: Math.max(latest, page[page.length - 1].seq), has_more: rest.length > page.length, ...sg });
    }
    if (/^\/(boardsApi|mapsApi)\//.test(p)) return itemEvents(req, res, p);
    if (p === '/accountApi/notifications' || p.startsWith('/accountApi/notifications/')) return inboxRoute(req, res, p);
    return send(res, 404, { error: 'unknown route in the fake' });
  }
  function idtHandler(req, res, raw) {
    const u = new URL(req.url, 'http://x');
    W.log.push({ h: 'idt', m: req.method, p: u.pathname, t: W.rel(), hdr: Object.keys(req.headers).sort(), key: u.searchParams.get('key') });
    const n = ++W.count.exchange;
    if (over('exchange', n, res)) return;
    if (req.method !== 'POST' || u.pathname !== '/v1/accounts:signInWithCustomToken') return send(res, 404, { error: { code: 404 } });
    if (u.searchParams.get('key') !== FAKE.webKey) return send(res, 400, { error: { code: 400, message: 'API key not valid.' } });
    if (req.headers.referer !== REFERER) return send(res, 403, { error: { code: 403, message: 'Requests from this referer are blocked.' } });
    const body = parseJson(raw);
    if (!body || JSON.stringify(Object.keys(body).sort()) !== '["returnSecureToken","token"]') return send(res, 400, { error: { code: 400, message: 'Invalid JSON payload' } });
    const parts = String(body.token).split('.');
    const pl = parts.length === 3 ? parseJson(Buffer.from(parts[1], 'base64url').toString('utf8')) : null;
    if (!pl || typeof pl.uid !== 'string' || !W.issued.includes(body.token)) return send(res, 400, { error: { code: 400, message: 'INVALID_CUSTOM_TOKEN' } });
    const iat = Math.floor(W.clock.t / 1000);
    const idToken = fakeJwt({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, auth_time: iat, user_id: pl.uid, sub: pl.uid, iat, exp: iat + 3600, firebase: { identities: {}, sign_in_provider: 'custom' }, spm: true, kind: 'agent' });
    W.idTokens.set(idToken, iat + 3600);
    return send(res, 200, { idToken, refreshToken: FAKE.refresh, expiresIn: '3600', localId: pl.uid });
  }
  function fsHandler(req, res) {
    const u = new URL(req.url, 'http://x');
    W.log.push({ h: 'fs', m: req.method, p: u.pathname, t: W.rel(), hdr: Object.keys(req.headers).sort(), q: u.search });
    const n = ++W.count.marker;
    if (over('marker', n, res)) return;
    const m = u.pathname.startsWith(`${FS_ROOT}/signals/`) && req.method === 'GET' ? u.pathname.slice(`${FS_ROOT}/signals/`.length) : null;
    if (!m) return send(res, 404, { error: { code: 404 } });
    const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const exp = W.idTokens.get(tok);
    if (exp === undefined) return send(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
    if (Math.floor(W.clock.t / 1000) >= exp) { W.expired401++; return send(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'token expired' } }); }
    const d = W.markers.get(m);
    if (!d) return send(res, 404, { error: { code: 404, message: 'Document not found', status: 'NOT_FOUND' } });
    return send(res, 200, { name: `projects/${PROJECT}/databases/(default)/documents/signals/${m}`, fields: { seq: { integerValue: String(d.seq) }, at: { timestampValue: d.at } }, createTime: d.at, updateTime: d.at });
  }
  const mk = (handler) => http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { handler(req, res, Buffer.concat(chunks).toString('utf8')); } catch (_) { try { res.writeHead(500); res.end('{}'); } catch (__) { /* gone */ } } });
  });
  const servers = [[FN_HOST, mk(fnHandler)], [IDT_HOST, mk(idtHandler)], [FS_HOST, mk(fsHandler)]];
  const ports = {};
  return {
    ports,
    use: (w) => { W = w; },
    async start() { for (const [host, srv] of servers) { await new Promise((r) => srv.listen(0, '127.0.0.1', r)); ports[host] = srv.address().port; } },
    releaseStalled() { if (W) for (const r of W.stalled) { try { r.socket.destroy(); } catch (_) { /* gone */ } } },
    async stop() { for (const [, srv] of servers) { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); } },
  };
}

let RUN_DIR = null;
async function runCase(env, o = {}) {
  const W = newWorld();
  env.use(W);
  if (o.world) o.world(W);
  for (const [ms, fn] of (o.at || [])) W.at(ms, fn);
  const dir = path.join(RUN_DIR, o.id || 'case');
  fs.mkdirSync(dir, { recursive: true });
  const cursorFile = path.join(dir, 'cursor.json');
  W.cursorFile = cursorFile;
  if (o.rawCursor !== undefined) fs.writeFileSync(cursorFile, o.rawCursor);
  else if (o.cursor) fs.writeFileSync(cursorFile, JSON.stringify(o.cursor) + '\n');
  const identity = o.identity || 'alpha';
  const cfg = {
    identity, email: TEST_IDENTITIES[identity].email, key: o.key || FAKE.key, webKey: o.webKey === undefined ? FAKE.webKey : o.webKey, documents: o.inbox ? [] : (o.docs || (o.boards || o.maps ? [] : [DOC_A])), boards: o.boards || [], maps: o.maps || [], cursorFile, inbox: !!o.inbox,
    mode: o.mode || 'once', pollMs: o.pollMs || 1500, fallbackS: o.fallbackS || 30, selfSkip: o.selfSkip !== false, safetyS: o.safetyS === undefined ? DEFAULTS.safetyS : o.safetyS,
  };
  const outs = []; const errs = [];
  let inflight = 0; // real requests in flight: the pump never moves the fake clock while one is open
  const baseHttp = makeTransport({ lib: http, resolveTarget: (u) => { W.hostsSeen.add(u.hostname); const port = env.ports[u.hostname]; if (!port) throw new Error('unmapped host'); return { hostname: '127.0.0.1', port }; } });
  const transport = (...args) => { inflight++; return baseHttp(...args).finally(() => { inflight--; }); };
  let listener = null;
  const deps = {
    io: { out: (s) => { outs.push(s); W.outLog.push({ t: W.clock.t, s }); if (o.onOut) o.onOut(s, fs.existsSync(cursorFile) ? fs.readFileSync(cursorFile, 'utf8') : null); }, err: (s) => errs.push(s) },
    now: () => W.clock.t,
    http: transport,
    requestTimeoutMs: o.reqTimeoutMs || 3000,
    // a timer on the fake clock: it resolves when the pump reaches it, never in real time
    sleep: (ms, signal) => new Promise((resolve) => {
      (W.sleeps = W.sleeps || []).push({ ms, signal, rel: W.rel() }); // the test reads each wait and its abort signal
      if (signal && signal.aborted) return resolve();
      const e = W.schedAbs(W.clock.t + ms, () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); });
      function onAbort() { const i = W.sched.indexOf(e); if (i >= 0) W.sched.splice(i, 1); resolve(); }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    }),
    // the Firebase SDK's sign-in, as a fake: the same exchange (custom token, web key, Referer) through the fake identity server
    signIn: async (customToken, webKey) => {
      const r = await transport(`https://${IDT_HOST}/v1/accounts:signInWithCustomToken?key=${webKey}`, 'POST', { Referer: REFERER }, { token: customToken, returnSecureToken: true }, { timeoutMs: 3000 });
      if (r.status !== 200) throw Object.assign(new Error('sign-in refused'), { code: `auth/${r.status}` });
      return { idToken: parseJson(r.text).idToken };
    },
    // the SDK's onSnapshot on signals/<sid>: next and error callbacks; the first snapshot comes at once; no timer
    listen: (sid, onNext, onError) => {
      const sub = { sid, onNext, onError, live: true };
      W.listens.push({ sid, t: W.rel() });
      const spec = W.over.listen ? W.over.listen(W.listens.length) : null; // a listen that fails before any snapshot (the SDK ends it at once)
      if (spec && spec.error) { queueMicrotask(() => onError({ code: spec.error })); return () => {}; }
      W.subs.add(sub);
      queueMicrotask(() => { if (sub.live) onNext(W.snapOf(sid)); }); // the SDK's first snapshot comes before any timer moves the clock
      return () => { sub.live = false; W.subs.delete(sub); };
    },
    // the wall-clock check: a repeating event on the fake queue (it makes no request)
    interval: (fn, ms) => {
      let e = null;
      const loop = () => { fn(); e = W.schedAbs(W.clock.t + ms, loop); };
      e = W.schedAbs(W.clock.t + ms, loop);
      return () => { const i = W.sched.indexOf(e); if (i >= 0) W.sched.splice(i, 1); };
    },
    close: o.closeHang ? () => { W.closed = (W.closed || 0) + 1; return new Promise(() => {}); } : async () => { W.closed = (W.closed || 0) + 1; W.closedCursor = fs.existsSync(cursorFile) ? fs.readFileSync(cursorFile, 'utf8') : null; }, // the SDK's terminate and deleteApp, counted; the cursor file as it stood when the SDK closed
  };
  listener = (o.inbox ? createInboxListener : createListener)(cfg, deps);
  if (o.stopAt !== undefined) W.at(o.stopAt, () => listener.stop('test'));
  const guard = setTimeout(() => { W.watchdog = true; listener.stop('realtime'); }, o.realMs || 25000);
  let finished = false;
  const running = listener.run().finally(() => { finished = true; });
  const maxMs = o.maxFakeMs || 600000;
  const fire = () => { if (!W.watchdog) { W.watchdog = true; listener.stop('watchdog'); } };
  // the pump: with no request in flight it moves the fake clock to the next timer or test event; with nothing left at all, the listener is idle for good and the watchdog ends it
  const pump = (async () => {
    let quiet = 0;
    while (!finished) {
      await new Promise((r) => setImmediate(r));
      if (finished) break;
      if (inflight > 0) { quiet = 0; continue; }
      if (W.sched.length) { quiet = 0; W.stepTo(W.sched[0].at); if (W.clock.t - T0 > maxMs) fire(); continue; }
      if (++quiet < 3) { await new Promise((r) => setTimeout(r, 2)); continue; }
      W.clock.t = T0 + maxMs + 1; fire();
    }
  })();
  let code;
  // (b3d7b994): a run that never ends fails the case in 10 s of real time (not a spin on the fake clock)
  try { code = await Promise.race([running, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('the listener did not end within 10 s of real time')), 10000); running.finally(() => clearTimeout(t)); })]); } finally { finished = true; clearTimeout(guard); env.releaseStalled(); await pump; }
  if (W.watchdog && !o.allowWatchdog) throw new Error('watchdog fired: the listener did not stop when it should have');
  if (W.violations.length) throw new Error(`the fake returned a shape the real route never returns: ${W.violations.slice(0, 2).join(' | ')}`);
  const text = fs.existsSync(cursorFile) ? fs.readFileSync(cursorFile, 'utf8') : null;
  return { code, outs, errs, lines: outs.map((s) => parseJson(s)), events: outs.map((s) => parseJson(s)).filter((l) => l && 'kind' in l), W, cursorFile, cursorText: text, cursor: text === null ? null : parseJson(text), dir, cfg };
}

function spawnNode(code, args) {
  const child = spawn(process.execPath, ['-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const r = { child, out: '', err: '', exited: null };
  child.stdout.on('data', (c) => { r.out += c; });
  child.stderr.on('data', (c) => { r.err += c; });
  r.done = new Promise((resolve) => child.on('exit', (code2, signal) => { r.exited = { code: code2, signal }; resolve(r.exited); }));
  return r;
}
const waitFor = async (fn, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 15)); } throw new Error(`timed out waiting for ${what}`); };
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fnCalls = (W, p) => W.log.filter((e) => e.h === 'fn' && e.p === p);

function defineCases(cases, env) {
  const tc = (id, name, fn) => cases.push({ id, name, fn });

  // ---- LS-1: the signal is a Firestore snapshot, never a poll
  tc('T1a', 'SNAPSHOT ONLY: after the start reads, 10 fake minutes idle make ZERO requests and ZERO Firestore GETs', async () => {
    const r = await runCase(env, { id: 'T1a', world: (W) => W.addDoc(DOC_A, 2), cursor: { [DOC_A]: 2 }, mode: 'stream', stopAt: 600000, maxFakeMs: 700000 });
    check(r.code === 0, `exit ${r.code}`);
    const late = r.W.log.filter((e) => e.t > 0);
    check(late.length === 0, `${late.length} requests after the start: ${late.slice(0, 4).map((e) => `${e.h} ${e.p} at ${e.t} ms`).join(', ')}`);
    check(r.W.count.marker === 0 && !r.W.hostsSeen.has(FS_HOST), `Firestore REST GETs: ${r.W.count.marker}`);
    check(r.W.count.events === 1 && r.W.count.token === 1 && r.W.count.exchange === 1, `start reads: events ${r.W.count.events}, mints ${r.W.count.token}, exchanges ${r.W.count.exchange}`);
  });

  tc('T1b', 'SNAPSHOT: a marker bump with a higher seq makes exactly ONE events read for that item at once; its line is printed and the cursor saved', async () => {
    const r = await runCase(env, { id: 'T1b', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 20000, at: [[5000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'one new' })]] });
    check(r.events.length === 1 && r.events[0].seq === 4 && r.events[0].via === 'marker', `lines ${r.outs.join(' | ')}`);
    check(r.cursor && r.cursor[DOC_A] === 4, `cursor ${r.cursorText}`);
    const reads = fnCalls(r.W, '/documentsApi/listDocumentCommentEvents');
    check(reads.length === 2, `events reads ${reads.map((e) => `${e.t}:${e.body.since}`).join(', ')}: expected the start baseline and exactly one read for the bump`);
    check(reads[1].t === 5000, `the bump read ran at ${reads[1].t} ms, expected 5000 ms (the snapshot, not a poll)`);
  });

  tc('T1c', 'SNAPSHOT: a stream error, then a recovered stream: exactly ONE catch-up read for that item after it comes back, and no timer reads while it is down', async () => {
    const r = await runCase(env, { id: 'T1c', world: (W) => W.addDoc(DOC_A, 2), cursor: { [DOC_A]: 2 }, mode: 'stream', stopAt: 60000,
      at: [[5000, (W) => W.failSignal('unavailable')], [5500, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'sent while the stream was down', publish: false })]] });
    check(r.code === 0, `exit ${r.code}`);
    const reads = fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').filter((e) => e.t > 5000);
    check(reads.length === 1, `events reads after the error: ${reads.length}, expected exactly one catch-up read: ${reads.map((e) => e.t).join(', ')} ms`);
    check(r.events.length === 1 && r.events[0].seq === 3 && r.events[0].via === 'safety', `the event sent while down is delivered once by the catch-up: ${r.outs.join(' | ')}`);
    check(r.W.count.marker === 0, `Firestore REST GETs: ${r.W.count.marker}`);
  });

  tc('T1d', 'SNAPSHOT: --poll-ms, --safety-s and --fallback-s are refused with exit 2 and a message naming the before any call or key read', async () => {
    const cf = path.join(RUN_DIR, 'T1d', 'cursor.json');
    const argvs = [['--config', cfgFile('alpha'), '--document', DOC_A, '--cursor-file', cf, '--poll-ms', '1500'],
      ['--config', cfgFile('alpha'), '--document', DOC_A, '--cursor-file', cf, '--safety-s', '60'], ['--config', cfgFile('alpha'), '--document', DOC_A, '--cursor-file', cf, '--fallback-s', '30']];
    for (const argv of argvs) {
      let calls = 0; const errs = [];
      const deps = { io: { out: () => { calls++; }, err: (s) => errs.push(s) }, proc: new (require('node:events'))(), readKey: () => { calls++; return FAKE.key; }, loadWebKey: () => { calls++; return FAKE.webKey; }, http: () => { calls++; throw new Error('network'); }, now: () => T0, sleep: async () => { calls++; if (calls > 60) throw new Error('runaway: the listener kept going instead of refusing'); }, requestTimeoutMs: 100 };
      const code = await main(argv, deps);
      check(code === 2 && calls === 0, `${argv.slice(2, 3).join(' ')}: exit ${code}, ${calls} calls`);
      check(errs.some((s) => /is refused/.test(s)), `${argv.join(' ')}: message ${JSON.stringify(errs.slice(0, 1))}`);
    }
  });

  tc('T1e', 'SNAPSHOT: while the connection is cache-only, a marker move makes NO events read and prints NO line; once the server answers, the move is read ONCE and printed (via "marker")', async () => {
    const r = await runCase(env, { id: 'T1e', world: (W) => W.addDoc(DOC_A, 2), cursor: { [DOC_A]: 2 }, mode: 'stream', stopAt: 30000, maxFakeMs: 40000,
      at: [[2000, (W) => W.goOffline()], [5000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'sent while cache only' })], [20000, (W) => W.comeBack()]] });
    check(r.code === 0, `exit ${r.code}`);
    const offline = fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').filter((e) => e.t >= 2000 && e.t < 20000);
    check(offline.length === 0, `events reads while cache-only: ${offline.map((e) => e.t).join(', ')} ms: expected none`);
    const early = r.W.outLog.filter((l) => l.t - T0 < 20000);
    check(early.length === 0, `lines printed while cache-only: ${early.map((l) => l.s).join(' | ')}`);
    const after = fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').filter((e) => e.t >= 20000);
    check(after.length === 1, `events reads after the server answers: ${after.length}, expected exactly one: ${after.map((e) => e.t).join(', ')} ms`);
    check(r.W.outLog.length === 1 && r.W.outLog[0].t - T0 === 20000, `the line came out at ${r.W.outLog[0] ? r.W.outLog[0].t - T0 : 'never'} ms: expected 20000 ms`);
    check(r.events.length === 1 && r.events[0].seq === 3 && r.events[0].via === 'marker', `lines ${r.outs.join(' | ')}: expected the one event (seq 3) via "marker"`);
    check(r.cursor && r.cursor[DOC_A] === 3, `cursor ${r.cursorText}`);
  });

  tc('T1f', 'WAKE: a clock jump of more than 60 s in one step (a wake from sleep) listens to every item again and reads each ONCE via "safety"; the events sent while asleep are delivered; a stderr note names the jump', async () => {
    const r = await runCase(env, { id: 'T1f', world: (W) => { W.addDoc(DOC_A, 2); W.addDoc(DOC_B, 2); }, docs: [DOC_A, DOC_B], cursor: { [DOC_A]: 2, [DOC_B]: 2 }, mode: 'stream', stopAt: 300000, maxFakeMs: 320000,
      at: [[180000, (W) => { W.addEvent(DOC_A, { actor: HUMAN, body: 'sent while asleep', publish: false }); W.addEvent(DOC_B, { actor: HUMAN, body: 'sent while asleep', publish: false }); W.jumpClock(120000); }]] });
    check(r.code === 0, `exit ${r.code}`);
    check(r.W.listens.length === 4 && same(r.W.listens.slice(2).map((l) => l.sid).sort(), [sidFor(DOC_A), sidFor(DOC_B)].sort()) && r.W.listens.slice(2).every((l) => l.t >= 180000), `listens at ${r.W.listens.map((l) => `${l.t}`).join(', ')} ms: expected 2 more listens (one per item) after 180000 ms`);
    const after = fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').filter((e) => e.t >= 180000);
    check(after.length === 2, `events reads after the jump: ${after.length}, expected one per item (2): ${after.map((e) => e.t).join(', ')} ms`);
    check(r.events.length === 2 && r.events.every((l) => l.via === 'safety') && same(r.events.map((l) => l.document_id).sort(), [DOC_A, DOC_B].sort()), `lines ${r.outs.join(' | ')}: expected one line per document, each via "safety"`);
    check(r.cursor && r.cursor[DOC_A] === 3 && r.cursor[DOC_B] === 3, `cursor ${r.cursorText}`);
    check(r.W.count.marker === 0, `Firestore REST GETs: ${r.W.count.marker}`);
    check(r.errs.some((s) => /clock jumped/.test(s)), `no stderr note about the clock jump: ${r.errs.join(' | ')}`);
  });

  tc('T1g', 'WAKE negative: three minutes of normal 5 s ticks cause NO extra listen, NO read and NO clock-jump note', async () => {
    const r = await runCase(env, { id: 'T1g', world: (W) => W.addDoc(DOC_A, 2), cursor: { [DOC_A]: 2 }, mode: 'stream', stopAt: 180000, maxFakeMs: 200000 });
    check(r.code === 0, `exit ${r.code}`);
    check(r.W.listens.length === 1, `listens at ${r.W.listens.map((l) => l.t).join(', ')} ms: expected only the first one`);
    const reads = fnCalls(r.W, '/documentsApi/listDocumentCommentEvents');
    check(reads.length === 1, `events reads at ${reads.map((e) => e.t).join(', ')} ms: expected only the start read`);
    check(!r.errs.some((s) => /clock jumped/.test(s)), `a clock-jump note on a normal clock: ${r.errs.join(' | ')}`);
  });

  tc('T1h', 'SHUTDOWN --mode once: after one delivery the cursor is saved, then the SDK is closed exactly ONCE with the new cursor already on disk; run resolves with exit 0', async () => {
    const r = await runCase(env, { id: 'T1h', world: (W) => W.addDoc(DOC_A, 2), cursor: { [DOC_A]: 2 }, mode: 'once', maxFakeMs: 60000,
      at: [[5000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'one new' })]] });
    check(r.code === 0 && r.events.length === 1, `exit ${r.code}, lines ${r.outs.join(' | ')}`);
    check(r.W.closed === 1, `the SDK was closed ${r.W.closed} times: expected exactly 1`);
    check(r.W.closedCursor !== null && parseJson(r.W.closedCursor)[DOC_A] === 3, `the cursor file when the SDK closed: ${r.W.closedCursor}: expected the saved cursor (seq 3)`);
  });

  tc('T1i', 'SHUTDOWN --mode stream: a stop saves the cursor, closes the SDK exactly ONCE with the new cursor already on disk, and run resolves with exit 0', async () => {
    const r = await runCase(env, { id: 'T1i', world: (W) => W.addDoc(DOC_A, 2), cursor: { [DOC_A]: 2 }, mode: 'stream', stopAt: 9000, maxFakeMs: 20000,
      at: [[2000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'one new' })]] });
    check(r.code === 0 && r.events.length === 1, `exit ${r.code}, lines ${r.outs.join(' | ')}`);
    check(r.W.closed === 1, `the SDK was closed ${r.W.closed} times: expected exactly 1`);
    check(r.W.closedCursor !== null && parseJson(r.W.closedCursor)[DOC_A] === 3, `the cursor file when the SDK closed: ${r.W.closedCursor}: expected the saved cursor (seq 3)`);
  });

  tc('T2', 'SOURCE PIN: every setTimeout( and setInterval( site in the listener is on the named list (the backoff sleep, the request timeouts, the wall-clock check); a new timer site fails this', () => {
    const src = fs.readFileSync(__filename, 'utf8');
    const listenerPart = src.slice(0, src.indexOf('SELFTEST (fake servers'));
    const sites = listenerPart.split('\n').filter((l) => /\bset(Timeout|Interval)\s*\(/.test(l) && !/^\s*(\*|\/\/)/.test(l));
    const NAMED = [
      ['const t = setTimeout(done, ms);', 'sleepReal: the backoff sleep'],
      ['req.setTimeout(ms, () => fail(', 'makeTransport: the request idle timeout'],
      ['hard = setTimeout(() => fail(', 'makeTransport: the absolute request backstop'],
      ['const h = setInterval(fn, ms);', 'realDeps.interval: the A4 wall-clock check (no request)'],
    ];
    check(sites.length === NAMED.length, `${sites.length} timer sites in the listener, the named list has ${NAMED.length}: ${sites.map((l) => l.trim()).join(' || ')}`);
    for (const [pat, why] of NAMED) check(sites.filter((l) => l.includes(pat)).length === 1, `not on the named list (${why}): ${pat}`);
    check(!listenerPart.includes('FALLBACK_POLL_MS'), 'FALLBACK_POLL_MS is still defined in the listener');
  });

  tc('T01', 'mint, exchange, baseline, marker read, events, one JSON line, cursor written; headers as specified', async () => {
    const body = 'Hello agent, please look at item 70';
    const r = await runCase(env, { id: 'T01', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'once', at: [[4000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body })]] });
    check(r.code === 0, `exit ${r.code}`);
    check(r.events.length === 1 && r.lines.length === 1, `expected one line, got ${r.outs.length}`);
    const ev = r.events[0];
    check(same(Object.keys(ev), EVENT_KEYS), `keys ${Object.keys(ev)}`);
    check(ev.seq === 4 && ev.kind === 'comment.created' && ev.document_id === DOC_A && ev.author_kind === 'human' && ev.author_name === 'Person Fake' && ev.excerpt === body && typeof ev.comment_id === 'string', `line ${r.outs[0]}`);
    check(ISO_IST_RE.test(ev.t) && r.W.outLog[0].t - T0 === 4000 && ev.t === '2026-10-04T11:30:04+05:30', `t ${ev.t} at fake ${r.W.outLog[0].t - T0} ms (the snapshot is read at once: 06:00:04 UTC is 11:30:04 IST)`);
    const L = r.W.log;
    check(L[0].h === 'fn' && L[0].p === '/getRealtimeToken' && L[0].m === 'POST', 'first call is the token mint');
    check(L[1].h === 'idt' && L[1].p === '/v1/accounts:signInWithCustomToken' && L[1].key === FAKE.webKey, 'second call is the exchange');
    check(L[2].h === 'fn' && L[2].p === '/documentsApi/listDocumentCommentEvents' && L[2].body.since === FUTURE_SINCE && L[2].body.documentId === DOC_A, 'third call is the baseline events read');
    check(L[3].h === 'fn' && L[3].p === '/documentsApi/listDocumentCommentEvents' && L[3].body.since === 3 && L[3].body.documentId === DOC_A, 'fourth call is the events read since 3 that the snapshot asks for (no REST marker GET)');
    check(same(L[0].body, {}), 'mint body is {}');
    check(L[0].hdr.includes('x-spm-api-key') && L[0].hdr.includes('x-spm-user-email'), 'mint carries the key and typed email headers');
    check(L.every((e) => !e.hdr.includes('origin')), 'no request carries an Origin header');
    check(L[1].hdr.includes('referer') && !L[1].hdr.some((h) => h.startsWith('x-spm') || h === 'authorization'), 'exchange: Referer, and neither the key nor the email nor a bearer');
    check(L.filter((e) => e.h === 'fs').every((e) => e.hdr.includes('authorization') && !e.hdr.some((h) => h.startsWith('x-spm') || h === 'referer')), 'marker reads carry only the bearer');
    check(L.filter((e) => e.h === 'fn').every((e) => !e.hdr.includes('authorization')), 'function calls never carry a bearer');
    check(same(r.cursor, { [DOC_A]: 4 }), `cursor ${r.cursorText}`);
  });

  tc('T02a', 'own events are skipped (actor_email, any letter case, deletes too) and the cursor passes them', async () => {
    const r = await runCase(env, {
      id: 'T02a', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 9000,
      at: [[2000, (W) => W.addEvent(DOC_A, { actor: OWN, body: 'my reply' })], [3500, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'human reply' })],
        [5000, (W) => W.addEvent(DOC_A, { actor: { ...OWN, email: BACKEND_EMAIL.toUpperCase() }, verb: 'comment.resolved', body: 'again mine' })],
        [6500, (W) => W.addEvent(DOC_A, { actor: OWN, verb: 'comment.deleted', commentId: crypto.randomUUID() })]],
    });
    check(r.code === 0, `exit ${r.code}`);
    check(r.events.length === 1 && r.events[0].seq === 5 && r.events[0].author_kind === 'human', `lines ${r.outs.join(' | ')}`);
    check(same(r.cursor, { [DOC_A]: 7 }), `cursor ${r.cursorText}`);
  });

  tc('T02b', 'with --self-actor-skip false the own events are printed too', async () => {
    const r = await runCase(env, { id: 'T02b', selfSkip: false, world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 7500,
      at: [[2000, (W) => W.addEvent(DOC_A, { actor: OWN, body: 'my reply' })], [3500, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'human reply' })], [5000, (W) => W.addEvent(DOC_A, { actor: OWN, body: 'mine again' })]] });
    check(same(r.events.map((e) => e.seq), [4, 5, 6]), `seqs ${r.events.map((e) => e.seq)}`);
    check(r.events[0].author_kind === 'agent', 'own event line says agent');
  });

  tc('T29', 'a stored cursor ahead of the stream (a cursor file from elsewhere) is moved back to the latest, so later events still wake the agent', async () => {
    const r = await runCase(env, { id: 'T29', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 50 }, mode: 'stream', stopAt: 9000, at: [[4000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'after the stale cursor' })]] });
    check(same(r.events.map((e) => e.seq), [4]) && same(r.cursor, { [DOC_A]: 4 }), `lines ${r.outs.join(' | ')} cursor ${r.cursorText}`);
    check(r.errs.some((s) => s.includes('cursor')), 'the move back was said on stderr');
  });

  tc('T30', '--mode once does not exit on a batch of only own events: it waits for the next one that prints a line', async () => {
    const r = await runCase(env, { id: 'T30', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'once',
      at: [[2000, (W) => W.addEvent(DOC_A, { actor: OWN, body: 'my own reply' })], [5000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'human answer' })]] });
    check(r.code === 0 && same(r.events.map((e) => e.seq), [5]) && same(r.cursor, { [DOC_A]: 5 }), `code ${r.code} lines ${r.outs.join(' | ')} cursor ${r.cursorText}`);
  });

  tc('T03', 'first run on an unknown document starts at the current max: nothing replayed, only later events printed', async () => {
    const r = await runCase(env, { id: 'T03', world: (W) => W.addDoc(DOC_A, 5), mode: 'stream', stopAt: 8000, at: [[3000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'first new one' })]] });
    check(r.code === 0 && r.events.length === 1 && r.events[0].seq === 6, `lines ${r.outs.join(' | ')}`);
    const bodies = fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').map((e) => e.body.since);
    check(bodies[0] === FUTURE_SINCE && bodies.slice(1).every((s) => s >= 5), `events reads asked since ${bodies}`);
    check(same(r.cursor, { [DOC_A]: 6 }), `cursor ${r.cursorText}`);
  });

  tc('T04a', 'a stored cursor behind the stream: exactly the new events, once, and never again', async () => {
    const r = await runCase(env, { id: 'T04a', world: (W) => W.addDoc(DOC_A, 5), cursor: { [DOC_A]: 2 }, mode: 'stream', stopAt: 12000 });
    check(same(r.events.map((e) => e.seq), [3, 4, 5]), `seqs ${r.events.map((e) => e.seq)}`);
    check(same(fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').map((e) => e.body.since), [FUTURE_SINCE, 2]), 'one baseline read and one since-cursor read, nothing more');
    check(same(r.cursor, { [DOC_A]: 5 }), `cursor ${r.cursorText}`);
  });

  tc('T04b', 'a marker bump after a stored cursor delivers exactly the new events once', async () => {
    const r = await runCase(env, { id: 'T04b', world: (W) => W.addDoc(DOC_A, 5), cursor: { [DOC_A]: 5 }, mode: 'stream', stopAt: 12000,
      at: [[2500, (W) => { W.addEvent(DOC_A, { actor: HUMAN, body: 'six', publish: false }); W.addEvent(DOC_A, { actor: HUMAN, body: 'seven' }); }]] });
    check(same(r.events.map((e) => e.seq), [6, 7]), `seqs ${r.events.map((e) => e.seq)}`);
    check(same(fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').map((e) => e.body.since), [FUTURE_SINCE, 5]), 'exactly one since-cursor read');
    check(same(r.cursor, { [DOC_A]: 7 }), `cursor ${r.cursorText}`);
  });

  tc('T31', 'events that arrived while the listener was down with NO marker written (a lost marker) are delivered at the start, not left for the next marker', async () => {
    const r = await runCase(env, { id: 'T31', world: (W) => { W.addDoc(DOC_A, 5); W.markers.clear(); }, cursor: { [DOC_A]: 2 }, mode: 'stream', stopAt: 6000 });
    check(same(r.events.map((e) => e.seq), [3, 4, 5]) && same(r.cursor, { [DOC_A]: 5 }), `lines ${r.outs.join(' | ')} cursor ${r.cursorText}`);
    check(r.W.outLog[0].t - T0 === 0, `first line at ${r.W.outLog[0] ? r.W.outLog[0].t - T0 : 'never'} ms: it should come with the first round`);
  });

  tc('T05', 'two documents: each listens to its own signal id and keeps its own cursor; lines carry their document id', async () => {
    const r = await runCase(env, { id: 'T05', docs: [DOC_A, DOC_B], world: (W) => { W.addDoc(DOC_A, 2); W.addDoc(DOC_B, 5); }, cursor: { [DOC_A]: 2, [DOC_B]: 5 }, mode: 'stream', stopAt: 20000,
      at: [[3000, (W) => W.addEvent(DOC_B, { actor: HUMAN, body: 'b6' })], [4000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'a3' })]] });
    check(same(r.events.map((e) => [e.document_id, e.seq]), [[DOC_B, 6], [DOC_A, 3]]), `lines ${r.outs.join(' | ')}`);
    check(same(r.cursor, { [DOC_A]: 3, [DOC_B]: 6 }), `cursor ${r.cursorText}`);
    check(same(r.W.listens.map((l) => l.sid).sort(), [sidFor(DOC_A), sidFor(DOC_B)].sort()), `listened to ${r.W.listens.map((l) => l.sid.slice(0, 8))}`);
  });

  tc('T06a', '--mode once exits 0 right after the first batch (no later polls, the later event is left for the next run)', async () => {
    const r = await runCase(env, { id: 'T06a', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'once',
      at: [[2000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'first' })], [6000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'second' })]] });
    check(r.code === 0 && same(r.events.map((e) => e.seq), [4]), `code ${r.code} lines ${r.outs.join(' | ')}`);
    check(r.W.log.every((e) => e.t < 6000), 'the listener kept polling after the batch');
    check(same(r.cursor, { [DOC_A]: 4 }), `cursor ${r.cursorText}`);
  });

  tc('T06b', '--mode stream keeps going after a batch and prints every event until stopped (exit 0); nothing is read while idle', async () => {
    const r = await runCase(env, { id: 'T06b', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 9000,
      at: [[2000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'first' })], [6000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'second' })]] });
    check(r.code === 0 && same(r.events.map((e) => e.seq), [4, 5]), `code ${r.code} lines ${r.outs.join(' | ')}`);
    check(r.W.count.events === 3, `events reads ${r.W.count.events}: the baseline and one per bump, none while idle`);
  });

  tc('T07a', 'atomic cursor write: temp file in the same folder, complete before the rename, gone after it', async () => {
    const dir = path.join(RUN_DIR, 'T07a'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'cursor.json');
    let seen = null;
    writeCursorAtomic(file, { [DOC_A]: 7 }, { beforeRename: (tmp) => { seen = { tmp, exists: fs.existsSync(tmp), content: fs.readFileSync(tmp, 'utf8'), dest: fs.existsSync(file) }; } });
    check(seen && path.dirname(seen.tmp) === dir && seen.tmp !== file && seen.exists && same(parseJson(seen.content), { [DOC_A]: 7 }), 'temp file in the same folder holding the complete new cursor');
    check(same(parseJson(fs.readFileSync(file, 'utf8')), { [DOC_A]: 7 }) && !fs.existsSync(seen.tmp), 'after the rename: the cursor is new and the temp file is gone');
    writeCursorAtomic(file, { [DOC_A]: 9, [DOC_B]: 1 });
    check(same(readCursorFile(file), { [DOC_A]: 9, [DOC_B]: 1 }), 'second write replaces the first');
  });

  tc('T07b', 'atomic cursor: a process killed (SIGKILL) between the temp write and the rename leaves the OLD cursor intact', async () => {
    const dir = path.join(RUN_DIR, 'T07b'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'cursor.json');
    fs.writeFileSync(file, JSON.stringify({ [DOC_A]: 5 }) + '\n');
    const code = 'const m=require(process.argv[1]);m.writeCursorAtomic(process.argv[2],{"' + DOC_A + '":99},{beforeRename:(tmp)=>{process.stdout.write("READY "+tmp+"\\n");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}});';
    const c = spawnNode(code, [__filename, file]);
    await waitFor(() => /READY /.test(c.out) || c.exited, 8000, 'the child to reach the crash window');
    check(/READY /.test(c.out), `child did not reach the window: ${c.err.slice(0, 120)}`);
    const tmp = c.out.trim().split('\n')[0].slice(6);
    check(fs.existsSync(tmp) && path.dirname(tmp) === dir, 'the temp file exists in the cursor folder at the crash point');
    c.child.kill('SIGKILL');
    await c.done;
    check(same(parseJson(fs.readFileSync(file, 'utf8')), { [DOC_A]: 5 }), `the old cursor was damaged: ${fs.readFileSync(file, 'utf8').slice(0, 60)}`);
    check(same(readCursorFile(file), { [DOC_A]: 5 }), 'the old cursor reads back');
  });

  tc('T07c', 'crash safety: a listener killed (SIGKILL) right after delivering has already saved the new cursor', async () => {
    const dir = path.join(RUN_DIR, 'T07c'); fs.mkdirSync(dir, { recursive: true });
    const W = newWorld(); env.use(W); W.addDoc(DOC_A, 4);
    const file = path.join(dir, 'cursor.json');
    fs.writeFileSync(file, JSON.stringify({ [DOC_A]: 2 }) + '\n');
    const cfg = { identity: 'alpha', email: BACKEND_EMAIL, key: FAKE.key, webKey: FAKE.webKey, documents: [DOC_A], cursorFile: file, mode: 'stream', selfSkip: true, ports: env.ports };
    const c = spawnNode('const m=require(process.argv[1]);m.selftestChild(JSON.parse(process.argv[2])).then((x)=>{process.exitCode=x;});', [__filename, JSON.stringify(cfg)]);
    try {
      // the lines reach the pipe before the child's own save runs, so wait for the saved cursor too
      await waitFor(() => { const j = parseJson(fs.readFileSync(file, 'utf8')); return (c.out.trim().split('\n').filter(Boolean).length >= 2 && j && j[DOC_A] === 4) || c.exited; }, 8000, 'the child to print and save its first batch');
      check(!c.exited && c.out.trim().split('\n').filter(Boolean).length === 2, `child output ${c.out.slice(0, 200)} ${c.err.slice(0, 100)}`);
      c.child.kill('SIGKILL');
      await c.done;
      check(same(parseJson(fs.readFileSync(file, 'utf8')), { [DOC_A]: 4 }), `cursor after the kill: ${fs.readFileSync(file, 'utf8').slice(0, 60)} (events 3 and 4 were printed)`);
    } finally { if (!c.exited) c.child.kill('SIGKILL'); }
  });

  tc('T08', 'the ID token is minted ONCE: the SDK refreshes the ID token itself, so two fake hours of idle make no second mint and no second exchange', async () => {
    const r = await runCase(env, { id: 'T08', world: (W) => W.addDoc(DOC_A, 0), mode: 'stream', stopAt: 2 * 3600000, maxFakeMs: 3 * 3600000 });
    check(r.code === 0, `exit ${r.code}`);
    check(r.W.count.token === 1 && r.W.count.exchange === 1, `mints ${r.W.count.token}, exchanges ${r.W.count.exchange}`);
  });

  tc('T09a', 'a signal stream error (unauthenticated): the listener listens again after the 1 s backoff with NO second mint or exchange (the SDK refreshes its own ID token)', async () => {
    const r = await runCase(env, { id: 'T09a', world: (W) => W.addDoc(DOC_A, 2), cursor: { [DOC_A]: 2 }, mode: 'stream', stopAt: 20000, at: [[5000, (W) => W.failSignal('unauthenticated')]] });
    check(r.W.count.token === 1 && r.W.count.exchange === 1, `mints ${r.W.count.token}, exchanges ${r.W.count.exchange}`);
    check(same(r.W.listens.map((l) => l.t), [0, 6000]), `listens at ${r.W.listens.map((l) => l.t)} ms: expected 0 and 6000`);
    check(r.code === 0, `exit ${r.code}`);
  });

  tc('T09b', 'a signal stream that fails again before any snapshot: the wait doubles (1, 2, 4, 8 s) and the mint is not repeated', async () => {
    const r = await runCase(env, { id: 'T09b', world: (W) => { W.addDoc(DOC_A, 2); W.over.listen = (n) => (n >= 2 && n <= 4 ? { error: 'permission-denied' } : null); }, cursor: { [DOC_A]: 2 }, mode: 'stream', stopAt: 30000,
      at: [[5000, (W) => W.failSignal('unavailable')]] });
    check(same(r.W.listens.map((l) => l.t), [0, 6000, 8000, 12000, 20000]), `listens at ${r.W.listens.map((l) => l.t)} ms: expected 0, 6000, 8000, 12000, 20000`);
    check(r.W.count.token === 1 && r.W.count.exchange === 1, `mints ${r.W.count.token}, exchanges ${r.W.count.exchange}`);
  });

  const tenCase = (id, header, lo, hi) => async () => {
    const r = await runCase(env, { id, world: (W) => { W.addDoc(DOC_A, 0); W.over.token = (n) => (n === 1 ? { status: 429, headers: header === null ? {} : { 'retry-after': header }, body: { code: 'rate_limited' } } : null); },
      fallbackS: 300, mode: 'stream', stopAt: 80000 });
    const calls = fnCalls(r.W, '/getRealtimeToken');
    check(calls.length === 2 && calls[0].t === 0, `token calls at ${calls.map((c) => c.t)}`);
    check(calls[1].t >= lo && calls[1].t < hi, `second token call at ${calls[1].t} ms, wanted ${lo} to ${hi}`);
    check(r.W.mints.length === 1 && r.W.count.exchange === 1, 'mint and exchange follow the retry');
  };
  tc('T10a', '429 from getRealtimeToken with Retry-After 7: waits 7 seconds', tenCase('T10a', '7', 7000, 7000 + 1500 + 50));
  tc('T10b', '429 from getRealtimeToken without the header: waits 60 seconds', tenCase('T10b', null, 60000, 60000 + 1500 + 50));
  tc('T10c', '429 with a Retry-After that is not a number of seconds: waits 60 seconds', tenCase('T10c', 'abc', 60000, 60000 + 1500 + 50));

  tc('T11a', 'a signal stream that keeps failing for minutes: no fallback line, no read while it is down, and one catch-up read (via "safety") once it comes back', async () => {
    const r = await runCase(env, { id: 'T11a', world: (W) => { W.addDoc(DOC_A, 3); W.over.listen = (n) => (n >= 2 && n <= 6 ? { error: 'unavailable' } : null); }, cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 300000,
      at: [[5000, (W) => W.failSignal('unavailable')], [9000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'sent during the outage', publish: false })]] });
    check(r.outs.every((s) => !s.includes('"fallback"')), `a fallback line was printed: ${r.outs.join(' | ')}`);
    check(r.events.length === 1 && r.events[0].seq === 4 && r.events[0].via === 'safety', `lines ${r.outs.join(' | ')}`);
    check(fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').filter((e) => e.t >= 5000).length === 1, `reads after the error: ${fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').filter((e) => e.t >= 5000).map((e) => e.t)}`);
  });

  tc('T11b', 'token endpoint refusing at the start (503): the events reads still run, the mint is retried with the login backoff, and the listen starts once sign-in works', async () => {
    const r = await runCase(env, { id: 'T11b', world: (W) => { W.addDoc(DOC_A, 3); W.over.token = (n) => (n <= 2 ? { status: 503, body: { error: 'x' } } : null); }, cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 30000,
      at: [[20000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'after sign-in' })]] });
    check(r.W.count.token === 3 && r.W.count.exchange === 1, `mints ${r.W.count.token}, exchanges ${r.W.count.exchange}`);
    check(same(r.W.listens.map((l) => l.t), [15000]), `listened at ${r.W.listens.map((l) => l.t)} ms: expected 15000 (waits 5 s, then 10 s)`);
    check(r.events.length === 1 && r.events[0].seq === 4 && r.events[0].via === 'marker', `lines ${r.outs.join(' | ')}`);
    check(r.outs.every((s) => !s.includes('"fallback"')), 'a fallback line was printed');
  });

  tc('T11c', 'after a stream recovers: one catch-up read (via "safety") for the bump sent while it was down, then the next bump is read at once (via "marker")', async () => {
    const r = await runCase(env, { id: 'T11c', world: (W) => W.addDoc(DOC_A, 2), cursor: { [DOC_A]: 2 }, mode: 'stream', stopAt: 20000,
      at: [[4000, (W) => W.failSignal('unavailable')], [4500, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'while down', publish: false })], [9000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'bump' })]] });
    check(same(r.events.map((e) => [e.seq, e.via]), [[3, 'safety'], [4, 'marker']]), `lines ${r.outs.join(' | ')}`);
    check(r.outs.every((s) => !s.includes('"fallback"')), 'a fallback line was printed');
    check(fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').some((e) => e.t === 9000), 'the bump was not read at once');
  });

  const signalCase = (sig) => async () => {
    const cursorDoc = DOC_A;
    const dir = path.join(RUN_DIR, 'T12' + sig); fs.mkdirSync(dir, { recursive: true });
    const W = newWorld(); env.use(W); W.addDoc(cursorDoc, 2);
    const file = path.join(dir, 'cursor.json');
    const cfg = { identity: 'alpha', email: BACKEND_EMAIL, key: FAKE.key, webKey: FAKE.webKey, documents: [cursorDoc], cursorFile: file, mode: 'stream', selfSkip: true, ports: env.ports };
    const code = 'const m=require(process.argv[1]);m.selftestChild(JSON.parse(process.argv[2])).then((c)=>{process.exitCode=c;});';
    const t0 = Date.now();
    const c = spawnNode(code, [__filename, JSON.stringify(cfg)]);
    try {
      await waitFor(() => (W.count.exchange >= 1 && W.count.events >= 1) || c.exited, 8000, 'the child to be signed in and idle');
      await new Promise((r) => setTimeout(r, 300)); // the child subscribes right after its sign-in
      check(!c.exited && W.count.exchange >= 1, `child ended early: ${c.err.slice(0, 120)}`);
      fs.writeFileSync(file, '{}\n'); // the file goes stale; only the shutdown save can put the in-memory cursor back
      c.child.kill(sig);
      await Promise.race([c.done, new Promise((r) => setTimeout(r, 5000))]);
      check(c.exited && c.exited.code === 0 && c.exited.signal === null, `exit ${JSON.stringify(c.exited)} err ${c.err.slice(0, 120)}`);
      check(Date.now() - t0 < 6000, 'the listener did not stop promptly');
      check(same(parseJson(fs.readFileSync(file, 'utf8')), { [cursorDoc]: 2 }), `cursor after ${sig}: ${fs.readFileSync(file, 'utf8').slice(0, 80)}`);
    } finally { if (!c.exited) c.child.kill('SIGKILL'); }
  };
  // Once mode ends the run after the batch even when the SDK close never resolves (the notice of 26 Oct sat 4+ minutes)
  tc('E1a', ' once mode (item): the batch is printed, the cursor saved, and the run ends with exit 0 within 3 s of fake time even when the SDK close never resolves', async () => {
    const r = await runCase(env, { id: 'E1a', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'once', closeHang: true, at: [[4000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'hello' })]] });
    check(r.code === 0 && r.lines.length === 1, `code ${r.code} lines ${r.lines.length}`);
    check(r.cursor && r.cursor[DOC_A] === 4, `cursor ${r.cursorText}`);
    check(r.W.clock.t - r.W.outLog[0].t <= 3000, `the run ended ${r.W.clock.t - r.W.outLog[0].t} ms after the print`);
  });
  tc('E1c', ' once mode, real child process: a line printed, the cursor saved, the SDK close never resolves and a timer is left open: the process exits 0 within 8 s', async () => {
    const dir = path.join(RUN_DIR, 'E1c'); fs.mkdirSync(dir, { recursive: true });
    const W = newWorld(); env.use(W); W.addDoc(DOC_A, 4);
    const file = path.join(dir, 'cursor.json');
    fs.writeFileSync(file, JSON.stringify({ [DOC_A]: 2 }) + '\n');
    const cfg = { identity: 'alpha', email: BACKEND_EMAIL, key: FAKE.key, webKey: FAKE.webKey, documents: [DOC_A], cursorFile: file, mode: 'once', selfSkip: true, ports: env.ports, closeHang: true, linger: true };
    const t0 = Date.now();
    const c = spawnNode('const m=require(process.argv[1]);m.exitWhenDone(m.selftestChild(JSON.parse(process.argv[2])));', [__filename, JSON.stringify(cfg)]);
    try {
      await Promise.race([c.done, new Promise((r) => setTimeout(r, 9000))]);
      check(c.exited && c.exited.code === 0 && c.exited.signal === null, `exit ${JSON.stringify(c.exited)} after ${Date.now() - t0} ms; stdout ${c.out.slice(0, 120)} stderr ${c.err.slice(0, 160)}`);
      const printed = c.out.trim().split('\n').filter(Boolean);
      check(printed.length >= 1 && printed.every((l) => parseJson(l) && parseJson(l).kind === 'comment.created'), `stdout lines: ${c.out.slice(0, 200)}`);
      check(same(parseJson(fs.readFileSync(file, 'utf8')), { [DOC_A]: 4 }), `cursor: ${fs.readFileSync(file, 'utf8').slice(0, 80)}`);
    } finally { if (!c.exited) c.child.kill('SIGKILL'); }
  });
  tc('T12a', 'SIGTERM (real signal, real child process) stops promptly with exit 0 and the cursor saved', signalCase('SIGTERM'));
  tc('T12b', 'SIGINT (real signal, real child process) stops promptly with exit 0 and the cursor saved', signalCase('SIGINT'));

  tc('T13', 'no key, token, uid, address or reply body reaches stdout, stderr, the cursor file or any write (fakes seeded with secrets)', async () => {
    const leak = { error: `denied for ${FAKE.key} and ${FAKE.webKey} token eyJleakedtoken.eyJpayload.sigsigsig ${FAKE.humanEmail} ${FAKE.uid} ${BACKEND_EMAIL} ${FAKE.refresh}` };
    const realOut = process.stdout.write.bind(process.stdout); const realErr = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stdout.write = (s, ...a) => { captured += String(s); return typeof a[a.length - 1] === 'function' ? realOut('', a[a.length - 1]) : true; };
    process.stderr.write = (s, ...a) => { captured += String(s); return typeof a[a.length - 1] === 'function' ? realErr('', a[a.length - 1]) : true; };
    let r1; let r2; let all;
    try {
      r1 = await runCase(env, { id: 'T13a', world: (W) => { W.addDoc(DOC_A, 3);
        W.over.token = (n) => (n === 1 ? { status: 500, body: leak } : null); W.over.exchange = (n) => (n === 1 ? { status: 400, body: leak } : null);
        W.over.marker = (n) => (n === 4 ? { status: 500, body: leak } : null); W.over.events = (n) => (n === 3 ? { status: 500, body: leak } : null); },
      cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 40000, at: [[9000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'plain text body' })], [20000, (W) => W.addEvent(DOC_A, { actor: OTHER, body: 'from the other agent' })],
        [30000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: `someone pasted ${FAKE.key} and a token eyJpasted12345.eyJpayload123.sigpasted123 into a comment` })]] });
      r2 = await runCase(env, { id: 'T13b', world: (W) => { W.addDoc(DOC_A, 3); W.over.events = (n) => (n >= 2 ? { status: 403, body: leak } : null); }, cursor: { [DOC_A]: 1 }, mode: 'once' });
      all = r1.W.issued.concat([...r1.W.idTokens.keys()], [FAKE.key, FAKE.webKey, FAKE.refresh, FAKE.uid, BACKEND_EMAIL, FAKE.humanEmail, 'FAKESIGNATURE', 'eyJleakedtoken', 'sigsigsig']);
    } finally { process.stdout.write = realOut; process.stderr.write = realErr; }
    check(r1.events.length === 3 && r2.code === 1, `events ${r1.events.length}, fatal run exit ${r2.code}`);
    check(r1.events[2].excerpt.includes('[redacted]') && r1.events[2].excerpt.startsWith('someone pasted '), 'a key pasted into a comment body is redacted in the excerpt, the rest of the text stays');
    const scan = [['stdout lines', r1.outs.concat(r2.outs).join('\n')], ['stderr lines', r1.errs.concat(r2.errs).join('\n')], ['cursor files', `${r1.cursorText}\n${r2.cursorText}`], ['process writes', captured]];
    const patterns = [/eyJ/, /AIza/, /spm_k_/, /Bearer /i, /AMf-v/, /spm_[0-9a-f]{8}-/, /[A-Za-z0-9._-]+@[A-Za-z0-9.-]+/, /FAKESIGNATURE/i];
    for (const [name, text] of scan) {
      for (const s of all) check(!text.includes(s), `${name} contain a secret (${s.slice(0, 10)}...)`);
      for (const re of patterns) check(!re.test(text), `${name} match ${re}`);
    }
    check(r1.errs.length + r2.errs.length > 0, 'the failure paths should have said something on stderr');
    check(r2.errs.join(' ').includes('403'), 'the fatal message names the status');
  });

  tc('T14a', 'allow-list: only the Cloud Function routes (mint, document, board and map events reads); the SDK sign-in and the Firestore REST marker are refused, as are wrong bodies and headers', async () => {
    const A = `https://${FN_HOST}`; const I = `https://${IDT_HOST}/v1/accounts:signInWithCustomToken?key=${FAKE.webKey}`; const F = `https://${FS_HOST}${FS_ROOT}/signals/${'a'.repeat(64)}`;
    const key = { 'X-SPM-API-Key': FAKE.key, 'X-SPM-User-Email': BACKEND_EMAIL };
    const ev = { documentId: DOC_A, since: 3 };
    const g = (url, method, headers, body) => { try { guardRequest(url, method, headers || {}, body); return true; } catch (e) { return false; } };
    const okCases = [
      [`${A}/getRealtimeToken`, 'POST', key, {}], [`${A}/documentsApi/listDocumentCommentEvents`, 'POST', key, ev], [`${A}/documentsApi/listDocumentCommentEvents`, 'POST', key, { documentId: DOC_A, since: FUTURE_SINCE }],
    ];
    okCases.forEach((c, i) => check(g(...c), `allowed call #${i} was refused`));
    const bad = [
      ["sdk sign-in (the SDK makes it, not the guard)", [I, 'POST', { Referer: REFERER }, { token: 'x.y.z', returnSecureToken: true }]], ["firestore marker REST (retired)", [F, 'GET', { Authorization: 'Bearer x' }, undefined]],
      ['other host', ['https://evil.invalid/getRealtimeToken', 'POST', key, {}]], ['us-central1 host', ['https://us-central1-litethink.cloudfunctions.net/getRealtimeToken', 'POST', key, {}]],
      ['http scheme', [`http://${FN_HOST}/getRealtimeToken`, 'POST', key, {}]], ['port', [`https://${FN_HOST}:8443/getRealtimeToken`, 'POST', key, {}]], ['userinfo', [`https://u:p@${FN_HOST}/getRealtimeToken`, 'POST', key, {}]],
      ['other function route', [`${A}/createDocumentComment`, 'POST', key, ev]], ['other function route 2', [`${A}/deleteDocument`, 'POST', key, ev]], ['trailing slash', [`${A}/getRealtimeToken/`, 'POST', key, {}]],
      ['query on function', [`${A}/getRealtimeToken?x=1`, 'POST', key, {}]], ['GET on function', [`${A}/getRealtimeToken`, 'GET', key, undefined]], ['PUT on function', [`${A}/getRealtimeToken`, 'PUT', key, {}]],
      ['mint body not empty', [`${A}/getRealtimeToken`, 'POST', key, { x: 1 }]], ['events body extra key', [`${A}/documentsApi/listDocumentCommentEvents`, 'POST', key, { ...ev, extra: 1 }]],
      ['events documentId not a uuid', [`${A}/documentsApi/listDocumentCommentEvents`, 'POST', key, { documentId: 'not-a-uuid', since: 3 }]], ['events since negative', [`${A}/documentsApi/listDocumentCommentEvents`, 'POST', key, { documentId: DOC_A, since: -1 }]],
      ['events since a string', [`${A}/documentsApi/listDocumentCommentEvents`, 'POST', key, { documentId: DOC_A, since: '3' }]],
      ['idt signUp', [`https://${IDT_HOST}/v1/accounts:signUp?key=${FAKE.webKey}`, 'POST', { Referer: REFERER }, { returnSecureToken: true }]], ['idt delete', [`https://${IDT_HOST}/v1/accounts:delete?key=${FAKE.webKey}`, 'POST', { Referer: REFERER }, { idToken: 'x' }]],
      ['idt no key', [`https://${IDT_HOST}/v1/accounts:signInWithCustomToken`, 'POST', { Referer: REFERER }, { token: 'x', returnSecureToken: true }]], ['idt extra query', [`${I}&foo=1`, 'POST', { Referer: REFERER }, { token: 'x', returnSecureToken: true }]],
      ['idt GET', [I, 'GET', { Referer: REFERER }, undefined]], ['idt body extra', [I, 'POST', { Referer: REFERER }, { token: 'x', returnSecureToken: true, a: 1 }]], ['securetoken host', ['https://securetoken.googleapis.com/v1/token?key=abcdefgh12', 'POST', {}, { grant_type: 'refresh_token' }]],
      ['firestore other collection', [`https://${FS_HOST}${FS_ROOT}/users/${'a'.repeat(64)}`, 'GET', { Authorization: 'Bearer x' }, undefined]], ['firestore list', [`https://${FS_HOST}${FS_ROOT}/signals`, 'GET', { Authorization: 'Bearer x' }, undefined]],
      ['firestore short id', [`https://${FS_HOST}${FS_ROOT}/signals/${'a'.repeat(63)}`, 'GET', { Authorization: 'Bearer x' }, undefined]], ['firestore upper-case id', [`https://${FS_HOST}${FS_ROOT}/signals/${'A'.repeat(64)}`, 'GET', { Authorization: 'Bearer x' }, undefined]],
      ['firestore query', [`${F}?mask.fieldPaths=seq`, 'GET', { Authorization: 'Bearer x' }, undefined]], ['firestore other project', [`https://${FS_HOST}/v1/projects/other/databases/(default)/documents/signals/${'a'.repeat(64)}`, 'GET', { Authorization: 'Bearer x' }, undefined]],
      ['firestore other database', [`https://${FS_HOST}/v1/projects/${PROJECT}/databases/other/documents/signals/${'a'.repeat(64)}`, 'GET', { Authorization: 'Bearer x' }, undefined]],
      ['firestore dotted path', [`https://${FS_HOST}${FS_ROOT}/signals/%2e%2e/users/x`, 'GET', { Authorization: 'Bearer x' }, undefined]], ['firestore double slash', [`https://${FS_HOST}${FS_ROOT}//signals/${'a'.repeat(64)}`, 'GET', { Authorization: 'Bearer x' }, undefined]],
      ['firestore DELETE', [F, 'DELETE', { Authorization: 'Bearer x' }, undefined]], ['firestore PATCH', [F, 'PATCH', { Authorization: 'Bearer x' }, {}]], ['firestore POST', [F, 'POST', { Authorization: 'Bearer x' }, {}]],
      ['firestore with a body', [F, 'GET', { Authorization: 'Bearer x' }, {}]], ['commit', [`https://${FS_HOST}${FS_ROOT}:commit`, 'POST', { Authorization: 'Bearer x' }, { writes: [] }]],
      ['key sent to Identity Toolkit', [I, 'POST', { Referer: REFERER, 'X-SPM-API-Key': FAKE.key }, { token: 'x', returnSecureToken: true }]], ['key sent to Firestore', [F, 'GET', { Authorization: 'Bearer x', 'X-SPM-API-Key': FAKE.key }, undefined]],
      ['email sent to Firestore', [F, 'GET', { Authorization: 'Bearer x', 'X-SPM-User-Email': BACKEND_EMAIL }, undefined]], ['bearer sent to a function', [`${A}/getRealtimeToken`, 'POST', { ...key, Authorization: 'Bearer x' }, {}]],
      ['Origin sent to a function', [`${A}/getRealtimeToken`, 'POST', { ...key, Origin: 'https://app.superproductmanager.ai' }, {}]], ['unparseable url', ['not a url', 'GET', {}, undefined]],
    ];
    for (const [name, c] of bad) check(!g(...c), `refused case "${name}" was allowed`);
  });

  tc('T14d', 'the documents comment events read goes through the warm router: POST /documentsApi/listDocumentCommentEvents is admitted; the bare /listDocumentCommentEvents is refused before any call', async () => {
    const A = `https://${FN_HOST}`;
    const key = { 'X-SPM-API-Key': FAKE.key, 'X-SPM-User-Email': BACKEND_EMAIL };
    const ev = { documentId: DOC_A, since: 3 };
    const g = (url, method, headers, body) => { try { guardRequest(url, method, headers || {}, body); return true; } catch (e) { return false; } };
    check(g(`${A}/documentsApi/listDocumentCommentEvents`, 'POST', key, ev), 'the router events read was refused');
    check(!g(`${A}/listDocumentCommentEvents`, 'POST', key, ev), 'the bare events read was admitted');
  });

  tc('T14b', 'a redirect is never followed: the listener treats it as a failed call and no request goes to the redirect target', async () => {
    const evil = 'https://evil.invalid/steal';
    const r = await runCase(env, { id: 'T14b', world: (W) => { W.addDoc(DOC_A, 3); W.over.token = (n) => (n === 1 ? { status: 302, headers: { location: evil }, body: '' } : null); W.over.events = (n) => (n === 2 ? { status: 307, headers: { location: evil }, body: '' } : null); },
      cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 60000, at: [[40000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'still works' })]] });
    check([...r.W.hostsSeen].every((h) => [FN_HOST, IDT_HOST].includes(h)), `hosts called: ${[...r.W.hostsSeen]}`);
    check(r.events.length === 1 && r.W.mints.length >= 1, `the listener did not recover after the redirects: ${r.outs.join(' | ')}`);
  });

  tc('T14c', 'the implementation reads no environment variable except the key sources and HOME, and has no flag that names a base', async () => {
    const src = fs.readFileSync(__filename, 'utf8');
    const impl = src.slice(src.indexOf('// ==== IMPLEMENTATION-BEGIN'), src.indexOf('// ==== IMPLEMENTATION-END'));
    const names = [...impl.matchAll(/process\.env\.([A-Z_a-z0-9]+)/g)].map((m) => m[1]);
    const DELETED = ['__FIREBASE_DEFAULTS__', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']; // A1: deleted before the SDK loads, never read
    const PROXY_NAMES = ['HTTPS_PROXY', 'https_proxy', 'NODE_USE_ENV_PROXY']; // R1: the proxy URL only (proxyAgentFor), names no base host; NODE_USE_ENV_PROXY is the Node switch that makes the proxy agent work (transport webchannel), not a host
    check(names.every((n) => n === 'SPM_AGENT_RUNTIME_DIR' || DELETED.includes(n) || PROXY_NAMES.includes(n)) && DELETED.every((n) => impl.includes(`delete process.env.${n};`)), `process.env names: ${names}`);
    const rest = impl.replace(/process\.env\.[A-Z_a-z0-9]+/g, '').replace('loadWebKeyFrom(process.env, appId)', '');
    check(!/process\.env\[/.test(impl) && !/process\.env\b/.test(rest), 'process.env used as a whole object (only the web key loader may take it)');
    const envNames = [...impl.matchAll(/\benv\.([A-Z_a-z0-9]+)/g)].map((m) => m[1]);
    check(envNames.every((n) => ['VITE_FIREBASE_API_KEY', 'FIREBASE_API_KEY', 'HOME', '__FIREBASE_DEFAULTS__', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'HTTPS_PROXY', 'https_proxy', 'NODE_USE_ENV_PROXY'].includes(n)), `env.* names: ${envNames}`);
    for (const flag of ['--base', '--base-url', '--host', '--functions-base', '--firestore', '--idt', '--url', '--proxy', '--resolve']) {
      const res = parseArgs(['--config', cfgFile('alpha'), '--document', DOC_A, '--cursor-file', '/tmp/x.json', flag, 'http://127.0.0.1:1']);
      check(res && res.ok === false, `${flag} was accepted`);
    }
  });

  tc('T15', 'usage errors exit 2 before any call or key read; a good command line parses to the documented defaults (mode once, self-actor-skip true)', async () => {
    const good = ['--config', cfgFile('beta'), '--document', `${DOC_A},${DOC_B}`, '--cursor-file', '/tmp/agent-listen-x.json'];
    const parsed = parseArgs(good);
    check(parsed.ok === true && same(parsed.cfg.documents, [DOC_A, DOC_B]) && parsed.cfg.cursorFile === '/tmp/agent-listen-x.json' && parsed.cfg.mode === 'once' && parsed.cfg.selfSkip === true && parsed.cfg.pollMs === undefined, `defaults ${JSON.stringify(parsed)}`);
    const full = parseArgs([...good, '--mode', 'stream', '--self-actor-skip', 'false']);
    check(full.ok && full.cfg.mode === 'stream' && full.cfg.selfSkip === false, 'explicit values');
    check(parseArgs(['--config', cfgFile('alpha'), '--document', upperCase(DOC_A), '--cursor-file', '/tmp/x.json']).cfg.documents[0] === upperCase(DOC_A).toLowerCase(), 'document ids are lower-cased');
    const base = ['--config', cfgFile('alpha'), '--document', DOC_A, '--cursor-file', '/tmp/x.json'];
    const without = (flag) => { const i = base.indexOf(flag); return base.filter((_, k) => k !== i && k !== i + 1); };
    const withv = (flag, v) => [...without(flag), flag, v];
    const bads = [[], without('--document'), without('--cursor-file'), withv('--document', 'not-a-uuid'), withv('--document', `${DOC_A},${DOC_A}`), withv('--cursor-file', 'relative/cursor.json'), withv('--cursor-file', '/tmp/dir/'),
      withv('--document', Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',')),
      [...base, '--mode', 'forever'], [...base, '--poll-ms', '1500'], [...base, '--poll-ms', 'abc'], [...base, '--fallback-s', '30'], [...base, '--fallback-s', 'x'], [...base, '--safety-s', '60'], [...base, '--inbox'],
      [...base, '--self-actor-skip', 'maybe'], [...base, '--bogus', 'x'], [...base, '--mode'], [...base, 'stray'], [...base, '--config', cfgFile('beta')], [...base, '--selftest-extra']];
    let calls = 0;
    const stderr = [];
    const deps = { io: { out: () => { calls++; }, err: (s) => stderr.push(s) }, proc: new (require('node:events'))(), readKey: () => { calls++; return FAKE.key; }, loadWebKey: () => { calls++; return FAKE.webKey; }, http: () => { calls++; throw new Error('network'); }, now: () => T0, sleep: async () => { calls++; }, requestTimeoutMs: 100 };
    for (const argv of bads) {
      stderr.length = 0;
      check(parseArgs(argv).ok === false, `argv ${JSON.stringify(argv).slice(0, 90)} was accepted (a usage error was expected; running it would start a listener)`);
      const code = await main(argv, deps);
      check(code === 2, `argv ${JSON.stringify(argv).slice(0, 90)} exited ${code}`);
      check(stderr.some((s) => s.includes('usage') || s.includes('refused')), `argv ${JSON.stringify(argv).slice(0, 90)}: no usage or refusal text`);
    }
    check(calls === 0, `${calls} call(s), key read(s) or print(s) happened on a usage error`);
  });

  tc('T16', 'more than 100 events behind: a reset line, the newest 100 are delivered, the cursor lands on the latest', async () => {
    const r = await runCase(env, { id: 'T16', world: (W) => W.addDoc(DOC_A, 250), cursor: { [DOC_A]: 10 }, mode: 'once' });
    const resets = r.lines.filter((l) => l && l.reset === true);
    check(resets.length === 1 && same(Object.keys(resets[0]), ['t', 'document_id', 'reset', 'latest']) && resets[0].latest === 250 && resets[0].document_id === DOC_A, `reset lines ${JSON.stringify(resets)}`);
    check(r.events.length === 100 && r.events[0].seq === 151 && r.events[99].seq === 250, `events ${r.events.length} from ${r.events[0] && r.events[0].seq}`);
    check(same(fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').map((e) => e.body.since), [FUTURE_SINCE, 10, 150]), 'reads: baseline, the refused one, the recovery one');
    check(same(r.cursor, { [DOC_A]: 250 }), `cursor ${r.cursorText}`);
  });

  tc('T17', 'a marker stuck ahead of the stream causes ONE events read for it, not one per bump of time, and a later real marker still delivers', async () => {
    const r = await runCase(env, { id: 'T17', world: (W) => W.addDoc(DOC_A, 5), cursor: { [DOC_A]: 5 }, mode: 'stream', stopAt: 60000,
      at: [[1000, (W) => { W.markers.set(sidFor(DOC_A), { seq: 999, at: new Date(W.clock.t).toISOString() }); W.notify(sidFor(DOC_A)); }], [30000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'real one' })]] });
    const reads = fnCalls(r.W, '/documentsApi/listDocumentCommentEvents');
    check(reads.length === 3, `${reads.length} events reads (baseline, one for the stuck marker, one for the real event)`);
    check(r.events.length === 1 && r.events[0].seq === 6, `lines ${r.outs.join(' | ')}`);
  });

  tc('T18', 'a missing signal document (no marker written yet) is a normal state: no events read, however long it lasts', async () => {
    const r = await runCase(env, { id: 'T18', world: (W) => { W.addDoc(DOC_A, 3); W.markers.clear(); }, cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 300000, maxFakeMs: 400000 });
    check(r.code === 0 && r.outs.length === 0, `exit ${r.code} lines ${r.outs.join(' | ')}`);
    check(r.W.count.events === 1, `events reads ${r.W.count.events}: only the start baseline`);
  });

  tc('T19', 'a damaged cursor file is refused (exit 1, no call, file untouched); a missing one is fine', async () => {
    const bads = ['{not json', '[1,2]', '"text"', `{"${DOC_A}": "x"}`, `{"${DOC_A}": -1}`, `{"${DOC_A}": 1.5}`, ''];
    for (let i = 0; i < bads.length; i++) {
      const r = await runCase(env, { id: `T19-${i}`, world: (W) => W.addDoc(DOC_A, 3), rawCursor: bads[i], mode: 'once' });
      check(r.code === 1, `raw ${JSON.stringify(bads[i])} exited ${r.code}`);
      check(r.W.log.length === 0, `raw ${JSON.stringify(bads[i])}: a call was made`);
      check(r.cursorText === bads[i], `raw ${JSON.stringify(bads[i])}: the file was changed`);
      check(r.errs.join(' ').includes('cursor'), `raw ${JSON.stringify(bads[i])}: message does not name the cursor file`);
    }
    const m = await runCase(env, { id: 'T19-missing', world: (W) => W.addDoc(DOC_A, 3), mode: 'stream', stopAt: 2000 });
    check(m.code === 0 && same(m.cursor, { [DOC_A]: 3 }), 'a missing cursor file starts at the current max');
  });

  tc('T20', 'keys of other documents in the cursor file are kept when it is rewritten', async () => {
    const other = '00000000-0000-4000-8000-000000000003';
    const r = await runCase(env, { id: 'T20', world: (W) => W.addDoc(DOC_A, 4), cursor: { [other]: 9, [DOC_A]: 2 }, mode: 'once' });
    check(same(r.cursor, { [other]: 9, [DOC_A]: 4 }), `cursor ${r.cursorText}`);
  });

  tc('T21', 'a stalled events read times out instead of hanging the listener; it retries and delivers', async () => {
    const r = await runCase(env, { id: 'T21', world: (W) => { W.addDoc(DOC_A, 3); W.over.events = (n) => (n === 2 ? { stall: true } : null); }, cursor: { [DOC_A]: 3 }, mode: 'stream', reqTimeoutMs: 300, stopAt: 20000,
      at: [[4000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'after the stall' })]] });
    check(r.code === 0 && r.events.length === 1 && r.events[0].seq === 4, `code ${r.code} lines ${r.outs.join(' | ')} errs ${r.errs.join(' | ')}`);
    check(fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').length === 3, `events reads ${fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').length}: expected the baseline, the stalled read and its retry`);
  });

  tc('T22', 'a reply without signal_id (secret not set, or signal off): ONE clear line, exit 1, no listen and no further read', async () => {
    const r = await runCase(env, { id: 'T22', world: (W) => { W.addDoc(DOC_A, 3); W.noSignalId = true; }, cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 60000 });
    check(r.code === 1, `exit ${r.code}`);
    check(r.errs.length === 1 && /signal id/.test(r.errs[0]), `errs ${r.errs.join(' | ')}`);
    check(r.W.count.events === 1 && r.W.listens.length === 0 && r.outs.length === 0, `events reads ${r.W.count.events}, listens ${r.W.listens.length}, lines ${r.outs.length}`);
  });

  tc('T23', 'web key from the environment only; key file read trimmed', async () => {
    const root = path.join(RUN_DIR, 'T23'); fs.mkdirSync(path.join(root, 'a/scripts'), { recursive: true }); fs.mkdirSync(path.join(root, 'b'), { recursive: true }); fs.mkdirSync(path.join(root, 'c/scripts'), { recursive: true });
    check(loadWebKeyFrom({ VITE_FIREBASE_API_KEY: 'example-env-var-app-id-0000000000' }) === 'example-env-var-app-id-0000000000', 'env VITE_FIREBASE_API_KEY');
    check(loadWebKeyFrom({ FIREBASE_API_KEY: 'example-env-plain-app-id-000000000' }) === 'example-env-plain-app-id-000000000', 'env FIREBASE_API_KEY');
    let threw = false; try { loadWebKeyFrom({}); } catch (_) { threw = true; }
    check(threw, 'no env key: throws, nothing is read from disk');
    check(loadWebKeyFrom({}, 'example-config-app-id-000000000000') === 'example-config-app-id-000000000000', 'no env key: the settings file app_id is used');
    check(loadWebKeyFrom({ FIREBASE_API_KEY: 'example-env-plain-app-id-000000000' }, 'example-config-app-id-000000000000') === 'example-env-plain-app-id-000000000', 'env wins over the settings file app_id');
    const kf = path.join(root, 'k.key'); fs.writeFileSync(kf, `  ${FAKE.key}\n`);
    check(readKeyFile(kf) === FAKE.key, 'key file trimmed');
    let missing = false; try { readKeyFile(path.join(root, 'nope.key')); } catch (_) { missing = true; }
    fs.writeFileSync(path.join(root, 'empty.key'), '\n'); let empty = false; try { readKeyFile(path.join(root, 'empty.key')); } catch (_) { empty = true; }
    check(missing && empty, 'missing or empty key file throws');
    const d = realDeps();
    const keyOfAlpha = cfgFile('alpha').replace(/\.json$/, '.key');
    check(d.readKey(keyOfAlpha) === FAKE.key, 'the real key reader reads the key file named in the settings file');
    let missingKey = false; try { d.readKey(path.join(os.tmpdir(), 'agent-listen-no-such.key')); } catch (_) { missingKey = true; }
    check(missingKey, 'a missing key file is an error, not a silent empty key');
    const labels = Object.keys(TEST_IDENTITIES);
    check(labels.every((l) => JSON.parse(fs.readFileSync(cfgFile(l), 'utf8')).agent.email === TEST_IDENTITIES[l].email) && new Set(labels.map((l) => TEST_IDENTITIES[l].email)).size === labels.length, 'each synthetic settings file names its own address');
  });

  tc('T24', 'a signal id that changes (a rotated secret, seen in the catch-up reply) is followed: the listener listens to the new id and delivers from it', async () => {
    const r = await runCase(env, { id: 'T24', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 30000,
      at: [[4000, (W) => W.failSignal('unavailable')], [4500, (W) => { W.salt = 'rotated'; W.addEvent(DOC_A, { actor: HUMAN, body: 'under the new secret' }); }]] });
    check(same(r.events.map((e) => [e.seq, e.via]), [[4, 'safety']]), `lines ${r.outs.join(' | ')}`);
    check(r.W.listens.length >= 2 && r.W.listens[r.W.listens.length - 1].sid === sidFor(DOC_A + 'rotated'), `listened to ${r.W.listens.map((l) => l.sid.slice(0, 8))}: the last listen must be on the new id`);
  });

  tc('T25', 'a failing events read is retried with a growing pause (not every poll), then delivers once', async () => {
    const r = await runCase(env, { id: 'T25', world: (W) => { W.addDoc(DOC_A, 3); W.over.events = (n) => (n === 2 || n === 3 ? { status: 500, body: { error: 'x' } } : null); }, cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 30000,
      at: [[2000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'retry me' })]] });
    const ts = fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').map((e) => e.t);
    check(ts.length === 4, `events reads ${fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').map((e) => `${e.t}:${e.body.since}`).join(', ')}`);
    check(ts[2] - ts[1] >= 1000 && ts[3] - ts[2] >= 2000, `gaps ${ts[2] - ts[1]} and ${ts[3] - ts[2]}`);
    check(r.events.length === 1 && r.events[0].seq === 4 && r.code === 0, `lines ${r.outs.join(' | ')}`);
  });

  tc('T26', 'has_more pages are read to the end, once each, in order', async () => {
    const r = await runCase(env, { id: 'T26', world: (W) => { W.addDoc(DOC_A, 7); W.pageSize = 2; }, cursor: { [DOC_A]: 2 }, mode: 'stream', stopAt: 6000 });
    check(same(r.events.map((e) => e.seq), [3, 4, 5, 6, 7]), `seqs ${r.events.map((e) => e.seq)}`);
    check(same(fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').map((e) => e.body.since), [FUTURE_SINCE, 2, 4, 6]), `one read per page: ${fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').map((e) => `${e.t}:${e.body.since}`).join(', ')}`);
    check(same(r.cursor, { [DOC_A]: 7 }), `cursor ${r.cursorText}`);
  });

  tc('T27', 'excerpt is the first 160 characters (whole code points), one line per event even for a multi-line body', async () => {
    const long = `${'x'.repeat(158)}\u{1F600}tail and more\nsecond line`;
    const multi = 'line one\nline two\ttabbed "quoted"';
    const r = await runCase(env, { id: 'T27', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 9000,
      at: [[2000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: long })], [4000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: multi })], [6000, (W) => W.addEvent(DOC_A, { actor: HUMAN, verb: 'comment.deleted', commentId: crypto.randomUUID() })]] });
    check(r.events.length === 3, `lines ${r.outs.length}`);
    check(r.events[0].excerpt === `${'x'.repeat(158)}\u{1F600}t` && Array.from(r.events[0].excerpt).length === 160, 'long body cut at 160 code points');
    check(r.events[1].excerpt === multi, 'short multi-line body kept whole');
    check(r.events[2].excerpt === '' && r.events[2].kind === 'comment.deleted' && r.events[2].author_kind === 'human', 'a deleted comment has an empty excerpt and keeps the actor kind');
    check(r.outs.every((s) => !/[\n\r]/.test(s)), 'a printed line holds a raw newline');
  });

  tc('T28', 'identity ui: its own address, its own events skipped, the OTHER agent and the human both wake it', async () => {
    const r = await runCase(env, { id: 'T28', identity: 'beta', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 12000,
      at: [[2000, (W) => W.addEvent(DOC_A, { actor: { ...OTHER, email: UI_EMAIL }, body: 'beta own' })], [4000, (W) => W.addEvent(DOC_A, { actor: OWN, body: 'alpha says hi' })],
        [6000, (W) => W.addEvent(DOC_A, { actor: HUMAN, verb: 'comment.reacted', commentId: [...W.docs.get(DOC_A).comments.keys()].pop(), body: 'ignored for reactions' })]] });
    check(same(r.events.map((e) => e.seq), [5, 6]), `seqs ${r.events.map((e) => e.seq)}`);
    check(r.events[0].author_kind === 'agent' && r.events[0].author_name === 'Alpha agent' && r.events[1].author_kind === 'human' && r.events[1].kind === 'comment.reacted' && r.events[1].author_name === null, `lines ${r.outs.join(' | ')}`);
    check(r.W.mints.every((m) => m.email === UI_EMAIL), 'the mint carried the beta address');
  });

  tc('T28b', 'identity gamma (synthetic settings file): its own address in the mint, its own events skipped, the alpha and beta agents and the human all wake it', async () => {
    const SELF = { email: TEST_IDENTITIES.gamma.email, kind: 'agent', name: 'Gamma agent' };
    const r = await runCase(env, { id: 'T28b', identity: 'gamma', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 14000,
      at: [[2000, (W) => W.addEvent(DOC_A, { actor: SELF, body: 'gamma own' })], [4000, (W) => W.addEvent(DOC_A, { actor: OWN, body: 'alpha says hi' })],
        [6000, (W) => W.addEvent(DOC_A, { actor: OTHER, body: 'beta says hi' })], [8000, (W) => W.addEvent(DOC_A, { actor: { ...SELF, email: SELF.email.toUpperCase() }, body: 'gamma own, other letter case' })],
        [10000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'human says hi' })]] });
    check(same(r.events.map((e) => e.seq), [5, 6, 8]), `seqs ${r.events.map((e) => e.seq)}`);
    check(r.events[0].author_name === 'Alpha agent' && r.events[1].author_name === 'Beta agent' && r.events[2].author_kind === 'human', `lines ${r.outs.join(' | ')}`);
    check(r.W.mints.length >= 1 && r.W.mints.every((m) => m.email === TEST_IDENTITIES.gamma.email), 'the mint carried the gamma address');
    check(same(r.cursor, { [DOC_A]: 8 }), `cursor ${r.cursorText}`);
  });

  tc('T28e', 'the SDK folder is SPM_AGENT_RUNTIME_DIR when set, else the home runtime folder', async () => {
    check(RUNTIME_DIR === (process.env.SPM_AGENT_RUNTIME_DIR || path.join(os.homedir(), '.spm-agent-runtime')), 'runtime folder rule');
  });

  tc('T28c', 'no settings file: one plain line and exit 2; the usage text says each listener needs its OWN --cursor-file', async () => {
    const errs = [];
    const deps = { io: { out: () => {}, err: (x) => errs.push(x) }, proc: new (require('node:events'))(), readKey: () => FAKE.key, loadWebKey: () => FAKE.webKey, http: () => { throw new Error('network'); }, now: () => T0, sleep: async () => {}, requestTimeoutMs: 100 };
    const code = await main(['--document', DOC_A, '--cursor-file', '/tmp/x.json'], deps);
    check(code === 2 && errs.length === 1 && /^agent-listen: no settings file/.test(errs[0]), `one plain line expected: ${JSON.stringify(errs)}`);
    check(/--config <abs path>/.test(USAGE) && /OWN --cursor-file/.test(USAGE), 'the usage names --config and says each listener needs its OWN --cursor-file');
    const tt = parseArgs(['--config', cfgFile('delta'), '--inbox', '--cursor-file', '/tmp/x.json']);
    check(tt.ok === true && tt.cfg.inbox === true, `inbox parse ${JSON.stringify(tt)}`);
    const ok = parseArgs(['--config', cfgFile('gamma'), '--document', DOC_A, '--cursor-file', '/tmp/agent-listen-third.json']);
    check(ok.ok === true && ok.cfg.cursorFile === '/tmp/agent-listen-third.json', `document parse ${JSON.stringify(ok)}`);
  });
  // ---- the safety read: a marker write can fail on a cold server; the listener then reads the events itself after --safety-s seconds without any events read
  const sinceList = (W, doc) => fnCalls(W, '/documentsApi/listDocumentCommentEvents').filter((e) => !doc || e.body.documentId === doc).map((e) => e.body.since);
  const fallbackLines = (r) => r.W.outLog.filter((l) => /"fallback":/.test(l.s));
  const lostMarkerEvent = (body, extra) => (W) => W.addEvent(DOC_A, { actor: HUMAN, body, publish: false, ...(extra || {}) });

  tc('T32', 'a LOST bump (it never reaches the stream) is not recovered by any timer: no read while it waits, and the next bump delivers the lost event too', async () => {
    const r = await runCase(env, { id: 'T32', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 200000,
      at: [[4000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'lost bump', publish: false })], [150000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'next bump' })]] });
    check(same(r.events.map((e) => [e.seq, e.via]), [[4, 'marker'], [5, 'marker']]), `lines ${r.outs.join(' | ')}`);
    check(fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').filter((e) => e.t > 0 && e.t < 150000).length === 0, 'a read ran while the lost bump was waiting');
    check(r.W.count.events === 2, `events reads ${r.W.count.events}: the baseline and the next bump's one read`);
  });

  tc('T32b', '--safety-s is refused (exit 2): the lost-bump timer is gone; the refusal names the ', async () => {
    const p = parseArgs(['--config', cfgFile('alpha'), '--document', DOC_A, '--cursor-file', path.join(RUN_DIR, 'T32b', 'cursor.json'), '--safety-s', '20']);
    check(p.ok === false && /--safety-s is refused/.test(p.error) && /is refused/.test(p.error), `parsed ${JSON.stringify(p)}`);
  });

  tc('T33', 'a marker-triggered event carries via "marker" (the last key), and no safety read runs while the marker works', async () => {
    const r = await runCase(env, { id: 'T33', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 12000, at: [[4000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'marker works' })]] });
    check(r.events.length === 1 && r.events[0].seq === 4 && r.events[0].via === 'marker', `lines ${r.outs.join(' | ')}`);
    check(same(Object.keys(r.events[0]), EVENT_KEYS) && Object.keys(r.events[0])[8] === 'via', `keys ${Object.keys(r.events[0])}`);
    check(same(sinceList(r.W), [FUTURE_SINCE, 3]), `events reads asked since ${sinceList(r.W)}: baseline and the one marker-triggered read, nothing else`);
  });

  tc('T34', 'no fallback line is ever printed, and a snapshot-delivered event carries via "marker"', async () => {
    const r = await runCase(env, { id: 'T34', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 120000, at: [[4000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'marker path' })]] });
    check(r.outs.every((s) => !s.includes('"fallback"')), `a fallback line was printed: ${r.outs.join(' | ')}`);
    check(r.events.length === 1 && r.events[0].via === 'marker', `lines ${r.outs.join(' | ')}`);
  });

  tc('T35', 'a marker bump and the safety timer in the SAME tick deliver each event once (the marker path wins, the cursor is the single source of truth)', async () => {
    const r = await runCase(env, { id: 'T35', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 100000, at: [[60000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'bump and timer together' })]] });
    check(r.events.length === 1 && r.events[0].seq === 4 && r.events[0].via === 'marker', `lines ${r.outs.join(' | ')}`);
    check(r.W.outLog[0].t - T0 === 60000, `delivered at ${r.W.outLog[0].t - T0} ms: the round in which the marker moved and the 60 s window ended together`);
    check(same(sinceList(r.W), [FUTURE_SINCE, 3]), `events reads asked since ${sinceList(r.W)}: ONE read in that tick, not a marker read plus a safety read`);
    check(same(r.cursor, { [DOC_A]: 4 }), `cursor ${r.cursorText}`);
  });

  tc('T36', 'the retired flags --poll-ms, --fallback-s and --safety-s are each refused (exit 2, naming the ) before any call or key read; the usage text names none of them', async () => {
    const base = ['--config', cfgFile('alpha'), '--document', DOC_A, '--cursor-file', path.join(RUN_DIR, 'T36', 'cursor.json')];
    for (const f of ['--poll-ms', '--fallback-s', '--safety-s']) {
      const p = parseArgs([...base, f, '60']);
      check(p.ok === false && p.error.includes(f) && /is refused/.test(p.error), `${f}: ${JSON.stringify(p)}`);
    }
    check(!/--poll-ms|--fallback-s|--safety-s|--inbox/.test(USAGE), 'the usage text still names a retired flag');
  });

  tc('T37', '--mode once exits 0 right after a snapshot delivery (one line, and no read after it)', async () => {
    const r = await runCase(env, { id: 'T37', world: (W) => W.addDoc(DOC_A, 2), cursor: { [DOC_A]: 2 }, mode: 'once', stopAt: 30000,
      at: [[4000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'one' })], [9000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'later' })]] });
    check(r.code === 0 && r.events.length === 1 && r.events[0].seq === 3, `code ${r.code} lines ${r.outs.join(' | ')}`);
    check(fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').filter((e) => e.t >= 4000).length === 1, 'a read ran after the delivery');
  });

  tc('T38', 'the safety read does NOT run while markers keep delivering: one events read per marker-triggered batch, every line via "marker"', async () => {
    const times = [20000, 50000, 80000, 110000, 140000, 170000];
    const r = await runCase(env, { id: 'T38', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 200000, at: times.map((ms, i) => [ms, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: `steady ${i}` })]) });
    check(r.events.length === 6 && r.events.every((e) => e.via === 'marker') && same(r.events.map((e) => e.seq), [4, 5, 6, 7, 8, 9]), `lines ${r.outs.join(' | ')}`);
    check(same(sinceList(r.W), [FUTURE_SINCE, 3, 4, 5, 6, 7, 8]), `events reads asked since ${sinceList(r.W)}`);
  });

  tc('T39', 'own events are dropped on the snapshot path like any other path (and printed with --self-actor-skip false); the cursor passes them either way', async () => {
    const at = [[3000, (W) => { W.addEvent(DOC_A, { actor: OWN, body: 'my own' }); W.addEvent(DOC_A, { actor: OTHER, body: 'the other agent' }); }]];
    const r = await runCase(env, { id: 'T39a', world: (W) => W.addDoc(DOC_A, 2), cursor: { [DOC_A]: 2 }, mode: 'stream', stopAt: 10000, at });
    check(same(r.events.map((e) => e.excerpt), ['the other agent']) && same(r.cursor, { [DOC_A]: 4 }), `skip on: lines ${r.outs.join(' | ')} cursor ${r.cursorText}`);
    const r2 = await runCase(env, { id: 'T39b', world: (W) => W.addDoc(DOC_A, 2), cursor: { [DOC_A]: 2 }, mode: 'stream', stopAt: 10000, at, selfSkip: false });
    check(same(r2.events.map((e) => e.excerpt), ['my own', 'the other agent']), `skip off: ${r2.outs.join(' | ')}`);
  });

  tc('T40', 'two documents: a lost bump in B is not recovered by any timer (B\'s next bump delivers it); A, whose bumps arrive, is read on its own bumps only', async () => {
    const r = await runCase(env, { id: 'T40', docs: [DOC_A, DOC_B], world: (W) => { W.addDoc(DOC_A, 2); W.addDoc(DOC_B, 2); }, cursor: { [DOC_A]: 2, [DOC_B]: 2 }, mode: 'stream', stopAt: 200000,
      at: [[4000, (W) => W.addEvent(DOC_B, { actor: HUMAN, body: 'lost in B', publish: false })], [5000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'a bump' })], [150000, (W) => W.addEvent(DOC_B, { actor: HUMAN, body: 'b bump' })]] });
    check(same(r.events.map((e) => [e.document_id, e.seq]), [[DOC_A, 3], [DOC_B, 3], [DOC_B, 4]]), `lines ${r.outs.join(' | ')}`);
    check(fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').filter((e) => e.body.documentId === DOC_B && e.t < 150000).length === 1, 'B was read between its baseline and its bump');
  });

  tc('T41', '--mode once exits 0 right after a catch-up delivery after a signal error (via "safety")', async () => {
    const r = await runCase(env, { id: 'T41', world: (W) => W.addDoc(DOC_A, 2), cursor: { [DOC_A]: 2 }, mode: 'once', stopAt: 60000,
      at: [[4000, (W) => W.failSignal('unavailable')], [4500, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'sent while down', publish: false })]] });
    check(r.code === 0 && r.events.length === 1 && r.events[0].via === 'safety' && r.events[0].seq === 3, `code ${r.code} lines ${r.outs.join(' | ')}`);
  });

  tc('T42', 'a signal error that hides a bump: the recovered stream catches up (via "safety"), and the next bump is delivered via "marker" with no timer read in between', async () => {
    const r = await runCase(env, { id: 'T42', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'stream', stopAt: 60000,
      at: [[4000, (W) => W.failSignal('unavailable')], [4500, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'hidden bump', publish: false })], [30000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'next bump' })]] });
    check(same(r.events.map((e) => [e.seq, e.via]), [[4, 'safety'], [5, 'marker']]), `lines ${r.outs.join(' | ')}`);
    check(fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').filter((e) => e.t > 4000 && e.t < 30000).length === 1, 'reads between the error and the next bump');
  });
  // ---- reply wiring: parent_id, thread_root_id and the FULL body ride on every event line, from the comment the events read already returns
  tc('T43', 'a REPLY event carries parent_id (its parent) and thread_root_id = that parent, plus the full body', async () => {
    const top = crypto.randomUUID(); const reply = crypto.randomUUID();
    const r = await runCase(env, { id: 'T43', world: (W) => { W.addDoc(DOC_A, 3); W.addEvent(DOC_A, { actor: HUMAN, body: 'top level', commentId: top, publish: false }); }, cursor: { [DOC_A]: 4 }, mode: 'once',
      at: [[3000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'a reply under the top comment', commentId: reply, parent: top })]] });
    check(r.code === 0 && r.events.length === 1, `exit ${r.code} lines ${r.outs.join(' | ')}`);
    const ev = r.events[0];
    check(same(Object.keys(ev), EVENT_KEYS), `keys ${Object.keys(ev)}`);
    check(ev.comment_id === reply && ev.parent_id === top && ev.thread_root_id === top && ev.body === 'a reply under the top comment' && !('body_truncated' in ev), `line ${r.outs[0]}`);
  });

  tc('T44', 'a TOP-LEVEL event has parent_id null and thread_root_id = its own comment id', async () => {
    const top = crypto.randomUUID();
    const r = await runCase(env, { id: 'T44', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'once', at: [[3000, (W) => W.addEvent(DOC_A, { actor: HUMAN, body: 'a new top level comment', commentId: top })]] });
    check(r.code === 0 && r.events.length === 1, `exit ${r.code} lines ${r.outs.join(' | ')}`);
    const ev = r.events[0];
    check(ev.comment_id === top && ev.parent_id === null && ev.thread_root_id === top && ev.body === 'a new top level comment', `line ${r.outs[0]}`);
  });

  tc('T45', 'a DELETED comment (no current comment) has parent_id null, thread_root_id null and an empty body: the thread cannot be known', async () => {
    const gone = crypto.randomUUID();
    const r = await runCase(env, { id: 'T45', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'once', at: [[3000, (W) => W.addEvent(DOC_A, { actor: HUMAN, verb: 'comment.deleted', commentId: gone, parent: crypto.randomUUID() })]] });
    check(r.code === 0 && r.events.length === 1, `exit ${r.code} lines ${r.outs.join(' | ')}`);
    const ev = r.events[0];
    check(ev.kind === 'comment.deleted' && ev.comment_id === gone && ev.parent_id === null && ev.thread_root_id === null && ev.body === '' && ev.excerpt === '' && !('body_truncated' in ev), `line ${r.outs[0]}`);
  });

  tc('T46', 'a 5,000-code-point body is cut to 4,000 code points with body_truncated true; exactly 4,000 is not flagged; the excerpt stays 160', async () => {
    const big = '\u{1F600}'.repeat(5000); const exact = 'x'.repeat(3999) + '\u{1F600}';
    const r = await runCase(env, { id: 'T46', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'once', at: [[3000, (W) => { W.addEvent(DOC_A, { actor: HUMAN, body: big }); W.addEvent(DOC_A, { actor: HUMAN, body: exact }); }]] });
    check(r.code === 0 && r.events.length === 2, `exit ${r.code} lines ${r.outs.length}`);
    const [a, b] = r.events;
    check(Array.from(a.body).length === 4000 && a.body === '\u{1F600}'.repeat(4000) && a.body_truncated === true && Array.from(a.excerpt).length === 160, `big: ${Array.from(a.body).length} cp, flag ${a.body_truncated}`);
    check(same(Object.keys(a), [...EVENT_KEYS, 'body_truncated']), `big keys ${Object.keys(a)}`);
    check(b.body === exact && !('body_truncated' in b) && same(Object.keys(b), EVENT_KEYS), `exact: ${Array.from(b.body).length} cp, keys ${Object.keys(b)}`);
  });

  tc('T47', 'a pasted key or token in the body is redacted (also when it straddles the 4,000 cut: redact first, then cut)', async () => {
    const jwt = fakeJwt({ uid: FAKE.uid });
    const r = await runCase(env, { id: 'T47', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'once',
      at: [[3000, (W) => { W.addEvent(DOC_A, { actor: HUMAN, body: `my key is ${FAKE.key} and a token ${jwt} and ${FAKE.webKey}, ok` }); W.addEvent(DOC_A, { actor: HUMAN, body: 'a'.repeat(3995) + FAKE.key }); }]] });
    check(r.code === 0 && r.events.length === 2, `exit ${r.code} lines ${r.outs.length}`);
    const all = r.outs.join('\n');
    check(!all.includes(FAKE.key) && !all.includes(jwt) && !all.includes(FAKE.webKey) && !all.includes('spm_k'), 'a key, token or fragment of one reached stdout');
    check(r.events[0].body === 'my key is [redacted] and a token [redacted] and [redacted], ok', `body ${r.events[0].body}`);
    check(r.events[1].body === 'a'.repeat(3995) + '[reda' && r.events[1].body_truncated === true, `straddle body tail ${r.events[1].body.slice(3990)} flag ${r.events[1].body_truncated}`);
  });

  // ==== BOARD AND MAP COMMENTS: --board and --map, the same flow per item, the same guard style. The fake answers in the REAL wire (frozen from the real routers; see SHAPE_CHECKED).
  const C1 = '00000000-0000-4000-8000-000000000009'; const C2 = '00000000-0000-4000-8000-00000000000a'; const C3 = '00000000-0000-4000-8000-00000000000b';
  const itemReads = (W, fn) => W.log.filter((e) => e.h === 'fn' && e.p.startsWith(`/${fn}/`));
  const sinceOf = (e) => Number(new URLSearchParams(e.q).get('since'));
  const idHeaders = (e) => e.hdr.filter((h) => h.startsWith('x-spm') || h === 'origin' || h === 'authorization' || h === 'content-type' || h === 'content-length' || h === 'cookie' || h === 'referer');

  tc('T48', 'the command line: --board and --map parse next to --document; --document is optional but one of the three is required; the cap of 20 counts all three; no uuid twice within a flag; ids lower-cased', async () => {
    const base = ['--config', cfgFile('alpha'), '--cursor-file', '/tmp/x.json'];
    const ok = parseArgs([...base, '--board', `${upperCase(BOARD_A)},${BOARD_B}`, '--map', MAP_A]);
    check(ok.ok === true && same(ok.cfg.boards, [upperCase(BOARD_A).toLowerCase(), BOARD_B]) && same(ok.cfg.maps, [MAP_A]) && same(ok.cfg.documents, []), `boards and maps ${JSON.stringify(ok)}`);
    const only = parseArgs([...base, '--map', `${MAP_A},${MAP_B}`]);
    check(only.ok === true && same(only.cfg.maps, [MAP_A, MAP_B]) && same(only.cfg.boards, []) && same(only.cfg.documents, []), `maps only ${JSON.stringify(only)}`);
    const all3 = parseArgs([...base, '--document', DOC_A, '--board', BOARD_A, '--map', MAP_A]);
    check(all3.ok === true && same(all3.cfg.documents, [DOC_A]) && same(all3.cfg.boards, [BOARD_A]) && same(all3.cfg.maps, [MAP_A]), `all three ${JSON.stringify(all3)}`);
    const same1 = parseArgs([...base, '--document', DOC_A, '--board', DOC_A, '--map', DOC_A]);
    check(same1.ok === true, 'one uuid in three different flags is three different items (a document, a board and a map may share a uuid)');
    const uuids = (n, from = 0) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(from + i).padStart(12, '0')}`);
    const exact20 = parseArgs([...base, '--document', uuids(7).join(','), '--board', uuids(7, 100).join(','), '--map', uuids(6, 200).join(',')]);
    check(exact20.ok === true, `7 + 7 + 6 = 20 items must be accepted: ${JSON.stringify(exact20).slice(0, 100)}`);
    const bads = [
      ['no flag of the three', base], ['--board twice', [...base, '--board', BOARD_A, '--board', BOARD_B]], ['--map twice', [...base, '--map', MAP_A, '--map', MAP_B]],
      ['--board not a uuid', [...base, '--board', 'not-a-uuid']], ['--map not a uuid', [...base, '--map', 'not-a-uuid']], ['--board empty', [...base, '--board', '']], ['--map trailing comma', [...base, '--map', `${MAP_A},`]],
      ['--board repeats a uuid', [...base, '--board', `${BOARD_A},${BOARD_B},${BOARD_A}`]], ['--map repeats a uuid', [...base, '--map', `${MAP_A},${MAP_A}`]],
      ['21 boards', [...base, '--board', uuids(21).join(',')]], ['21 maps', [...base, '--map', uuids(21).join(',')]],
      ['10 + 10 + 1 over the cap', [...base, '--document', uuids(10).join(','), '--board', uuids(10, 100).join(','), '--map', uuids(1, 200).join(',')]],
      ['1 + 20 over the cap', [...base, '--document', DOC_A, '--board', uuids(20, 100).join(',')]],
    ];
    for (const [name, argv] of bads) { const p = parseArgs(argv); check(p.ok === false, `${name} was accepted`); }
    let calls = 0; const err = [];
    const deps = { io: { out: () => { calls++; }, err: (x) => err.push(x) }, proc: new (require('node:events'))(), readKey: () => { calls++; return FAKE.key; }, loadWebKey: () => { calls++; return FAKE.webKey; }, http: () => { calls++; throw new Error('network'); }, now: () => T0, sleep: async () => { calls++; }, requestTimeoutMs: 100 };
    for (const [name, argv] of bads) { if (parseArgs(argv).ok) continue; /* already reported above; running it would start a listener */ err.length = 0; const code = await main(argv, deps); check(code === 2 && err.some((x) => x.includes('usage')), `${name}: exit ${code}`); }
    check(calls === 0, `${calls} call(s) before a usage error`);
  });

  tc('T49', 'a BOARD: baseline read, marker, since-cursor read through GET /boardsApi/boards/<id>/comment-events?since=<n> with the key and the typed address only (no Origin, no body); the line carries item_type, item_id and task_id in the documented order; cursor key board:<id>', async () => {
    const body = 'Hello agent, please look at the task';
    const r = await runCase(env, { id: 'T49', boards: [BOARD_A], world: (W) => W.addItem('board', BOARD_A, 3), cursor: { [bkey(BOARD_A)]: 3 }, mode: 'once', at: [[4000, (W) => W.addEvent(bkey(BOARD_A), { actor: HUMAN, body, commentId: C1 })]] });
    check(r.code === 0 && r.events.length === 1 && r.lines.length === 1, `exit ${r.code} lines ${r.outs.join(' | ')}`);
    const ev = r.events[0];
    check(same(Object.keys(ev), BOARD_KEYS), `keys ${Object.keys(ev)}`);
    check(ev.item_type === 'board' && ev.item_id === BOARD_A && ev.task_id === TASK_A && ev.seq === 4 && ev.kind === 'comment.created' && ev.comment_id === C1 && ev.author_kind === 'human' && ev.author_name === 'Person Fake' && ev.excerpt === body && ev.body === body && ev.via === 'marker' && ev.parent_id === null && ev.thread_root_id === C1 && !('document_id' in ev), `line ${r.outs[0]}`);
    check(ISO_IST_RE.test(ev.t), `t ${ev.t}`);
    const reads = itemReads(r.W, 'boardsApi');
    check(reads.length >= 2 && reads.every((e) => e.m === 'GET' && e.body === undefined), `board reads ${reads.map((e) => e.m + e.p + e.q)}`);
    check(reads[0].p === `/boardsApi/boards/${BOARD_A}/comment-events` && reads[0].q === `?since=${FUTURE_SINCE}` && reads[1].q === '?since=3', `first reads ${reads.slice(0, 2).map((e) => e.p + e.q)}`);
    check(reads.every((e) => same(idHeaders(e), ['x-spm-api-key', 'x-spm-user-email'])), `headers ${reads.map((e) => idHeaders(e))}`);
    check(r.W.listens.some((l) => l.sid === sidFor(bkey(BOARD_A))), 'the signal listen used the board signal id (domain separated from the document id)');
    check(fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').length === 0 && same(r.cursor, { [bkey(BOARD_A)]: 4 }), `document route calls ${fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').length}, cursor ${r.cursorText}`);
  });

  tc('T50', 'a MAP: GET /mapsApi/maps/<id>/comment-events; the line has item_type map, item_id and NO task_id; cursor key map:<id>; an unknown map starts at its current max (no replay)', async () => {
    const r = await runCase(env, { id: 'T50', maps: [MAP_A], world: (W) => W.addItem('map', MAP_A, 3), mode: 'once', at: [[4000, (W) => W.addEvent(mkey(MAP_A), { actor: HUMAN, body: 'a comment on a box', commentId: C1 })]] });
    check(r.code === 0 && r.events.length === 1, `exit ${r.code} lines ${r.outs.join(' | ')}`);
    const ev = r.events[0];
    check(same(Object.keys(ev), MAP_KEYS) && ev.item_type === 'map' && ev.item_id === MAP_A && ev.seq === 4 && ev.thread_root_id === C1 && ev.via === 'marker' && ev.excerpt === 'a comment on a box', `line ${r.outs[0]}`);
    const reads = itemReads(r.W, 'mapsApi');
    check(reads[0].p === `/mapsApi/maps/${MAP_A}/comment-events` && reads[0].q === `?since=${FUTURE_SINCE}` && reads.every((e) => e.m === 'GET' && same(idHeaders(e), ['x-spm-api-key', 'x-spm-user-email'])), `reads ${reads.map((e) => e.m + e.p + e.q)}`);
    check(itemReads(r.W, 'boardsApi').length === 0 && same(r.cursor, { [mkey(MAP_A)]: 4 }), `cursor ${r.cursorText}`);
  });

  tc('T51', 'a document, a board and a map with the SAME uuid keep three separate cursors (bare uuid, board:<uuid>, map:<uuid>); an existing bare-uuid cursor file works unchanged and is not read for the board or the map', async () => {
    const SAME = DOC_A;
    const r = await runCase(env, { id: 'T51', docs: [SAME], boards: [SAME], maps: [SAME], cursor: { [SAME]: 2 }, mode: 'stream', stopAt: 12000,
      world: (W) => { W.addDoc(SAME, 2); W.addItem('board', SAME, 5); W.addItem('map', SAME, 9); },
      at: [[4000, (W) => { W.addEvent(SAME, { actor: HUMAN, body: 'doc comment' }); W.addEvent(bkey(SAME), { actor: HUMAN, body: 'board comment' }); W.addEvent(mkey(SAME), { actor: HUMAN, body: 'map comment' }); }]] });
    const doc = r.events.filter((e) => e.document_id === SAME); const board = r.events.filter((e) => e.item_type === 'board'); const map = r.events.filter((e) => e.item_type === 'map');
    check(r.events.length === 3 && doc.length === 1 && board.length === 1 && map.length === 1, `lines ${r.outs.join(' | ')}`);
    check(doc[0].seq === 3 && doc[0].excerpt === 'doc comment' && board[0].seq === 6 && board[0].excerpt === 'board comment' && map[0].seq === 10 && map[0].excerpt === 'map comment', 'each line came from its own stream, from its own cursor (3, 6, 10)');
    check(same(r.cursor, { [SAME]: 3, [bkey(SAME)]: 6, [mkey(SAME)]: 10 }), `cursor ${r.cursorText}`);
    const sids = r.W.listens.map((l) => l.sid);
    check([SAME, bkey(SAME), mkey(SAME)].every((k) => sids.includes(sidFor(k))), 'three signal ids were listened to (document, board and map ids differ for the same uuid)');
  });

  tc('T52', 'board and map lines for a top-level comment, a REPLY, a reply whose task differs from the default, and a DELETED comment: task_id from the comment (null once it is gone), thread root from the parent', async () => {
    const OTHER_TASK = '00000000-0000-4000-8000-00000000000c';
    const r = await runCase(env, { id: 'T52', boards: [BOARD_A], maps: [MAP_A], world: (W) => { W.addItem('board', BOARD_A, 3); W.addItem('map', MAP_A, 3); }, mode: 'stream', stopAt: 15000,
      at: [[3000, (W) => {
        W.addEvent(bkey(BOARD_A), { actor: HUMAN, body: 'top', commentId: C1 });
        W.addEvent(bkey(BOARD_A), { actor: HUMAN, body: 'reply', commentId: C2, parent: C1 });
        W.addEvent(bkey(BOARD_A), { actor: HUMAN, body: 'on another task', commentId: C3, target: OTHER_TASK });
        W.addEvent(bkey(BOARD_A), { actor: OTHER, verb: 'comment.deleted', commentId: crypto.randomUUID() });
        W.addEvent(mkey(MAP_A), { actor: HUMAN, body: 'map top', commentId: C1 });
        W.addEvent(mkey(MAP_A), { actor: HUMAN, body: 'map reply', commentId: C2, parent: C1 });
      }]] });
    const b = r.events.filter((e) => e.item_type === 'board'); const m = r.events.filter((e) => e.item_type === 'map');
    check(b.length === 4 && m.length === 2, `lines ${r.outs.join(' | ')}`);
    check(b[0].task_id === TASK_A && b[0].parent_id === null && b[0].thread_root_id === C1, `top ${JSON.stringify(b[0])}`);
    check(b[1].kind === 'comment.created' && b[1].parent_id === C1 && b[1].thread_root_id === C1 && b[1].task_id === TASK_A && b[1].body === 'reply', `reply ${JSON.stringify(b[1])}`);
    check(b[2].task_id === OTHER_TASK, `the task id is the comment's own: ${b[2].task_id}`);
    check(b[3].kind === 'comment.deleted' && b[3].task_id === null && b[3].thread_root_id === null && b[3].parent_id === null && b[3].body === '' && b[3].excerpt === '' && same(Object.keys(b[3]), BOARD_KEYS), `deleted ${JSON.stringify(b[3])}`);
    check(m[1].parent_id === C1 && m[1].thread_root_id === C1 && same(Object.keys(m[1]), MAP_KEYS) && !('task_id' in m[1]), `map reply ${JSON.stringify(m[1])}`);
    check(r.W.log.every((e) => e.p !== '/boardsApi/comments' && !/^\/boardsApi\/comments\//.test(e.p)), 'no extra read of GET /comments/<id> was needed: the events read already carries the comment and its task');
  });

  tc('T53', 'board and map: own events are skipped (the cursor passes them), the other agent and a human wake the listener; --self-actor-skip false prints own events too', async () => {
    const ats = [[3000, (W) => { W.addEvent(bkey(BOARD_A), { actor: OWN, body: 'my own board comment' }); W.addEvent(bkey(BOARD_A), { actor: OTHER, body: 'the other agent on the board' }); W.addEvent(mkey(MAP_A), { actor: OWN, body: 'my own map comment' }); W.addEvent(mkey(MAP_A), { actor: HUMAN, body: 'a human on the map' }); }]];
    const world = (W) => { W.addItem('board', BOARD_A, 3); W.addItem('map', MAP_A, 3); };
    const r = await runCase(env, { id: 'T53a', boards: [BOARD_A], maps: [MAP_A], world, mode: 'stream', stopAt: 12000, at: ats });
    check(same(r.events.map((e) => e.excerpt), ['the other agent on the board', 'a human on the map']) && same(r.cursor, { [bkey(BOARD_A)]: 5, [mkey(MAP_A)]: 5 }), `lines ${r.outs.join(' | ')} cursor ${r.cursorText}`);
    const r2 = await runCase(env, { id: 'T53b', boards: [BOARD_A], maps: [MAP_A], world, mode: 'stream', stopAt: 12000, at: ats, selfSkip: false });
    check(r2.events.length === 4 && r2.events[0].excerpt === 'my own board comment', `with --self-actor-skip false: ${r2.events.length} lines`);
  });

  tc('T54', 'board and map: a LOST bump is not recovered by any timer (the next bump delivers it); a signal error is caught up once (via "safety") for boards and maps alike', async () => {
    const lost = await runCase(env, { id: 'T54a', boards: [BOARD_A], maps: [MAP_A], world: (W) => { W.addItem('board', BOARD_A, 3); W.addItem('map', MAP_A, 3); }, mode: 'stream', stopAt: 200000,
      at: [[4000, (W) => { W.addEvent(bkey(BOARD_A), { actor: HUMAN, body: 'board marker lost', publish: false }); W.addEvent(mkey(MAP_A), { actor: HUMAN, body: 'map marker lost', publish: false }); }],
        [150000, (W) => { W.addEvent(bkey(BOARD_A), { actor: HUMAN, body: 'board bump' }); W.addEvent(mkey(MAP_A), { actor: HUMAN, body: 'map bump' }); }]] });
    check(lost.events.length === 4 && lost.events.every((e) => e.via === 'marker') && lost.events.filter((e) => e.item_type === 'board').length === 2, `lines ${lost.outs.join(' | ')}`);
    check(same(lost.cursor, { [bkey(BOARD_A)]: 5, [mkey(MAP_A)]: 5 }), `cursor ${lost.cursorText}`);
    const cu = await runCase(env, { id: 'T54b', boards: [BOARD_A], maps: [MAP_A], world: (W) => { W.addItem('board', BOARD_A, 3); W.addItem('map', MAP_A, 3); }, mode: 'stream', stopAt: 60000,
      at: [[4000, (W) => W.failSignal('unavailable')], [4500, (W) => { W.addEvent(bkey(BOARD_A), { actor: HUMAN, body: 'board during the outage', publish: false }); W.addEvent(mkey(MAP_A), { actor: HUMAN, body: 'map during the outage', publish: false }); }]] });
    check(cu.events.length === 2 && cu.events.every((e) => e.via === 'safety') && cu.outs.every((s) => !s.includes('"fallback"')), `lines ${cu.outs.join(' | ')}`);
    check(itemReads(cu.W, 'boardsApi').filter((e) => e.t > 4000).length === 1 && itemReads(cu.W, 'mapsApi').filter((e) => e.t > 4000).length === 1, 'the catch-up was not one read per item');
  });

  tc('T55', 'the allow-list admits exactly the two comment-events reads (board and map, GET, query exactly since=<integer>, key and typed address only) and refuses every near-miss before the call', async () => {
    const A = `https://${FN_HOST}`; const key = { 'X-SPM-API-Key': FAKE.key, 'X-SPM-User-Email': BACKEND_EMAIL };
    const g = (url, method, headers, body) => { try { guardRequest(url, method, headers, body); return true; } catch (e) { return false; } };
    const B = `${A}/boardsApi/boards/${BOARD_A}/comment-events`; const M = `${A}/mapsApi/maps/${MAP_A}/comment-events`;
    const okCases = [[`${B}?since=0`, 'GET', key, undefined], [`${B}?since=7`, 'GET', key, undefined], [`${B}?since=${FUTURE_SINCE}`, 'GET', key, undefined], [`${M}?since=0`, 'GET', key, undefined], [`${M}?since=${FUTURE_SINCE}`, 'GET', { 'x-spm-api-key': 'k', 'x-spm-user-email': 'e@x' }, undefined]];
    okCases.forEach((c, i) => check(g(...c), `allowed item read #${i} was refused`));
    const bad = [
      ['POST on the board route', [`${B}?since=0`, 'POST', key, {}]], ['POST with no body on the board route', [`${B}?since=0`, 'POST', key, undefined]], ['POST with no body on the map route', [`${M}?since=0`, 'POST', key, undefined]], ['POST with a body on the map route', [`${M}?since=0`, 'POST', key, { documentId: DOC_A, since: 0 }]], ['PUT', [`${B}?since=0`, 'PUT', key, undefined]], ['DELETE', [`${M}?since=0`, 'DELETE', key, undefined]],
      ['a body on the GET', [`${B}?since=0`, 'GET', key, {}]],
      ['other function name', [`${A}/otherApi/boards/${BOARD_A}/comment-events?since=0`, 'GET', key, undefined]], ['itemsApi', [`${A}/itemsApi/boards/${BOARD_A}/comment-events?since=0`, 'GET', key, undefined]], ['accountApi', [`${A}/accountApi/maps/${MAP_A}/comment-events?since=0`, 'GET', key, undefined]],
      ['board path on mapsApi', [`${A}/mapsApi/boards/${BOARD_A}/comment-events?since=0`, 'GET', key, undefined]], ['map path on boardsApi', [`${A}/boardsApi/maps/${MAP_A}/comment-events?since=0`, 'GET', key, undefined]],
      ['no function name', [`${A}/boards/${BOARD_A}/comment-events?since=0`, 'GET', key, undefined]], ['tasks route', [`${A}/boardsApi/tasks/${TASK_A}/comments`, 'GET', key, undefined]], ['comments route', [`${A}/boardsApi/comments/${C1}`, 'GET', key, undefined]],
      ['the board itself', [`${A}/boardsApi/boards/${BOARD_A}`, 'GET', key, undefined]], ['the board list', [`${A}/boardsApi/boards?since=0`, 'GET', key, undefined]], ['another suffix', [`${A}/boardsApi/boards/${BOARD_A}/comment-events/x?since=0`, 'GET', key, undefined]],
      ['trailing slash', [`${B}/?since=0`, 'GET', key, undefined]], ['extra path segment before', [`${A}/boardsApi/x/boards/${BOARD_A}/comment-events?since=0`, 'GET', key, undefined]],
      ['id not a uuid', [`${A}/boardsApi/boards/not-a-uuid/comment-events?since=0`, 'GET', key, undefined]], ['id upper-case', [`${A}/boardsApi/boards/${upperCase(BOARD_A)}/comment-events?since=0`, 'GET', key, undefined]], ['id with dots', [`${A}/boardsApi/boards/../maps/${MAP_A}/comment-events?since=0`, 'GET', key, undefined]],
      ['no query', [B, 'GET', key, undefined]], ['empty query', [`${B}?`, 'GET', key, undefined]], ['extra query key', [`${B}?since=0&x=1`, 'GET', key, undefined]], ['other query key', [`${B}?cursor=0`, 'GET', key, undefined]], ['since twice', [`${B}?since=0&since=1`, 'GET', key, undefined]],
      ['since negative', [`${B}?since=-1`, 'GET', key, undefined]], ['since fractional', [`${B}?since=1.5`, 'GET', key, undefined]], ['since not a number', [`${B}?since=abc`, 'GET', key, undefined]], ['since empty', [`${B}?since=`, 'GET', key, undefined]],
      ['since with a leading zero', [`${B}?since=01`, 'GET', key, undefined]], ['since in exponent form', [`${B}?since=1e3`, 'GET', key, undefined]], ['since a hex number', [`${B}?since=0x10`, 'GET', key, undefined]], ['since too large for an integer', [`${M}?since=99999999999999999999`, 'GET', key, undefined]], ['since with a space', [`${B}?since=%200`, 'GET', key, undefined]],
      ['fragment', [`${B}?since=0#x`, 'GET', key, undefined]],
      ['us-central1 host', [`https://us-central1-litethink.cloudfunctions.net/boardsApi/boards/${BOARD_A}/comment-events?since=0`, 'GET', key, undefined]], ['other host', [`https://evil.invalid/boardsApi/boards/${BOARD_A}/comment-events?since=0`, 'GET', key, undefined]],
      ['look-alike host', [`https://${FN_HOST}.evil.com/boardsApi/boards/${BOARD_A}/comment-events?since=0`, 'GET', key, undefined]], ['http scheme', [`http://${FN_HOST}/boardsApi/boards/${BOARD_A}/comment-events?since=0`, 'GET', key, undefined]],
      ['port', [`https://${FN_HOST}:8443/mapsApi/maps/${MAP_A}/comment-events?since=0`, 'GET', key, undefined]], ['userinfo', [`https://u:p@${FN_HOST}/mapsApi/maps/${MAP_A}/comment-events?since=0`, 'GET', key, undefined]],
      ['Origin added', [`${B}?since=0`, 'GET', { ...key, Origin: 'https://app.superproductmanager.ai' }, undefined]], ['bearer added', [`${B}?since=0`, 'GET', { ...key, Authorization: 'Bearer x' }, undefined]], ['content-type added', [`${B}?since=0`, 'GET', { ...key, 'Content-Type': 'application/json' }, undefined]],
      ['workspace header added', [`${M}?since=0`, 'GET', { ...key, 'X-SPM-Workspace': 'ws' }, undefined]], ['key missing', [`${B}?since=0`, 'GET', { 'X-SPM-User-Email': BACKEND_EMAIL }, undefined]], ['typed address missing', [`${B}?since=0`, 'GET', { 'X-SPM-API-Key': FAKE.key }, undefined]], ['no headers at all', [`${M}?since=0`, 'GET', {}, undefined]],
      ['unparseable', ['not a url', 'GET', key, undefined]],
    ];
    for (const [name, c] of bad) check(!g(...c), `refused item case "${name}" was allowed`);
  });

  tc('T56', 'more than 100 events behind on a board: a reset line with item_type and item_id (no document_id), the newest 100 delivered, the cursor on the latest', async () => {
    const r = await runCase(env, { id: 'T56', boards: [BOARD_A], world: (W) => W.addItem('board', BOARD_A, 250), cursor: { [bkey(BOARD_A)]: 10 }, mode: 'once' });
    const resets = r.lines.filter((l) => l && l.reset === true);
    check(resets.length === 1 && same(Object.keys(resets[0]), ['t', 'item_type', 'item_id', 'reset', 'latest']) && resets[0].item_type === 'board' && resets[0].item_id === BOARD_A && resets[0].latest === 250, `reset lines ${JSON.stringify(resets)}`);
    check(r.events.length === 100 && r.events[0].seq === 151 && r.events[99].seq === 250 && same(r.cursor, { [bkey(BOARD_A)]: 250 }), `events ${r.events.length}, cursor ${r.cursorText}`);
    check(same(itemReads(r.W, 'boardsApi').map(sinceOf), [FUTURE_SINCE, 10, 150]), `reads ${itemReads(r.W, 'boardsApi').map(sinceOf)}`);
  });

  tc('T57', 'a board or map the key cannot open (404), a bad key (401): the run stops with exit 1 and a short message naming the item, no secret, no further reads', async () => {
    const r = await runCase(env, { id: 'T57a', boards: [BOARD_A], world: () => {}, mode: 'once' });
    check(r.code === 1 && r.errs.some((e) => e.includes('board') && e.includes(BOARD_A.slice(0, 8)) && e.includes('404')) && r.outs.length === 0, `exit ${r.code} err ${r.errs.join(' | ')}`);
    const r2 = await runCase(env, { id: 'T57b', maps: [MAP_A], world: (W) => W.addItem('map', MAP_A, 2), key: 'spm_k_test_wrongkey0000000000000000', mode: 'once' });
    check(r2.code === 1 && r2.errs.some((e) => e.includes('map') && e.includes(MAP_A.slice(0, 8)) && e.includes('401')) && !r2.errs.join(' ').includes('WRONGKEY'), `bad key: exit ${r2.code} err ${r2.errs.join(' | ')}`);
    const r3 = await runCase(env, { id: 'T57c', maps: [MAP_B], world: () => {}, mode: 'once' });
    check(r3.code === 1 && r3.errs.some((e) => e.includes('map') && e.includes(MAP_B.slice(0, 8)) && e.includes('404')), `map exit ${r3.code} err ${r3.errs.join(' | ')}`);
    check(!r.errs.join(' ').includes(FAKE.key) && !r3.errs.join(' ').includes(FAKE.key) && itemReads(r.W, 'boardsApi').length === 1, `board reads ${itemReads(r.W, 'boardsApi').length}`);
  });

  tc('T58', 'an existing DOCUMENT is byte-identical to the build before this lane: the golden lines (top-level, reply, deleted, reset) and the cursor file text are pinned as literal strings', async () => {
    const G = [
      '{"t":"2026-10-04T11:30:04+05:30","document_id":"00000000-0000-4000-8000-000000000001","seq":4,"kind":"comment.created","comment_id":"00000000-0000-4000-8000-000000000009","author_kind":"human","author_name":"Person Fake","excerpt":"Hello agent, please look at item 70","via":"marker","parent_id":null,"thread_root_id":"00000000-0000-4000-8000-000000000009","body":"Hello agent, please look at item 70"}',
      '{"t":"2026-10-04T11:30:04+05:30","document_id":"00000000-0000-4000-8000-000000000001","seq":5,"kind":"comment.created","comment_id":"00000000-0000-4000-8000-00000000000a","author_kind":"human","author_name":"Person Fake","excerpt":"a reply","via":"marker","parent_id":"00000000-0000-4000-8000-000000000009","thread_root_id":"00000000-0000-4000-8000-000000000009","body":"a reply"}',
      '{"t":"2026-10-04T11:30:04+05:30","document_id":"00000000-0000-4000-8000-000000000001","seq":6,"kind":"comment.deleted","comment_id":"00000000-0000-4000-8000-00000000000b","author_kind":"agent","author_name":null,"excerpt":"","via":"marker","parent_id":null,"thread_root_id":null,"body":""}',
    ];
    const r = await runCase(env, { id: 'T58', world: (W) => W.addDoc(DOC_A, 3), cursor: { [DOC_A]: 3 }, mode: 'once', at: [[4000, (W) => { W.addEvent(DOC_A, { actor: HUMAN, body: 'Hello agent, please look at item 70', commentId: C1 }); W.addEvent(DOC_A, { actor: HUMAN, body: 'a reply', commentId: C2, parent: C1 }); W.addEvent(DOC_A, { actor: OTHER, verb: 'comment.deleted', commentId: C3 }); }]] });
    check(same(r.outs, G), `document lines changed:\n${r.outs.join('\n')}`);
    check(r.cursorText === '{"00000000-0000-4000-8000-000000000001":6}\n', `cursor file text ${JSON.stringify(r.cursorText)}`);
    const r2 = await runCase(env, { id: 'T58b', world: (W) => W.addDoc(DOC_A, 150), cursor: { [DOC_A]: 3 }, mode: 'once' });
    check(r2.outs[0] === '{"t":"2026-10-04T11:30:00+05:30","document_id":"00000000-0000-4000-8000-000000000001","reset":true,"latest":150}', `reset line ${r2.outs[0]}`);
    check(fnCalls(r.W, '/documentsApi/listDocumentCommentEvents').length >= 2 && itemReads(r.W, 'boardsApi').length === 0 && itemReads(r.W, 'mapsApi').length === 0, 'a document run never touches the board or map functions');
  });

  tc('T59', 'the usage text names --board, --map and the three cursor key forms; the header comment documents the item line shape', async () => {
    check(USAGE.includes('--board <uuid>[,<uuid>...]') && USAGE.includes('--map <uuid>[,<uuid>...]') && USAGE.includes('--document <uuid>[,<uuid>...]'), 'usage names the three flags');
    const src = fs.readFileSync(__filename, 'utf8');
    const head = src.slice(0, src.indexOf('const fs = require'));
    check(head.includes('board:<uuid>') && head.includes('map:<uuid>') && head.includes('item_type') && head.includes('task_id'), 'the header comment documents the cursor keys and the item line');
    const p = parseArgs(['--config', cfgFile('alpha'), '--cursor-file', '/tmp/x.json']);
    check(p.ok === false && /--document, --board or --map/.test(p.error), `the refusal names the three flags: ${p.error}`);
  });

  tc('T60', 'the same flow per item in ONE listener: documents, boards and maps together each wake it once, with their own markers, and a request to one item never carries another item\'s id', async () => {
    const r = await runCase(env, { id: 'T60', docs: [DOC_A], boards: [BOARD_A, BOARD_B], maps: [MAP_A], world: (W) => { W.addDoc(DOC_A, 2); W.addItem('board', BOARD_A, 2); W.addItem('board', BOARD_B, 2); W.addItem('map', MAP_A, 2); }, mode: 'stream', stopAt: 12000,
      at: [[3000, (W) => { W.addEvent(DOC_A, { actor: HUMAN, body: 'd' }); W.addEvent(bkey(BOARD_A), { actor: HUMAN, body: 'a' }); W.addEvent(bkey(BOARD_B), { actor: HUMAN, body: 'b' }); W.addEvent(mkey(MAP_A), { actor: HUMAN, body: 'm' }); }]] });
    check(r.events.length === 4 && same(r.events.map((e) => e.excerpt).sort(), ['a', 'b', 'd', 'm']), `lines ${r.outs.join(' | ')}`);
    check(r.events.find((e) => e.excerpt === 'b').item_id === BOARD_B && r.events.find((e) => e.excerpt === 'a').item_id === BOARD_A && r.events.find((e) => e.excerpt === 'd').document_id === DOC_A, 'ids');
    check(same(r.cursor, { [DOC_A]: 3, [bkey(BOARD_A)]: 3, [bkey(BOARD_B)]: 3, [mkey(MAP_A)]: 3 }), `cursor ${r.cursorText}`);
  });

  tc('T61', 'a reply without signal_id on a board (secret not set): ONE clear line, exit 1, no listen and no further read', async () => {
    const r = await runCase(env, { id: 'T61', boards: [BOARD_A], world: (W) => { W.noSignalId = true; W.addItem('board', BOARD_A, 3); }, cursor: { [bkey(BOARD_A)]: 3 }, mode: 'stream', stopAt: 120000 });
    check(r.code === 1 && r.errs.length === 1 && /signal id/.test(r.errs[0]), `exit ${r.code} errs ${r.errs.join(' | ')}`);
    check(itemReads(r.W, 'boardsApi').length === 1 && r.W.listens.length === 0, `board reads ${itemReads(r.W, 'boardsApi').length}, listens ${r.W.listens.length}`);
  });

  const INBOX_KEYS = ['t', 'kind', 'notification_id', 'seq', 'reason', 'lane', 'verb', 'item', 'comment_id', 'thread_root_id', 'task_id', 'target', 'item_seq', 'actor_kind'];
  const inboxRun = (o) => runCase(env, { inbox: true, maxFakeMs: 1000000, ...o });
  const notices = (r) => r.lines.filter((l) => l && l.kind === 'notice');
  const seedDocs = (W, n) => { for (let i = 0; i < n; i++) W.addNotice('document', { itemId: DOC_A }); };
  const inboxDeps = (counter, stderr) => ({ io: { out: () => { counter.n++; }, err: (s) => stderr.push(s) }, proc: new (require('node:events'))(), readKey: () => { counter.n++; return FAKE.key; }, loadWebKey: () => { counter.n++; return FAKE.webKey; }, http: () => { counter.n++; throw new Error('network'); }, now: () => T0, sleep: async () => { counter.n++; if (counter.n > 60) throw new Error('runaway: the listener kept retrying instead of refusing (an instant sleep would spin forever and starve the timers)'); }, requestTimeoutMs: 100 });
  const readsFrom = (r, t0) => r.W.inboxCalls.filter((c) => c.t >= t0).length;

  tc('B10a', ' --inbox listens to signals/<signal_id> from the feed reply (the same listen call as item mode), and an identity other than backend uses the same path', async () => {
    const r = await inboxRun({ id: 'B10a', identity: 'epsilon', world: (W) => seedDocs(W, 3), cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 4000 });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    check(r.W.listens.length >= 1 && r.W.listens.every((l) => l.sid === INBOX_SID), `listens ${JSON.stringify(r.W.listens)}`);
    check(r.W.inboxCalls.every((c) => c.m === 'GET' && c.p === '/accountApi/notifications'), 'only GET of the feed');
  });

  tc('B10b', ' a bump of the inbox marker reads the feed ONCE and prints the new notice; the read is not repeated', async () => {
    const r = await inboxRun({ id: 'B10b', world: (W) => seedDocs(W, 3), cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 20000, at: [[5000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const n = notices(r);
    check(n.length === 1 && n[0].seq === 4, `notices ${r.outs.join(' | ')}`);
    check(readsFrom(r, 5000) === 1, `reads after the bump: ${readsFrom(r, 5000)} (${r.W.inboxCalls.map((c) => c.t + ':' + c.q).join(' ')})`);
  });

  tc('B10c', ' no bump for 10 minutes of fake clock: the ONLY feed reads are the re-raise reads at 5 and 10 minutes (state=unresolved); every notice printed is a re-raise line', async () => {
    const r = await inboxRun({ id: 'B10c', world: (W) => seedDocs(W, 3), cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 605000 });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const later = r.W.inboxCalls.filter((c) => c.t >= 1000);
    check(later.length === 2 && same(later.map((c) => c.t), [300000, 600000]) && later.every((c) => c.q === '?since=0&limit=100&state=unresolved'), `reads after the first second: ${JSON.stringify(later.map((c) => [c.t, c.q]))}`);
    check(notices(r).length === notices(r).filter((l) => 'reraise' in l).length, 'a notice without a bump was not a re-raise line');
  });

  tc('B10d', ' a bump that arrives DURING a read re-runs the read ONCE after it (the rule), and the row it covers is printed', async () => {
    const r = await inboxRun({ id: 'B10d', world: (W) => { seedDocs(W, 3); let fired = false; W.inbox.hook = (body) => { if (!fired && W.clock.t >= T0 + 5000) { fired = true; W.addNotice('document', { itemId: DOC_B }); } return body; }; }, cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 20000, at: [[5000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const n = notices(r);
    check(n.length === 2 && n[0].seq === 4 && n[1].seq === 5, `notices ${r.outs.join(' | ')}`);
    check(readsFrom(r, 5000) === 2, `reads after the bump: ${readsFrom(r, 5000)} (the bump read and ONE re-run)`);
  });

  tc('B10e', ' a metadata-only snapshot (same marker, same seq and time) never reads the feed', async () => {
    const r = await inboxRun({ id: 'B10e', world: (W) => seedDocs(W, 3), cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 30000, at: [[5000, (W) => W.notify(INBOX_SID)], [9000, (W) => W.notify(INBOX_SID)]] });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    check(readsFrom(r, 1000) === 0, `reads after the metadata-only snapshots: ${readsFrom(r, 1000)}`);
  });

  // ==== P2: after a FAILED notices read, and only then, the same read is retried after 5 s, 15 s, 45 s, then every 120 s, until one read succeeds. No failure, no timer.
  const readTimes = (r) => r.W.inboxCalls.map((c) => c.t);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  tc('P2a', 'P2 a bump whose read fails (feed 500) is retried after 5 s with NO new bump: the row is printed by the retry', async () => {
    const r = await inboxRun({ id: 'P2a', world: (W) => { seedDocs(W, 3); W.over.inbox = () => (W.clock.t >= T0 + 5000 && W.clock.t < T0 + 9000 ? { status: 500, body: {} } : null); }, cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 20000, at: [[5000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const n = notices(r);
    check(n.length === 1 && n[0].seq === 4, `notices ${r.outs.join(' | ')}`);
    const after = readTimes(r).filter((t) => t >= 5000);
    check(same(after, [5000, 10000]), `reads at/after the bump: ${JSON.stringify(after)}, want [5000,10000] (the bump read, then the 5 s retry)`);
  });

  tc('P2b', 'P2 three failed reads then success: reads at 0, 5, 20 and 65 s (retry after 5 s, 15 s, 45 s), and the row is printed at 65 s', async () => {
    const r = await inboxRun({ id: 'P2b', world: (W) => { seedDocs(W, 4); W.over.inbox = (n) => (n <= 3 ? { status: 500, body: {} } : null); }, cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 80000 });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const t = readTimes(r);
    check(same(t.slice(0, 4), [0, 5000, 20000, 65000]) && t.slice(4).every((x) => x === 65000) && t.length <= 6, `reads at ${JSON.stringify(t)}, want [0,5000,20000,65000] then only the catch-up read at 65000`);
    const n = notices(r);
    check(n.length === 1 && n[0].seq === 4, `notices ${r.outs.join(' | ')}`);
  });

  tc('P2c', 'P2 no failure: after the start read, 10 fake minutes with no bump and no failure cause NO read except the re-raise reads at 5 and 10 minutes', async () => {
    const r = await inboxRun({ id: 'P2c', world: (W) => seedDocs(W, 3), cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 605000 });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const later = readTimes(r).filter((x) => x > 0);
    check(same(later, [300000, 600000]), `reads ${JSON.stringify(readTimes(r))}, want the start reads at 0 and the re-raise reads at 300000 and 600000`);
  });

  tc('P2d', 'P2 a bump during the retry wait reads at once, and the pending retry does not read again afterwards', async () => {
    const r = await inboxRun({ id: 'P2d', world: (W) => { seedDocs(W, 3); W.over.inbox = () => (W.clock.t >= T0 + 5000 && W.clock.t < T0 + 7000 ? { status: 500, body: {} } : null); }, cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 30000, at: [[5000, (W) => W.addNotice('document', { itemId: DOC_A })], [7000, (W) => W.addNotice('document', { itemId: DOC_B })]] });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const after = readTimes(r).filter((t) => t >= 5000);
    check(same(after, [5000, 7000]), `reads at/after the first bump: ${JSON.stringify(after)}, want [5000,7000] (no read at 10000)`);
    const n = notices(r);
    check(n.length === 2 && n[0].seq === 4 && n[1].seq === 5, `notices ${r.outs.join(' | ')}`);
  });

  tc('P2e', 'P2 a notice committed between the start read and the subscription is printed by the catch-up read on the first snapshot (no bump needed)', async () => {
    let fired = false;
    const r = await inboxRun({ id: 'P2e', world: (W) => { seedDocs(W, 3); W.inbox.hook = (body) => { if (!fired) { fired = true; W.inbox.silent = true; W.addNotice('document', { itemId: DOC_A }); W.inbox.silent = false; } return body; }; }, cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 4000 });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const n = notices(r);
    check(n.length === 1 && n[0].seq === 4, `notices ${r.outs.join(' | ')}`);
  });

  tc('P2f', 'P2 the cursor file holds the new position as soon as a batch is printed (saved after each batch, not only at shutdown)', async () => {
    const r = await inboxRun({ id: 'P2f', world: (W) => seedDocs(W, 3), cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 9000, at: [[5000, (W) => W.addNotice('document', { itemId: DOC_A })], [7000, (W) => { W.midCursor = fs.readFileSync(W.cursorFile, 'utf8'); }]] });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    check(JSON.parse(r.W.midCursor)[INBOX_CURSOR_KEY] === 4, `the cursor file at 7 s: ${r.W.midCursor}`);
  });

  tc('P2g', 'P2 --mode once keeps listening after a read that printed nothing, and exits after the first notice it prints', async () => {
    const r = await inboxRun({ id: 'P2g', world: (W) => seedDocs(W, 3), cursor: { inbox_seq: 3 }, mode: 'once', stopAt: 9000, at: [[5000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const n = notices(r);
    check(n.length === 1 && n[0].seq === 4, `once: notices ${r.outs.join(' | ')}`);
  });

  tc('P2h', 'P2 the first run (no cursor) prints only the UNRESOLVED notices (state=unresolved), not the resolved ones', async () => {
    const r = await inboxRun({ id: 'P2h', world: (W) => { seedDocs(W, 3); W.inbox.rows[1].resolved_at = new Date(T0).toISOString(); }, mode: 'stream', stopAt: 3000 });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const seqs = notices(r).map((x) => x.seq);
    check(JSON.stringify(seqs) === '[1,3]', `catch-up seqs ${JSON.stringify(seqs)}, want [1,3] (seq 2 is resolved)`);
  });

  tc('P2i', 'P2 a first run with no cursor prints its catch-up lines, then the next bump prints only the new notice (no replay of the feed)', async () => {
    const r = await inboxRun({ id: 'P2i', world: (W) => seedDocs(W, 3), mode: 'stream', stopAt: 9000, at: [[5000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const seqs = notices(r).map((x) => x.seq);
    check(JSON.stringify(seqs) === '[1,2,3,4]', `notice seqs ${JSON.stringify(seqs)}, want [1,2,3,4]`);
  });

  tc('P2k', 'P2 --inbox with --document is refused at the command line (exit 2 usage), before any call', async () => {
    const p = parseArgs(['--config', cfgFile('alpha'), '--inbox', '--document', DOC_A, '--cursor-file', '/tmp/x.json']);
    check(p.ok === false, `parsed ${JSON.stringify(p)}`);
  });

  tc('P2l', 'P2 a 429 on a bump read waits its Retry-After (30 s), not the 5 s ladder step: the retry reads at 35 s', async () => {
    const r = await inboxRun({ id: 'P2l', world: (W) => { seedDocs(W, 3); W.over.inbox = () => (W.clock.t >= T0 + 5000 && W.clock.t < T0 + 6000 ? { status: 429, headers: { 'retry-after': '30' }, body: {} } : null); }, cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 40000, at: [[5000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const after = readTimes(r).filter((t) => t >= 5000);
    check(same(after, [5000, 35000]), `reads at/after the bump: ${JSON.stringify(after)}, want [5000,35000] (429 Retry-After 30)`);
    const n = notices(r);
    check(n.length === 1 && n[0].seq === 4, `notices ${r.outs.join(' | ')}`);
  });

  tc('P2m', 'P2 a 429 on the first (start) read waits its Retry-After (30 s): the second read is at 30 s', async () => {
    const r = await inboxRun({ id: 'P2m', world: (W) => { seedDocs(W, 4); W.over.inbox = (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '30' }, body: {} } : null); }, cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 40000 });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const t = readTimes(r);
    check(t.length >= 2 && t[0] === 0 && t[1] === 30000, `reads ${JSON.stringify(t)}, want the second read at 30000`);
    const n = notices(r);
    check(n.length === 1 && n[0].seq === 4, `notices ${r.outs.join(' | ')}`);
  });

  tc('P2n', 'P2 a stop while a retry is armed cancels it: no feed read after the stop, and the armed retry sleep is aborted', async () => {
    const r = await inboxRun({ id: 'P2n', world: (W) => { seedDocs(W, 3); W.over.inbox = () => (W.clock.t >= T0 + 5000 && W.clock.t < T0 + 6000 ? { status: 500, body: {} } : null); }, cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 7000, at: [[5000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    check(readTimes(r).filter((t) => t > 7000).length === 0, `a feed read after the stop: ${JSON.stringify(readTimes(r))}`);
    const arm = (r.W.sleeps || []).find((x) => x.rel === 5000 && x.ms === 5000);
    check(arm && arm.signal && arm.signal.aborted === true, `the retry armed at 5 s was not aborted by the stop: ${JSON.stringify((r.W.sleeps || []).map((x) => [x.rel, x.ms]))}`);
  });

  tc('B10f', ' a feed reply with NO signal_id is fatal: exit 1 with one plain line naming the signal, and nothing printed', async () => {
    const r = await inboxRun({ id: 'B10f', world: (W) => { seedDocs(W, 3); W.inbox.noSignalId = true; }, cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 4000 });
    check(r.code === 1, `exit ${r.code}`);
    check(r.errs.some((e) => /signal/.test(e)), `stderr ${r.errs.join('|')}`);
    check(r.outs.length === 0, 'nothing printed');
    check(r.W.listens.length === 0, `a listen started without a signal id: ${JSON.stringify(r.W.listens)}`);
  });

  tc('B10g', ' --poll-ms is refused for --inbox (exit 2 at the command line, before any call)', async () => {
    const p = parseArgs(['--config', cfgFile('alpha'), '--inbox', '--cursor-file', '/tmp/x.json', '--poll-ms', '5000']);
    check(p.ok === false && /--poll-ms is refused/.test(p.error), `parsed ${JSON.stringify(p)}`);
    const q = parseArgs(['--config', cfgFile('alpha'), '--inbox', '--cursor-file', '/tmp/x.json']);
    check(q.ok === true && q.cfg.inbox === true, `--inbox alone is accepted: ${JSON.stringify(q)}`);
  });

  tc('E1b', ' once mode (inbox): the notice is printed, the cursor saved, and the run ends with exit 0 within 3 s of fake time even when the SDK close never resolves', async () => {
    const r = await inboxRun({ id: 'E1b', world: (W) => seedDocs(W, 3), cursor: { inbox_seq: 3 }, mode: 'once', closeHang: true, at: [[5000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    check(r.code === 0 && r.lines.length === 1 && r.lines[0].kind === 'notice', `code ${r.code} lines ${r.lines.length}`);
    check(r.cursor && r.cursor.inbox_seq > 3, `cursor ${r.cursorText}`);
    check(r.W.closed === 1, `the SDK close was called ${r.W.closed || 0} times (inbox mode never closed the SDK)`);
    check(r.W.clock.t - r.W.outLog[0].t <= 3000, `the run ended ${r.W.clock.t - r.W.outLog[0].t} ms after the print`);
  });
  tc('E1d', ' once mode (inbox), real child process: the notice is printed, the cursor saved, the SDK close never resolves and a timer is left open: the process exits 0 within 8 s', async () => {
    const dir = path.join(RUN_DIR, 'E1d'); fs.mkdirSync(dir, { recursive: true });
    const W = newWorld(); env.use(W); seedDocs(W, 3); W.addNotice('document', { itemId: DOC_A });
    const file = path.join(dir, 'cursor.json');
    fs.writeFileSync(file, JSON.stringify({ inbox_seq: 3 }) + '\n');
    const cfg = { identity: 'alpha', email: BACKEND_EMAIL, key: FAKE.key, webKey: FAKE.webKey, cursorFile: file, mode: 'once', selfSkip: true, ports: env.ports, inbox: true, closeHang: true, linger: true };
    const t0 = Date.now();
    const c = spawnNode('const m=require(process.argv[1]);m.exitWhenDone(m.selftestChild(JSON.parse(process.argv[2])));', [__filename, JSON.stringify(cfg)]);
    try {
      await Promise.race([c.done, new Promise((r) => setTimeout(r, 9000))]);
      check(c.exited && c.exited.code === 0 && c.exited.signal === null, `exit ${JSON.stringify(c.exited)} after ${Date.now() - t0} ms; stdout ${c.out.slice(0, 120)} stderr ${c.err.slice(0, 160)}`);
      check(c.out.trim().split('\n').filter(Boolean).length === 1 && parseJson(c.out.trim()).kind === 'notice', `stdout lines: ${c.out.slice(0, 200)}`);
      check(parseJson(fs.readFileSync(file, 'utf8')).inbox_seq > 3, `cursor: ${fs.readFileSync(file, 'utf8').slice(0, 80)}`);
    } finally { if (!c.exited) c.child.kill('SIGKILL'); }
  });
  tc('B10h', ' --mode once exits after the first printed notice, with exit 0 and one line', async () => {
    const r = await inboxRun({ id: 'B10h', world: (W) => seedDocs(W, 3), cursor: { inbox_seq: 3 }, mode: 'once', at: [[5000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    check(r.code === 0, `exit ${r.code}`);
    check(notices(r).length === 1 && notices(r)[0].seq === 4, `notices ${r.outs.join(' | ')}`);
  });

  tc('B10i', 'a first run with no cursor prints the unresolved notices of the last 24 hours, at most 20, as catch-up lines, then streams new ones', async () => {
    const r = await inboxRun({ id: 'B10i', world: (W) => seedDocs(W, 25), mode: 'stream', stopAt: 20000, at: [[5000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const n = notices(r);
    check(n.length === 21 && n[0].seq === 6 && n[19].seq === 25 && n[20].seq === 26, `catch-up then stream: ${n.map((l) => l.seq).join(',')}`);
  });

  // ==== RE-RAISE. Stream mode only: every 5 minutes (REraise_MS) ONE feed read since=0 state=unresolved; each unresolved row older than 5 minutes and newer than 24 hours is printed again with "reraise": n (n counts the re-raises of that id in this process); at most 20 lines per pass, oldest first. Never moves the cursor, never POSTs.
  const RR_Q = '?since=0&limit=100&state=unresolved';
  const rrOf = (r) => notices(r).filter((l) => 'reraise' in l);
  tc('RR1', 'RE-RAISE: an unresolved notice older than 5 minutes is printed again at the 10-minute pass with reraise 1 (the 5-minute pass prints nothing: the rows are exactly 5 minutes old); reads are GET since=0&limit=100&state=unresolved at 5 and 10 minutes; the cursor is unchanged; nothing is POSTed', async () => {
    const r = await inboxRun({ id: 'RR1', world: (W) => seedDocs(W, 3), cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 605000 });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const rr = rrOf(r);
    check(rr.length === 3 && rr.every((l) => l.reraise === 1), `re-raised lines ${JSON.stringify(rr)}`);
    check(same(rr.map((l) => l.seq), [1, 2, 3]), `order ${JSON.stringify(rr.map((l) => l.seq))}`);
    check(rr.every((l) => same(Object.keys(l), [...INBOX_KEYS, 'reraise'])), `keys ${JSON.stringify(Object.keys(rr[0] || {}))}`);
    const reads = r.W.inboxCalls.filter((c) => c.q === RR_Q);
    check(same(reads.map((c) => c.t), [300000, 600000]), `re-raise reads at ${JSON.stringify(reads.map((c) => c.t))}`);
    check(r.W.inboxWrites.length === 0, `a POST was sent: ${r.W.inboxWrites.join(',')}`);
    check(same(r.cursor, { inbox_seq: 3 }), `the cursor moved: ${r.cursorText}`);
  });

  tc('RR2', 'RE-RAISE: the count goes up on each pass that prints the id: reraise 1 at 10 minutes, reraise 2 at 15 minutes', async () => {
    const r = await inboxRun({ id: 'RR2', world: (W) => seedDocs(W, 3), cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 905000 });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const rr = rrOf(r);
    check(rr.length === 6, `re-raised lines ${rr.length}: ${JSON.stringify(rr.map((l) => [l.seq, l.reraise]))}`);
    check(same(rr.map((l) => [l.seq, l.reraise]), [[1, 1], [2, 1], [3, 1], [1, 2], [2, 2], [3, 2]]), `counts ${JSON.stringify(rr.map((l) => [l.seq, l.reraise]))}`);
  });

  tc('RR3', 'RE-RAISE window: a row older than 24 hours is never re-raised; a row younger than 5 minutes is not re-raised at the 5-minute pass but is at the 10-minute pass', async () => {
    const r = await inboxRun({ id: 'RR3', world: (W) => { seedDocs(W, 3); W.inbox.rows[0].created_at = new Date(T0 - 25 * 3600 * 1000).toISOString(); }, cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 605000, at: [[120000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const plain = notices(r).filter((l) => !('reraise' in l));
    check(plain.length === 1 && plain[0].seq === 4, `the normal line for the new row: ${JSON.stringify(plain.map((l) => l.seq))}`);
    const rr = rrOf(r);
    check(same(rr.map((l) => [l.seq, l.reraise]), [[2, 1], [3, 1], [4, 1]]), `re-raised ${JSON.stringify(rr.map((l) => [l.seq, l.reraise]))}, want [2,3,4] once each (seq 1 is older than 24 hours)`);
  });

  tc('RR4', 'RE-RAISE: at most 20 lines per pass, oldest first; the other rows wait for the next pass', async () => {
    const r = await inboxRun({ id: 'RR4', world: (W) => seedDocs(W, 25), cursor: { inbox_seq: 25 }, mode: 'stream', stopAt: 605000 });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const rr = rrOf(r);
    check(rr.length === 20 && same(rr.map((l) => l.seq), Array.from({ length: 20 }, (_, i) => i + 1)) && rr.every((l) => l.reraise === 1), `re-raised ${JSON.stringify(rr.map((l) => [l.seq, l.reraise]))}`);
  });

  tc('RR5', 'RE-RAISE: a failed re-raise read prints ONE stderr line, the cursor does not move, and the next pass (15 minutes) prints the notice with reraise 1', async () => {
    const r = await inboxRun({ id: 'RR5', world: (W) => { seedDocs(W, 3); W.over.inbox = () => (W.clock.t >= T0 + 600000 && W.clock.t < T0 + 600500 ? { status: 500, body: {} } : null); }, cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 905000 });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    const reErrs = r.errs.filter((s) => /re-raise/.test(s));
    check(reErrs.length === 1, `re-raise stderr lines ${reErrs.length}: ${r.errs.join(' | ')}`);
    const rr = rrOf(r);
    check(rr.length === 3 && rr.every((l) => l.reraise === 1), `re-raised ${JSON.stringify(rr.map((l) => [l.seq, l.reraise]))}`);
    check(same(r.cursor, { inbox_seq: 3 }), `the cursor moved: ${r.cursorText}`);
  });

  tc('RR6', 'RE-RAISE is stream only: in once mode no re-raise read is made and no re-raised line is printed', async () => {
    const r = await inboxRun({ id: 'RR6', world: (W) => seedDocs(W, 3), cursor: { inbox_seq: 3 }, mode: 'once', stopAt: 700000 });
    check(r.code === 0, `exit ${r.code} ${r.errs.join('|')}`);
    check(r.W.inboxCalls.filter((c) => c.q === RR_Q).length === 0 && rrOf(r).length === 0, `once mode re-raised: reads ${r.W.inboxCalls.filter((c) => c.q === RR_Q).length}`);
  });

  tc('T63', 'INBOX first run: no cursor prints the unresolved notices already waiting (catch-up), then the cursor is the feed latest; a row that arrives later is printed once; the cursor file is its own inbox cursor', async () => {
    const r = await inboxRun({ id: 'T63', world: (W) => seedDocs(W, 5), mode: 'stream', stopAt: 30000, at: [[20000, (W) => W.addNotice('board', { itemId: BOARD_A, targetId: TASK_A })]] });
    check(r.code === 0, `exit ${r.code}`);
    check(r.lines.length === 6, `expected five catch-up lines and one notice, got ${r.outs.join(' | ')}`);
    check(same(notices(r).map((l) => l.seq), [1, 2, 3, 4, 5, 6]) && r.lines.every((l) => l.kind === 'notice'), `lines ${r.outs.join(' | ')}`);
    check(same(r.cursor, { inbox_seq: 6 }), `cursor ${r.cursorText}`);
    check(/^\?since=0&limit=100&state=unresolved$/.test(r.W.inboxCalls[0].q), `the first read is the catch-up read: ${r.W.inboxCalls[0].q}`);
    const empty = await inboxRun({ id: 'T63b', world: (W) => seedDocs(W, 2), rawCursor: '{}\n', mode: 'stream', stopAt: 4000 });
    check(empty.lines.length === 2 && empty.lines.every((l) => l.kind === 'notice') && same(notices(empty).map((l) => l.seq), [1, 2]), `an empty cursor file is a first run: ${empty.outs.join(' | ')}`);
  });

  tc('T64', 'INBOX: two new rows give two lines, in order, in ONE batch; the cursor moves; a restart does not repeat a line, and the next new row is printed once', async () => {
    const r = await inboxRun({ id: 'T64', world: (W) => seedDocs(W, 3), cursor: { inbox_seq: 3 }, mode: 'stream', stopAt: 16000, at: [[6000, (W) => { W.addNotice('document', { itemId: DOC_A }); W.addNotice('document', { itemId: DOC_B }); }]] });
    check(r.code === 0, `exit ${r.code}`);
    const n = notices(r);
    check(n.length === 2 && n[0].seq === 4 && n[1].seq === 5 && n[0].item.id === DOC_A && n[1].item.id === DOC_B, `lines ${r.outs.join(' | ')}`);
    check(r.lines.length === 2 && r.W.outLog[0].t === r.W.outLog[1].t, 'the two lines came out in one batch');
    check(same(r.cursor, { inbox_seq: 5 }), `cursor ${r.cursorText}`);
    const again = await inboxRun({ id: 'T64b', world: (W) => seedDocs(W, 5), cursor: r.cursor, mode: 'stream', stopAt: 14000, at: [[7000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    const m = notices(again);
    check(m.length === 1 && m[0].seq === 6 && again.lines.length === 1, `after the restart: ${again.outs.join(' | ')}`);
    check(same(again.cursor, { inbox_seq: 6 }), `cursor after the restart ${again.cursorText}`);
  });

  tc('T65', 'INBOX line: exact keys in order; a DOCUMENT row feeds --document item.id, a BOARD row --task task_id, a MAP row --map item.id; a reply row names its thread root; ids only', async () => {
    const root = crypto.randomUUID();
    const r = await inboxRun({ id: 'T65', cursor: { inbox_seq: 0 }, mode: 'stream', stopAt: 8000, world: (W) => {
      W.addNotice('document', { itemId: DOC_A, threadId: root, verb: 'comment.replied', reason: 'participant' });
      W.addNotice('board', { itemId: BOARD_A, targetId: TASK_A });
      W.addNotice('map', { itemId: MAP_A, targetId: NODE_A, actorKind: 'agent' });
    } });
    const n = notices(r);
    check(n.length === 3 && r.lines.length === 3, `lines ${r.outs.join(' | ')}`);
    for (const l of n) check(same(Object.keys(l), INBOX_KEYS) && ISO_IST_RE.test(l.t) && UUID_RE.test(l.notification_id) && UUID_RE.test(l.comment_id) && Number.isSafeInteger(l.item_seq) && l.lane === 'needs_you', `keys or values ${JSON.stringify(l)}`);
    const [d, b, m] = n; const rows = r.W.inbox.rows;
    check(d.item.type === 'document' && d.item.id === DOC_A && d.comment_id === rows[0].object.id && d.thread_root_id === root && d.thread_root_id !== d.comment_id && d.task_id === null && d.target === null && d.verb === 'comment.replied' && d.reason === 'participant' && d.actor_kind === 'human', `document line ${JSON.stringify(d)}`);
    check(b.item.type === 'board' && b.item.id === BOARD_A && b.task_id === TASK_A && same(b.target, { type: 'task', id: TASK_A }) && b.thread_root_id === b.comment_id && b.reason === 'mentioned' && b.verb === 'comment.created', `board line ${JSON.stringify(b)}`);
    check(m.item.type === 'map' && m.item.id === MAP_A && m.task_id === null && same(m.target, { type: 'node', id: NODE_A }) && m.actor_kind === 'agent', `map line ${JSON.stringify(m)}`);
  });

  tc('T66', 'INBOX never prints comment text: a body, a text, an excerpt, a nested comment and an actor name planted in the mock rows never reach stdout or stderr; a line has only the fixed keys', async () => {
    const r = await inboxRun({ id: 'T66', cursor: { inbox_seq: 0 }, mode: 'once', world: (W) => { seedDocs(W, 2); W.inbox.plant = { body: 'PLANTED-BODY-TEXT', text: 'PLANTED-TEXT', excerpt: 'PLANTED-EXCERPT', comment: { body: 'PLANTED-NESTED' }, actor: { kind: 'human', name: 'PLANTED-NAME' } }; } });
    check(notices(r).length === 2, `lines ${r.outs.join(' | ')}`);
    const all = `${r.outs.join('\n')}\n${r.errs.join('\n')}`;
    check(!/PLANTED/.test(all), `a planted text reached the output: ${all.slice(0, 240)}`);
    check(notices(r).every((l) => same(Object.keys(l), INBOX_KEYS)), 'a line has keys beyond the fixed list');
  });

  tc('T67', 'INBOX cursor file: a per-item cursor file is refused with a plain message and exit 2 before any call or key read, and left untouched (an inbox file is refused by a per-item listener the same way); absent or empty means a first run', async () => {
    const dir = path.join(RUN_DIR, 'T67'); fs.mkdirSync(dir, { recursive: true });
    const items = path.join(dir, 'items.json'); fs.writeFileSync(items, `${JSON.stringify({ [DOC_A]: 3, [bkey(BOARD_A)]: 2 })}\n`);
    const inboxF = path.join(dir, 'inbox.json'); fs.writeFileSync(inboxF, '{"inbox_seq":4}\n');
    const mixed = path.join(dir, 'mixed.json'); fs.writeFileSync(mixed, `${JSON.stringify({ inbox_seq: 4, [DOC_A]: 3 })}\n`);
    const empty = path.join(dir, 'empty.json'); fs.writeFileSync(empty, '{}\n');
    check(cursorKindOf(items) === 'items' && cursorKindOf(inboxF) === 'inbox' && cursorKindOf(mixed) === 'mixed' && cursorKindOf(empty) === 'none' && cursorKindOf(path.join(dir, 'absent.json')) === 'none', 'cursorKindOf');
    const counter = { n: 0 }; const stderr = [];
    const deps = inboxDeps(counter, stderr);
    for (const [argv, file, why] of [
      [['--config', cfgFile('alpha'), '--inbox', '--cursor-file', items], items, 'an item cursor file with --inbox'],
      [['--config', cfgFile('alpha'), '--inbox', '--cursor-file', mixed], mixed, 'a mixed file with --inbox'],
      [['--config', cfgFile('alpha'), '--document', DOC_A, '--cursor-file', inboxF], inboxF, 'an inbox cursor file with --document'],
      [['--config', cfgFile('alpha'), '--board', BOARD_A, '--cursor-file', mixed], mixed, 'a mixed file with --board'],
    ]) {
      stderr.length = 0;
      const snap = fs.readFileSync(file, 'utf8');
      const code = await main(argv, deps);
      check(code === 2, `${why}: exit ${code}`);
      check(stderr.some((s) => /OWN --cursor-file/.test(s)), `${why}: no plain message: ${stderr.join(' | ')}`);
      check(fs.readFileSync(file, 'utf8') === snap, `${why}: the file was changed`);
    }
    check(counter.n === 0, `${counter.n} call(s), key read(s) or print(s) happened before the refusal`);
    const own = await inboxRun({ id: 'T67b', world: (W) => seedDocs(W, 1), cursor: { inbox_seq: 1 }, mode: 'stream', stopAt: 3000 });
    check(own.code === 0 && own.lines.length === 0, `an inbox cursor file is accepted by --inbox: code ${own.code} ${own.outs.join(' | ')}`);
    const direct = await inboxRun({ id: 'T67c', world: (W) => seedDocs(W, 1), cursor: { [DOC_A]: 1 }, mode: 'stream', stopAt: 3000 });
    check(direct.code === 1 && /per-item cursors/.test(direct.errs.join(' ')) && same(direct.cursor, { [DOC_A]: 1 }) && direct.W.inboxCalls.length === 0, `the listener itself refuses a per-item file too (defence in depth): code ${direct.code} ${direct.errs.join(' | ')} ${direct.cursorText}`);
  });

  tc('T69', 'INBOX 401, 403, 400 and 404: ONE clear line, exit 1, no retry, nothing printed, the key never shown', async () => {
    const fx = inboxFixture();
    for (const [status, body, want] of [[401, fx.refusals.wrong_key.body, /refused \(401 unauthenticated\)/], [403, fx.refusals.address_mismatch.body, /refused \(403 email_mismatch\)/], [400, { error: 'invalid_since', code: 'invalid_since' }, /refused \(400 invalid_since\)/], [404, { error: 'unknown_route', code: 'unknown_route' }, /refused \(404 unknown_route\)/]]) {
      const r = await inboxRun({ id: `T69-${status}`, cursor: { inbox_seq: 0 }, mode: 'stream', world: (W) => { seedDocs(W, 1); W.over.inbox = () => ({ status, body }); } });
      check(r.code === 1, `${status}: exit ${r.code}`);
      check(r.errs.length === 1 && want.test(r.errs[0]) && /check the key/.test(r.errs[0]), `${status}: ${r.errs.join(' | ')}`);
      check(r.W.inboxCalls.length === 1, `${status}: ${r.W.inboxCalls.length} calls (a retry happened)`);
      check(r.outs.length === 0, `${status}: something was printed: ${r.outs.join(' | ')}`);
      check(!`${r.outs.join('')}${r.errs.join('')}`.includes(FAKE.key), `${status}: the key is shown`);
    }
  });

  tc('T73', 'INBOX a row the feed leaves out (access lost) is simply absent; the cursor still moves past it, also when it is the last one; a restart does not repeat anything', async () => {
    const r = await inboxRun({ id: 'T73', cursor: { inbox_seq: 0 }, mode: 'once', world: (W) => { seedDocs(W, 4); W.inbox.hidden.add(2); W.inbox.hidden.add(4); } });
    check(r.code === 0 && same(notices(r).map((l) => l.seq), [1, 3]), `lines ${r.outs.join(' | ')}`);
    check(same(r.cursor, { inbox_seq: 4 }), `cursor ${r.cursorText}`);
    const again = await inboxRun({ id: 'T73b', cursor: r.cursor, mode: 'stream', stopAt: 12000, world: (W) => { seedDocs(W, 4); W.inbox.hidden.add(2); W.inbox.hidden.add(4); } });
    check(again.lines.length === 0 && same(again.cursor, { inbox_seq: 4 }), `restart ${again.outs.join(' | ')} ${again.cursorText}`);
  });

  tc('T74', 'INBOX requests: only GET /accountApi/notifications?since=<n>&limit=100&state=all with the key and the typed address (no Origin, no bearer); the allow-list refuses every variation', async () => {
    const r = await inboxRun({ id: 'T74', cursor: { inbox_seq: 0 }, mode: 'stream', stopAt: 12000, world: (W) => seedDocs(W, 2), at: [[7000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    check(r.W.inboxCalls.length >= 2, `${r.W.inboxCalls.length} reads`);
    for (const c of r.W.inboxCalls) {
      check(c.m === 'GET' && c.p === '/accountApi/notifications' && /^\?since=\d+&limit=100&state=all$/.test(c.q), `request ${c.m} ${c.p}${c.q}`);
      check(c.hdr.includes('x-spm-api-key') && c.hdr.includes('x-spm-user-email') && !c.hdr.includes('origin') && !c.hdr.includes('authorization') && !c.hdr.includes('content-type') && c.hdr.filter((h) => h.startsWith('x-')).length === 2, `headers ${c.hdr}`);
    }
    check(!r.W.log.some((e) => e.h === 'fn' && /comment-events|listDocumentCommentEvents/.test(e.p)), 'the inbox mode read an item events route');
    const H = { 'X-SPM-API-Key': FAKE.key, 'X-SPM-User-Email': BACKEND_EMAIL };
    const U = (qs, p = '/accountApi/notifications', host = FN_HOST) => `https://${host}${p}${qs}`;
    const okQs = '?since=0&limit=100&state=all';
    for (const [url, m, h] of [[U(okQs), 'GET', H], [U('?since=12&limit=1&state=unread'), 'GET', H], [U('?since=2147483647&limit=100&state=unresolved'), 'GET', H], [U('?since=9007199254740991&limit=50&state=all'), 'GET', H]]) {
      try { guardRequest(url, m, h, undefined); } catch (e) { throw new Error(`the allow-list refused a good read ${url}: ${e.message}`); }
    }
    const refuses = [
      [U(okQs), 'POST', H, {}], [U(okQs), 'POST', H], [U(okQs), 'PUT', H], [U(okQs), 'DELETE', H], [U(okQs, '/accountApi/notifications/read'), 'POST', H, { all: true }], [U(okQs, '/accountApi/notifications/resolve'), 'POST', H, { up_to_seq: 1 }], [U(okQs, '/accountApi/notifications/counts'), 'GET', H],
      [U(okQs, '/accountApi/notifications/'), 'GET', H], [U(okQs, '/accountApi/notificationsx'), 'GET', H], [U(okQs, '/accountApi/notifications/act'), 'GET', H], [U(okQs, '/accountApi/Notifications'), 'GET', H], [U(okQs, '/notifications'), 'GET', H],
      [U('?since=0&limit=100&state=all&x=1'), 'GET', H], [U('?since=0&limit=100&state=all&since=1'), 'GET', H], [U('?limit=100&since=0&state=all'), 'GET', H], [U('?since=0&limit=100'), 'GET', H], [U('?since=0&state=all'), 'GET', H], [U('?since=-1&limit=100&state=all'), 'GET', H], [U('?since=1.5&limit=100&state=all'), 'GET', H],
      [U('?since=0x10&limit=100&state=all'), 'GET', H], [U('?since=007&limit=100&state=all'), 'GET', H], [U('?since=&limit=100&state=all'), 'GET', H], [U('?since=0&limit=101&state=all'), 'GET', H], [U('?since=0&limit=0&state=all'), 'GET', H], [U('?since=0&limit=100&state=ALL'), 'GET', H], [U('?since=0&limit=100&state=bogus'), 'GET', H], [U(''), 'GET', H],
      [U('?since=9007199254740992&limit=100&state=all'), 'GET', H], [U('?since=99999999999999999&limit=100&state=all'), 'GET', H],
      [U(okQs, undefined, 'us-central1-litethink.cloudfunctions.net'), 'GET', H], [U(okQs, undefined, 'evil.example'), 'GET', H],
      [U(okQs), 'GET', { ...H, Origin: 'https://app.superproductmanager.ai' }], [U(okQs), 'GET', { ...H, Authorization: 'Bearer x' }], [U(okQs), 'GET', { 'X-SPM-API-Key': FAKE.key }], [U(okQs), 'GET', { ...H, 'X-Extra': '1' }], [U(okQs), 'GET', {}],
      [U(okQs), 'GET', H, {}], [`http://${FN_HOST}/accountApi/notifications${okQs}`, 'GET', H], [`https://${FN_HOST}:8443/accountApi/notifications${okQs}`, 'GET', H], [`${U(okQs)}#frag`, 'GET', H], [`https://user@${FN_HOST}/accountApi/notifications${okQs}`, 'GET', H],
    ];
    for (const [url, m, h, b] of refuses) {
      let threw = null;
      try { guardRequest(url, m, h, b); } catch (e) { threw = e; }
      check(threw && threw.name === 'GuardError', `the allow-list accepted ${m} ${url.slice(0, 120)} ${JSON.stringify(h).slice(0, 80)}`);
    }
  });

  tc('T75', 'INBOX only reads: across a run with several rows the listener sends no POST and no request except the feed read and the signal listen (nothing is marked read, acted on or resolved)', async () => {
    const r = await inboxRun({ id: 'T75', cursor: { inbox_seq: 0 }, mode: 'stream', stopAt: 20000, world: (W) => seedDocs(W, 3), at: [[6000, (W) => W.addNotice('board', { itemId: BOARD_A, targetId: TASK_A })], [11000, (W) => W.addNotice('map', { itemId: MAP_A, targetId: NODE_A })]] });
    check(notices(r).length === 5, `lines ${r.outs.join(' | ')}`);
    check(r.W.inboxWrites.length === 0, `non-read requests: ${r.W.inboxWrites.join(', ')}`);
    check(r.W.log.filter((e) => e.h === 'fn').every((e) => (e.m === 'GET' && e.p === '/accountApi/notifications') || (e.m === 'POST' && e.p === '/getRealtimeToken')), 'a request other than the feed read and the signal token');
  });

  tc('T76', 'INBOX print first, then save: when a line is printed the cursor file still holds the OLD position; it moves only after the whole batch is out', async () => {
    const snaps = [];
    const r = await inboxRun({ id: 'T76', cursor: { inbox_seq: 0 }, mode: 'once', world: (W) => seedDocs(W, 3), onOut: (s, cur) => snaps.push(cur) });
    check(notices(r).length === 3 && snaps.length === 3, `lines ${r.outs.join(' | ')}`);
    check(snaps.every((c) => c && same(parseJson(c), { inbox_seq: 0 })), `the cursor file at each print: ${snaps.join(' | ')}`);
    check(same(r.cursor, { inbox_seq: 3 }), `cursor after ${r.cursorText}`);
  });

  tc('T77', 'INBOX --mode once: a first run with nothing to print does not end it (it waits for a notice); a batch with a notice prints it and exits 0 after ONE read; stream keeps going', async () => {
    const wait = await inboxRun({ id: 'T77a', mode: 'once', allowWatchdog: true, maxFakeMs: 40000, world: (W) => seedDocs(W, 0) });
    check(wait.lines.length === 0 && wait.W.inboxCalls.length === 2, `an idle once run: expected the first read and one catch-up read on the first signal snapshot, nothing after: ${wait.outs.join(' | ')} (${wait.W.inboxCalls.length} reads)`);
    const one = await inboxRun({ id: 'T77b', cursor: { inbox_seq: 0 }, mode: 'once', world: (W) => seedDocs(W, 2) });
    check(one.code === 0 && notices(one).length === 2 && one.W.inboxCalls.length === 1, `once with rows waiting: ${one.outs.join(' | ')} (${one.W.inboxCalls.length} reads)`);
    const stream = await inboxRun({ id: 'T77c', cursor: { inbox_seq: 0 }, mode: 'stream', stopAt: 12000, world: (W) => seedDocs(W, 1), at: [[6000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    check(notices(stream).length === 2 && stream.W.inboxCalls.length >= 3, `stream: ${stream.outs.join(' | ')}`);
  });

  tc('T78', 'INBOX a stored cursor ahead of the stream moves back to the latest with a stderr note and replays nothing; a later row is printed', async () => {
    const r = await inboxRun({ id: 'T78', cursor: { inbox_seq: 99 }, mode: 'stream', stopAt: 14000, world: (W) => seedDocs(W, 5), at: [[7000, (W) => W.addNotice('document', { itemId: DOC_A })]] });
    check(r.code === 0 && same(notices(r).map((l) => l.seq), [6]) && r.lines.length === 1, `lines ${r.outs.join(' | ')}`);
    check(r.errs.some((e) => /ahead of the stream/.test(e)) && same(r.cursor, { inbox_seq: 6 }), `errs ${r.errs.join(' | ')} cursor ${r.cursorText}`);
  });

  tc('T79', 'INBOX paging: 250 rows behind are read in pages of 100 (since 0, 100, 200), printed in order, the cursor lands on the last', async () => {
    const r = await inboxRun({ id: 'T79', cursor: { inbox_seq: 0 }, mode: 'once', world: (W) => seedDocs(W, 250) });
    check(r.code === 0 && notices(r).length === 250 && notices(r).every((l, i) => l.seq === i + 1), `${notices(r).length} lines`);
    check(same(r.W.inboxCalls.map((c) => c.q), ['?since=0&limit=100&state=all', '?since=100&limit=100&state=all', '?since=200&limit=100&state=all']), `queries ${r.W.inboxCalls.map((c) => c.q)}`);
    check(same(r.cursor, { inbox_seq: 250 }), `cursor ${r.cursorText}`);
  });

  tc('T81', 'INBOX --self-actor-skip is accepted (true and false) and a row whose ACTOR is another agent is printed either way (a tag by another agent is a tag; the server never writes a row for the author of an event)', async () => {
    for (const selfSkip of [true, false]) {
      const r = await inboxRun({ id: `T81-${selfSkip}`, cursor: { inbox_seq: 0 }, mode: 'once', selfSkip, world: (W) => { W.addNotice('document', { itemId: DOC_A, actorKind: 'agent' }); } });
      check(r.code === 0 && notices(r).length === 1 && notices(r)[0].actor_kind === 'agent', `selfSkip ${selfSkip}: ${r.outs.join(' | ')}`);
    }
    check(['beta', 'gamma'].every((id) => { const p = parseArgs(['--config', cfgFile(id), '--inbox', '--cursor-file', '/tmp/x.json', '--self-actor-skip', 'true']); return p.ok === true && p.cfg.inbox === true; }), 'the --inbox command line is accepted for beta and gamma');
  });

  tc('T82', 'INBOX the mock is held to the real shapes: the fixture loads, a reply with an extra key, a missing key or a reordered row is a violation that fails the case that made it, and the feed route was exercised', async () => {
    const fx = inboxFixture();
    check(keysOf(fx.document.feed) === 'notifications,cursor,latest,has_more' && keysOf(fx.document.reset) === 'notifications,cursor,latest,has_more,reset' && fx.document.feed.notifications.length === 2 && fx.board.feed.notifications[0].target.type === 'task' && fx.map.feed.notifications[0].target.type === 'node' && fx.document.feed.notifications[0].target === null, 'fixture shape');
    check(fx.refusals.no_key.status === 401 && fx.refusals.wrong_key.status === 401 && fx.refusals.address_mismatch.status === 403 && fx.refusals.address_mismatch.body.code === 'email_mismatch', 'fixture refusals');
    check(inboxShapeProblem(fx.board.feed) === null && inboxShapeProblem(fx.board.reset) === null && inboxShapeProblem(fx.board.empty) === null, 'a real reply was rejected by the shape check');
    const clone = () => JSON.parse(JSON.stringify(fx.board.feed));
    const extra = clone(); extra.extra_field = 1;
    const rowExtra = clone(); rowExtra.notifications[0].body = 'x';
    const rowMissing = clone(); delete rowMissing.notifications[0].lane;
    const rowOrder = clone(); rowOrder.notifications[0] = { seq: rowOrder.notifications[0].seq, ...rowOrder.notifications[0] };
    const reordered = clone(); reordered.notifications[0].actor = { name: 'x', kind: 'human' };
    const noReset = { ...fx.board.reset }; delete noReset.reset;
    for (const [name, v] of [['an extra reply key', extra], ['an extra row key', rowExtra], ['a missing row key', rowMissing], ['a reordered row', rowOrder], ['a reordered actor', reordered], ['a reset key that is not true', { ...noReset, reset: undefined }]]) check(inboxShapeProblem(v) !== null, `the shape check accepted ${name}`);
    for (const [name, hook] of [['an extra reply key', (b) => ({ ...b, extra_field: 1 })], ['an extra row key', (b) => ({ ...b, notifications: b.notifications.map((x) => ({ ...x, body: 'x' })) })]]) {
      let threw = null;
      try { await inboxRun({ id: 'T82b', cursor: { inbox_seq: 0 }, mode: 'once', allowWatchdog: true, maxFakeMs: 30000, world: (W) => { seedDocs(W, 1); W.inbox.hook = hook; } }); } catch (e) { threw = e; }
      check(threw && /never returns/.test(String(threw.message)) && /inbox\.feed/.test(String(threw.message)), `a mock answering with ${name} did not fail its case: ${threw && threw.message}`);
    }
  });
  tc('T83', 'INBOX a reply that is not what the real route returns (rows out of order, a row that is not a row, a missing cursor) prints nothing, leaves the cursor, notes it once and retries', async () => {
    for (const [name, hook] of [['rows in descending order', (b) => ({ ...b, notifications: [...b.notifications].reverse() })], ['a row without an item', (b) => ({ ...b, notifications: b.notifications.map((x) => ({ ...x, item: { type: 'folder', id: x.item.id } })) })], ['a reply with cursor as text', (b) => ({ ...b, cursor: String(b.cursor) })]]) {
      const r = await inboxRun({ id: 'T83', cursor: { inbox_seq: 0 }, mode: 'stream', stopAt: 12000, world: (W) => { seedDocs(W, 3); W.inbox.hook = hook; } });
      check(r.code === 0 && r.lines.length === 0, `${name}: something was printed: ${r.outs.join(' | ')}`);
      check(same(r.cursor, { inbox_seq: 0 }), `${name}: the cursor moved: ${r.cursorText}`);
      check(r.errs.length === 1 && /unexpected_reply/.test(r.errs[0]) && r.W.inboxCalls.length >= 2, `${name}: notes ${r.errs.join(' | ')} reads ${r.W.inboxCalls.length}`);
    }
  });
}

/** Runs in a CHILD process of the selftest: the same createListener and the same signal wiring as main, real clock, real timers, the fake servers through the injected transport. Not reachable from the command line. */
async function selftestChild(c) {
  const { ports, ...cfg } = c;
  const deps = {
    io: { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }, now: () => Date.now(), sleep: sleepReal, requestTimeoutMs: 30000,
    http: makeTransport({ lib: http, resolveTarget: (u) => ({ hostname: '127.0.0.1', port: ports[u.hostname] }) }),
    interval: (fn, ms) => { const h = setInterval(fn, ms); return () => clearInterval(h); },
    signIn: async (tok, wk) => { const r = await deps.http(`https://${IDT_HOST}/v1/accounts:signInWithCustomToken?key=${wk}`, 'POST', { Referer: REFERER }, { token: tok, returnSecureToken: true }, { timeoutMs: 3000 }); if (r.status !== 200) throw Object.assign(new Error('refused'), { code: `auth/${r.status}` }); },
    listen: (sid, onNext) => { const t = setImmediate(() => onNext({ metadata: { fromCache: false }, exists: () => false, data: () => undefined })); return () => clearImmediate(t); },
    close: c.closeHang ? () => new Promise(() => {}) : async () => {}, // E1: closeHang = the SDK close never resolves
  };
  if (c.linger) setInterval(() => {}, 60000); // E1: a handle left open, as a real SDK can leave one
  const listener = (c.inbox ? createInboxListener : createListener)(cfg, deps);
  const off = installSignalHandlers(process, listener);
  try { return await listener.run(); } finally { off(); }
}

// ---------------------------------------------------------------- selftest: a REAL local proxy on 127.0.0.1 records the first request line. The call goes through the real transport and a guarded lib that refuses any request without a proxy agent, so no direct production socket can open even when the code is wrong.
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
    try { await transport(`https://${FN_HOST}/documentsApi/listDocumentCommentEvents`, 'POST', { 'x-spm-api-key': 'selftest-fake-key', 'x-spm-user-email': 'selftest@agents.invalid' }, { documentId: '00000000-0000-4000-8000-000000000000', since: 0 }, { timeoutMs: 3000 }); outcome = 'resolved'; } catch (e) { outcome = `rejected:${String((e && e.code) || (e && e.message)).slice(0, 40)}`; }
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
  const lines = [];
  const say = (s) => { lines.push(s); process.stdout.write(s + '\n'); };
  say('FAKE: agent-listen selftest. Local fake servers on 127.0.0.1, a fake clock, fake secrets. No production call, no real key file read, no real Firebase.');
  delete process.env.SPM_AGENT_CONFIG; // the selftest names its own settings files
  RUN_DIR = path.join(os.tmpdir(), 'agent-listen-selftest', `${Date.now()}-${process.pid}`);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const env = makeFakeServers();
  await env.start();
  const cases = [];
  defineCases(cases, env);
  cases.push({ id: 'P1a', name: 'with HTTPS_PROXY set, a real call to the production host goes through the proxy as CONNECT to that host (no direct socket, no crash)', fn: () => proxyRouteCase(true) });
  cases.push({ id: 'P1b', name: 'with HTTPS_PROXY unset, the call keeps agent:false and the proxy receives nothing', fn: () => proxyRouteCase(false) });
  let pass = 0; let fail = 0;
  try {
    for (const c of cases) {
      let err = null; const c0 = Date.now(); let cap = null;
      try { await Promise.race([c.fn(), new Promise((_, rej) => { cap = setTimeout(() => rej(new Error('case timed out after 60 s')), 60000); })]); } catch (e) { err = e; } finally { clearTimeout(cap); }
      if (err) { fail++; say(`FAIL ${c.id} ${c.name}: ${String(err && err.message).slice(0, 300)} [${Date.now() - c0} ms]`); } else { pass++; say(`PASS ${c.id} ${c.name} [${Date.now() - c0} ms]`); }
    }
  } finally { await env.stop(); }
  say(`SELFTEST ${pass} passed, ${fail} failed (scratch folder ${RUN_DIR})`);
  return fail === 0 ? 0 : 1;
}

module.exports = { transportRefusal, loadSdk, parseArgs, guardRequest, GuardError, readCursorFile, writeCursorAtomic, makeTransport, loadWebKeyFrom, readKeyFile, createListener, createInboxListener, noticeLine, cursorKindOf, installSignalHandlers, exitWhenDone, realDeps, main, selftestChild, selftest, istIso, FUTURE_SINCE };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const run = argv.length === 1 && argv[0] === '--selftest' ? selftest() : main(argv, realDeps());
  exitWhenDone(run);
}
