'use strict';
// Tests for the Firestore transport setting (node or webchannel) in agent-listen.cjs.
// A FAKE Firebase SDK tree is written to a temp folder: stubs for @firebase/app, @firebase/auth, @firebase/firestore (node build) and
// @firebase/firestore/dist/index.cjs.js. Each stub appends what it was asked to a log file, so the tests can see which
// file loaded and which options were passed. The stubs are fakes for the SDK only (no network); the loader code itself is real.
// Each loader case runs in its own child process, because the SDK cache and the fetch wrap are per process.
// Run: node --test test/transport.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const KIT = path.join(__dirname, '..');
const LISTENER = path.join(KIT, 'agent-listen.cjs');
const { transportRefusal } = require(LISTENER);
const WEB_LINE = 'agent-listen: transport webchannel needs NODE_USE_ENV_PROXY=1 at start (start.sh sets it)';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-kit-transport-'));
const SDK_DIR = path.join(ROOT, 'sdk');
const LOG = path.join(ROOT, 'sdk-calls.jsonl');

// The fake SDK folder: what cloud-agent-setup.sh would install, reduced to the files the loader touches.
function writeFakeSdk() {
  const put = (rel, body) => { const p = path.join(SDK_DIR, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
  const rec = (name) => `const fs = require('node:fs'); const rec = (ev, data) => fs.appendFileSync(process.env.FAKE_SDK_LOG, JSON.stringify({ ev, file: ${name}, ...data }) + '\\n');`;
  put('package.json', JSON.stringify({ name: 'fake-runtime', private: true }));
  put('node_modules/@firebase/app/package.json', JSON.stringify({ name: '@firebase/app', version: '0.0.0-fake', main: 'app.js' }));
  put('node_modules/@firebase/app/app.js', `${rec("'@firebase/app'")}
fs.appendFileSync(process.env.FAKE_SDK_LOG, JSON.stringify({ ev: 'load', file: __filename }) + '\\n');
exports.initializeApp = (opts, name) => { rec('initializeApp', { name, hasKey: typeof opts.apiKey === 'string' }); return { name }; };
exports.deleteApp = async () => {};
exports.setLogLevel = () => {};`);
  put('node_modules/@firebase/auth/package.json', JSON.stringify({ name: '@firebase/auth', version: '0.0.0-fake', main: 'auth.js' }));
  put('node_modules/@firebase/auth/auth.js', `${rec("'@firebase/auth'")}
fs.appendFileSync(process.env.FAKE_SDK_LOG, JSON.stringify({ ev: 'load', file: __filename }) + '\\n');
exports.inMemoryPersistence = { fake: true };
exports.initializeAuth = (app) => { rec('initializeAuth', {}); return { app }; };
exports.signInWithCustomToken = async (auth, token) => { rec('signInWithCustomToken', { tokenLen: String(token).length }); return {}; };`);
  put('node_modules/@firebase/firestore/node.js', `${rec("'@firebase/firestore node'")}
fs.appendFileSync(process.env.FAKE_SDK_LOG, JSON.stringify({ ev: 'load', file: __filename }) + '\\n');
exports.getFirestore = (app) => { rec('getFirestore', {}); return { fake: 'db' }; };
exports.doc = (db, a, b) => ({ a, b });
exports.onSnapshot = (ref, opts, next, err) => { rec('onSnapshot', { ref }); return () => {}; };
exports.terminate = async () => {};
exports.setLogLevel = () => {};`);
  put('node_modules/@firebase/firestore/package.json', JSON.stringify({ name: '@firebase/firestore', version: '0.0.0-fake', exports: { '.': './node.js', './package.json': './package.json', './dist/index.cjs.js': './dist/index.cjs.js' } }));
  put('node_modules/@firebase/firestore/dist/index.cjs.js', `${rec("'@firebase/firestore dist'")}
fs.appendFileSync(process.env.FAKE_SDK_LOG, JSON.stringify({ ev: 'load', file: __filename }) + '\\n');
exports.initializeFirestore = (app, opts) => { rec('initializeFirestore', { opts }); return { fake: 'db' }; };
exports.getFirestore = (app) => { rec('getFirestore', {}); return { fake: 'db' }; };
exports.doc = (db, a, b) => ({ a, b });
exports.onSnapshot = (ref, opts, next, err) => { rec('onSnapshot', { ref }); return () => {}; };
exports.terminate = async () => {};
exports.setLogLevel = () => {};`);
}
writeFakeSdk();

// Child: loads the real listener, installs a fake fetch as the "real" one, signs in through the chosen transport,
// then asks the fetch wrap about three hosts. Prints one JSON line with the results.
const CHILD = `
const m = require(process.argv[1]);
const mode = process.argv[2];
const seen = [];
globalThis.fetch = async (input, init = {}) => {
  const h = new Headers(init.headers || {});
  fs.appendFileSync(process.env.FAKE_SDK_LOG, JSON.stringify({ ev: 'fetch', url: String(input), redirect: init.redirect, referer: h.get('Referer') }) + '\\n');
  return { ok: true };
};
const fs = require('node:fs');
(async () => {
  const d = m.realDeps();
  d.transport = mode;
  await d.signIn('tok-value', 'web-key-value');
  d.listen('a'.repeat(64), () => {}, () => {});
  const out = {};
  for (const u of ['https://firestore.googleapis.com/v1/x', 'https://identitytoolkit.googleapis.com/v1/accounts', 'https://example.com/x']) {
    try { await globalThis.fetch(u); out[u] = 'reached'; } catch (e) { out[u] = e.message; }
  }
  process.stdout.write(JSON.stringify(out) + '\\n');
  process.exit(0);
})().catch((e) => { process.stdout.write('CHILD-ERROR ' + e.message + '\\n'); process.exit(1); });
`;

function runMode(mode, extraEnv = {}) {
  try { fs.unlinkSync(LOG); } catch (_) { /* first run */ }
  const r = spawnSync(process.execPath, ['-e', CHILD, LISTENER, mode], {
    encoding: 'utf8',
    timeout: 60000,
    env: { PATH: process.env.PATH, HOME: ROOT, SPM_AGENT_RUNTIME_DIR: SDK_DIR, FAKE_SDK_LOG: LOG, ...extraEnv },
  });
  assert.equal(r.status, 0, `child exited ${r.status}: ${r.stdout} ${r.stderr}`);
  const calls = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const results = JSON.parse(r.stdout.trim().split('\n').pop());
  return { calls, results };
}

const loadsOf = (calls) => calls.filter((c) => c.ev === 'load').map((c) => path.relative(SDK_DIR, c.file).split(path.sep).join('/'));

test('node mode loads @firebase/firestore, calls getFirestore, and never loads the browser build', () => {
  const { calls } = runMode('node');
  assert.deepEqual(loadsOf(calls), ['node_modules/@firebase/app/app.js', 'node_modules/@firebase/auth/auth.js', 'node_modules/@firebase/firestore/node.js']);
  assert.ok(calls.some((c) => c.ev === 'getFirestore'), 'getFirestore not called');
  assert.ok(!calls.some((c) => c.ev === 'initializeFirestore'), 'initializeFirestore called in node mode');
  assert.ok(calls.some((c) => c.ev === 'signInWithCustomToken'), 'signIn did not run');
});

test('webchannel mode loads the browser build by absolute path and passes exactly the two long-polling options', () => {
  const { calls } = runMode('webchannel');
  assert.deepEqual(loadsOf(calls), ['node_modules/@firebase/app/app.js', 'node_modules/@firebase/auth/auth.js', 'node_modules/@firebase/firestore/dist/index.cjs.js']);
  const init = calls.filter((c) => c.ev === 'initializeFirestore');
  assert.equal(init.length, 1, 'initializeFirestore must be called once');
  assert.deepEqual(init[0].opts, { experimentalForceLongPolling: true, useFetchStreams: true });
  assert.ok(!calls.some((c) => c.ev === 'getFirestore'), 'getFirestore called in webchannel mode');
});

test('fetch wrap: node mode refuses firestore.googleapis.com and allows only the sign-in hosts', () => {
  const { calls, results } = runMode('node');
  assert.equal(results['https://firestore.googleapis.com/v1/x'], 'refused: the SDK may only reach the sign-in hosts');
  assert.equal(results['https://identitytoolkit.googleapis.com/v1/accounts'], 'reached');
  assert.match(results['https://example.com/x'], /^refused/);
  assert.ok(!calls.some((c) => c.ev === 'fetch' && c.url.includes('firestore.googleapis.com')), 'a firestore fetch reached the real fetch in node mode');
});

test('fetch wrap: webchannel mode allows firestore.googleapis.com, still refuses other hosts, keeps Referer and redirect error', () => {
  const { calls, results } = runMode('webchannel');
  assert.equal(results['https://firestore.googleapis.com/v1/x'], 'reached');
  assert.equal(results['https://identitytoolkit.googleapis.com/v1/accounts'], 'reached');
  assert.match(results['https://example.com/x'], /^refused/);
  const fsCall = calls.find((c) => c.ev === 'fetch' && c.url.includes('firestore.googleapis.com'));
  assert.ok(fsCall, 'no firestore fetch reached the real fetch');
  assert.equal(fsCall.redirect, 'error');
  assert.equal(fsCall.referer, 'https://app.superproductmanager.ai/');
});

test('transportRefusal: webchannel with HTTPS_PROXY and no NODE_USE_ENV_PROXY refuses with the one line', () => {
  assert.equal(transportRefusal('webchannel', { HTTPS_PROXY: 'http://proxy.example:3128' }), WEB_LINE);
  assert.equal(transportRefusal('webchannel', { https_proxy: 'http://proxy.example:3128' }), WEB_LINE);
  assert.equal(transportRefusal('webchannel', { HTTPS_PROXY: 'http://proxy.example:3128', NODE_USE_ENV_PROXY: '0' }), WEB_LINE);
});

test('transportRefusal: allowed when no proxy is set, or NODE_USE_ENV_PROXY=1, or the transport is node', () => {
  assert.equal(transportRefusal('webchannel', {}), null);
  assert.equal(transportRefusal('webchannel', { HTTPS_PROXY: 'http://proxy.example:3128', NODE_USE_ENV_PROXY: '1' }), null);
  assert.equal(transportRefusal('node', { HTTPS_PROXY: 'http://proxy.example:3128' }), null);
  assert.equal(transportRefusal('node', {}), null);
});

test('the refusal reaches the process as exit 2 with that one line, before any key read or call', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'refuse-'));
  const cfg = path.join(dir, 'agent.json');
  fs.writeFileSync(cfg, JSON.stringify({ agent: { name: 'Example agent', email: 'spm-example-agent@agents.invalid' }, key_file: path.join(dir, 'missing.key'), transport: 'webchannel' }));
  const r = spawnSync(process.execPath, [LISTENER, '--config', cfg, '--cursor-file', path.join(dir, 'cursor.json'), '--document', '00000000-0000-4000-8000-000000000001'], {
    encoding: 'utf8',
    timeout: 60000,
    env: { PATH: process.env.PATH, HOME: dir, SPM_AGENT_RUNTIME_DIR: SDK_DIR, FAKE_SDK_LOG: LOG, HTTPS_PROXY: 'http://proxy.example:3128' },
  });
  assert.equal(r.status, 2, `status ${r.status}, stderr ${r.stderr}`);
  assert.equal(r.stderr.trim(), WEB_LINE);
  assert.ok(!fs.existsSync(path.join(dir, 'cursor.json')), 'a cursor was written');
});

test('main passes the settings transport to the deps, and a node settings file leaves it node', async () => {
  const { main } = require(LISTENER);
  const dir = fs.mkdtempSync(path.join(ROOT, 'wire-'));
  const cfgFor = (transport) => {
    const cfg = path.join(dir, `agent-${transport}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ agent: { name: 'Example agent', email: 'spm-example-agent@agents.invalid' }, key_file: path.join(dir, 'k.key'), transport }));
    return cfg;
  };
  const argv = (cfg) => ['--config', cfg, '--cursor-file', path.join(dir, 'c.json'), '--document', '00000000-0000-4000-8000-000000000001'];
  for (const transport of ['webchannel', 'node']) {
    const deps = { io: { out() {}, err() {} }, sdkMissing: () => 'stop before any call' };
    const code = await main(argv(cfgFor(transport)), deps);
    assert.equal(code, 2);
    assert.equal(deps.transport, transport);
  }
});
