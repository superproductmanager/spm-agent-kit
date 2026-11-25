'use strict';
// Tests for lib/backend.cjs and the one-server rule (0.3.0): the settings file may name the SPM server
// ("backend": { api_base, firebase_project, firebase_web_key }). Absent values fall back to the litethink
// server the kit has always used. Every guard admits only the configured https host and refuses every other host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveBackend, DEFAULT_BACKEND, BackendError } = require('../lib/backend.cjs');
const { loadConfig, ConfigError } = require('../lib/config.cjs');
const listen = require('../agent-listen.cjs');
const ack = require('../agent-ack.cjs');
const reply = require('../agent-reply.cjs');
const report = require('../lib/report.cjs');

const LITE_BASE = 'https://asia-south1-litethink.cloudfunctions.net';
const CONF = { api_base: 'https://functions.spm-test.example.com', firebase_project: 'spm-backend-example', firebase_web_key: 'AIzaExampleWebKey000000000000000' };
const CONF_HOST = 'functions.spm-test.example.com';
const UUID = '00000000-0000-4000-8000-000000000001';
const KEY = { 'X-SPM-API-Key': 'k_example_key_for_tests', 'X-SPM-User-Email': 'spm-example-agent@agents.invalid' };
const KEY_LOWER = { 'x-spm-api-key': 'k_example_key_for_tests', 'x-spm-user-email': 'spm-example-agent@agents.invalid' };

function refused(fn) { try { fn(); return false; } catch (e) { return e instanceof Error && (e.name === 'GuardError' || /refused|only|must|not allowed|may only|is allowed/i.test(e.message)); } }
function admitted(fn) { try { fn(); return true; } catch (_) { return false; } }

// ---------------------------------------------------------------- the values

test('no backend in the settings gives the litethink values', () => {
  const b = resolveBackend({});
  assert.deepEqual(b, { api_base: LITE_BASE, api_host: 'asia-south1-litethink.cloudfunctions.net', firebase_project: 'litethink', firebase_web_key: null, firestore_region: 'asia-southeast1' });
  assert.deepEqual(resolveBackend({ backend: undefined }), b);
  assert.deepEqual(DEFAULT_BACKEND, b);
});

test('a partial backend block falls back per field to the litethink values', () => {
  const b = resolveBackend({ backend: { api_base: CONF.api_base } });
  assert.equal(b.api_base, CONF.api_base);
  assert.equal(b.api_host, CONF_HOST);
  assert.equal(b.firebase_project, 'litethink');
  assert.equal(b.firebase_web_key, null);
});

test('a configured https host is accepted and becomes the one host', () => {
  const b = resolveBackend({ backend: CONF });
  assert.deepEqual(b, { api_base: CONF.api_base, api_host: CONF_HOST, firebase_project: CONF.firebase_project, firebase_web_key: CONF.firebase_web_key, firestore_region: 'asia-southeast1' });
});

// ---------------------------------------------------------------- 0.3.1 KITFIX: the Firestore region
test('firestore_region: the default is asia-southeast1 when the backend block omits it', () => {
  assert.equal(resolveBackend({}).firestore_region, 'asia-southeast1');
  assert.equal(resolveBackend({ backend: CONF }).firestore_region, 'asia-southeast1');
});

test('firestore_region: a configured region of lower-case letters, digits and hyphens is accepted', () => {
  assert.equal(resolveBackend({ backend: { firestore_region: 'europe-west3' } }).firestore_region, 'europe-west3');
  assert.equal(resolveBackend({ backend: { firestore_region: 'us-central1' } }).firestore_region, 'us-central1');
});

test('firestore_region: a value that is not a lower-case region name is refused with BackendError', () => {
  for (const bad of ['', 'Asia-Southeast1', 'asia southeast1', 'asia.southeast1', '1asia', 'x'.repeat(60), 42]) {
    assert.throws(() => resolveBackend({ backend: { firestore_region: bad } }), BackendError, `refused: ${JSON.stringify(bad)}`);
  }
});

test('an api_base with a trailing slash is normalised to the origin', () => {
  assert.equal(resolveBackend({ backend: { api_base: CONF.api_base + '/' } }).api_base, CONF.api_base);
});

