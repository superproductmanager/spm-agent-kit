// Tests for lib/report.cjs: the item rules, the spool file and the batched POST to SPM.
// Real files in a temp folder, real HTTP to a local server on 127.0.0.1 (no real network). No fakes of the transport.
// Run: node --test test/report.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const report = require(path.join(__dirname, '..', 'lib', 'report.cjs'));
const { findSecrets } = require(path.join(__dirname, '..', 'lib', 'secret-patterns.cjs'));

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
// Built at runtime so that no source line carries a key shape.
const FAKE_GOOGLE_KEY = ['AI', 'za'].join('') + 'Q'.repeat(35);
const FAKE_SPM_KEY = ['spm', 'k', 'test', 'report', 'fixture'].join('_') + '0123456789';

function tmpdir(label) { return fs.mkdtempSync(path.join(os.tmpdir(), `report-${label}-`)); }

// A local HTTP server standing in for SPM. handler(rec) returns { status, body } (body is an object or a string).
// Default: 202 with accepted = number of reports in the body.
function server(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const rec = { method: req.method, url: req.url, headers: req.headers, text, bytes: Buffer.byteLength(text) };
      try { rec.json = JSON.parse(text); } catch (_) { rec.json = null; }
      seen.push(rec);
      let out = handler ? handler(rec) : null;
      if (!out) {
        const n = rec.json && Array.isArray(rec.json.reports) ? rec.json.reports.length : 0;
        out = { status: 202, body: { accepted: n, duplicates: 0 } };
      }
      const payload = typeof out.body === 'string' ? out.body : JSON.stringify(out.body || {});
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ base: `http://127.0.0.1:${port}/accountApi`, seen, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }) });
    });
  });
}

// A base URL on a port nothing listens on (a real connection refusal).
function deadBase() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(`http://127.0.0.1:${port}/accountApi`));
    });
  });
}

const VERSION = '0.2.0';
const RUN = '0123abcd-ef01';
let seq = 0;
const uid = () => { seq++; return `a1b2c3d4-0000-4000-8000-${String(seq).padStart(12, '0')}`; };
const setupItem = (over = {}) => ({ id: uid(), kind: 'setup', role: 'setup', at: iso(NOW), kit_version: VERSION, run_id: RUN, step: 'config', status: 'pass', ...over });
const usageItem = (over = {}) => ({ id: uid(), kind: 'usage', role: 'listener', at: iso(NOW), kit_version: VERSION, session_key: '0123456789abcdef', model: 'claude-test-model-1', price_tier: 'standard', numbers: { calls: 2, input_tokens: 30, output_tokens: 12, cache_write_5m_tokens: 100, cache_write_1h_tokens: 0, cache_read_tokens: 3000, compactions: 0, compaction_pre_tokens: 0 }, ...over });
const heartbeatItem = (over = {}) => ({ id: uid(), kind: 'heartbeat', role: 'listener', at: iso(NOW), kit_version: VERSION, session_key: '0123456789abcdef', numbers: { listener_starts: 1, listener_restarts: 0, listener_failing: 0, container_starts: 1, main_changes: 0, uptime_s: 60 }, ...over });

function spoolFile() { return path.join(tmpdir('spool'), 'setup-report.jsonl'); }
const rejectedFile = (spool) => path.join(path.dirname(spool), 'setup-report.rejected.jsonl');
const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0) : []);

// ---------------------------------------------------------------- item rules
test('validateItem accepts one valid item of each kind', () => {
  for (const it of [setupItem(), setupItem({ kind: 'check', step: 'google-host', status: 'fail', code: 'connect_refused', detail: 'HTTP 0' }), heartbeatItem({ main_status: 'idle' }), usageItem(), heartbeatItem({ node_version: 'v22.22.0' })]) {
    assert.deepEqual(report.validateItem(it, NOW), { ok: true }, JSON.stringify(it).slice(0, 120));
  }
});

test('validateItem refuses an unknown field and names it', () => {
  const r = report.validateItem(setupItem({ email: 'someone@example.invalid' }), NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /email/);
});

