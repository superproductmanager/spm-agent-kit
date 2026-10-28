// Tests for
// Real node, real child processes running the real CLI. The four hosts are replaced by local HTTP servers
// that are FAKES (Firestore regional host, Firestore shared host, getRealtimeToken/accountApi, identitytoolkit).
// Reply shapes are copied from the real services: (codes),
// the refusal, rate-limit, unavailable, method and internal-error bodies, and the listener's feed and sign-in calls.
// Run: node --test
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
// The one synthetic agent every test uses. Its settings file and key file are written into a temp folder per test.
const TEST_AGENT = { name: 'Example agent', email: 'spm-example-agent@agents.invalid', keyFile: 'example-agent.key' };

const SCRIPT = path.join(__dirname, '..', 'agent-selfcheck.cjs');

// Recognisable fake secrets: none may ever appear in stdout or stderr.
const FAKE_KEY = 'spm_k_test_selfcheck_5d1e9a77';
const FAKE_CUSTOM = 'FAKECUSTOMTOKEN-selfcheck-4421';
const FAKE_ID = 'FAKEIDTOKEN-selfcheck-8803';
const FAKE_REFRESH = 'FAKEREFRESH-selfcheck-7710';
const FAKE_WEB = 'example-web-app-id-selfcheck-000000';
const SIGNAL = 'ab'.repeat(32);
const SECRETS = [FAKE_KEY, FAKE_CUSTOM, FAKE_ID, FAKE_REFRESH, FAKE_WEB];

// ---------------------------------------------------------------- FAKE servers (never the real hosts)
/** FAKE HTTP server on 127.0.0.1. handler(req, body) -> { status, body, headers }. Every request is logged. */
function fakeServer(handler) {
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      log.push({ method: req.method, url: req.url, headers: req.headers, body });
      const r = handler(req, body) || {};
      const status = r.status || 200;
      const payload = typeof r.body === 'string' ? r.body : JSON.stringify(r.body === undefined ? {} : r.body);
      res.writeHead(status, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, log, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** A port nobody listens on: connection refused, the "cannot reach" path. */
async function deadBase() {
  const s = await fakeServer(() => ({}));
  const base = s.base;
  await s.close();
  return base;
}

/** FAKE Firestore (regional or shared host), same reply shapes as Firestore REST: 401 for a bad bearer, 404 for a missing document. */
function fakeFirestore(cfg = {}) {
  return fakeServer((req) => {
    if (cfg.status) return { status: cfg.status, body: cfg.body || { error: { code: cfg.status, message: 'FAKE forced status' } } };
    const auth = req.headers.authorization || '';
    if (auth === `Bearer ${FAKE_ID}`) return { status: 404, body: { error: { code: 404, message: 'Document not found', status: 'NOT_FOUND' } } };
    return { status: 401, body: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } };
  });
}

/** FAKE getRealtimeToken plus accountApi feed (Cloud Functions host). Mirrors the real answers (no key, owner mismatch). */
function fakeFunctions(cfg = {}) {
  return fakeServer((req) => {
    const key = req.headers['x-spm-api-key'];
    const email = req.headers['x-spm-user-email'];
    if (req.url.startsWith('/accountApi/notifications')) {
      if (!key) return { status: 401, body: { code: 'missing_credential', error: 'missing Authorization Bearer token or X-SPM-API-Key header' } };
      if (cfg.feed) return cfg.feed;
      return { status: 200, body: { notifications: [], cursor: 0, latest: 0, has_more: false, signal_id: SIGNAL } };
    }
    if (req.url !== '/getRealtimeToken') return { status: 404, body: {} };
    if (req.method !== 'POST') return { status: 405, body: { code: 'method_not_allowed', error: 'POST only' } };
    if (cfg.mint) return cfg.mint;
    if (!key) return { status: 401, body: { code: 'missing_credential', error: 'missing Authorization Bearer token or X-SPM-API-Key header' } };
    if (!email) return { status: 400, body: { code: 'user_email_required', error: 'X-SPM-API-Key requires X-SPM-User-Email' } };
    if (key !== FAKE_KEY) return { status: 401, body: { code: 'invalid_credential', error: `invalid or revoked API key ${FAKE_KEY}` } };
    if (email !== TEST_AGENT.email) return { status: 403, body: { code: 'api_key_owner_mismatch', error: 'this API key can only act as its owner' } };
    return { status: 200, body: { token: FAKE_CUSTOM, expires_in: 3600 } };
  });
}

/** FAKE identitytoolkit accounts:signInWithCustomToken. Bad web key -> 400 API_KEY_INVALID, bad token -> 400 INVALID_CUSTOM_TOKEN. */
function fakeIdentity(cfg = {}) {
  return fakeServer((req, body) => {
    if (cfg.status) return { status: cfg.status, body: cfg.body };
    const key = new URL(req.url, 'http://x').searchParams.get('key');
    if (req.url.split('?')[0] !== '/v1/accounts:signInWithCustomToken') return { status: 404, body: {} };
    if (key !== FAKE_WEB) return { status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } } };
    let token = null;
    try { token = JSON.parse(body).token; } catch (_) { token = null; }
    if (token !== FAKE_CUSTOM) return { status: 400, body: { error: { code: 400, message: 'INVALID_CUSTOM_TOKEN', status: 'INVALID_ARGUMENT' } } };
    return { status: 200, body: { kind: 'identitytoolkit#VerifyCustomTokenResponse', idToken: FAKE_ID, refreshToken: FAKE_REFRESH, expiresIn: '3600', localId: 'fake-local-id' } };
  });
}