test('a backend block that is not https, has a path, port, credentials or a bad project is refused', () => {
  const bad = [
    { api_base: 'http://functions.spm-test.example.com' },
    { api_base: 'https://functions.spm-test.example.com/accountApi' },
    { api_base: 'https://functions.spm-test.example.com:8443' },
    { api_base: 'https://u:p@functions.spm-test.example.com' },
    { api_base: 'https://functions.spm-test.example.com?x=1' },
    { api_base: 'not a url' },
    { api_base: 42 },
    { firebase_project: 'Bad Project!' },
    { firebase_web_key: '' },
    { firebase_web_key: 'has space in it 0000000000000000' },
  ];
  for (const b of bad) assert.throws(() => resolveBackend({ backend: b }), BackendError, JSON.stringify(b));
  assert.throws(() => resolveBackend({ backend: 'x' }), BackendError);
});

test('loadConfig reads the backend block and gives the litethink values when it is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-kit-backend-'));
  const base = { agent: { name: 'Example agent', email: 'spm-example-agent@agents.invalid' }, key_file: path.join(dir, 'example.key') };
  const plain = path.join(dir, 'plain.json'); fs.writeFileSync(plain, JSON.stringify(base));
  assert.equal(loadConfig({ argv: ['--config', plain] }).backend.api_host, 'asia-south1-litethink.cloudfunctions.net');
  const cfg = path.join(dir, 'cfg.json'); fs.writeFileSync(cfg, JSON.stringify({ ...base, backend: CONF }));
  assert.equal(loadConfig({ argv: ['--config', cfg] }).backend.api_host, CONF_HOST);
  const badp = path.join(dir, 'bad.json'); fs.writeFileSync(badp, JSON.stringify({ ...base, backend: { api_base: 'http://x.example' } }));
  assert.throws(() => loadConfig({ argv: ['--config', badp] }), ConfigError);
});

// ---------------------------------------------------------------- the guards: configured host admitted, every other host refused

test('agent-listen: the configured host is admitted and every other host is refused', () => {
  listen.applyBackend(resolveBackend({ backend: CONF }));
  try {
    assert.ok(admitted(() => listen.guardRequest(`${CONF.api_base}/getRealtimeToken`, 'POST', KEY_LOWER, {})), 'configured host admitted');
    assert.ok(refused(() => listen.guardRequest(`${LITE_BASE}/getRealtimeToken`, 'POST', KEY_LOWER, {})), 'litethink host refused once a backend is configured');
    assert.ok(refused(() => listen.guardRequest('https://evil.example.net/getRealtimeToken', 'POST', KEY_LOWER, {})), 'other host refused');
    assert.ok(refused(() => listen.guardRequest(`http://${CONF_HOST}/getRealtimeToken`, 'POST', KEY_LOWER, {})), 'plain http on the configured host refused');
    assert.ok(refused(() => listen.guardRequest(`https://${CONF_HOST}:8443/getRealtimeToken`, 'POST', KEY_LOWER, {})), 'port refused');
    assert.ok(refused(() => listen.guardRequest(`https://${CONF_HOST}.evil.example.net/getRealtimeToken`, 'POST', KEY_LOWER, {})), 'look-alike host refused');
  } finally { listen.applyBackend(resolveBackend({})); }
  assert.ok(admitted(() => listen.guardRequest(`${LITE_BASE}/getRealtimeToken`, 'POST', KEY_LOWER, {})), 'defaults restored');
});

test('agent-ack: the configured host is admitted on list and item routes; other hosts are refused', () => {
  ack.applyBackend(resolveBackend({ backend: CONF }));
  try {
    assert.ok(admitted(() => ack.guardList(`${CONF.api_base}/documentsApi/listDocumentComments`, 'POST', KEY_LOWER, { documentId: UUID })), 'configured list admitted');
    assert.ok(refused(() => ack.guardList(`${LITE_BASE}/documentsApi/listDocumentComments`, 'POST', KEY_LOWER, { documentId: UUID })), 'litethink list refused');
    assert.ok(admitted(() => ack.guardApi(`${CONF.api_base}/boardsApi/tasks/${UUID}/comments`, 'GET', KEY_LOWER, undefined)), 'configured item read admitted');
    assert.ok(refused(() => ack.guardApi(`${LITE_BASE}/boardsApi/tasks/${UUID}/comments`, 'GET', KEY_LOWER, undefined)), 'litethink item read refused');
    assert.ok(refused(() => ack.guardList('https://evil.example.net/documentsApi/listDocumentComments', 'POST', KEY_LOWER, { documentId: UUID })), 'other host refused');
    assert.ok(refused(() => ack.guardList(`http://${CONF_HOST}/documentsApi/listDocumentComments`, 'POST', KEY_LOWER, { documentId: UUID })), 'plain http refused');
  } finally { ack.applyBackend(resolveBackend({})); }
  assert.ok(admitted(() => ack.guardList(`${LITE_BASE}/documentsApi/listDocumentComments`, 'POST', KEY_LOWER, { documentId: UUID })), 'defaults restored');
});