test('validateItem refuses a field that belongs to another kind', () => {
  const r = report.validateItem(usageItem({ step: 'config' }), NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /step/);
  assert.equal(report.validateItem(heartbeatItem({ model: 'claude-test-model-1' }), NOW).ok, false);
});

test('validateItem enforces the id, kind, role, at and kit_version rules', () => {
  assert.equal(report.validateItem(setupItem({ id: 'XYZ' }), NOW).ok, false);
  assert.equal(report.validateItem(setupItem({ id: 'abc' }), NOW).ok, false); // shorter than 16
  assert.equal(report.validateItem(setupItem({ kind: 'other' }), NOW).ok, false);
  assert.equal(report.validateItem(setupItem({ role: 'admin' }), NOW).ok, false);
  assert.equal(report.validateItem(setupItem({ at: iso(NOW - 9 * 24 * 3600 * 1000) }), NOW).ok, false); // older than 8 days
  assert.equal(report.validateItem(setupItem({ at: iso(NOW - 7 * 24 * 3600 * 1000) }), NOW).ok, true);
  assert.equal(report.validateItem(setupItem({ at: iso(NOW + 6 * 60 * 1000) }), NOW).ok, false); // more than 5 minutes ahead
  assert.equal(report.validateItem(setupItem({ at: iso(NOW + 4 * 60 * 1000) }), NOW).ok, true);
  assert.equal(report.validateItem(setupItem({ at: '2026-10-28 12:00:00' }), NOW).ok, false); // not ISO 8601 UTC with Z
  assert.equal(report.validateItem(setupItem({ kit_version: 'v0.2.0' }), NOW).ok, false);
  assert.equal(report.validateItem(setupItem({ node_version: '22.22.0' }), NOW).ok, false);
});

test('validateItem enforces run_id, step, status, code and the 200-character detail limit', () => {
  assert.equal(report.validateItem(setupItem({ run_id: 'short' }), NOW).ok, false);
  assert.equal(report.validateItem(setupItem({ step: 'Config' }), NOW).ok, false);
  assert.equal(report.validateItem(setupItem({ step: 'x'.repeat(33) }), NOW).ok, false);
  assert.equal(report.validateItem(setupItem({ status: 'ok' }), NOW).ok, false);
  assert.equal(report.validateItem(setupItem({ code: 'Bad-Code' }), NOW).ok, false);
  assert.equal(report.validateItem(setupItem({ detail: 'd'.repeat(200) }), NOW).ok, true);
  assert.equal(report.validateItem(setupItem({ detail: 'd'.repeat(201) }), NOW).ok, false);
});

test('validateItem refuses a secret-shaped detail and a secret-shaped text field, and says nothing of the value', () => {
  const r1 = report.validateItem(setupItem({ kind: 'check', step: 'app-id', status: 'fail', detail: `key ${FAKE_GOOGLE_KEY}` }), NOW);
  assert.equal(r1.ok, false);
  assert.doesNotMatch(r1.error, /Q{10}/);
  assert.equal(report.validateItem(setupItem({ kind: 'check', step: 'app-id', status: 'fail', detail: `token ${FAKE_SPM_KEY}` }), NOW).ok, false);
});

test('validateItem enforces session_key, model, main_status and the numbers keys and ranges', () => {
  assert.equal(report.validateItem(usageItem({ session_key: '0123' }), NOW).ok, false);
  assert.equal(report.validateItem(usageItem({ session_key: 'ABCDEF0123456789' }), NOW).ok, false);
  assert.equal(report.validateItem(usageItem({ model: 'gpt-4' }), NOW).ok, false);
  assert.equal(report.validateItem(heartbeatItem({ main_status: 'sleeping' }), NOW).ok, false);
  assert.equal(report.validateItem(usageItem({ numbers: { calls: 1, bogus: 1 } }), NOW).ok, false);
  assert.equal(report.validateItem(usageItem({ numbers: { calls: -1 } }), NOW).ok, false);
  assert.equal(report.validateItem(usageItem({ numbers: { calls: 1.5 } }), NOW).ok, false);
  assert.equal(report.validateItem(usageItem({ numbers: { calls: 1e12 + 1 } }), NOW).ok, false);
  assert.equal(report.validateItem(usageItem({ numbers: { calls: 1e12 } }), NOW).ok, true);
  assert.equal(report.validateItem(heartbeatItem({ numbers: { input_tokens: 1 } }), NOW).ok, false);
});