// ---------------------------------------------------------------- harness
/**
 * Runs the real CLI as a child process. ASYNC on purpose: the FAKE servers live in this process, so a blocking
 * spawnSync would starve them and every request would wait for the client's timeout.
 * env: only what the test sets (no real HOME, no real key files).
 */
function runSelfcheck({ args, keyDir, webKey = FAKE_WEB, bases }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-home-'));
  const env = { PATH: process.env.PATH, HOME: home };
  if (webKey !== null) env.FIREBASE_API_KEY = webKey;
  const base = ['--config', path.join(keyDir, 'agent.json'),
    '--base-regional', bases.regional, '--base-shared', bases.shared, '--base-fn', bases.fn, '--base-idt', bases.idt];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...(args || base)], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr, signal });
    });
  });
}

function keyDirWith(key = FAKE_KEY) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-keys-'));
  const keyFile = path.join(d, TEST_AGENT.keyFile);
  if (key !== null) fs.writeFileSync(keyFile, key + '\n');
  fs.writeFileSync(path.join(d, 'agent.json'), JSON.stringify({ agent: { name: TEST_AGENT.name, email: TEST_AGENT.email }, key_file: keyFile }));
  return d;
}

const servers = [];
async function serve(p) { const s = await p; servers.push(s); return s; }
after(async () => { for (const s of servers) await s.close().catch(() => {}); });

/** Builds the four fake hosts for one test. Defaults are the healthy path. */
async function world(opts = {}) {
  const regional = await serve(fakeFirestore(opts.regional));
  const shared = await serve(fakeFirestore(opts.shared || { status: 403 }));
  const fn = await serve(fakeFunctions(opts.fn));
  const idt = await serve(fakeIdentity(opts.idt));
  return { regional, shared, fn, idt, bases: { regional: opts.regionalBase || regional.base, shared: opts.sharedBase || shared.base, fn: fn.base, idt: idt.base } };
}

const hasLine = (out, re) => out.split('\n').some((l) => re.test(l));
const allOut = (r) => r.stdout + r.stderr;
const noSecret = (r, label) => { for (const s of SECRETS) assert.ok(!allOut(r).includes(s), `${label}: a secret value was printed`); };

