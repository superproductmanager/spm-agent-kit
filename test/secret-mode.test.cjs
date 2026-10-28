'use strict';
// Network-secret mode (K-A3 items 1, 2 and 5). A settings file with no key_file means the key is a network
// secret in the Claude cloud environment: every SPM call sends the fixed placeholder header value and goes
// through the cloud proxy (HTTPS_PROXY). Real child processes, real files; the only fakes are a local CONNECT
// proxy (answers 502, so nothing leaves the machine) and a local http server standing in for SPM.
// Run: node --test test/secret-mode.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const KIT = path.join(__dirname, '..');
const PLACEHOLDER = 'network-secret';
const REFUSAL = 'network-secret mode needs the Claude cloud proxy; set key_file to run elsewhere';
const FN_CONNECT = 'asia-south1-litethink.cloudfunctions.net:443';
const FS_CONNECT = 'firestore.asia-southeast1.rep.googleapis.com:443';
const DOC_ID = '00000000-0000-4000-8000-000000000010';
const COMMENT_ID = '00000000-0000-4000-8000-000000000011';
const ID1 = '00000000-0000-4000-8000-000000000001';
const KEY = 'spm_k_test_secretmode_agent_key_0123456789';
const AGENT = { name: 'Example agent', email: 'spm-example-agent@agents.invalid' };

function workdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `secret-mode-${label}-`));
}

