// Tests for agent-health.cjs: identify, usage, heartbeat, flush. Real node child processes, a temp HOME,
// a temp copy of the kit (so VERSION is read the same way as in an install), and a local HTTP server on 127.0.0.1
// standing in for SPM. No real network. Run: node --test test/agent-health.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { findSecrets } = require(path.join(__dirname, '..', 'lib', 'secret-patterns.cjs'));

const KIT_SRC = path.join(__dirname, '..');
const FAKE_SPM_KEY = ['spm', 'k', 'test', 'health', 'fixture'].join('_') + '0123456789';
const SPM_NAME = 'Example agent';
const SPM_ADDRESS = 'spm-example-agent@agents.invalid';
const SESSION_A = '3f2a9c10-1111-4aaa-8bbb-000000000001';
const SESSION_B = '3f2a9c10-2222-4aaa-8bbb-000000000002';
const KEY_OF = (sid) => crypto.createHash('sha256').update(sid).digest('hex').slice(0, 16);

function tmpdir(label) { return fs.mkdtempSync(path.join(os.tmpdir(), `health-${label}-`)); }

// A kit folder: a copy of agent-health.cjs and lib/, with a VERSION file as the installer writes it.
function makeKit() {
  const dir = tmpdir('kit');
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.copyFileSync(path.join(KIT_SRC, 'agent-health.cjs'), path.join(dir, 'agent-health.cjs'));
  for (const f of fs.readdirSync(path.join(KIT_SRC, 'lib'))) fs.copyFileSync(path.join(KIT_SRC, 'lib', f), path.join(dir, 'lib', f));
  fs.writeFileSync(path.join(dir, 'VERSION'), '0.2.0\n');
  return dir;
}

// A temp HOME with a key file and a settings file that names no agent yet (unless `agent` is given).
function makeHome(agent) {
  const home = tmpdir('home');
  fs.mkdirSync(path.join(home, 'keys'));
  fs.writeFileSync(path.join(home, 'keys', 'agent.key'), FAKE_SPM_KEY + '\n', { mode: 0o600 });
  const cfg = { key_file: path.join(home, 'keys', 'agent.key'), ignore_agents: ['Other agent'] };
  if (agent) cfg.agent = agent;
  const config = path.join(home, 'settings', 'agent.json');
  fs.mkdirSync(path.dirname(config));
  fs.writeFileSync(config, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return { home, config };
}

// Local stand-in for SPM. handler(rec) returns { status, body } or null for the default.
function server(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const rec = { method: req.method, url: req.url, headers: req.headers, text };
      try { rec.json = JSON.parse(text); } catch (_) { rec.json = null; }
      seen.push(rec);
      let out = handler ? handler(rec) : null;
      if (!out) {
        if (req.url.endsWith('/agent/self')) out = { status: 200, body: { address: SPM_ADDRESS, name: SPM_NAME, workspaces: [] } };
        else {
          const n = rec.json && Array.isArray(rec.json.reports) ? rec.json.reports.length : 0;
          out = { status: 202, body: { accepted: n, duplicates: 0 } };
        }
      }
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body || {}));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ base: `http://127.0.0.1:${port}/accountApi`, seen, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }) });
    });
  });
}

function deadBase() {
  return new Promise((resolve) => {
    const s = require('node:net').createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(`http://127.0.0.1:${port}/accountApi`)); });
  });
}

// Runs agent-health.cjs from the kit copy with a clean environment (only PATH, HOME and the base override).
function run(kit, home, args, base, extraEnv = {}) {
  const env = { PATH: process.env.PATH, HOME: home, ...extraEnv };
  if (base) env.SPM_AGENT_API_BASE = base;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(kit, 'agent-health.cjs'), ...args], { env, cwd: home });
    let out = ''; let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err, lines: (out + err).split('\n').filter((l) => l.length > 0) }));
  });
}

const stateDir = (home) => path.join(home, '.spm-agent-state');
const spoolOf = (home) => path.join(stateDir(home), 'setup-report.jsonl');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const reportsOf = (srv) => srv.seen.filter((r) => r.url.endsWith('/agent/reports')).flatMap((r) => r.json.reports);
const bootId = () => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (_) { return null; } };

