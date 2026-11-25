'use strict';
// Tests for agent-call.cjs (0.4.0): one SPM API call as the agent, against a LOCAL real http server (node:http, random port).
// The transport is the real one (makeTransport); only the host is pointed at 127.0.0.1. No real SPM host, no real key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { main, makeTransport, isApiPath } = require('../agent-call.cjs');

const KEY = 'fake-agent-call-key-0123456789abcdef';
const EMAIL = 'spm-example-agent@agents.invalid';
const API_BASE = 'https://spm-stub.invalid';
const COMMENT = '00000000-0000-4000-8000-0000000000c1';
const TASK = '00000000-0000-4000-8000-0000000000ab';
const WS = 'ws-test-1';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-kit-agent-call-'));
const keyFile = path.join(dir, 'example.key');
fs.writeFileSync(keyFile, `${KEY}\n`);
const cfgFile = path.join(dir, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ agent: { name: 'Example agent', email: EMAIL }, key_file: keyFile, backend: { api_base: API_BASE } }));
const bodyFile = path.join(dir, 'body.json');
fs.writeFileSync(bodyFile, JSON.stringify({ documentId: TASK, note: 'synthetic' }));

// A local stub: records every request, answers by path.
function startStub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ method: req.method, path: u.pathname, query: u.search, headers: req.headers, body });
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/ok') return send(200, { ok: true, echo: 'ok' });
      if (u.pathname === '/echo-body') return send(200, { got: JSON.parse(body || 'null') });
      if (u.pathname === '/missing') return send(404, { code: 'not_found', error: 'no such item' });
      if (u.pathname === '/denied') return send(403, { code: 'on_behalf_not_tagged', error: 'not tagged' });
      if (u.pathname === '/boom') return send(500, { code: 'internal', error: 'boom' });
      return send(404, { code: 'route_unknown' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({ port, calls, close: () => new Promise((r) => server.close(r)) });
  }));
}

// Runs main() with the real transport pointed at the stub port; returns { code, out, err, env }.
async function runCall(port, argv, { env = {}, config = cfgFile } = {}) {
  const out = []; const err = [];
  const deps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    env: { ...env },
    http: makeTransport({ lib: http, resolveTarget: () => ({ hostname: '127.0.0.1', port }) }),
    readKeyFile: (file) => fs.readFileSync(file, 'utf8').trim(),
  };
  const code = await main(['--config', config, ...argv], deps);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const xSpmHeaders = (headers) => Object.keys(headers).filter((h) => h.startsWith('x-spm')).sort();

test('headers are exactly as O8: key and address always; workspace and on-behalf only when given', async () => {
  const stub = await startStub();
  try {
    const full = await runCall(stub.port, ['--method', 'GET', '--path', '/ok', '--workspace', WS, '--for-comment', COMMENT.toUpperCase()]);
    assert.equal(full.code, 0, full.err);
    const h = stub.calls[0].headers;
    assert.deepEqual(xSpmHeaders(h), ['x-spm-api-key', 'x-spm-on-behalf-of-comment', 'x-spm-user-email', 'x-spm-workspace']);
    assert.equal(h['x-spm-api-key'], KEY);
    assert.equal(h['x-spm-user-email'], EMAIL);
    assert.equal(h['x-spm-workspace'], WS);
    assert.equal(h['x-spm-on-behalf-of-comment'], COMMENT, 'the comment id is sent lower-case');

    const bare = await runCall(stub.port, ['--method', 'GET', '--path', '/ok']);
    assert.equal(bare.code, 0, bare.err);
    assert.deepEqual(xSpmHeaders(stub.calls[1].headers), ['x-spm-api-key', 'x-spm-user-email']);
  } finally { await stub.close(); }
});

test('a 2xx prints the JSON reply body on stdout and exits 0', async () => {
  const stub = await startStub();
  try {
    const r = await runCall(stub.port, ['--method', 'GET', '--path', '/ok']);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { ok: true, echo: 'ok' });
    assert.equal(r.err, '');
  } finally { await stub.close(); }
});

test('POST with --body-file sends the JSON body with a JSON content type, and the path keeps its query', async () => {
  const stub = await startStub();
  try {
    const r = await runCall(stub.port, ['--method', 'POST', '--path', '/echo-body?x=1', '--body-file', bodyFile]);
    assert.equal(r.code, 0, r.err);
    assert.equal(stub.calls[0].method, 'POST');
    assert.equal(stub.calls[0].path, '/echo-body');
    assert.equal(stub.calls[0].query, '?x=1', 'the query string was dropped');
    assert.equal(stub.calls[0].headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(r.out).got, { documentId: TASK, note: 'synthetic' });
  } finally { await stub.close(); }
});