// A settings file with no key_file (network-secret mode), or with key_file pointing at a synthetic key file.
function writeConfig(dir, { keyFile } = {}) {
  const file = path.join(dir, 'agent.config.json');
  const body = { agent: AGENT };
  if (keyFile) {
    const kf = path.join(dir, 'agent.key');
    fs.writeFileSync(kf, `${KEY}\n`, { mode: 0o600 });
    body.key_file = kf;
  }
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

// Runs a kit script as a child process with a clean environment (only PATH and HOME are inherited).
function runCli(script, args, { env = {}, input = '', timeoutMs = 20000, home } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(KIT, script), ...args], {
      env: { PATH: process.env.PATH, HOME: home, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// A local CONNECT proxy: records every CONNECT target and answers 502, so no socket reaches the target.
function startConnectProxy() {
  const seen = [];
  const server = http.createServer();
  server.on('connect', (req, socket) => {
    seen.push(req.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}

// Argument lists that get past usage parsing, so the key-mode check is what decides the outcome.
function scriptArgs(script, config, dir) {
  if (script === 'agent-listen.cjs') return ['--config', config, '--inbox', '--cursor-file', path.join(dir, 'cursor.json'), '--mode', 'stream'];
  if (script === 'agent-reply.cjs') return ['--config', config, '--document', DOC_ID, '--to', COMMENT_ID, '--text', 'Synthetic reply.'];
  if (script === 'agent-resolve.cjs') return ['--config', config, '--ids', ID1];
  if (script === 'agent-selfcheck.cjs') return ['--config', config];
  return ['--config', config]; // agent-ack.cjs
}

// --- item 1: refusal without a proxy -------------------------------------------------------------------------

for (const script of ['agent-listen.cjs', 'agent-reply.cjs', 'agent-ack.cjs', 'agent-resolve.cjs', 'agent-selfcheck.cjs']) {
  test(`${script}: network-secret mode with no HTTPS_PROXY is refused with exit 2 and the one refusal line`, async () => {
    const dir = workdir('noproxy');
    const home = workdir('home');
    const config = writeConfig(dir);
    const r = await runCli(script, scriptArgs(script, config, dir), { home, input: '' });
    assert.equal(r.code, 2, `exit ${r.code}, stderr ${JSON.stringify(r.stderr)}`);
    assert.ok(r.stderr.includes(REFUSAL), `stderr was ${JSON.stringify(r.stderr)}`);
    assert.ok(!r.stdout.includes('ok ') && !r.stdout.includes('FAIL'), `stdout was ${JSON.stringify(r.stdout)}`);
  });
}

// --- item 1: every real call goes through the proxy, with no key file ----------------------------------------

for (const [script, expected] of [
  ['agent-reply.cjs', FN_CONNECT],
  ['agent-resolve.cjs', FN_CONNECT],
  ['agent-selfcheck.cjs', FS_CONNECT],
]) {
  test(`${script}: network-secret mode sends its first SPM call as CONNECT ${expected} through the proxy, reading no key file`, async () => {
    const dir = workdir('route');
    const home = workdir('home');
    const config = writeConfig(dir); // no key_file: nothing to read
    const proxy = await startConnectProxy();
    try {
      const r = await runCli(script, scriptArgs(script, config, dir), { home, env: { HTTPS_PROXY: proxy.url }, timeoutMs: 20000 });
      assert.notEqual(r.code, 0, `a call that the proxy refuses must not succeed: ${JSON.stringify(r)}`);
      assert.ok(proxy.seen.includes(expected), `proxy saw ${JSON.stringify(proxy.seen)}, want ${expected}`);
      assert.ok(!r.stderr.includes(KEY) && !r.stdout.includes(KEY), 'a key value was printed');
    } finally {
      await proxy.close();
    }
  });
}

test('agent-ack.cjs: network-secret mode with a proxy starts its lookup through the proxy to the functions host', async () => {
  const dir = workdir('ack-route');
  const home = workdir('home');
  const config = writeConfig(dir);
  const proxy = await startConnectProxy();
  const line = JSON.stringify({ t: '2026-10-04T16:50:15+05:30', document_id: DOC_ID, seq: 101, kind: 'comment.replied', comment_id: COMMENT_ID, author_kind: 'human', author_name: 'Example person', excerpt: '@Example agent hello', via: 'marker' });
  try {
    await runCli('agent-ack.cjs', scriptArgs('agent-ack.cjs', config, dir), { home, env: { HTTPS_PROXY: proxy.url }, input: `${line}\n`, timeoutMs: 20000 });
    assert.ok(proxy.seen.includes(FN_CONNECT), `proxy saw ${JSON.stringify(proxy.seen)}, want ${FN_CONNECT}`);
  } finally {
    await proxy.close();
  }
});

// --- item 1: the placeholder header, end to end through selfcheck (http fakes, so no CONNECT needed) ----------

// A fake SPM: the four endpoints selfcheck calls. The mode decides what getRealtimeToken answers.
function startFakeSpm({ spmKeyAnswer }) {
  const headers = {};
  const server = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = req.url;
      if (u.startsWith('/getRealtimeToken')) { headers.getRealtimeToken = req.headers['x-spm-api-key']; return spmKeyAnswer.status === 200 ? send(200, { token: 'fake-custom-token' }) : send(spmKeyAnswer.status, { code: spmKeyAnswer.code }); }
      if (u.startsWith('/v1/accounts:signInWithCustomToken')) return send(200, { idToken: 'fake-id-token' });
      if (u.startsWith('/accountApi/notifications')) { headers.notifications = req.headers['x-spm-api-key']; return send(200, { signal_id: '0'.repeat(63) + '1' }); }
      if (u.startsWith('/v1/projects/litethink/databases/(default)/documents/signals/')) return u.endsWith('0'.repeat(63) + '1') ? send(404, {}) : send(401, {});
      return send(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ headers, base, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function selfcheckArgs(config, base) {
  return ['--config', config, '--base-regional', base, '--base-shared', base, '--base-fn', base, '--base-idt', base];
}

test('agent-selfcheck.cjs: network-secret mode sends the placeholder as X-SPM-API-Key on every key call and never reads a key file', async () => {
  const dir = workdir('sc-placeholder');
  const home = workdir('home');
  const config = writeConfig(dir);
  const spm = await startFakeSpm({ spmKeyAnswer: { status: 200 } });
  const proxy = await startConnectProxy();
  try {
    const r = await runCli('agent-selfcheck.cjs', selfcheckArgs(config, spm.base), { home, env: { HTTPS_PROXY: proxy.url, FIREBASE_API_KEY: 'fake-web-app-id' } });
    assert.equal(spm.headers.getRealtimeToken, PLACEHOLDER, `getRealtimeToken header was ${spm.headers.getRealtimeToken}`);
    assert.equal(spm.headers.notifications, PLACEHOLDER, `feed header was ${spm.headers.notifications}`);
    assert.ok(r.stdout.includes('ok spm-key') && r.stdout.includes('ok signal-read'), `stdout was ${JSON.stringify(r.stdout)}`);
    assert.equal(r.code, 0, `exit ${r.code}, stderr ${JSON.stringify(r.stderr)}`);
  } finally {
    await spm.close();
    await proxy.close();
  }
});

test('agent-selfcheck.cjs: network-secret mode, untrusted_origin at the key check names the network-secret cause', async () => {
  const dir = workdir('sc-cause');
  const home = workdir('home');
  const config = writeConfig(dir);
  const spm = await startFakeSpm({ spmKeyAnswer: { status: 403, code: 'untrusted_origin' } });
  const proxy = await startConnectProxy();
  try {
    const r = await runCli('agent-selfcheck.cjs', selfcheckArgs(config, spm.base), { home, env: { HTTPS_PROXY: proxy.url, FIREBASE_API_KEY: 'fake-web-app-id' } });
    assert.equal(r.code, 1);
    const want = 'FAIL spm-key: the network secret did not reach SPM: check the secret\'s host is exactly asia-south1-litethink.cloudfunctions.net and its header is X-SPM-API-Key. Fix:';
    assert.ok(r.stdout.includes(want), `stdout was ${JSON.stringify(r.stdout)}`);
  } finally {
    await spm.close();
    await proxy.close();
  }
});

test('agent-selfcheck.cjs: key_file mode keeps today\'s cause for untrusted_origin and sends the key from the file', async () => {
  const dir = workdir('sc-file');
  const home = workdir('home');
  const config = writeConfig(dir, { keyFile: true });
  const spm = await startFakeSpm({ spmKeyAnswer: { status: 403, code: 'untrusted_origin' } });
  try {
    const r = await runCli('agent-selfcheck.cjs', selfcheckArgs(config, spm.base), { home, env: { FIREBASE_API_KEY: 'fake-web-app-id' } });
    assert.equal(spm.headers.getRealtimeToken, KEY, 'file mode must send the key read from key_file');
    assert.equal(r.code, 1);
    assert.ok(r.stdout.includes('FAIL spm-key: no SPM agent key reached SPM'), `stdout was ${JSON.stringify(r.stdout)}`);
    assert.ok(!r.stdout.includes('network secret did not reach'), 'file mode must not use the network-secret cause');
  } finally {
    await spm.close();
  }
});

// --- item 1, in-process: resolve sends the placeholder and never calls the key reader ------------------------

test('agent-resolve.cjs main: network-secret mode posts the placeholder header and reads no key file', async () => {
  const { main } = require(path.join(KIT, 'agent-resolve.cjs'));
  const dir = workdir('resolve-main');
  const config = writeConfig(dir);
  const posted = [];
  let reads = 0;
  const saved = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  try {
    const out = [];
    const err = [];
    const code = await main(['--config', config, '--ids', ID1], {
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      readKeyFile: () => { reads++; return KEY; },
      post: async (o) => { posted.push(o); return { status: 500, text: '{}' }; },
    });
    assert.equal(reads, 0, 'the key file was read');
    assert.equal(posted.length, 1, `posts ${posted.length}`);
    assert.equal(posted[0].headers['X-SPM-API-Key'], PLACEHOLDER);
    assert.notEqual(code, 2, `exit ${code}, err ${JSON.stringify(err)}`);
  } finally {
    if (saved === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = saved;
  }
});

test('agent-resolve.cjs main: network-secret mode without a proxy exits 2 before any post', async () => {
  const { main } = require(path.join(KIT, 'agent-resolve.cjs'));
  const dir = workdir('resolve-noproxy');
  const config = writeConfig(dir);
  const saved = process.env.HTTPS_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  try {
    const err = [];
    let posts = 0;
    const code = await main(['--config', config, '--ids', ID1], {
      io: { out: () => {}, err: (s) => err.push(s) },
      readKeyFile: () => KEY,
      post: async () => { posts++; return { status: 200, text: '{}' }; },
    });
    assert.equal(code, 2);
    assert.equal(posts, 0);
    assert.ok(err.join('\n').includes(REFUSAL), `err ${JSON.stringify(err)}`);
  } finally {
    if (saved !== undefined) process.env.HTTPS_PROXY = saved;
  }
});

// --- the key never reaches output in either mode ------------------------------------------------------------

test('key_file mode: the key value never appears in selfcheck output', async () => {
  const dir = workdir('sc-nokey');
  const home = workdir('home');
  const config = writeConfig(dir, { keyFile: true });
  const spm = await startFakeSpm({ spmKeyAnswer: { status: 401, code: 'missing_credential' } });
  try {
    const r = await runCli('agent-selfcheck.cjs', selfcheckArgs(config, spm.base), { home, env: { FIREBASE_API_KEY: 'fake-web-app-id' } });
    assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  } finally {
    await spm.close();
  }
});