function writeTranscript(home, folder, sid, lines, ageSeconds = 0) {
  const dir = path.join(home, '.claude', 'projects', folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const t = Date.now() / 1000 - ageSeconds;
  fs.utimesSync(file, t, t);
  return file;
}

// The fixture for session A: 9 lines. Hand count (last line per message id, <synthetic> skipped):
//   claude-test-model-1: calls 2 (msg-1, msg-2); input 10+20=30; output 5+7=12; cache write 100; cache read 1000+2000=3000
//   claude-test-model-2: calls 1 (msg-3); input 3; output 4; cache write 5; cache read 6
//   compactions 2 (preTokens 150000 + 50000 = 200000), attached to claude-test-model-1 (the model with most calls)
function fixtureA() {
  return [
    { type: 'user', sessionId: SESSION_A, message: { role: 'user', content: 'synthetic user text that must never be sent' } },
    { type: 'assistant', sessionId: SESSION_A, message: { id: 'msg-1', model: 'claude-test-model-1', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 }, content: [{ type: 'text', text: 'synthetic reply text' }] } },
    { type: 'assistant', sessionId: SESSION_A, message: { id: 'msg-1', model: 'claude-test-model-1', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 }, content: [{ type: 'text', text: 'synthetic reply text' }] } },
    { type: 'assistant', sessionId: SESSION_A, message: { id: 'msg-1', model: 'claude-test-model-1', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } } },
    { type: 'system', subtype: 'compact_boundary', sessionId: SESSION_A, compactMetadata: { trigger: 'auto', preTokens: 150000, postTokens: 9000, durationMs: 1234 } },
    { type: 'assistant', sessionId: SESSION_A, message: { id: 'msg-2', model: 'claude-test-model-1', usage: { input_tokens: 20, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 } } },
    { type: 'assistant', sessionId: SESSION_A, message: { id: 'msg-3', model: 'claude-test-model-2', usage: { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 5, cache_read_input_tokens: 6 } } },
    { type: 'assistant', sessionId: SESSION_A, message: { id: 'msg-4', model: '<synthetic>', usage: { input_tokens: 999, output_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: 'system', subtype: 'compact_boundary', sessionId: SESSION_A, compactMetadata: { trigger: 'manual', preTokens: 50000, postTokens: 8000, durationMs: 900 } },
  ];
}

const hasLine = (lines, re) => lines.some((l) => re.test(l));
const oneLine = (r) => r.lines.length === 1;

// ---------------------------------------------------------------- start: identity
test('start writes agent.name and agent.email when absent, keeps other keys, and sends only the key header', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  const srv = await server();
  try {
    const r = await run(kit, home, ['start', '--role', 'listener', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    const cfg = readJson(config);
    assert.deepEqual(cfg.agent, { name: SPM_NAME, email: SPM_ADDRESS });
    assert.deepEqual(cfg.ignore_agents, ['Other agent']);
    assert.equal(cfg.key_file, path.join(home, 'keys', 'agent.key'));
    assert.equal(fs.statSync(config).mode & 0o777, 0o600);
    const self = srv.seen.find((q) => q.url.endsWith('/agent/self'));
    assert.equal(self.method, 'GET');
    assert.equal(self.url, '/accountApi/agent/self');
    assert.equal(self.headers['x-spm-api-key'], FAKE_SPM_KEY);
    assert.equal(self.headers['x-spm-user-email'], undefined);
    assert.equal(self.text, '');
    assert.equal(r.lines.length, 1);
    assert.match(r.lines[0], new RegExp(`^health: identified ${SPM_NAME}; sent \\d+, kept \\d+$`));
  } finally { await srv.close(); }
});

test('start with a settings file that already matches SPM changes nothing', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  const before = fs.readFileSync(config, 'utf8');
  const srv = await server();
  try {
    const r = await run(kit, home, ['start', '--role', 'main', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(config, 'utf8'), before);
  } finally { await srv.close(); }
});

test('start with a settings file naming another agent exits 5, one plain line, and changes nothing', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: 'Another agent', email: 'another-agent@agents.invalid' });
  const before = fs.readFileSync(config, 'utf8');
  const srv = await server();
  try {
    const r = await run(kit, home, ['start', '--role', 'main', '--config', config], srv.base);
    assert.equal(r.code, 5, r.err);
    assert.ok(oneLine(r), JSON.stringify(r.lines));
    assert.match(r.lines[0], /^health: /);
    assert.equal(fs.readFileSync(config, 'utf8'), before);
    assert.equal(fs.existsSync(spoolOf(home)), false);
    assert.equal(reportsOf(srv).length, 0);
  } finally { await srv.close(); }
});