// ---------------------------------------------------------------- usage
test('usage: no settings file exits 2 with one plain line', async () => {
  const w = await world();
  const r = await runSelfcheck({ args: ['--base-idt', '/nonexistent'], bases: w.bases, keyDir: keyDirWith() });
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('usage: a settings file that cannot be read exits 2 and says so in one line', async () => {
  const w = await world();
  const r = await runSelfcheck({ args: ['--config', '/nonexistent/agent.json'], bases: w.bases, keyDir: keyDirWith() });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot read the settings file/);
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

// ---------------------------------------------------------------- check 1: google-host
test('ok all four checks pass on the healthy path, exit 0, one line each', async () => {
  const w = await world();
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 0, allOut(r));
  for (const name of ['google-host', 'spm-key', 'sign-in', 'signal-read']) {
    assert.ok(hasLine(r.stdout, new RegExp(`^ok ${name}$`)), `missing ok ${name}: ${r.stdout}`);
  }
  noSecret(r, 'healthy');
});

test('google-host ok: regional host answers 401 to the fake bearer', async () => {
  const w = await world();
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.ok(hasLine(r.stdout, /^ok google-host$/));
  const probe = w.regional.log.find((x) => x.headers.authorization === 'Bearer abc');
  assert.ok(probe, 'the regional probe used Authorization: Bearer abc');
  assert.match(probe.url, /^\/v1\/projects\/litethink\/databases\/\(default\)\/documents\/signals\/0{64}$/);
});

test('google-host FAIL: regional 403 names the wildcard secret and stops before spm-key', async () => {
  const w = await world({ regional: { status: 403 } });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL google-host: a network secret is being added on firestore\.asia-southeast1\.rep\.googleapis\.com, most likely a wildcard \*\.googleapis\.com\. Fix: list exact hosts instead of the wildcard\.$/), r.stdout);
  assert.equal(w.fn.log.length, 0, 'spm-key must not run after a failed google-host');
  assert.equal(w.idt.log.length, 0, 'sign-in must not run after a failed google-host');
});

test('google-host FAIL: regional 500 is reported as unexpected code', async () => {
  const w = await world({ regional: { status: 500 } });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL google-host: unexpected 500\. Fix: /), r.stdout);
});

test('google-host FAIL: regional host unreachable is reported as cannot reach', async () => {
  const w = await world({ regionalBase: await deadBase() });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL google-host: cannot reach firestore\.asia-southeast1\.rep\.googleapis\.com/), r.stdout);
});

test('google-host shared host 403 is info only, not a failure, and the run goes on', async () => {
  const w = await world({ shared: { status: 403 } });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 0, allOut(r));
  assert.ok(hasLine(r.stdout, /^info google-host \(firestore\.googleapis\.com\): HTTP 403/), r.stdout);
  assert.ok(!/FAIL/.test(r.stdout));
  assert.ok(hasLine(r.stdout, /^ok spm-key$/));
});

test('google-host shared host unreachable is info only', async () => {
  const w = await world({ sharedBase: await deadBase() });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 0, allOut(r));
  assert.ok(hasLine(r.stdout, /^info google-host \(firestore\.googleapis\.com\)/), r.stdout);
});

