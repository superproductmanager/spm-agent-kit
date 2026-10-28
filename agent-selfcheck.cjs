#!/usr/bin/env node
'use strict';
/**
 * agent-selfcheck.cjs.
 * Runs four checks in order and stops at the first failure. Prints one line per check:
 *   ok <name>
 *   info google-host (<shared host>): ... (never a failure)
 *   FAIL <name>: <cause>. Fix: <fix>.
 * Exit 0 when all four pass, 1 on a failure, 2 on a usage error (one line on stderr).
 * Never prints a key, token, ID token, web key or email value. Server text is never echoed; only the
 * server's short code is read, and it is mapped to a fixed plain cause line.
 *
 *   node agent-selfcheck.cjs --config <abs path> (or the SPM_AGENT_CONFIG environment variable; see lib/config.cjs)
 *   Key modes: a settings file with key_file reads the key from that file (as before). With no key_file the key is a
 *   network secret in the Claude cloud environment: the header value is the fixed placeholder, every https call goes
 *   through HTTPS_PROXY, and with no proxy the script refuses (exit 2). The first stdout line is the kit version.
 *        [--base-regional <url>] [--base-shared <url>] [--base-fn <url>] [--base-idt <url>] (tests only)
 *
 * CHECKS
 *   1 google-host GET <regional host>/v1/projects/litethink/databases/(default)/documents/signals/<64 zeros>, Bearer abc.
 *                  401 ok. 403 = a network secret on that host (wildcard). The shared host is probed only after this passes,
 *                  and only prints info.
 *   2 spm-key POST getRealtimeToken on asia-south1-litethink.cloudfunctions.net, headers X-SPM-API-Key (the key file,
 *                  omitted when there is none) and X-SPM-User-Email, body {}. Server codes map to causes (table below).
 *   3 sign-in POST identitytoolkit accounts:signInWithCustomToken?key=<web key>, Referer as the listener sends it.
 *   4 signal-read GET the inbox feed (accountApi/notifications, same headers as check 2) for signal_id, then GET that
 *                  signals/<id> document on the regional host with the ID token. 200 or 404 ok; 403 as check 1.
 *
 * SERVER CODES (every code the server can send for getRealtimeToken and the feed, mapped to one cause line):
 *   missing_credential (401)
 *   invalid_credential
 *   email_required / email_not_verified / email_unsupported
 *   ambiguous_credentials (400)
 *   user_email_required / invalid_user_email
 *   api_key_owner_mismatch (403)
 *   platform_key_cannot_get_realtime_token (403)
 *   no_identity / ambiguous_identity
 *   agent_identity_required (403)
 *   agent_must_use_api_key (403)
 *   untrusted_origin (403)
 *   realtime_token_disabled (503)
 *   method_not_allowed (405)
 *   rate_limited (429)
 *   internal_error (500)
 */
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { loadWebKeyFrom, readKeyFile } = require('./agent-listen.cjs');
const { loadConfig } = require('./lib/config.cjs');
const { keyMode, proxyUrl } = require('./lib/key-mode.cjs');

const PROJECT = 'litethink';
const FS_HOST = 'firestore.asia-southeast1.rep.googleapis.com'; // D10: our database's regional host
const SHARED_FS_HOST = 'firestore.googleapis.com';             // shared host: info only
const FN_HOST = 'asia-south1-litethink.cloudfunctions.net';
const IDT_HOST = 'identitytoolkit.googleapis.com';
const REFERER = 'https://app.superproductmanager.ai/';
const FS_ROOT = `/v1/projects/${PROJECT}/databases/(default)/documents`;
const TIMEOUT_MS = 10000;