test('start exits 6 with one line and changes nothing when SPM refuses the key (401, 403, 404)', async () => {
  for (const status of [401, 403, 404]) {
    const kit = makeKit(); const { home, config } = makeHome();
    const before = fs.readFileSync(config, 'utf8');
    const srv = await server(() => ({ status, body: { code: 'nope' } }));
    try {
      const r = await run(kit, home, ['start', '--role', 'listener', '--config', config], srv.base);
      assert.equal(r.code, 6, `status ${status}: ${r.err}`);
      assert.ok(oneLine(r), `status ${status}: ${JSON.stringify(r.lines)}`);
      assert.equal(fs.readFileSync(config, 'utf8'), before);
    } finally { await srv.close(); }
  }
});

test('start with SPM not reachable exits 0 with one kept line and changes nothing', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  const before = fs.readFileSync(config, 'utf8');
  const r = await run(kit, home, ['start', '--role', 'listener', '--config', config], await deadBase());
  assert.equal(r.code, 0, r.err);
  assert.ok(oneLine(r), JSON.stringify(r.lines));
  assert.match(r.lines[0], /^health: kept \d+ for later$/);
  assert.equal(fs.readFileSync(config, 'utf8'), before);
});

test('start treats an identity answer with a bad name or address as not reachable and changes nothing', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  const before = fs.readFileSync(config, 'utf8');
  const srv = await server((rec) => (rec.url.endsWith('/agent/self') ? { status: 200, body: { address: 'person@example.invalid', name: 'x'.repeat(61), workspaces: [] } } : null));
  try {
    const r = await run(kit, home, ['start', '--role', 'listener', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.match(r.lines[0], /^health: kept \d+ for later$/);
    assert.equal(fs.readFileSync(config, 'utf8'), before);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- usage
test('usage counts the fixture by hand: last line per message id, <synthetic> skipped, compactions summed', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  const srv = await server();
  try {
    const r = await run(kit, home, ['usage', '--role', 'listener', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    const usage = reportsOf(srv).filter((x) => x.kind === 'usage');
    assert.equal(usage.length, 2, JSON.stringify(usage));
    const m1 = usage.find((x) => x.model === 'claude-test-model-1');
    const m2 = usage.find((x) => x.model === 'claude-test-model-2');
    assert.deepEqual(m1.numbers, { calls: 2, input_tokens: 30, output_tokens: 12, cache_write_tokens: 100, cache_read_tokens: 3000, compactions: 2, compaction_pre_tokens: 200000 });
    assert.deepEqual(m2.numbers, { calls: 1, input_tokens: 3, output_tokens: 4, cache_write_tokens: 5, cache_read_tokens: 6, compactions: 0, compaction_pre_tokens: 0 });
    assert.equal(m1.session_key, KEY_OF(SESSION_A));
    assert.equal(m1.role, 'listener');
    assert.equal(m1.kit_version, '0.2.0');
    assert.match(m1.id, /^[0-9a-f-]{16,64}$/);
    assert.equal(m1.id.length, 36);
  } finally { await srv.close(); }
});

test('usage reads only the newest transcript under the projects folders', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA(), 3600);
  writeTranscript(home, '-other-proj', SESSION_B, [{ type: 'assistant', sessionId: SESSION_B, message: { id: 'old-1', model: 'claude-old-model', usage: { input_tokens: 500, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }], 7200);
  const srv = await server();
  try {
    await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base);
    const usage = reportsOf(srv).filter((x) => x.kind === 'usage');
    assert.ok(usage.length >= 1);
    assert.ok(usage.every((x) => x.session_key === KEY_OF(SESSION_A)), 'the older session is not reported');
    assert.ok(usage.every((x) => x.model !== 'claude-old-model'));
  } finally { await srv.close(); }
});

test('usage with --transcript reads the named file', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  const file = writeTranscript(home, '-work-proj', SESSION_B, [{ type: 'assistant', sessionId: SESSION_B, message: { id: 'only-1', model: 'claude-test-model-3', usage: { input_tokens: 4, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }]);
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA(), 3600);
  const srv = await server();
  try {
    const r = await run(kit, home, ['usage', '--role', 'listener', '--config', config, '--transcript', file], srv.base);
    assert.equal(r.code, 0, r.err);
    const usage = reportsOf(srv).filter((x) => x.kind === 'usage');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].session_key, KEY_OF(SESSION_B));
    assert.equal(usage[0].numbers.input_tokens, 4);
  } finally { await srv.close(); }
});

test('usage with no transcript queues nothing and exits 0', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  const srv = await server();
  try {
    const r = await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(reportsOf(srv).length, 0);
  } finally { await srv.close(); }
});

test('usage with SPM down keeps its items in the spool file, one line each', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  const r = await run(kit, home, ['usage', '--role', 'main', '--config', config], await deadBase());
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.lines, ['health: kept 2 for later']);
  const lines = fs.readFileSync(spoolOf(home), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((x) => x.kind === 'usage' && x.role === 'main' && typeof x.id === 'string'));
});