// ---------------------------------------------------------------- check 2: spm-key (getRealtimeToken)
// Each row: the server reply and the one plain cause line.
const KEY_CASES = [
  // [name, status, body or null for "no key sent", cause fragment, file:line of the server code]
  ['missing_credential', 401, null, 'no key was sent'],
  ['invalid_credential', 401, { code: 'invalid_credential' }, 'the key is unknown, revoked or failed verification'],
  ['email_required', 401, { code: 'email_required' }, 'the sign-in token carries no email'],
  ['email_not_verified', 401, { code: 'email_not_verified' }, 'the signed-in email is not verified'],
  ['email_unsupported', 401, { code: 'email_unsupported' }, 'the email address has characters the server does not accept'],
  ['ambiguous_credentials', 400, { code: 'ambiguous_credentials' }, 'both a key and a Bearer token were sent'],
  ['user_email_required', 400, { code: 'user_email_required' }, 'the X-SPM-User-Email header is missing'],
  ['invalid_user_email', 400, { code: 'invalid_user_email' }, 'X-SPM-User-Email is not a valid email address'],
  ['api_key_owner_mismatch', 403, { code: 'api_key_owner_mismatch' }, 'this key belongs to another agent'],
  ['platform_key_cannot_get_realtime_token', 403, { code: 'platform_key_cannot_get_realtime_token' }, 'this is a platform key, which cannot get a realtime token'],
  ['no_identity', 403, { code: 'no_identity' }, 'there is no SPM identity for this account'],
  ['ambiguous_identity', 403, { code: 'ambiguous_identity' }, 'more than one SPM identity exists for this account'],
  ['agent_identity_required', 403, { code: 'agent_identity_required' }, 'this identity is not an agent, so an agent key cannot be used'],
  ['agent_must_use_api_key', 403, { code: 'agent_must_use_api_key' }, 'the agent identity must sign in with its key, not a person token'],
  ['untrusted_origin', 403, { code: 'untrusted_origin' }, 'no SPM agent key reached SPM'],
  ['realtime_token_disabled', 503, { code: 'realtime_token_disabled' }, 'realtime tokens are switched off on the server'],
  ['method_not_allowed', 405, { code: 'method_not_allowed' }, 'the request method is not POST'],
  ['rate_limited', 429, { code: 'rate_limited' }, 'too many requests'],
  ['internal_error', 500, { code: 'internal_error' }, 'SPM server error'],
];