test('exit 2 on 4xx and prints the error code on stderr; exit 1 on 5xx; the key never appears in stdout or stderr', async () => {
  const stub = await startStub();
  try {
    const nf = await runCall(stub.port, ['--method', 'GET', '--path', '/missing', '--for-comment', COMMENT]);
    assert.equal(nf.code, 2);
    assert.match(nf.err, /HTTP 404 not_found/);
    const dn = await runCall(stub.port, ['--method', 'GET', '--path', '/denied', '--for-comment', COMMENT]);
    assert.equal(dn.code, 2);
    assert.match(dn.err, /on_behalf_not_tagged/);
    const bo = await runCall(stub.port, ['--method', 'GET', '--path', '/boom']);
    assert.equal(bo.code, 1);
    assert.match(bo.err, /HTTP 500/);
    for (const r of [nf, dn, bo]) {
      assert.equal(r.out.includes(KEY), false, 'the key is in stdout');
      assert.equal(r.err.includes(KEY), false, 'the key is in stderr');
    }
  } finally { await stub.close(); }
});

test('exit 1 when the server cannot be reached; the key is not printed', async () => {
  const stub = await startStub();
  const port = stub.port;
  await stub.close();
  const r = await runCall(port, ['--method', 'GET', '--path', '/ok']);
  assert.equal(r.code, 1);
  assert.equal(r.out.includes(KEY) || r.err.includes(KEY), false);
});

test('a path that leaves the configured host is refused (exit 2) before any call', async () => {
  const stub = await startStub();
  try {
    const bad = [
      'https://evil.example/ok', 'http://evil.example/ok', '//evil.example/ok', '/ok@evil', 'ok', '/../ok', '/ok/../../x', '/ok#frag', '/ok\\x',
    ];
    for (const p of bad) {
      const r = await runCall(stub.port, ['--method', 'GET', '--path', p]);
      assert.equal(r.code, 2, `path ${p} was not refused`);
    }
    assert.equal(stub.calls.length, 0, 'a refused path still reached the stub');
    assert.equal(isApiPath('/boardsApi/tasks/x/comments'), true);
    assert.equal(isApiPath('https://evil.example/ok'), false);
  } finally { await stub.close(); }
});

test('usage errors exit 2 and send nothing: bad method, body on GET, comment id not a uuid, workspace with a slash, missing value', async () => {
  const stub = await startStub();
  try {
    const cases = [
      ['--method', 'DELETE', '--path', '/ok'],
      ['--method', 'GET', '--path', '/ok', '--body-file', bodyFile],
      ['--method', 'GET', '--path', '/ok', '--for-comment', 'nope'],
      ['--method', 'GET', '--path', '/ok', '--workspace', 'a/b'],
      ['--method', 'GET', '--path'],
      ['--method', 'GET', '--path', '/ok', '--unknown', 'x'],
      ['--method', 'POST', '--path', '/ok', '--body-file', 'relative.json'],
    ];
    for (const argv of cases) {
      const r = await runCall(stub.port, argv);
      assert.equal(r.code, 2, `argv ${argv.join(' ')} was not refused`);
    }
    assert.equal(stub.calls.length, 0);
  } finally { await stub.close(); }
});

test('network-secret mode (no key_file, proxy set) sends the placeholder; no proxy refuses before any call', async () => {
  const stub = await startStub();
  try {
    const noKeyCfg = path.join(dir, 'nokey.json');
    fs.writeFileSync(noKeyCfg, JSON.stringify({ agent: { name: 'Example agent', email: EMAIL }, backend: { api_base: API_BASE } }));
    const secret = await runCall(stub.port, ['--method', 'GET', '--path', '/ok'], { config: noKeyCfg, env: { HTTPS_PROXY: 'http://proxy.invalid:3128' } });
    assert.equal(secret.code, 0, secret.err);
    assert.equal(stub.calls[0].headers['x-spm-api-key'], 'network-secret');
    const refused = await runCall(stub.port, ['--method', 'GET', '--path', '/ok'], { config: noKeyCfg, env: {} });
    assert.equal(refused.code, 2);
    assert.equal(stub.calls.length, 1, 'a refused run still reached the stub');
  } finally { await stub.close(); }
});