// ---------------------------------------------------------------- flush
test('flush sends the spool with the key header and no identity call, and empties the spool', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  fs.mkdirSync(stateDir(home), { recursive: true });
  const setup = (step) => JSON.stringify({ id: crypto.randomUUID(), kind: 'setup', role: 'setup', at: new Date().toISOString(), run_id: 'abcdef12', step, status: 'pass' });
  fs.writeFileSync(spoolOf(home), [setup('config'), setup('skill'), setup('settings')].join('\n') + '\n');
  const srv = await server();
  try {
    const r = await run(kit, home, ['flush', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(srv.seen.filter((q) => q.url.endsWith('/agent/self')).length, 0);
    assert.equal(srv.seen.length, 1);
    assert.equal(srv.seen[0].headers['x-spm-api-key'], FAKE_SPM_KEY);
    assert.equal(srv.seen[0].json.reports[0].kit_version, '0.2.0');
    assert.equal(fs.readFileSync(spoolOf(home), 'utf8'), '');
    assert.match(r.lines[0], /^health: sent 3, kept 0$/);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- heartbeat
test('heartbeat: the first run counts the whole log, the next run counts only new lines', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  fs.mkdirSync(stateDir(home), { recursive: true });
  const log = path.join(stateDir(home), 'listener.log');
  fs.writeFileSync(log, ['{"kind":"start","t":"x"}', '{"kind":"listener.restart","t":"x","exit_code":1,"delay_s":2}', '{"kind":"listener.failing","t":"x","restarts":3}'].join('\n') + '\n');
  const srv = await server();
  try {
    const r1 = await run(kit, home, ['heartbeat', '--config', config], srv.base);
    assert.equal(r1.code, 0, r1.err);
    const hb1 = reportsOf(srv).filter((x) => x.kind === 'heartbeat');
    assert.equal(hb1.length, 1);
    assert.deepEqual(hb1[0].numbers, { listener_starts: 1, listener_restarts: 1, listener_failing: 1, container_starts: 1, main_changes: 0, uptime_s: 0 });
    assert.equal(hb1[0].session_key, KEY_OF(SESSION_A));
    assert.equal(hb1[0].role, 'listener');
    assert.equal(hb1[0].main_status, undefined);
    fs.appendFileSync(log, '{"kind":"listener.restart","t":"y"}\n{"kind":"start","t":"y"}\n{"kind":"start","t":"z"\n');
    srv.seen.length = 0;
    const r2 = await run(kit, home, ['heartbeat', '--config', config], srv.base);
    assert.equal(r2.code, 0, r2.err);
    const hb2 = reportsOf(srv).filter((x) => x.kind === 'heartbeat');
    assert.equal(hb2.length, 1);
    assert.equal(hb2[0].numbers.listener_starts, 1, 'the half-written last line is not counted yet');
    assert.equal(hb2[0].numbers.listener_restarts, 1);
    assert.equal(hb2[0].numbers.listener_failing, 0);
    assert.equal(hb2[0].numbers.container_starts, 0);
  } finally { await srv.close(); }
});

test('heartbeat: container_starts is 1 for a new boot id, and main_changes follows main-session-id', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  fs.mkdirSync(stateDir(home), { recursive: true });
  fs.writeFileSync(path.join(stateDir(home), 'main-session-id'), 'main-one\n');
  const srv = await server();
  try {
    await run(kit, home, ['heartbeat', '--config', config], srv.base);
    const first = reportsOf(srv).filter((x) => x.kind === 'heartbeat')[0];
    assert.equal(first.numbers.main_changes, 1, 'the first id seen counts as a change');
    srv.seen.length = 0;
    await run(kit, home, ['heartbeat', '--config', config], srv.base);
    assert.equal(reportsOf(srv).filter((x) => x.kind === 'heartbeat')[0].numbers.main_changes, 0);
    fs.writeFileSync(path.join(stateDir(home), 'main-session-id'), 'main-two\n');
    srv.seen.length = 0;
    await run(kit, home, ['heartbeat', '--config', config], srv.base);
    assert.equal(reportsOf(srv).filter((x) => x.kind === 'heartbeat')[0].numbers.main_changes, 1);
    // A state file from another boot: this is a new container.
    const healthFile = path.join(stateDir(home), 'health.json');
    const st = readJson(healthFile);
    fs.writeFileSync(healthFile, JSON.stringify({ ...st, bootId: 'some-other-boot' }));
    srv.seen.length = 0;
    await run(kit, home, ['heartbeat', '--config', config], srv.base);
    assert.equal(reportsOf(srv).filter((x) => x.kind === 'heartbeat')[0].numbers.container_starts, 1);
  } finally { await srv.close(); }
});

test('heartbeat with no transcript queues nothing and keeps the log position', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  fs.mkdirSync(stateDir(home), { recursive: true });
  const log = path.join(stateDir(home), 'listener.log');
  fs.writeFileSync(log, '{"kind":"start","t":"x"}\n');
  const srv = await server();
  try {
    const r = await run(kit, home, ['heartbeat', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(reportsOf(srv).length, 0);
    assert.equal(fs.existsSync(path.join(stateDir(home), 'health.json')), false);
    writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
    await run(kit, home, ['heartbeat', '--config', config], srv.base);
    assert.equal(reportsOf(srv).filter((x) => x.kind === 'heartbeat')[0].numbers.listener_starts, 1);
  } finally { await srv.close(); }
});

test('heartbeat --main-status accepts a listed word and writes it on the item', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  const srv = await server();
  try {
    const bad = await run(kit, home, ['heartbeat', '--main-status', 'sleeping', '--config', config], srv.base);
    assert.equal(bad.code, 2);
    assert.equal(srv.seen.length, 0);
    const ok = await run(kit, home, ['heartbeat', '--main-status', 'review_ready', '--config', config], srv.base);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(reportsOf(srv).filter((x) => x.kind === 'heartbeat')[0].main_status, 'review_ready');
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- spool and batching through the CLI
test('the CLI sends 120 queued items in batches of at most 50, each body at most 16 KB, and empties the spool', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  fs.mkdirSync(stateDir(home), { recursive: true });
  const lines = [];
  for (let i = 0; i < 120; i++) lines.push(JSON.stringify({ id: crypto.randomUUID(), kind: 'check', role: 'setup', at: new Date().toISOString(), run_id: 'abcdef12', step: 'google-host', status: 'fail', code: 'connect_refused', detail: 'd'.repeat(200) }));
  fs.writeFileSync(spoolOf(home), lines.join('\n') + '\n');
  const srv = await server();
  try {
    const r = await run(kit, home, ['flush', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.ok(srv.seen.length >= 3);
    for (const q of srv.seen) { assert.ok(q.json.reports.length <= 50); assert.ok(Buffer.byteLength(q.text) <= 16384); }
    assert.equal(reportsOf(srv).length, 120);
    assert.equal(fs.readFileSync(spoolOf(home), 'utf8'), '');
  } finally { await srv.close(); }
});

test('the CLI refuses a spool line that carries an unknown field, sends nothing for it, and drops it', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  fs.mkdirSync(stateDir(home), { recursive: true });
  const good = JSON.stringify({ id: crypto.randomUUID(), kind: 'setup', role: 'setup', at: new Date().toISOString(), run_id: 'abcdef12', step: 'config', status: 'pass' });
  const bad = JSON.stringify({ id: crypto.randomUUID(), kind: 'setup', role: 'setup', at: new Date().toISOString(), run_id: 'abcdef12', step: 'config', status: 'pass', owner_email: 'x@agents.invalid' });
  fs.writeFileSync(spoolOf(home), good + '\n' + bad + '\n');
  const srv = await server();
  try {
    const r = await run(kit, home, ['flush', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(reportsOf(srv).length, 1);
    assert.doesNotMatch(JSON.stringify(srv.seen.map((q) => q.text)), /owner_email/);
    assert.equal(fs.readFileSync(spoolOf(home), 'utf8'), '');
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- arguments and secrecy
test('bad arguments exit 2 with one line and send nothing', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  const srv = await server();
  const cases = [
    [[], 'no command'],
    [['start', '--role', 'listener'], 'no config'],
    [['start', '--config', 'relative/agent.json', '--role', 'listener'], 'relative config'],
    [['start', '--config', config], 'no role'],
    [['start', '--config', config, '--role', 'setup'], 'bad role'],
    [['usage', '--config', config, '--role', 'main', '--bogus', 'x'], 'unknown argument'],
    [['flush', '--config', config, '--role', 'main'], 'role on flush'],
    [['heartbeat', '--config', config, '--main-status'], 'missing value'],
    [['whatever', '--config', config], 'unknown command'],
  ];
  try {
    for (const [args, label] of cases) {
      const r = await run(kit, home, args, srv.base);
      assert.equal(r.code, 2, `${label}: ${r.err}`);
      assert.ok(r.lines.length >= 1 && r.lines.length <= 2, `${label}: ${JSON.stringify(r.lines)}`);
    }
    assert.equal(srv.seen.length, 0);
  } finally { await srv.close(); }
});

test('no request body or output carries the key, and no body carries a secret-shaped string or any transcript text', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  fs.mkdirSync(stateDir(home), { recursive: true });
  fs.writeFileSync(path.join(stateDir(home), 'listener.log'), '{"kind":"start","t":"x"}\n');
  const srv = await server();
  try {
    const outs = [];
    outs.push(await run(kit, home, ['start', '--role', 'main', '--config', config], srv.base));
    outs.push(await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base));
    outs.push(await run(kit, home, ['heartbeat', '--config', config], srv.base));
    assert.equal(srv.seen.length >= 4, true);
    for (const q of srv.seen) {
      assert.equal(q.text.includes(FAKE_SPM_KEY), false, 'the key is never in a body');
      assert.deepEqual(findSecrets(q.text), [], 'no secret-shaped string in a body');
      assert.equal(q.text.includes('synthetic user text'), false);
      assert.equal(q.text.includes('synthetic reply text'), false);
    }
    for (const o of outs) assert.equal((o.out + o.err).includes(FAKE_SPM_KEY), false);
    for (const q of srv.seen.filter((x) => x.url.endsWith('/agent/reports'))) {
      for (const item of q.json.reports) assert.equal(Object.keys(item).every((k) => ['id', 'kind', 'role', 'at', 'kit_version', 'node_version', 'session_key', 'model', 'numbers', 'main_status', 'code', 'detail', 'run_id', 'step', 'status'].includes(k)), true);
    }
  } finally { await srv.close(); }
});

test('the state folder follows SPM_AGENT_STATE_DIR when it is set', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  const alt = tmpdir('alt-state');
  const srv = await server();
  try {
    const r = await run(kit, home, ['heartbeat', '--config', config], srv.base, { SPM_AGENT_STATE_DIR: alt });
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.existsSync(path.join(alt, 'health.json')), false, 'no transcript, so no state is saved');
    writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
    await run(kit, home, ['heartbeat', '--config', config], srv.base, { SPM_AGENT_STATE_DIR: alt });
    assert.equal(fs.existsSync(path.join(alt, 'health.json')), true);
    assert.equal(fs.existsSync(stateDir(home)), false);
  } finally { await srv.close(); }
});