// ---------------------------------------------------------------- spool
test('queueItem assigns a random UUID id, appends one line, and writes a 0600 file in a 0700 folder', () => {
  const file = path.join(tmpdir('q'), 'sub', 'setup-report.jsonl');
  const { id, ...rest } = setupItem();
  const r = report.queueItem(file, rest, NOW);
  assert.equal(r.ok, true);
  assert.match(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const lines = readLines(file);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).id, r.id);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const r2 = report.queueItem(file, usageItem({ id: undefined }), NOW);
  assert.notEqual(r2.id, r.id);
});

test('queueItem refuses an invalid item and writes nothing', () => {
  const file = spoolFile();
  const r = report.queueItem(file, { ...setupItem(), extra: 'x' }, NOW);
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(report.queueItem(file, { ...setupItem(), detail: `k ${FAKE_GOOGLE_KEY}` }, NOW).ok, false);
  assert.equal(fs.existsSync(file), false);
});

test('readSpool returns parsed items and marks unparseable lines with a null item', () => {
  const file = spoolFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(setupItem()) + '\nnot json\n');
  const got = report.readSpool(file);
  assert.equal(got.length, 2);
  assert.equal(got[0].item.kind, 'setup');
  assert.equal(got[1].item, null);
  assert.deepEqual(report.readSpool(path.join(path.dirname(file), 'missing.jsonl')), []);
});

// ---------------------------------------------------------------- flush against a real server
test('flushSpool sends the batch with only the key header, then removes the sent lines', async () => {
  const file = spoolFile();
  for (let i = 0; i < 3; i++) report.queueItem(file, setupItem({ step: `s${i}` }), NOW);
  const srv = await server();
  try {
    const r = await report.flushSpool({ spoolFile: file, base: srv.base, key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW });
    assert.deepEqual([r.sent, r.refused, r.kept], [3, 0, 0]);
    assert.equal(srv.seen.length, 1);
    const req = srv.seen[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/accountApi/agent/reports');
    assert.equal(req.headers['x-spm-api-key'], FAKE_SPM_KEY);
    assert.equal(req.headers['x-spm-user-email'], undefined);
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.json.reports.length, 3);
    assert.equal(req.json.reports[0].kit_version, VERSION); // a line without kit_version gets the kit version
    assert.deepEqual(readLines(file), []);
  } finally { await srv.close(); }
});