// Server code -> one plain cause line and its fix. Keys are the codes listed in the header comment.
const SERVER_CAUSES = {
  missing_credential: ['no key was sent (no network secret on the functions host, or the header name is wrong)', 'add the SPM agent key as a network secret on asia-south1-litethink.cloudfunctions.net, header X-SPM-API-Key'],
  invalid_credential: ['the key is unknown, revoked or failed verification', 'ask SPM for this agent key again and replace the network secret'],
  email_required: ['the sign-in token carries no email', 'use the agent key, not a person token'],
  email_not_verified: ['the signed-in email is not verified', 'use the agent key, not a person token'],
  email_unsupported: ['the email address has characters the server does not accept', 'use the address from the settings file'],
  ambiguous_credentials: ['both a key and a Bearer token were sent', 'send the key only'],
  user_email_required: ['the X-SPM-User-Email header is missing', 'send the agent address in X-SPM-User-Email'],
  invalid_user_email: ['X-SPM-User-Email is not a valid email address', 'fix agent.email in the settings file'],
  api_key_owner_mismatch: ['this key belongs to another agent', 'use the key that belongs to the agent named in the settings file'],
  platform_key_cannot_get_realtime_token: ['this is a platform key, which cannot get a realtime token', "replace it with this agent's own key"],
  no_identity: ['there is no SPM identity for this account', 'ask SPM to create the agent identity'],
  ambiguous_identity: ['more than one SPM identity exists for this account', 'ask SPM to remove the duplicate identity'],
  agent_identity_required: ['this identity is not an agent, so an agent key cannot be used', 'ask SPM to check the identity type'],
  agent_must_use_api_key: ['the agent identity must sign in with its key, not a person token', 'send the agent key in X-SPM-API-Key'],
  // A request with no X-SPM-API-Key starting spm_k_ and no trusted Origin is refused here first,
  // so this is what a missing network secret, a wrong header name or an uncleared "Bearer" prefix looks like.
  untrusted_origin: ['no SPM agent key reached SPM (no network secret on the functions host, a wrong header name, or a prefix left on it)', 'add the SPM agent key as a network secret on asia-south1-litethink.cloudfunctions.net, header X-SPM-API-Key, prefix cleared'],
  realtime_token_disabled: ['realtime tokens are switched off on the server', 'wait; SPM has to switch them on'],
  method_not_allowed: ['the request method is not POST', 'send this line to the script owner'],
  rate_limited: ['too many requests (rate limited)', 'wait one minute and run the check again'],
  internal_error: ['SPM server error', 'wait a few minutes and run again; if it repeats, send this line to SPM'],
};
const UNEXPECTED_FIX = 'run again; if it repeats, send this line to SPM';
// Network-secret mode (K-A3 item 2): these three codes mean the cloud secret never reached SPM.
const SECRET_NOT_REACHED_CODES = ['missing_credential', 'invalid_credential', 'untrusted_origin'];
const SECRET_NOT_REACHED = ['the network secret did not reach SPM: check the secret\'s host is exactly asia-south1-litethink.cloudfunctions.net and its header is X-SPM-API-Key', 'set the network secret for host asia-south1-litethink.cloudfunctions.net with header X-SPM-API-Key, then run again'];

function out(line) { process.stdout.write(line + '\n'); }

/** The kit version: the VERSION file next to this script, else "dev". */
function kitVersion() {
  try {
    const v = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim();
    if (/^[A-Za-z0-9._-]{1,40}$/.test(v)) return v;
  } catch (_) { /* no VERSION file: a checkout */ }
  return 'dev';
}

/** The plain cause for a server reply: the known code's line, else "unexpected HTTP <status>". Body text is never echoed. */
function serverCause(status, json, secret = false) {
  const code = json && typeof json.code === 'string' && /^[a-z_]{1,60}$/.test(json.code) ? json.code : null;
  if (secret && (status === 401 || status === 403) && SECRET_NOT_REACHED_CODES.includes(code)) return { cause: SECRET_NOT_REACHED[0], fix: SECRET_NOT_REACHED[1] };
  if (code && Object.prototype.hasOwnProperty.call(SERVER_CAUSES, code)) return { cause: SERVER_CAUSES[code][0], fix: SERVER_CAUSES[code][1] };
  return { cause: `unexpected HTTP ${status}`, fix: UNEXPECTED_FIX };
}

function wildcardCause(host) {
  return { cause: `a network secret is being added on ${host}, most likely a wildcard *.googleapis.com`, fix: 'list exact hosts instead of the wildcard' };
}