test('agent-reply: the configured host is admitted and every other host is refused', () => {
  reply.applyBackend(resolveBackend({ backend: CONF }));
  try {
    const url = (h) => `${h}/documentsApi/listDocumentComments`;
    assert.ok(admitted(() => reply.guardRequest(url(CONF.api_base), 'POST', KEY, { documentId: UUID }, 'reply')), 'configured host admitted');
    assert.ok(refused(() => reply.guardRequest(url(LITE_BASE), 'POST', KEY, { documentId: UUID }, 'reply')), 'litethink host refused');
    assert.ok(refused(() => reply.guardRequest('https://evil.example.net/documentsApi/listDocumentComments', 'POST', KEY, { documentId: UUID }, 'reply')), 'other host refused');
    assert.ok(refused(() => reply.guardRequest(`http://${CONF_HOST}/documentsApi/listDocumentComments`, 'POST', KEY, { documentId: UUID }, 'reply')), 'plain http refused');
  } finally { reply.applyBackend(resolveBackend({})); }
  assert.ok(admitted(() => reply.guardRequest(url2(), 'POST', KEY, { documentId: UUID }, 'reply')), 'defaults restored');
});
function url2() { return `${LITE_BASE}/documentsApi/listDocumentComments`; }

test('lib/report: the SPM base is the configured accountApi; the litethink base is refused once another is configured', () => {
  const b = resolveBackend({ backend: CONF });
  assert.equal(report.spmBase({}, b), `${CONF.api_base}/accountApi`);
  assert.equal(report.spmBase({ SPM_AGENT_API_BASE: `${CONF.api_base}/accountApi` }, b), `${CONF.api_base}/accountApi`);
  assert.equal(report.spmBase({}, null), report.SPM_DEFAULT_BASE, 'no backend keeps the default');
  assert.throws(() => report.spmBase({ SPM_AGENT_API_BASE: report.SPM_DEFAULT_BASE }, b), 'litethink base refused under a configured backend');
  assert.throws(() => report.spmBase({ SPM_AGENT_API_BASE: 'https://evil.example.net/accountApi' }, b), 'other host refused');
});

// ---------------------------------------------------------------- 0.3.0 round 2: every script reads the configured server

const resolveAgent = require('../agent-resolve.cjs');
const selfcheck = require('../agent-selfcheck.cjs');

test('agent-resolve: a configured backend is the host of the request (dry run shows it, nothing sent)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-kit-resolve-'));
  const cfg = path.join(dir, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ agent: { name: 'Example agent', email: 'spm-example-agent@agents.invalid' }, backend: CONF }));
  const out = []; const err = [];
  const code = await resolveAgent.main(['--config', cfg, '--ids', UUID, '--dry-run'], { io: { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) }, env: {}, post: () => { throw new Error('nothing may be sent in a dry run'); } });
  const text = out.join('\n') + err.join('\n');
  assert.equal(code, 0, text);
  assert.ok(text.includes(`https://${CONF_HOST}/accountApi/notifications/resolve`), text);
  assert.ok(!text.includes('litethink'), text);
});

test('agent-selfcheck: a configured backend sets the functions host, the project and the secret text', () => {
  selfcheck.applyBackend(resolveBackend({ backend: CONF }));
  try {
    const t = selfcheck.currentTargets();
    assert.equal(t.fn_host, CONF_HOST);
    assert.equal(t.project, CONF.firebase_project);
    assert.equal(t.fs_root, `/v1/projects/${CONF.firebase_project}/databases/(default)/documents`);
    assert.ok(t.secret_not_reached.every((x) => x.includes(CONF_HOST) && !x.includes('litethink')), JSON.stringify(t.secret_not_reached));
  } finally { selfcheck.applyBackend(resolveBackend({})); }
  const d = selfcheck.currentTargets();
  assert.equal(d.fn_host, 'asia-south1-litethink.cloudfunctions.net');
  assert.equal(d.project, 'litethink');
});