test('flushSpool keeps every line when the server is down, and reports kept', async () => {
  const file = spoolFile();
  for (let i = 0; i < 2; i++) report.queueItem(file, setupItem({ step: `k${i}` }), NOW);
  const before = fs.readFileSync(file, 'utf8');
  const r = await report.flushSpool({ spoolFile: file, base: await deadBase(), key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW });
  assert.equal(r.unreachable, true);
  assert.equal(r.sent, 0);
  assert.equal(r.kept, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('flushSpool keeps the lines on a 401, 403, 404 (key refused) and on a 429 or 500', async () => {
  for (const status of [401, 404, 429, 500]) {
    const file = spoolFile();
    report.queueItem(file, setupItem(), NOW);
    const srv = await server(() => ({ status, body: { code: 'x' } }));
    try {
      const r = await report.flushSpool({ spoolFile: file, base: srv.base, key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW });
      assert.equal(r.sent, 0, `status ${status}`);
      assert.equal(r.kept, 1, `status ${status}`);
      assert.equal(readLines(file).length, 1, `status ${status}`);
      assert.equal(r.keyRefused, status === 401 || status === 404, `status ${status}`);
    } finally { await srv.close(); }
  }
});

test('flushSpool drops a batch SPM answers 400 to, and drops invalid lines locally', async () => {
  const file = spoolFile();
  report.queueItem(file, setupItem(), NOW);
  fs.appendFileSync(file, JSON.stringify({ ...setupItem(), extra: 1 }) + '\n');
  fs.appendFileSync(file, 'garbage\n');
  const srv = await server(() => ({ status: 400, body: { error: 'bad', code: 'bad_thing' } }));
  try {
    const r = await report.flushSpool({ spoolFile: file, base: srv.base, key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW });
    assert.equal(r.refused, 2, 'the two invalid lines');
    assert.equal(r.rejected, 1, 'the batch SPM answered 400 to');
    assert.deepEqual(r.rejectedCodes, ['bad_thing']);
    assert.equal(r.sent, 0);
    assert.equal(r.kept, 0);
    assert.deepEqual(readLines(file), []);
    assert.equal(readLines(rejectedFile(file)).length, 1);
  } finally { await srv.close(); }
});

test('flushSpool sends nothing and makes no call when the spool is empty', async () => {
  const srv = await server();
  try {
    const r = await report.flushSpool({ spoolFile: spoolFile(), base: srv.base, key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW });
    assert.deepEqual([r.sent, r.kept, r.refused], [0, 0, 0]);
    assert.equal(srv.seen.length, 0);
  } finally { await srv.close(); }
});

test('flushSpool batches at 50 items and never sends a body above 16 KB', async () => {
  const file = spoolFile();
  for (let i = 0; i < 120; i++) report.queueItem(file, setupItem({ step: 'big', status: 'fail', kind: 'check', detail: 'd'.repeat(200) }), NOW);
  const srv = await server();
  try {
    const r = await report.flushSpool({ spoolFile: file, base: srv.base, key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW });
    assert.equal(r.sent, 120);
    assert.ok(srv.seen.length >= 3, `requests ${srv.seen.length}`);
    for (const req of srv.seen) {
      assert.ok(req.json.reports.length <= 50, 'at most 50 items');
      assert.ok(req.bytes <= 16 * 1024, `body ${req.bytes} bytes`);
    }
    assert.equal(srv.seen.reduce((n, q) => n + q.json.reports.length, 0), 120);
    assert.deepEqual(readLines(file), []);
  } finally { await srv.close(); }
});

test('flushSpool keeps a line queued while the send was in flight', async () => {
  const file = spoolFile();
  report.queueItem(file, setupItem({ step: 'first' }), NOW);
  const srv = await server(() => {
    report.queueItem(file, setupItem({ step: 'late' }), NOW); // another writer appends during the POST
    return null;
  });
  try {
    await report.flushSpool({ spoolFile: file, base: srv.base, key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW });
    const left = readLines(file).map((l) => JSON.parse(l));
    assert.equal(left.length, 1);
    assert.equal(left[0].step, 'late');
  } finally { await srv.close(); }
});

test('flushSpool drops an item older than 7 days before sending it', async () => {
  const file = spoolFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(setupItem({ at: iso(NOW - 9 * 24 * 3600 * 1000) })) + '\n');
  const srv = await server();
  try {
    const r = await report.flushSpool({ spoolFile: file, base: srv.base, key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW });
    assert.equal(r.expired, 1);
    assert.equal(r.refused, 0);
    assert.equal(srv.seen.length, 0);
    assert.deepEqual(readLines(file), []);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- base URL
test('spmBase: default production base, a local http override, and refusals for other http hosts', () => {
  assert.equal(report.spmBase({}), 'https://asia-south1-litethink.cloudfunctions.net/accountApi');
  assert.equal(report.spmBase({ SPM_AGENT_API_BASE: 'http://127.0.0.1:9/accountApi/' }), 'http://127.0.0.1:9/accountApi');
  assert.throws(() => report.spmBase({ SPM_AGENT_API_BASE: 'http://example.invalid/accountApi' }));
  assert.throws(() => report.spmBase({ SPM_AGENT_API_BASE: 'ftp://127.0.0.1/x' }));
  assert.throws(() => report.spmBase({ SPM_AGENT_API_BASE: 'not a url' }));
});

test('spmBase (0.2.0): only the default base or http://127.0.0.1 (any port, any path) is accepted; the key never goes elsewhere', () => {
  const DEFAULT = 'https://asia-south1-litethink.cloudfunctions.net/accountApi';
  assert.equal(report.spmBase({ SPM_AGENT_API_BASE: DEFAULT }), DEFAULT);
  assert.equal(report.spmBase({ SPM_AGENT_API_BASE: 'http://127.0.0.1:1234/x' }), 'http://127.0.0.1:1234/x');
  const refused = [
    'https://other.example',
    'http://10.0.0.1',
    'http://10.0.0.1:8080/accountApi',
    'https://asia-south1-litethink.cloudfunctions.net.other.example/accountApi',
    'http://localhost:1234',
    'https://127.0.0.1:1234',
    'not a url',
  ];
  for (const bad of refused) {
    assert.throws(
      () => report.spmBase({ SPM_AGENT_API_BASE: bad }),
      (e) => e.message === 'SPM_AGENT_API_BASE may only be http://127.0.0.1 (tests)',
      `refused: ${bad}`,
    );
  }
});

// ---------------------------------------------------------------- Addendum A (28 Oct) in lib/report.cjs
test('A3 flushSpool appends each 2xx item to the sent log, and a missing kit version keeps unversioned lines', async () => {
  const file = spoolFile();
  const sentLog = path.join(path.dirname(file), 'health-sent.jsonl');
  report.queueItem(file, setupItem({ step: 'one' }), NOW);
  fs.appendFileSync(file, JSON.stringify({ ...setupItem({ step: 'noversion' }), kit_version: undefined }).replace(',"kit_version":undefined', '') + '\n');
  const srv = await server();
  try {
    const r = await report.flushSpool({ spoolFile: file, base: srv.base, key: FAKE_SPM_KEY, kitVersion: null, now: NOW, sentLog });
    assert.equal(r.sent, 1);
    assert.equal(r.kept, 1, 'the line with no kit version waits');
    assert.equal(readLines(sentLog).length, 1);
    assert.equal(fs.statSync(sentLog).mode & 0o777, 0o600);
    assert.equal(readLines(file).length, 1);
    const r2 = await report.flushSpool({ spoolFile: file, base: srv.base, key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW, sentLog });
    assert.equal(r2.sent, 1);
    assert.equal(readLines(sentLog).length, 2);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- Addendum B (28 Oct, b9d1c271) in lib/report.cjs
test('B3 lines older than 7 days are dropped before sending; a 6-day-old line is sent', async () => {
  const file = spoolFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(setupItem({ at: iso(NOW - 8 * 24 * 3600 * 1000) })) + '\n' + JSON.stringify(setupItem({ at: iso(NOW - 6 * 24 * 3600 * 1000) })) + '\n');
  const srv = await server();
  try {
    const r = await report.flushSpool({ spoolFile: file, base: srv.base, key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW });
    assert.equal(r.expired, 1);
    assert.equal(r.sent, 1);
    assert.equal(srv.seen[0].json.reports.length, 1);
  } finally { await srv.close(); }
});

test('B3 the spool holds at most 1,000 lines: queueItem drops the oldest', () => {
  const file = spoolFile();
  const rid = (i) => 'a' + i.toString(16).padStart(4, '0') + 'beef';
  for (let i = 0; i < 1005; i++) report.queueItem(file, setupItem({ step: 'cap', run_id: rid(i) }), NOW);
  const lines = readLines(file).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1000);
  assert.equal(lines[0].run_id, rid(5), 'the five oldest are gone');
  assert.equal(lines[999].run_id, rid(1004));
});

test('B3 a 400 or 413 batch moves to setup-report.rejected.jsonl with its code; a 413 is rejected too', async () => {
  for (const status of [400, 413]) {
    const file = spoolFile();
    report.queueItem(file, setupItem(), NOW);
    const srv = await server(() => ({ status, body: { code: status === 413 ? 'body_too_large' : 'field_not_for_kind' } }));
    try {
      const r = await report.flushSpool({ spoolFile: file, base: srv.base, key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW });
      assert.equal(r.rejected, 1, `status ${status}`);
      assert.deepEqual(r.rejectedCodes, [status === 413 ? 'body_too_large' : 'field_not_for_kind']);
      assert.equal(r.kept, 0);
      assert.deepEqual(readLines(file), []);
      assert.equal(readLines(rejectedFile(file)).length, 1);
    } finally { await srv.close(); }
  }
});

test('B3 the rejected log keeps its newest 200 lines', async () => {
  const file = spoolFile();
  const rej = rejectedFile(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(rej, Array.from({ length: 200 }, (_, i) => JSON.stringify({ old: i })).join('\n') + '\n');
  report.queueItem(file, setupItem({ step: 'fresh' }), NOW);
  const srv = await server(() => ({ status: 400, body: { code: 'field_not_for_kind' } }));
  try {
    await report.flushSpool({ spoolFile: file, base: srv.base, key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW });
    const lines = readLines(rej).map((l) => JSON.parse(l));
    assert.equal(lines.length, 200);
    assert.equal(lines[199].step, 'fresh');
    assert.equal(lines[0].old, 1);
  } finally { await srv.close(); }
});

test('B3 a sending copy left by a process that is gone is recovered and sent', async () => {
  const file = spoolFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const leftover = `${file}.sending.999999`;
  fs.writeFileSync(leftover, JSON.stringify(setupItem({ step: 'orphan' })) + '\n');
  const srv = await server();
  try {
    const r = await report.flushSpool({ spoolFile: file, base: srv.base, key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW });
    assert.equal(r.sent, 1);
    assert.equal(srv.seen[0].json.reports[0].step, 'orphan');
    assert.equal(fs.existsSync(leftover), false);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.sending.')), []);
  } finally { await srv.close(); }
});

test('B4 queueItem with an id that is already queued adds nothing (a retried heartbeat is a duplicate)', () => {
  const file = spoolFile();
  const id = 'f'.repeat(64);
  report.queueItem(file, setupItem({ id }), NOW);
  report.queueItem(file, setupItem({ id }), NOW);
  assert.equal(readLines(file).length, 1);
});

test('B5 usage numbers take cache_write_5m_tokens and cache_write_1h_tokens, not cache_write_tokens; price_tier is standard or long', () => {
  assert.equal(report.validateItem(usageItem({ numbers: { cache_write_tokens: 1 } }), NOW).ok, false);
  assert.equal(report.validateItem(usageItem({ numbers: { cache_write_5m_tokens: 1, cache_write_1h_tokens: 2 } }), NOW).ok, true);
  assert.equal(report.validateItem(usageItem({ price_tier: 'long' }), NOW).ok, true);
  assert.equal(report.validateItem(usageItem({ price_tier: 'cheap' }), NOW).ok, false);
  assert.equal(report.validateItem(setupItem({ price_tier: 'long' }), NOW).ok, false, 'price_tier is a usage field only');
  assert.equal(report.validateItem(heartbeatItem({ numbers: { cache_write_5m_tokens: 1 } }), NOW).ok, false);
});

test('B1 a detail with an @ is refused (secret check), an ordinary detail is accepted', () => {
  assert.equal(report.validateItem(setupItem({ kind: 'check', step: 'app-id', status: 'fail', detail: 'contact someone@example.invalid' }), NOW).ok, false);
  assert.equal(report.validateItem(setupItem({ kind: 'check', step: 'app-id', status: 'fail', detail: 'HTTP 503' }), NOW).ok, true);
});

test('B3 a network error keeps every line; a 429 or 5xx keeps every line; 2xx counts as sent', async () => {
  for (const status of [429, 500, 503]) {
    const file = spoolFile();
    report.queueItem(file, setupItem(), NOW);
    const srv = await server(() => ({ status, body: { code: 'busy' } }));
    try {
      const r = await report.flushSpool({ spoolFile: file, base: srv.base, key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW });
      assert.equal(readLines(file).length, 1, `status ${status}`);
      assert.equal(r.unreachable, true);
      assert.equal(r.kept, 1);
    } finally { await srv.close(); }
  }
  const file = spoolFile();
  report.queueItem(file, setupItem(), NOW);
  const srv = await server(() => ({ status: 200, body: { accepted: 1 } }));
  try {
    const r = await report.flushSpool({ spoolFile: file, base: srv.base, key: FAKE_SPM_KEY, kitVersion: VERSION, now: NOW });
    assert.equal(r.sent, 1);
    assert.deepEqual(readLines(file), []);
  } finally { await srv.close(); }
});