for (const [code, status, body, cause] of KEY_CASES) {
  test(`spm-key FAIL ${code} gives the plain cause`, async () => {
    const w = await world({ fn: { mint: { status, body: body || { code: 'missing_credential', error: 'x' } } } });
    // no-key case: the key file is absent, so the request carries no X-SPM-API-Key and the fake answers as the server does
    const keyDir = body === null ? keyDirWith(null) : keyDirWith();
    const r = await runSelfcheck({ keyDir, bases: w.bases });
    assert.equal(r.code, 1, allOut(r));
    const re = new RegExp(`^FAIL spm-key: .*${cause.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
    assert.ok(hasLine(r.stdout, re), `expected cause "${cause}" in: ${r.stdout}`);
    assert.ok(hasLine(r.stdout, /Fix: .+\.$/), 'the FAIL line names a fix');
    noSecret(r, code);
  });
}

test('spm-key FAIL missing_credential with the no-key fake: the server 401 is mapped, not a generic error', async () => {
  const w = await world();
  const r = await runSelfcheck({ keyDir: keyDirWith(null), bases: w.bases });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL spm-key: no key was sent/), r.stdout);
  assert.ok(!w.fn.log.some((x) => x.headers['x-spm-api-key']), 'no key header was sent');
});

test('spm-key FAIL unknown code with status 418 is reported as unexpected HTTP 418 and echoes no body text', async () => {
  const w = await world({ fn: { mint: { status: 418, body: { code: 'teapot', error: `leaked ${FAKE_KEY}` } } } });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL spm-key: unexpected HTTP 418\. Fix: /), r.stdout);
  noSecret(r, 'teapot');
});

test('spm-key FAIL 200 without a token is a plain failure', async () => {
  const w = await world({ fn: { mint: { status: 200, body: { expires_in: 3600 } } } });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL spm-key: the server reply has no token/), r.stdout);
});

test('spm-key sends the key from the identity key file and the identity email (values not printed)', async () => {
  const w = await world();
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.ok(hasLine(r.stdout, /^ok spm-key$/), r.stdout);
  const mint = w.fn.log.find((x) => x.url === '/getRealtimeToken');
  assert.equal(mint.method, 'POST');
  assert.equal(mint.headers['x-spm-api-key'], FAKE_KEY);
  assert.equal(mint.headers['x-spm-user-email'], TEST_AGENT.email);
  assert.equal(mint.body, '{}');
});

// ---------------------------------------------------------------- check 3: sign-in
test('sign-in ok: custom token exchanged at identitytoolkit with the web key and the Referer', async () => {
  const w = await world();
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.ok(hasLine(r.stdout, /^ok sign-in$/), r.stdout);
  const si = w.idt.log[0];
  assert.equal(si.method, 'POST');
  assert.equal(si.headers.referer, 'https://app.superproductmanager.ai/');
});

test('sign-in FAIL app id wrong: a bad web key gives the app id cause (400 API key error)', async () => {
  const w = await world();
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases, webKey: 'example-wrong-web-app-id-00000000' });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL sign-in: the app id \(web API key\) is wrong\. Fix: /), r.stdout);
  noSecret(r, 'wrong app id');
});

test('sign-in FAIL custom token refused: the server code is shown (INVALID_CUSTOM_TOKEN)', async () => {
  const w = await world({ idt: { status: 400, body: { error: { code: 400, message: 'INVALID_CUSTOM_TOKEN' } } } });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL sign-in: sign-in refused the token \(INVALID_CUSTOM_TOKEN\)\. Fix: /), r.stdout);
});

test('sign-in FAIL no app id on this machine: no web key found in env or files', async () => {
  const w = await world();
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases, webKey: null });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL sign-in: no app id \(web API key\) is set on this machine\. Fix: /), r.stdout);
  assert.equal(w.idt.log.length, 0);
});

test('sign-in FAIL identitytoolkit unreachable: cannot reach cause', async () => {
  const w = await world();
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: { ...w.bases, idt: await deadBase() } });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL sign-in: cannot reach identitytoolkit/), r.stdout);
});

// ---------------------------------------------------------------- check 4: signal-read
test('signal-read ok: the inbox signal document read with the ID token answers 404 (absent doc is ok)', async () => {
  const w = await world();
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.ok(hasLine(r.stdout, /^ok signal-read$/), r.stdout);
  const sig = w.regional.log.find((x) => x.headers.authorization === `Bearer ${FAKE_ID}`);
  assert.ok(sig, 'the signal read used the ID token');
  assert.equal(sig.url, `/v1/projects/litethink/databases/(default)/documents/signals/${SIGNAL}`);
});

test('signal-read FAIL: 403 on the regional host gives the same wildcard cause as google-host', async () => {
  // google-host must pass first (401 for "Bearer abc"), then the signal read is refused with 403
  const regional = await serve(fakeServer((req) => {
    if (req.headers.authorization === 'Bearer abc') return { status: 401, body: { error: { code: 401 } } };
    return { status: 403, body: { error: { code: 403 } } };
  }));
  const w = await world({ regionalBase: regional.base });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^ok google-host$/), r.stdout);
  assert.ok(hasLine(r.stdout, /^FAIL signal-read: a network secret is being added on firestore\.asia-southeast1\.rep\.googleapis\.com, most likely a wildcard \*\.googleapis\.com\. Fix: /), r.stdout);
});

test('signal-read FAIL: unexpected 401 with the ID token is reported as unexpected code', async () => {
  const regional = await serve(fakeServer((req) => {
    if (req.headers.authorization === 'Bearer abc') return { status: 401, body: { error: { code: 401 } } };
    return { status: 401, body: { error: { code: 401 } } };
  }));
  const w = await world({ regionalBase: regional.base });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL signal-read: unexpected 401\. Fix: /), r.stdout);
});

test('signal-read FAIL: the inbox feed reply has no signal id', async () => {
  const w = await world({ fn: { feed: { status: 200, body: { notifications: [], cursor: 0, latest: 0, has_more: false } } } });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL signal-read: the inbox feed reply has no signal id\. Fix: /), r.stdout);
});

test('signal-read FAIL: the inbox feed refused with a server code gets the same plain cause as spm-key', async () => {
  const w = await world({ fn: { feed: { status: 403, body: { code: 'api_key_owner_mismatch', error: 'x' } } } });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL signal-read: this key belongs to another agent/), r.stdout);
  noSecret(r, 'feed');
});

// ---------------------------------------------------------------- order, output shape, secrets
test('stop at first failure: a failed spm-key runs no sign-in and no signal read', async () => {
  const w = await world({ fn: { mint: { status: 403, body: { code: 'api_key_owner_mismatch' } } } });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 1);
  assert.equal(w.idt.log.length, 0, 'no sign-in after the failure');
  assert.equal(w.regional.log.filter((x) => x.headers.authorization === `Bearer ${FAKE_ID}`).length, 0, 'no signal read after the failure');
  const failLines = r.stdout.split('\n').filter((l) => /^FAIL /.test(l));
  assert.equal(failLines.length, 1, 'exactly one FAIL line');
  assert.ok(!r.stdout.includes('ok sign-in'));
});

test('output shape: every stdout line is ok, info or FAIL; each FAIL has a Fix clause', async () => {
  const w = await world({ regional: { status: 403 } });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.ok(hasLine(r.stdout, /^FAIL google-host: /), `the run must print its FAIL line: ${r.stdout}`);
  for (const l of r.stdout.split('\n').filter(Boolean)) assert.match(l, /^(ok|info|FAIL) /, l);
  for (const l of r.stdout.split('\n').filter((x) => x.startsWith('FAIL'))) assert.match(l, /\. Fix: .+\.$/, l);
});

test('no secret in output on the healthy path, with every fake secret present', async () => {
  const w = await world();
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 0);
  noSecret(r, 'healthy');
});

test('no secret in output when the server echoes the key and the token back in an error', async () => {
  const w = await world({ fn: { mint: { status: 401, body: { code: 'invalid_credential', error: `invalid or revoked API key ${FAKE_KEY} ${FAKE_CUSTOM}` } } } });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL spm-key: the key is unknown, revoked or failed verification/), `the run must reach the spm-key cause: ${r.stdout}`);
  noSecret(r, 'echo');
});

test('no secret in output when the app id is wrong and identitytoolkit echoes the token', async () => {
  const w = await world({ idt: { status: 400, body: { error: { code: 400, message: `API key not valid ${FAKE_CUSTOM} ${FAKE_ID}` } } } });
  const r = await runSelfcheck({ keyDir: keyDirWith(), bases: w.bases });
  assert.equal(r.code, 1);
  assert.ok(hasLine(r.stdout, /^FAIL sign-in: the app id \(web API key\) is wrong/), `the run must reach the sign-in cause: ${r.stdout}`);
  noSecret(r, 'idt echo');
});

// ---------------------------------------------------------------- 0.2.0: --setup (no key, three setup lines in the spool)
// --setup needs a VERSION file beside the script (the spool carries kit_version), so each setup test runs a copy of the
// script and its lib folder in a temp kit folder. Hosts are the local fakes above, or a closed port.
const SETUP_CONFIG_APP = 'example-web-app-id-selfcheck-000000';
const SPOOL_RE = { id: /^[a-f0-9-]{16,64}$/, run_id: /^[a-f0-9-]{8,64}$/, step: /^[a-z0-9-]{1,32}$/, code: /^[a-z0-9_]{1,64}$/ };

function setupKit(version = '0.2.0\n') {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-kit-'));
  fs.copyFileSync(path.join(__dirname, '..', 'agent-selfcheck.cjs'), path.join(kit, 'agent-selfcheck.cjs'));
  fs.copyFileSync(path.join(__dirname, '..', 'agent-listen.cjs'), path.join(kit, 'agent-listen.cjs'));
  fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(kit, 'lib'), { recursive: true });
  if (version !== null) fs.writeFileSync(path.join(kit, 'VERSION'), version);
  return kit;
}

function setupConfig(obj) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-setup-cfg-'));
  const p = path.join(d, 'config.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

/** Runs the kit copy with --setup. HOME is a temp folder; the env carries no proxy and no key. */
function runSetupMode({ kit, home, config, bases, args }) {
  const argv = args || ['--setup', '--config', config];
  const extra = [];
  if (bases) extra.push('--base-regional', bases.regional, '--base-shared', bases.shared, '--base-fn', bases.fn, '--base-idt', bases.idt);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(kit, 'agent-selfcheck.cjs'), ...argv, ...extra], { env: { PATH: process.env.PATH, HOME: home } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
  });
}

function spoolOf(home) {
  const f = path.join(home, '.spm-agent-state', 'setup-report.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function newHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-setup-home-')); }

/** Healthy fakes for the three setup checks: regional 401, functions 404 (any status is an answer), identity 400 invalid custom token. */
async function setupFakes(opts = {}) {
  const regional = await serve(fakeServer(() => ({ status: opts.regional ?? 401, body: { error: { code: 401 } } })));
  const fn = await serve(fakeServer(() => ({ status: opts.fn ?? 404, body: { error: { code: 404 } } })));
  const idt = await serve(fakeServer(() => ({ status: opts.idtStatus ?? 400, body: { error: { message: opts.idtMessage ?? 'INVALID_CUSTOM_TOKEN' } } })));
  return { regional: regional.base, shared: regional.base, fn: fn.base, idt: idt.base };
}

const SETUP_STEPS = ['spm-host', 'google-host'];

test('setup: two check lines in the spool, both pass on healthy hosts; stdout empty; exit 0; no key or proxy used', async () => {
  const kit = setupKit();
  const home = newHome();
  try {
    const bases = await setupFakes();
    const r = await runSetupMode({ kit, home, config: setupConfig({ app_id: SETUP_CONFIG_APP }), bases });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    const lines = spoolOf(home);
    assert.deepEqual(lines.map((l) => [l.step, l.status]), SETUP_STEPS.map((s) => [s, 'pass']));
    const runId = fs.readFileSync(path.join(home, '.spm-agent-state', 'setup-run-id'), 'utf8').trim();
    for (const l of lines) {
      assert.equal(l.kind, 'check');
      assert.equal(l.role, 'setup');
      assert.match(l.id, SPOOL_RE.id);
      assert.equal(l.run_id, runId);
      assert.match(l.run_id, SPOOL_RE.run_id);
      assert.match(l.step, SPOOL_RE.step);
      assert.equal(l.code, undefined, 'a pass has no code');
      assert.equal(l.kit_version, '0.2.0');
      assert.match(l.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    }
    assert.equal(new Set(lines.map((l) => l.id)).size, 2);
  } finally { fs.rmSync(kit, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('setup: every host refusing gives two fails with code no_answer, and still exits 0', async () => {
  const kit = setupKit();
  const home = newHome();
  try {
    const dead = await deadBase();
    const r = await runSetupMode({ kit, home, config: setupConfig({ app_id: SETUP_CONFIG_APP }), bases: { regional: dead, shared: dead, fn: dead, idt: dead } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.deepEqual(spoolOf(home).map((l) => [l.step, l.status, l.code]), SETUP_STEPS.map((s) => [s, 'fail', 'no_answer']));
  } finally { fs.rmSync(kit, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('setup: spm-host passes on any HTTP status (a 500 is an answer)', async () => {
  const kit = setupKit();
  const home = newHome();
  try {
    const r = await runSetupMode({ kit, home, config: setupConfig({ app_id: SETUP_CONFIG_APP }), bases: await setupFakes({ fn: 500 }) });
    assert.equal(r.code, 0);
    assert.equal(spoolOf(home).find((l) => l.step === 'spm-host').status, 'pass');
  } finally { fs.rmSync(kit, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('setup: no app-id line is written even when the config has no app_id (Addendum A1)', async () => {
  const kit = setupKit();
  const home = newHome();
  try {
    const r = await runSetupMode({ kit, home, config: setupConfig({}), bases: await setupFakes() });
    assert.equal(r.code, 0);
    assert.deepEqual(spoolOf(home).map((l) => l.step), ['spm-host', 'google-host']);
  } finally { fs.rmSync(kit, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('setup: google-host fails with code wildcard_secret on a regional 403, and passes are not affected', async () => {
  const kit = setupKit();
  const home = newHome();
  try {
    const r = await runSetupMode({ kit, home, config: setupConfig({ app_id: SETUP_CONFIG_APP }), bases: await setupFakes({ regional: 403 }) });
    assert.equal(r.code, 0);
    const lines = spoolOf(home);
    assert.equal(lines.find((l) => l.step === 'google-host').code, 'wildcard_secret');
    assert.equal(lines.find((l) => l.step === 'spm-host').status, 'pass');
  } finally { fs.rmSync(kit, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('setup: google-host fails with code unexpected_status on a regional 500', async () => {
  const kit = setupKit();
  const home = newHome();
  try {
    const r = await runSetupMode({ kit, home, config: setupConfig({ app_id: SETUP_CONFIG_APP }), bases: await setupFakes({ regional: 500 }) });
    assert.equal(r.code, 0);
    const line = spoolOf(home).find((l) => l.step === 'google-host');
    assert.deepEqual([line.status, line.code], ['fail', 'unexpected_status']);
  } finally { fs.rmSync(kit, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('setup: an unreadable config still exits 0 and records two fails with code no_config', async () => {
  const kit = setupKit();
  const home = newHome();
  try {
    const r = await runSetupMode({ kit, home, config: path.join(home, 'missing.json'), bases: await setupFakes() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.deepEqual(spoolOf(home).map((l) => [l.step, l.status, l.code]), SETUP_STEPS.map((s) => [s, 'fail', 'no_config']));
  } finally { fs.rmSync(kit, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('setup: a kit with no VERSION file writes no spool lines (kit_version cannot be filled in) and exits 0', async () => {
  const kit = setupKit(null);
  const home = newHome();
  try {
    const r = await runSetupMode({ kit, home, config: setupConfig({ app_id: SETUP_CONFIG_APP }), bases: await setupFakes() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(fs.existsSync(path.join(home, '.spm-agent-state', 'setup-report.jsonl')), false);
  } finally { fs.rmSync(kit, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('setup: the spool holds no secret, no address and no host name from the answers', async () => {
  const kit = setupKit();
  const home = newHome();
  try {
    const r = await runSetupMode({ kit, home, config: setupConfig({ app_id: SETUP_CONFIG_APP }), bases: await setupFakes({ idtMessage: 'API key not valid ' + FAKE_WEB, idtStatus: 400 }) });
    assert.equal(r.code, 0);
    const text = fs.readFileSync(path.join(home, '.spm-agent-state', 'setup-report.jsonl'), 'utf8');
    assert.equal(text.includes('@'), false);
    assert.equal(text.includes(FAKE_WEB), false, 'the app id must not reach the spool');
    assert.equal(text.includes('127.0.0.1'), false);
  } finally { fs.rmSync(kit, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('setup: a second run inside the hour reuses the run id', async () => {
  const kit = setupKit();
  const home = newHome();
  try {
    const bases = await setupFakes();
    const cfg = setupConfig({ app_id: SETUP_CONFIG_APP });
    assert.equal((await runSetupMode({ kit, home, config: cfg, bases })).code, 0);
    assert.equal((await runSetupMode({ kit, home, config: cfg, bases })).code, 0);
    const ids = new Set(spoolOf(home).map((l) => l.run_id));
    assert.equal(ids.size, 1, 'one run id across both runs');
  } finally { fs.rmSync(kit, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});