// Network-secret mode (K-A3 item 1): every https call goes through the cloud proxy by Node's proxyEnv agent.
// The key-file mode keeps fetch, as before. Set by main; tests use http fakes, which never take the proxy.
let VIA_PROXY = false;
let PROXY_AGENT = null;
function callViaProxy(url, method, headers, body) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const u = new URL(url);
    const h = { ...headers };
    if (typeof body === 'string') h['Content-Length'] = Buffer.byteLength(body);
    if (PROXY_AGENT === null) PROXY_AGENT = new https.Agent({ proxyEnv: { HTTPS_PROXY: proxyUrl() } }); // only the proxy URL reaches the agent
    const req = https.request({ protocol: 'https:', hostname: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`, method, headers: h, agent: PROXY_AGENT }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', () => done({ status: null, json: null }));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { json = null; }
        done({ status: res.statusCode, json });
      });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy());
    req.on('error', () => done({ status: null, json: null }));
    req.end(body);
  });
}

/** One HTTP call. Never follows a redirect. A network failure gives status null; the error text is not kept. */
async function call(url, method, headers, body) {
  if (VIA_PROXY && url.startsWith('https:')) return callViaProxy(url, method, headers, body);
  let res;
  try {
    res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (_) {
    return { status: null, json: null };
  }
  let text = '';
  try { text = await res.text(); } catch (_) { text = ''; }
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: res.status, json };
}

/** The key in the settings file's key_file, or null when there is none (the proxy may add the header on a secret host). */
function keyFor(keyFile) {
  if (!keyFile) return null;
  try { return readKeyFile(keyFile); } catch (_) { return null; }
}

function agentHeaders(ctx) {
  const h = { 'X-SPM-User-Email': ctx.email };
  if (ctx.key) h['X-SPM-API-Key'] = ctx.key;
  return h;
}

// ---------------------------------------------------------------- the four checks. Each returns { ok: true } or { ok: false, name, cause, fix }.

async function checkGoogleHost(ctx) {
  const probe = (base) => call(`${base}${FS_ROOT}/signals/${'0'.repeat(64)}`, 'GET', { Authorization: 'Bearer abc' });
  const r = await probe(ctx.bases.regional);
  if (r.status === null) return { ok: false, name: 'google-host', cause: `cannot reach ${FS_HOST}`, fix: 'check that this machine may reach that host' };
  if (r.status === 403) { const w = wildcardCause(FS_HOST); return { ok: false, name: 'google-host', ...w }; }
  if (r.status !== 401) return { ok: false, name: 'google-host', cause: `unexpected ${r.status}`, fix: UNEXPECTED_FIX };
  const s = await probe(ctx.bases.shared);
  if (s.status === null) out(`info google-host (${SHARED_FS_HOST}): no answer, not used by the listener any more`);
  else out(`info google-host (${SHARED_FS_HOST}): HTTP ${s.status}, not used by the listener any more`);
  out('ok google-host');
  return { ok: true };
}

async function checkSpmKey(ctx) {
  const url = `${ctx.bases.fn}/getRealtimeToken`;
  const r = await call(url, 'POST', { ...agentHeaders(ctx), 'Content-Type': 'application/json' }, '{}');
  if (r.status === null) return { ok: false, name: 'spm-key', cause: `cannot reach ${FN_HOST}`, fix: 'check that this machine may reach that host' };
  if (r.status === 200) {
    if (r.json && typeof r.json.token === 'string' && r.json.token) { ctx.customToken = r.json.token; out('ok spm-key'); return { ok: true }; }
    return { ok: false, name: 'spm-key', cause: 'the server reply has no token', fix: UNEXPECTED_FIX };
  }
  return { ok: false, name: 'spm-key', ...serverCause(r.status, r.json, ctx.secret) };
}

async function checkSignIn(ctx) {
  let webKey;
  try { webKey = loadWebKeyFrom(process.env); } catch (_) {
    return { ok: false, name: 'sign-in', cause: 'no app id (web API key) is set on this machine', fix: 'set FIREBASE_API_KEY in the environment to the public SPM app id' };
  }
  const url = `${ctx.bases.idt}/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(webKey)}`;
  const r = await call(url, 'POST', { Referer: REFERER, 'Content-Type': 'application/json' }, JSON.stringify({ token: ctx.customToken, returnSecureToken: true }));
  if (r.status === null) return { ok: false, name: 'sign-in', cause: `cannot reach ${IDT_HOST}`, fix: 'check that this machine may reach that host' };
  if (r.status === 200) {
    if (r.json && typeof r.json.idToken === 'string' && r.json.idToken) { ctx.idToken = r.json.idToken; out('ok sign-in'); return { ok: true }; }
    return { ok: false, name: 'sign-in', cause: 'the sign-in reply has no ID token', fix: UNEXPECTED_FIX };
  }
  const message = r.json && r.json.error && typeof r.json.error.message === 'string' ? r.json.error.message : '';
  if (r.status === 400 && /API key not valid|API_KEY_INVALID|API key/i.test(message)) {
    return { ok: false, name: 'sign-in', cause: 'the app id (web API key) is wrong', fix: 'set FIREBASE_API_KEY to the public SPM app id' };
  }
  if (r.status === 400 && /^[A-Z_]{3,60}$/.test(message)) {
    return { ok: false, name: 'sign-in', cause: `sign-in refused the token (${message})`, fix: UNEXPECTED_FIX };
  }
  return { ok: false, name: 'sign-in', cause: `unexpected HTTP ${r.status}`, fix: UNEXPECTED_FIX };
}

async function checkSignalRead(ctx) {
  const feed = await call(`${ctx.bases.fn}/accountApi/notifications?since=0&limit=100&state=all`, 'GET', agentHeaders(ctx));
  if (feed.status === null) return { ok: false, name: 'signal-read', cause: `cannot reach ${FN_HOST}`, fix: 'check that this machine may reach that host' };
  if (feed.status !== 200) return { ok: false, name: 'signal-read', ...serverCause(feed.status, feed.json, ctx.secret) };
  const sid = feed.json && feed.json.signal_id;
  if (typeof sid !== 'string' || !/^[0-9a-f]{64}$/.test(sid)) return { ok: false, name: 'signal-read', cause: 'the inbox feed reply has no signal id', fix: UNEXPECTED_FIX };
  const r = await call(`${ctx.bases.regional}${FS_ROOT}/signals/${sid}`, 'GET', { Authorization: `Bearer ${ctx.idToken}` });
  if (r.status === null) return { ok: false, name: 'signal-read', cause: `cannot reach ${FS_HOST}`, fix: 'check that this machine may reach that host' };
  if (r.status === 200 || r.status === 404) { out('ok signal-read'); return { ok: true }; }
  if (r.status === 403) return { ok: false, name: 'signal-read', ...wildcardCause(FS_HOST) };
  return { ok: false, name: 'signal-read', cause: `unexpected ${r.status}`, fix: UNEXPECTED_FIX };
}

// ---------------------------------------------------------------- arguments and main

/** Returns { bases } or { usage } with the one line to print. The settings file is read in main (lib/config.cjs). */
function parseArgs(argv) {
  const v = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (!flag || !flag.startsWith('--') || val === undefined || val.startsWith('--')) return { usage: 'usage: agent-selfcheck.cjs --config <abs path>' };
    v[flag] = val;
  }
  return {
    bases: {
      regional: v['--base-regional'] || `https://${FS_HOST}`,
      shared: v['--base-shared'] || `https://${SHARED_FS_HOST}`,
      fn: v['--base-fn'] || `https://${FN_HOST}`,
      idt: v['--base-idt'] || `https://${IDT_HOST}`,
    },
  };
}

async function main(argv) {
  const a = parseArgs(argv);
  if (a.usage) { process.stderr.write(a.usage + '\n'); return 2; }
  let conf;
  try { conf = loadConfig({ argv, env: process.env }); } catch (e) { process.stderr.write(`agent-selfcheck: ${e.message}\n`); return 2; }
  const mode = keyMode(conf, process.env); // K-A3 item 1: no key_file means network-secret mode, which needs the proxy
  if (mode.mode === 'refused') { process.stderr.write(`agent-selfcheck: ${mode.message}\n`); return 2; }
  VIA_PROXY = mode.mode === 'secret';
  out(`info kit version: ${kitVersion()}`);
  const secret = mode.mode === 'secret';
  const ctx = { email: conf.email, bases: a.bases, key: secret ? mode.key : keyFor(conf.keyFile), customToken: null, idToken: null, secret };
  for (const check of [checkGoogleHost, checkSpmKey, checkSignIn, checkSignalRead]) {
    const r = await check(ctx);
    if (!r.ok) { out(`FAIL ${r.name}: ${r.cause}. Fix: ${r.fix}.`); return 1; }
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => { out('FAIL selfcheck: the check itself stopped unexpectedly. Fix: run again; if it repeats, send this line to the script owner.'); process.exit(1); },
  );
}

module.exports = { parseArgs, main, SERVER_CAUSES, serverCause, kitVersion };
