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
const SESSION_A = '00000000-0000-4000-8000-000000000001';
const SESSION_B = '00000000-0000-4000-8000-000000000002';
// The salted session key (Addendum A2): first 16 hex of sha256(salt + sessionId), salt = <state>/report-salt.
const saltOf = (home) => fs.readFileSync(path.join(home, '.spm-agent-state', 'report-salt'), 'utf8').trim();
const KEY_OF = (home, sid) => crypto.createHash('sha256').update(saltOf(home) + sid).digest('hex').slice(0, 16);

function tmpdir(label) { return fs.mkdtempSync(path.join(os.tmpdir(), `health-${label}-`)); }

// A kit folder: a copy of agent-health.cjs and lib/, with a VERSION file as the installer writes it.
function makeKit({ version = '0.2.0\n' } = {}) {
  const dir = tmpdir('kit');
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.copyFileSync(path.join(KIT_SRC, 'agent-health.cjs'), path.join(dir, 'agent-health.cjs'));
  for (const f of fs.readdirSync(path.join(KIT_SRC, 'lib'))) fs.copyFileSync(path.join(KIT_SRC, 'lib', f), path.join(dir, 'lib', f));
  if (version !== null) fs.writeFileSync(path.join(dir, 'VERSION'), version);
  return dir;
}

// A self answer with extra fields (Addendum A1: app_id, min_kit_version, report).
const selfWith = (extra = {}) => (rec) => (rec.url.endsWith('/agent/self')
  ? { status: 200, body: { address: SPM_ADDRESS, name: SPM_NAME, app_id: null, min_kit_version: null, report_interval_s: 3600, settings: { autostart: true, reports: true }, ...extra } } : null);
const APP_ID = 'appid-test-0123456789abcdef';

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
const spoolText = (home) => (fs.existsSync(spoolOf(home)) ? fs.readFileSync(spoolOf(home), 'utf8') : ''); // an emptied spool is removed
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
//   claude-test-model-1 standard: calls 2 (msg-1, msg-2); input 10+20=30; output 5+7=12; cache 5m 100, 1h 0 (no breakdown:
//     all of cache_creation_input_tokens is 5m); cache read 1000+2000=3000
//   claude-test-model-2 standard: calls 1 (msg-3); input 3; output 4; 5m 5; 1h 0; cache read 6
//   claude-test-model-2 long (msg-5: 95000 + 10000 + 7 = 105007 > 100000): calls 1; input 95000; output 10; 5m 0; 1h 7; cache read 10000
//   compactions 2 (preTokens 150000 + 50000 = 200000), attached to claude-test-model-1 standard (the group with most calls)
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
    { type: 'assistant', sessionId: SESSION_A, message: { id: 'msg-5', model: 'claude-test-model-2', usage: { input_tokens: 95000, output_tokens: 10, cache_creation_input_tokens: 7, cache_read_input_tokens: 10000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 7 } } } },
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

test('start with SPM not reachable exits 7 with one line, runs twice, and changes nothing (B2)', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  const before = fs.readFileSync(config, 'utf8');
  const r = await run(kit, home, ['start', '--role', 'listener', '--config', config], await deadBase());
  assert.equal(r.code, 7, r.err);
  assert.ok(oneLine(r), JSON.stringify(r.lines));
  assert.equal(r.lines[0], 'health: could not reach SPM, run again');
  assert.equal(fs.readFileSync(config, 'utf8'), before);
  assert.equal(fs.existsSync(spoolOf(home)), false);
});

test('start exits 6 when SPM gives no valid agent name (null, or outside the pattern), and changes nothing (B2)', async () => {
  for (const name of [null, 'x'.repeat(61), 'bad/name']) {
    const kit = makeKit(); const { home, config } = makeHome();
    const before = fs.readFileSync(config, 'utf8');
    const srv = await server((rec) => (rec.url.endsWith('/agent/self') ? { status: 200, body: { address: SPM_ADDRESS, name, app_id: null } } : null));
    try {
      const r = await run(kit, home, ['start', '--role', 'listener', '--config', config], srv.base);
      assert.equal(r.code, 6, `${name}: ${r.err}`);
      assert.equal(r.lines.length, 1);
      assert.equal(fs.readFileSync(config, 'utf8'), before);
    } finally { await srv.close(); }
  }
});

test('B2 identify tries twice on a 503 and then exits 7; a 401 is not retried', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  let srv = await server(() => ({ status: 503, body: { code: 'busy' } }));
  try {
    const r = await run(kit, home, ['start', '--role', 'listener', '--config', config], srv.base);
    assert.equal(r.code, 7, r.err);
    assert.equal(srv.seen.filter((q) => q.url.endsWith('/agent/self')).length, 2);
  } finally { await srv.close(); }
  srv = await server(() => ({ status: 401, body: { code: 'nope' } }));
  try {
    await run(kit, home, ['start', '--role', 'listener', '--config', config], srv.base);
    assert.equal(srv.seen.filter((q) => q.url.endsWith('/agent/self')).length, 1);
  } finally { await srv.close(); }
});

test('B2 identify uses a 10 second timeout, shortened only by SPM_AGENT_IDENTIFY_TIMEOUT_MS in tests, and tries twice', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  let hits = 0;
  const srv = await new Promise((resolve) => {
    const h = http.createServer(() => { hits++; }); // never answers
    h.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${h.address().port}/accountApi`, close: () => new Promise((r) => { h.closeAllConnections(); h.close(() => r()); }) }));
  });
  try {
    const t0 = Date.now();
    const r = await run(kit, home, ['start', '--role', 'listener', '--config', config], srv.base, { SPM_AGENT_IDENTIFY_TIMEOUT_MS: '200' });
    assert.equal(r.code, 7, r.err);
    assert.equal(hits, 2);
    assert.ok(Date.now() - t0 < 5000);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- usage
test('usage counts the fixture by hand: last line per message id, <synthetic> skipped, compactions summed', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  const srv = await server();
  try {
    const r = await run(kit, home, ['usage', '--role', 'listener', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(r.code, 0, r.err);
    const usage = reportsOf(srv).filter((x) => x.kind === 'usage');
    assert.equal(usage.length, 3, JSON.stringify(usage));
    const m1 = usage.find((x) => x.model === 'claude-test-model-1');
    const m2 = usage.find((x) => x.model === 'claude-test-model-2' && x.price_tier === 'standard');
    const m2long = usage.find((x) => x.model === 'claude-test-model-2' && x.price_tier === 'long');
    assert.equal(m1.price_tier, 'standard');
    assert.deepEqual(m1.numbers, { calls: 2, input_tokens: 30, output_tokens: 12, cache_write_5m_tokens: 100, cache_write_1h_tokens: 0, cache_read_tokens: 3000, compactions: 2, compaction_pre_tokens: 200000 });
    assert.deepEqual(m2.numbers, { calls: 1, input_tokens: 3, output_tokens: 4, cache_write_5m_tokens: 5, cache_write_1h_tokens: 0, cache_read_tokens: 6, compactions: 0, compaction_pre_tokens: 0 });
    assert.deepEqual(m2long.numbers, { calls: 1, input_tokens: 95000, output_tokens: 10, cache_write_5m_tokens: 0, cache_write_1h_tokens: 7, cache_read_tokens: 10000, compactions: 0, compaction_pre_tokens: 0 });
    assert.equal(m1.session_key, KEY_OF(home, SESSION_A));
    assert.equal(m1.role, 'listener');
    assert.equal(m1.kit_version, '0.2.0');
    assert.match(m1.id, /^[0-9a-f-]{16,64}$/);
    assert.equal(m1.id.length, 36);
  } finally { await srv.close(); }
});

test('usage reads only the session named by CLAUDE_CODE_SESSION_ID, never the newest file (kit 0.2.0)', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA(), 3600);
  writeTranscript(home, '-other-proj', SESSION_B, [{ type: 'assistant', sessionId: SESSION_B, message: { id: 'old-1', model: 'claude-old-model', usage: { input_tokens: 500, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }], 60);
  const srv = await server();
  try {
    await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    const usage = reportsOf(srv).filter((x) => x.kind === 'usage');
    assert.ok(usage.length >= 1);
    assert.ok(usage.every((x) => x.session_key === KEY_OF(home, SESSION_A)), 'the older session is not reported');
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
    assert.equal(usage[0].session_key, KEY_OF(home, SESSION_B));
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
  const r = await run(kit, home, ['usage', '--role', 'main', '--config', config], await deadBase(), { CLAUDE_CODE_SESSION_ID: SESSION_A });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.lines, ['health: kept 3 for later']);
  const lines = fs.readFileSync(spoolOf(home), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 3, 'one item per model and tier');
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
    assert.equal(spoolText(home), '');
    assert.match(r.lines[0], /^health: sent 3, kept 0$/);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- heartbeat
test('heartbeat: the first run counts the whole log, the next run counts only new lines', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  fs.mkdirSync(stateDir(home), { recursive: true });
  const log = path.join(stateDir(home), 'listener.log');
  fs.writeFileSync(log, ['{"kind":"wrapper.start","t":"x"}', '{"kind":"start","t":"x"}', '{"kind":"listener.restart","t":"x","exit_code":1,"delay_s":2}', '{"kind":"listener.failing","t":"x","restarts":3}'].join('\n') + '\n');
  const srv = await server();
  try {
    const r1 = await run(kit, home, ['heartbeat', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(r1.code, 0, r1.err);
    const hb1 = reportsOf(srv).filter((x) => x.kind === 'heartbeat');
    assert.equal(hb1.length, 1);
    assert.deepEqual(hb1[0].numbers, { listener_starts: 1, listener_restarts: 1, listener_failing: 1, container_starts: 1, main_changes: 0, uptime_s: 0 });
    assert.equal(hb1[0].session_key, KEY_OF(home, SESSION_A));
    assert.equal(hb1[0].role, 'listener');
    assert.equal(hb1[0].main_status, undefined);
    fs.appendFileSync(log, '{"kind":"listener.restart","t":"y"}\n{"kind":"wrapper.start","t":"y"}\n{"kind":"wrapper.start","t":"z"\n');
    srv.seen.length = 0;
    const r2 = await run(kit, home, ['heartbeat', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
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
    await run(kit, home, ['heartbeat', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    const first = reportsOf(srv).filter((x) => x.kind === 'heartbeat')[0];
    assert.equal(first.numbers.main_changes, 1, 'the first id seen counts as a change');
    srv.seen.length = 0;
    await run(kit, home, ['heartbeat', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(reportsOf(srv).filter((x) => x.kind === 'heartbeat')[0].numbers.main_changes, 0);
    fs.writeFileSync(path.join(stateDir(home), 'main-session-id'), 'main-two\n');
    srv.seen.length = 0;
    await run(kit, home, ['heartbeat', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(reportsOf(srv).filter((x) => x.kind === 'heartbeat')[0].numbers.main_changes, 1);
    // A state file from another boot: this is a new container.
    const healthFile = path.join(stateDir(home), 'health.json');
    const st = readJson(healthFile);
    fs.writeFileSync(healthFile, JSON.stringify({ ...st, bootId: 'some-other-boot' }));
    srv.seen.length = 0;
    await run(kit, home, ['heartbeat', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(reportsOf(srv).filter((x) => x.kind === 'heartbeat')[0].numbers.container_starts, 1);
  } finally { await srv.close(); }
});

test('heartbeat with no transcript queues nothing and keeps the log position', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  fs.mkdirSync(stateDir(home), { recursive: true });
  const log = path.join(stateDir(home), 'listener.log');
  fs.writeFileSync(log, '{"kind":"wrapper.start","t":"x"}\n');
  const srv = await server();
  try {
    const r = await run(kit, home, ['heartbeat', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(r.code, 0, r.err);
    assert.equal(reportsOf(srv).length, 0);
    assert.equal(fs.existsSync(path.join(stateDir(home), 'health.json')), false);
    writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
    await run(kit, home, ['heartbeat', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(reportsOf(srv).filter((x) => x.kind === 'heartbeat')[0].numbers.listener_starts, 1);
  } finally { await srv.close(); }
});

test('heartbeat --main-status accepts a listed word; an unknown word becomes unknown (B4)', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  const srv = await server();
  try {
    const bad = await run(kit, home, ['heartbeat', '--main-status', 'sleeping', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(bad.code, 0, bad.err);
    assert.equal(reportsOf(srv).filter((x) => x.kind === 'heartbeat').at(-1).main_status, 'unknown');
    srv.seen.length = 0;
    const ok = await run(kit, home, ['heartbeat', '--main-status', 'review_ready', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
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
    assert.equal(spoolText(home), '');
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
    assert.equal(spoolText(home), '');
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
    outs.push(await run(kit, home, ['start', '--role', 'main', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A }));
    outs.push(await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A }));
    outs.push(await run(kit, home, ['heartbeat', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A }));
    assert.equal(srv.seen.length >= 4, true, JSON.stringify(srv.seen.map((q) => [q.method, q.url, q.text.length])));
    for (const q of srv.seen) {
      assert.equal(q.text.includes(FAKE_SPM_KEY), false, 'the key is never in a body');
      assert.deepEqual(findSecrets(q.text), [], 'no secret-shaped string in a body');
      assert.equal(q.text.includes('synthetic user text'), false);
      assert.equal(q.text.includes('synthetic reply text'), false);
    }
    const salt = saltOf(home);
    for (const q of srv.seen) assert.equal(q.text.includes(salt), false, 'the report salt is never sent');
    for (const o of outs) assert.equal((o.out + o.err).includes(FAKE_SPM_KEY), false);
    for (const q of srv.seen.filter((x) => x.url.endsWith('/agent/reports'))) {
      for (const item of q.json.reports) assert.equal(Object.keys(item).every((k) => ['id', 'kind', 'role', 'at', 'kit_version', 'node_version', 'session_key', 'model', 'numbers', 'main_status', 'code', 'detail', 'run_id', 'step', 'status', 'price_tier'].includes(k)), true);
    }
  } finally { await srv.close(); }
});

test('the state folder follows SPM_AGENT_STATE_DIR when it is set', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  const alt = tmpdir('alt-state');
  const srv = await server();
  try {
    const r = await run(kit, home, ['heartbeat', '--config', config], srv.base, { SPM_AGENT_STATE_DIR: alt, CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.existsSync(path.join(alt, 'health.json')), false, 'no transcript, so no state is saved');
    writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
    await run(kit, home, ['heartbeat', '--config', config], srv.base, { SPM_AGENT_STATE_DIR: alt, CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(fs.existsSync(path.join(alt, 'health.json')), true);
    assert.equal(fs.existsSync(stateDir(home)), false);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- Addendum A (28 Oct): app id, salt, sent log, opt-out, min kit
test('A1 identify writes app_id when the file has none, keeps an existing one, and ignores an invalid SPM value', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  let srv = await server(selfWith({ app_id: APP_ID }));
  try {
    const r = await run(kit, home, ['start', '--role', 'listener', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(readJson(config).app_id, APP_ID);
  } finally { await srv.close(); }
  const kept = makeHome({ name: SPM_NAME, email: SPM_ADDRESS }); // has no app_id yet
  fs.writeFileSync(kept.config, JSON.stringify({ ...readJson(kept.config), app_id: 'existing-app-id-0123456789' }));
  srv = await server(selfWith({ app_id: APP_ID }));
  try {
    await run(kit, kept.home, ['start', '--role', 'listener', '--config', kept.config], srv.base);
    assert.equal(readJson(kept.config).app_id, 'existing-app-id-0123456789');
  } finally { await srv.close(); }
  const bad = makeHome();
  srv = await server(selfWith({ app_id: 'bad id with spaces !!' }));
  try {
    const r = await run(kit, bad.home, ['start', '--role', 'listener', '--config', bad.config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(readJson(bad.config).app_id, undefined);
  } finally { await srv.close(); }
});

test('B1 settings.reports false from SPM: nothing is sent until the next identify, local files are still written', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  let srv = await server(selfWith({ settings: { autostart: true, reports: false } }));
  try {
    const r = await run(kit, home, ['start', '--role', 'main', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(r.code, 0, r.err);
    assert.equal(srv.seen.length, 1, 'only the identify call');
    assert.ok(hasLine(r.lines, /reports off/), JSON.stringify(r.lines));
    assert.equal(readJson(path.join(stateDir(home), 'health.json')).reportOn, false);
    assert.equal(fs.readFileSync(spoolOf(home), 'utf8').split('\n').filter(Boolean).length, 3, 'usage queued locally, one item per model and tier');
    srv.seen.length = 0;
    const f = await run(kit, home, ['flush', '--config', config], srv.base);
    assert.equal(f.code, 0, f.err);
    assert.ok(hasLine(f.lines, /reports off/));
    assert.equal(srv.seen.length, 0, 'flush sends nothing while off');
    const u = await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(u.code, 0, u.err);
    assert.equal(srv.seen.length, 0, 'usage sends nothing while off');
  } finally { await srv.close(); }
  srv = await server(selfWith({ settings: { autostart: true, reports: true } }));
  try {
    const r = await run(kit, home, ['start', '--role', 'main', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(r.code, 0, r.err);
    assert.equal(readJson(path.join(stateDir(home), 'health.json')).reportOn, true);
    assert.ok(reportsOf(srv).length >= 1, 'sending resumes after the next identify');
  } finally { await srv.close(); }
});

test('A5 a kit older than min_kit_version prints one warning line and still runs', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  let srv = await server(selfWith({ min_kit_version: '0.3.0' }));
  try {
    const r = await run(kit, home, ['start', '--role', 'listener', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines.filter((l) => /warning/.test(l)).length, 1, JSON.stringify(r.lines));
    assert.equal(r.lines.length, 2);
  } finally { await srv.close(); }
  srv = await server(selfWith({ min_kit_version: '0.2.0' }));
  try {
    const r = await run(kit, home, ['start', '--role', 'listener', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.lines.length, 1, JSON.stringify(r.lines));
  } finally { await srv.close(); }
});

test('A2 the session key is sha256(salt + sessionId) with a salt created 0600 on first use and reused after', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  const srv = await server();
  try {
    await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    const saltFile = path.join(stateDir(home), 'report-salt');
    assert.match(fs.readFileSync(saltFile, 'utf8').trim(), /^[0-9a-f]{32}$/);
    assert.equal(fs.statSync(saltFile).mode & 0o777, 0o600);
    const salt = saltOf(home);
    const usage = reportsOf(srv).filter((x) => x.kind === 'usage');
    assert.equal(usage[0].session_key, crypto.createHash('sha256').update(salt + SESSION_A).digest('hex').slice(0, 16));
    assert.notEqual(usage[0].session_key, KEY_OF_UNSALTED(SESSION_A));
    await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(saltOf(home), salt, 'the salt is not replaced');
  } finally { await srv.close(); }
});
function KEY_OF_UNSALTED(sid) { return crypto.createHash('sha256').update(sid).digest('hex').slice(0, 16); }

test('A2 a report-salt that is not 32 lower-case hex exits 2 with one line and queues nothing', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  fs.mkdirSync(stateDir(home), { recursive: true });
  fs.writeFileSync(path.join(stateDir(home), 'report-salt'), 'NOT-A-SALT\n');
  const r = await run(kit, home, ['usage', '--role', 'main', '--config', config], await deadBase(), { CLAUDE_CODE_SESSION_ID: SESSION_A });
  assert.equal(r.code, 2);
  assert.equal(r.lines.length, 1, JSON.stringify(r.lines));
  assert.equal(fs.existsSync(spoolOf(home)), false);
});

test('A3 every item SPM accepts is appended to health-sent.jsonl (0600); nothing is written when the send fails', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  const sent = path.join(stateDir(home), 'health-sent.jsonl');
  const down = await run(kit, home, ['usage', '--role', 'main', '--config', config], await deadBase(), { CLAUDE_CODE_SESSION_ID: SESSION_A });
  assert.equal(down.code, 0, down.err);
  assert.equal(fs.existsSync(sent), false);
  const srv = await server();
  try {
    const r = await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(r.code, 0, r.err);
    const lines = fs.readFileSync(sent, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.length, 6, 'the three items kept while down, and the three queued now');
    assert.equal(fs.statSync(sent).mode & 0o777, 0o600);
    assert.deepEqual(lines.map((x) => x.id).sort(), reportsOf(srv).map((x) => x.id).sort());
  } finally { await srv.close(); }
});

test('A3 over 1 MB the sent log keeps its newest half of the lines', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  fs.mkdirSync(stateDir(home), { recursive: true });
  const sent = path.join(stateDir(home), 'health-sent.jsonl');
  const old = [];
  for (let i = 0; i < 1200; i++) old.push(`{"old":${i},"pad":"${'p'.repeat(980)}"}`);
  fs.writeFileSync(sent, old.join('\n') + '\n');
  fs.writeFileSync(spoolOf(home), JSON.stringify({ id: crypto.randomUUID(), kind: 'setup', role: 'setup', at: new Date().toISOString(), kit_version: '0.2.0', run_id: 'abcdef12', step: 'config', status: 'pass' }) + '\n');
  const srv = await server();
  try {
    const r = await run(kit, home, ['flush', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    const lines = fs.readFileSync(sent, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, Math.ceil(1201 / 2));
    assert.equal(JSON.parse(lines[lines.length - 1]).step, 'config');
    assert.equal(JSON.parse(lines[0]).old, 600, 'the newest half: old lines 600 to 1199 and the new line');
    assert.ok(fs.statSync(sent).size <= 1024 * 1024);
    assert.equal(fs.statSync(sent).mode & 0o777, 0o600);
  } finally { await srv.close(); }
});

test('A4 settings report false: no network call at all, local files written, one line says reports off, no key needed', async () => {
  const kit = makeKit(); const home = tmpdir('home-off');
  const config = path.join(home, 'agent.json');
  fs.writeFileSync(path.join(home, 'agent.key'), FAKE_SPM_KEY + '\n', { mode: 0o600 });
  fs.writeFileSync(config, JSON.stringify({ report: false, key_file: path.join(home, 'agent.key') }) + '\n');
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  const srv = await server();
  try {
    const start = await run(kit, home, ['start', '--role', 'main', '--config', config], srv.base);
    assert.equal(start.code, 0, start.err);
    assert.deepEqual(start.lines, ['health: identified Example agent; reports off; nothing sent']);
    assert.equal(srv.seen.length, 1, 'start identifies once (A4 review: reports off does not skip identify)');
    const usage = await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(usage.code, 0, usage.err);
    assert.match(usage.lines[0], /reports off/);
    const hb = await run(kit, home, ['heartbeat', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(hb.code, 0, hb.err);
    assert.match(hb.lines[0], /reports off/);
    const fl = await run(kit, home, ['flush', '--config', config], srv.base);
    assert.equal(fl.code, 0, fl.err);
    assert.match(fl.lines[0], /reports off/);
    assert.equal(srv.seen.length, 1, 'the only network call is the identify at start');
    assert.equal(readJson(config).agent.name, SPM_NAME, 'identify at start writes the agent name');
    const queued = fs.readFileSync(spoolOf(home), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(queued.some((x) => x.kind === 'usage') && queued.some((x) => x.kind === 'heartbeat'));
    assert.equal(readJson(path.join(stateDir(home), 'health.json')).reportOn, true, 'SPM answer stored by start; local off still sends nothing');
  } finally { await srv.close(); }
});

test('A4 a report setting that is not true or false exits 2 with one line', async () => {
  const kit = makeKit(); const home = tmpdir('home-badreport');
  const config = path.join(home, 'agent.json');
  fs.writeFileSync(config, JSON.stringify({ report: 'off' }) + '\n');
  const r = await run(kit, home, ['flush', '--config', config], await deadBase());
  assert.equal(r.code, 2);
  assert.equal(r.lines.length, 1, JSON.stringify(r.lines));
});

test('A6 a missing kit VERSION does not stop identify; queueing commands exit 2; flush keeps lines it cannot version', async () => {
  const kit = makeKit({ version: null }); const { home, config } = makeHome();
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  fs.mkdirSync(stateDir(home), { recursive: true });
  fs.writeFileSync(spoolOf(home), JSON.stringify({ id: crypto.randomUUID(), kind: 'setup', role: 'setup', at: new Date().toISOString(), run_id: 'abcdef12', step: 'config', status: 'pass' }) + '\n');
  const srv = await server(selfWith({ app_id: APP_ID }));
  try {
    const st = await run(kit, home, ['start', '--role', 'listener', '--config', config], srv.base);
    assert.equal(st.code, 0, st.err);
    assert.deepEqual(readJson(config).agent, { name: SPM_NAME, email: SPM_ADDRESS });
    assert.equal(readJson(config).app_id, APP_ID);
    const us = await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(us.code, 2, us.err);
    assert.equal(us.lines.length, 1);
    const hb = await run(kit, home, ['heartbeat', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(hb.code, 2);
    srv.seen.length = 0;
    const fl = await run(kit, home, ['flush', '--config', config], srv.base);
    assert.equal(fl.code, 0, fl.err);
    assert.equal(reportsOf(srv).length, 0, 'the unversioned line is not sent');
    assert.equal(readLines(spoolOf(home)).length, 1, 'and is kept for later');
  } finally { await srv.close(); }
});
function readLines(f) { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); }

// ---------------------------------------------------------------- Addendum B (28 Oct, b9d1c271) in agent-health.cjs
const settingsHandler = (status, body) => (rec) => (rec.url.endsWith('/agent/settings') ? { status, body } : null);

test('B1 session-start prints exactly "autostart on" from SPM and exits 0 (no writes to the settings file)', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  const before = fs.readFileSync(config, 'utf8');
  const srv = await server(selfWith({ settings: { autostart: true, reports: true } }));
  try {
    const r = await run(kit, home, ['session-start', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'autostart on\n');
    assert.equal(fs.readFileSync(config, 'utf8'), before);
  } finally { await srv.close(); }
});

test('B1 session-start prints "autostart off" when SPM says off', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  const srv = await server(selfWith({ settings: { autostart: false, reports: true } }));
  try {
    const r = await run(kit, home, ['session-start', '--config', config], srv.base);
    assert.equal(r.code, 0);
    assert.equal(r.out, 'autostart off\n');
  } finally { await srv.close(); }
});

test('B1 local "autostart": false always wins, whatever SPM says', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  fs.writeFileSync(config, JSON.stringify({ ...readJson(config), autostart: false }));
  const srv = await server(selfWith({ settings: { autostart: true, reports: true } }));
  try {
    const r = await run(kit, home, ['session-start', '--config', config], srv.base);
    assert.equal(r.code, 0);
    assert.equal(r.out, 'autostart off\n');
  } finally { await srv.close(); }
});

test('B1 session-start with SPM not reached prints the default with the fallback note and exits 0', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  let r = await run(kit, home, ['session-start', '--config', config], await deadBase());
  assert.equal(r.code, 0);
  assert.equal(r.out, 'autostart on (SPM not reached, using the default)\n');
  fs.writeFileSync(config, JSON.stringify({ ...readJson(config), autostart: false }));
  r = await run(kit, home, ['session-start', '--config', config], await deadBase());
  assert.equal(r.code, 0);
  assert.equal(r.out, 'autostart off\n', 'a local autostart false is final: no SPM call, no fallback note (C1)');
});

test('B1 session-start with a refused key still prints one line and exits 0', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  const srv = await server(() => ({ status: 401, body: { code: 'nope' } }));
  try {
    const r = await run(kit, home, ['session-start', '--config', config], srv.base);
    assert.equal(r.code, 0);
    assert.equal(r.out, 'autostart on (SPM not reached, using the default)\n');
  } finally { await srv.close(); }
});

test('B1 session-start with local "report": false makes no network call and prints the local answer', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  fs.writeFileSync(config, JSON.stringify({ ...readJson(config), report: false }));
  const srv = await server();
  try {
    const r = await run(kit, home, ['session-start', '--config', config], srv.base);
    assert.equal(r.code, 0);
    assert.equal(r.out, 'autostart on\n');
    assert.equal(srv.seen.length, 0);
  } finally { await srv.close(); }
});

test('B1 settings posts only the given keys as booleans with the key header only, and prints the answer', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  const srv = await server(settingsHandler(200, { autostart: false, reports: true }));
  try {
    const r = await run(kit, home, ['settings', '--autostart', 'off', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'settings: autostart off, reports on\n');
    const post = srv.seen.find((q) => q.url.endsWith('/agent/settings'));
    assert.equal(post.method, 'POST');
    assert.deepEqual(post.json, { autostart: false, kit_version: '0.2.0' });
    assert.equal(post.headers['x-spm-api-key'], FAKE_SPM_KEY);
    assert.equal(post.headers['x-spm-user-email'], undefined);
    assert.equal(post.headers['content-type'], 'application/json');
  } finally { await srv.close(); }
  const srv2 = await server(settingsHandler(200, { autostart: true, reports: false }));
  try {
    const r = await run(kit, home, ['settings', '--autostart', 'on', '--reports', 'off', '--config', config], srv2.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'settings: autostart on, reports off\n');
    assert.deepEqual(srv2.seen.find((q) => q.url.endsWith('/agent/settings')).json, { autostart: true, reports: false, kit_version: '0.2.0' });
    assert.equal(readJson(path.join(stateDir(home), 'health.json')).reportOn, false, 'the answer is stored until the next identify');
  } finally { await srv2.close(); }
});

test('B1 settings: 401, 403 and 404 exit 6; a network failure exits 7; no flag or a bad value exits 2', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  for (const status of [401, 403, 404]) {
    const srv = await server(settingsHandler(status, { code: 'nope' }));
    try {
      const r = await run(kit, home, ['settings', '--reports', 'on', '--config', config], srv.base);
      assert.equal(r.code, 6, `status ${status}`);
    } finally { await srv.close(); }
  }
  const down = await run(kit, home, ['settings', '--reports', 'on', '--config', config], await deadBase());
  assert.equal(down.code, 7, down.err);
  assert.equal(down.lines.length, 1);
  const none = await run(kit, home, ['settings', '--config', config], await deadBase());
  assert.equal(none.code, 2);
  const bad = await run(kit, home, ['settings', '--autostart', 'maybe', '--config', config], await deadBase());
  assert.equal(bad.code, 2);
});

test('B1 settings with local "report": false sends nothing and says so', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  fs.writeFileSync(config, JSON.stringify({ ...readJson(config), report: false }));
  const srv = await server(settingsHandler(200, { autostart: true, reports: true }));
  try {
    const r = await run(kit, home, ['settings', '--autostart', 'on', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /reports off/);
    assert.equal(srv.seen.length, 0);
  } finally { await srv.close(); }
});

test('B4 listener_starts counts wrapper.start lines only, and the heartbeat id is sha256(salt + boot id + from + to) in 64 hex', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  fs.mkdirSync(stateDir(home), { recursive: true });
  const log = path.join(stateDir(home), 'listener.log');
  const body = '{"kind":"start","t":"x"}\n{"kind":"wrapper.start","t":"x"}\n{"kind":"wrapper.start","t":"y"}\n';
  fs.writeFileSync(log, body);
  const srv = await server();
  try {
    const r = await run(kit, home, ['heartbeat', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(r.code, 0, r.err);
    const hb = reportsOf(srv).filter((x) => x.kind === 'heartbeat')[0];
    assert.equal(hb.numbers.listener_starts, 2);
    const boot = (() => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (_) { return ''; } })();
    const expected = crypto.createHash('sha256').update(saltOf(home) + (boot || '') + '0' + Buffer.byteLength(body)).digest('hex').slice(0, 64);
    assert.equal(hb.id, expected);
  } finally { await srv.close(); }
});

test('B4 a retried heartbeat after a crash (same offsets) queues nothing new locally', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  fs.mkdirSync(stateDir(home), { recursive: true });
  fs.writeFileSync(path.join(stateDir(home), 'listener.log'), '{"kind":"wrapper.start","t":"x"}\n');
  fs.writeFileSync(path.join(stateDir(home), 'setup-report.jsonl'), '');
  fs.writeFileSync(config, JSON.stringify({ ...readJson(config), report: false }));
  const srv = await server();
  try {
    await run(kit, home, ['heartbeat', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    const healthFile = path.join(stateDir(home), 'health.json');
    const st = readJson(healthFile);
    fs.writeFileSync(healthFile, JSON.stringify({ ...st, logOffset: 0 })); // as if the state save was lost
    await run(kit, home, ['heartbeat', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    const hbLines = fs.readFileSync(path.join(stateDir(home), 'setup-report.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.kind === 'heartbeat');
    assert.equal(hbLines.length, 1, 'one heartbeat line, not two');
  } finally { await srv.close(); }
});

test('B3 a batch SPM answers 400 to is dropped with one line naming the code, and the command exits 0', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  fs.mkdirSync(stateDir(home), { recursive: true });
  fs.writeFileSync(spoolOf(home), JSON.stringify({ id: crypto.randomUUID(), kind: 'setup', role: 'setup', at: new Date().toISOString(), run_id: 'abcdef12', step: 'config', status: 'pass' }) + '\n');
  const srv = await server(() => ({ status: 400, body: { code: 'field_not_for_kind' } }));
  try {
    const r = await run(kit, home, ['flush', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.lines, ['health: dropped 1: field_not_for_kind', 'health: sent 0, kept 0']);
    assert.equal(fs.readFileSync(path.join(stateDir(home), 'setup-report.rejected.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- Addendum C: C1 autostart off, C2 whole session, C5 settings record
test('C1 session-start with local "autostart": false prints "autostart off" and sends no request to SPM', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  fs.writeFileSync(config, JSON.stringify({ ...readJson(config), autostart: false }));
  const srv = await server(selfWith({ settings: { autostart: true, reports: true } }));
  try {
    const r = await run(kit, home, ['session-start', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'autostart off\n');
    assert.equal(srv.seen.length, 0, 'no request reached SPM');
  } finally { await srv.close(); }
});

// A sub-agent file: <folder>/<session id>/subagents/<name>.jsonl
function subFile(home, folder, sid, name, lines) {
  const dir = path.join(home, '.claude', 'projects', folder, sid, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}
const callLine = (sid, id, model, input, output) => ({ type: 'assistant', sessionId: sid, message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
const usageRows = (srv) => reportsOf(srv).filter((x) => x.kind === 'usage');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('C2 the same session file in two project folders counts once (calls, tokens, compactions)', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  writeTranscript(home, '-copy-proj', SESSION_A, fixtureA());
  writeSubFixture(home);
  const srv = await server();
  try {
    const r = await run(kit, home, ['usage', '--role', 'main', '--config', config, '--session', SESSION_A], srv.base);
    assert.equal(r.code, 0, r.err);
    const rows = usageRows(srv);
    assert.equal(rows.length, 4, JSON.stringify(rows));
    const m1 = rows.find((x) => x.model === 'claude-test-model-1');
    assert.deepEqual(m1.numbers, { calls: 2, input_tokens: 30, output_tokens: 12, cache_write_5m_tokens: 100, cache_write_1h_tokens: 0, cache_read_tokens: 3000, compactions: 2, compaction_pre_tokens: 200000 });
    assert.equal(m1.session_key, KEY_OF(home, SESSION_A));
  } finally { await srv.close(); }
});
// The sub-agent file used by the copy test: one call on its own model (counted once, next to the copies).
function writeSubFixture(home) { subFile(home, '-work-proj', SESSION_A, 'agent-copy', [callLine(SESSION_A, 'sub-copy', 'claude-sub-model-9', 1, 1)]); }

test('C2 two sub-agent files add their own calls and model rows to the session totals', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  subFile(home, '-work-proj', SESSION_A, 'agent-one', [callLine(SESSION_A, 'sub-1', 'claude-sub-model-1', 100, 10)]);
  subFile(home, '-work-proj', SESSION_A, 'agent-two', [callLine(SESSION_A, 'sub-2', 'claude-sub-model-2', 200, 20)]);
  const srv = await server();
  try {
    const r = await run(kit, home, ['usage', '--role', 'main', '--config', config, '--session', SESSION_A], srv.base);
    assert.equal(r.code, 0, r.err);
    const rows = usageRows(srv);
    assert.equal(rows.length, 5, JSON.stringify(rows));
    const s1 = rows.find((x) => x.model === 'claude-sub-model-1');
    const s2 = rows.find((x) => x.model === 'claude-sub-model-2');
    assert.equal(s1.numbers.calls, 1); assert.equal(s1.numbers.input_tokens, 100); assert.equal(s1.numbers.output_tokens, 10);
    assert.equal(s2.numbers.calls, 1); assert.equal(s2.numbers.input_tokens, 200); assert.equal(s2.numbers.output_tokens, 20);
    const m1 = rows.find((x) => x.model === 'claude-test-model-1');
    assert.equal(m1.numbers.calls, 2, 'the main file is unchanged');
    assert.ok(rows.every((x) => x.session_key === KEY_OF(home, SESSION_A)));
  } finally { await srv.close(); }
});

test('C2 a sub-agent line whose sessionId differs counts under the parent session', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, [callLine(SESSION_A, 'main-1', 'claude-test-model-1', 5, 1)]);
  subFile(home, '-work-proj', SESSION_A, 'agent-odd', [callLine(SESSION_B, 'sub-odd', 'claude-sub-model-3', 40, 4)]);
  const srv = await server();
  try {
    const r = await run(kit, home, ['usage', '--role', 'main', '--config', config, '--session', SESSION_A], srv.base);
    assert.equal(r.code, 0, r.err);
    const rows = usageRows(srv);
    const sub = rows.find((x) => x.model === 'claude-sub-model-3');
    assert.ok(sub, JSON.stringify(rows));
    assert.equal(sub.session_key, KEY_OF(home, SESSION_A));
    assert.equal(sub.numbers.input_tokens, 40);
    assert.ok(rows.every((x) => x.session_key !== KEY_OF(home, SESSION_B)), 'nothing is filed under the sessionId the line carries');
  } finally { await srv.close(); }
});

test('C2 a file that cannot be read is skipped and the others still count (directory named *.jsonl)', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  subFile(home, '-work-proj', SESSION_A, 'agent-good', [callLine(SESSION_A, 'sub-good', 'claude-sub-model-4', 7, 3)]);
  fs.mkdirSync(path.join(home, '.claude', 'projects', '-work-proj', SESSION_A, 'subagents', 'agent-dir.jsonl'), { recursive: true });
  const srv = await server();
  try {
    const r = await run(kit, home, ['usage', '--role', 'main', '--config', config, '--session', SESSION_A], srv.base);
    assert.equal(r.code, 0, r.err);
    const rows = usageRows(srv);
    assert.equal(rows.find((x) => x.model === 'claude-sub-model-4').numbers.input_tokens, 7);
    assert.equal(rows.find((x) => x.model === 'claude-test-model-1').numbers.calls, 2);
  } finally { await srv.close(); }
});

test('C2 a sub-agent file with mode 000 is skipped and the others still count', { skip: isRoot ? 'running as root: mode 000 does not stop root, so this case is not run' : false }, async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  const locked = subFile(home, '-work-proj', SESSION_A, 'agent-locked', [callLine(SESSION_A, 'sub-locked', 'claude-sub-model-5', 9, 1)]);
  fs.chmodSync(locked, 0o000);
  subFile(home, '-work-proj', SESSION_A, 'agent-good', [callLine(SESSION_A, 'sub-good', 'claude-sub-model-4', 7, 3)]);
  const srv = await server();
  try {
    const r = await run(kit, home, ['usage', '--role', 'main', '--config', config, '--session', SESSION_A], srv.base);
    assert.equal(r.code, 0, r.err);
    const rows = usageRows(srv);
    assert.ok(rows.some((x) => x.model === 'claude-sub-model-4'));
    assert.ok(!rows.some((x) => x.model === 'claude-sub-model-5'), 'the unreadable file adds nothing');
  } finally { await srv.close(); fs.chmodSync(locked, 0o600); }
});

test('C2 with CLAUDE_CODE_SESSION_ID and no --session or --transcript the id is that session, and its sub-agent files in any folder count', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA(), 60);
  subFile(home, '-other-proj', SESSION_A, 'agent-far', [callLine(SESSION_A, 'sub-far', 'claude-sub-model-6', 11, 2)]);
  const srv = await server();
  try {
    const r = await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(r.code, 0, r.err);
    const sub = usageRows(srv).find((x) => x.model === 'claude-sub-model-6');
    assert.ok(sub, 'the sub-agent file in another folder counts');
    assert.equal(sub.numbers.input_tokens, 11);
  } finally { await srv.close(); }
});

test('C2 a --session that is not 8 to 64 letters, digits or dashes exits 2 with a clear message and sends nothing', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  const srv = await server();
  try {
    for (const bad of ['short', '../../etc/passwd', 'has space here', 'under_score_id', 'x'.repeat(65)]) {
      const r = await run(kit, home, ['usage', '--role', 'main', '--config', config, '--session', bad], srv.base);
      assert.equal(r.code, 2, bad);
      assert.ok(hasLine(r.lines, /--session must be 8 to 64 letters, digits or dashes/), JSON.stringify(r.lines));
    }
    const hb = await run(kit, home, ['heartbeat', '--config', config, '--session', '../x'], srv.base);
    assert.equal(hb.code, 2);
    assert.equal(srv.seen.length, 0);
  } finally { await srv.close(); }
});

test('C5 settings posts kit_version and the session_key of CLAUDE_CODE_SESSION_ID when a salt exists', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA(), 60);
  fs.mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir(home), 'report-salt'), 'ab'.repeat(16) + '\n', { mode: 0o600 });
  const srv = await server(settingsHandler(200, { autostart: false, reports: true }));
  try {
    const r = await run(kit, home, ['settings', '--autostart', 'off', '--config', config], srv.base, { CLAUDE_CODE_SESSION_ID: SESSION_A });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(srv.seen.find((q) => q.url.endsWith('/agent/settings')).json, { autostart: false, kit_version: '0.2.0', session_key: KEY_OF(home, SESSION_A) });
  } finally { await srv.close(); }
});

test('C5 settings omits session_key with no transcript or no salt, still sends kit_version, and creates no salt', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  const srv = await server(settingsHandler(200, { autostart: false, reports: true }));
  try {
    const r = await run(kit, home, ['settings', '--autostart', 'off', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(srv.seen.find((q) => q.url.endsWith('/agent/settings')).json, { autostart: false, kit_version: '0.2.0' });
    writeTranscript(home, '-work-proj', SESSION_A, fixtureA(), 60);
    const r2 = await run(kit, home, ['settings', '--autostart', 'on', '--config', config], srv.base);
    assert.equal(r2.code, 0, r2.err);
    const last = srv.seen.filter((q) => q.url.endsWith('/agent/settings')).pop().json;
    assert.deepEqual(last, { autostart: true, kit_version: '0.2.0' });
    assert.equal(fs.existsSync(path.join(stateDir(home), 'report-salt')), false, 'settings does not create the salt');
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- start identifies even with local report off (review finding on 3746ff9)
test('start with local "report": false still identifies: name and address are written, one GET /agent/self, nothing sent', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  fs.writeFileSync(config, JSON.stringify({ ...readJson(config), report: false }) + '\n');
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA());
  const srv = await server();
  try {
    const r = await run(kit, home, ['start', '--role', 'main', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'health: identified Example agent; reports off; nothing sent\n');
    assert.equal(readJson(config).agent.name, SPM_NAME);
    assert.equal(readJson(config).agent.email, SPM_ADDRESS);
    assert.equal(srv.seen.length, 1, JSON.stringify(srv.seen.map((q) => q.url)));
    assert.equal(srv.seen[0].method, 'GET');
    assert.ok(srv.seen[0].url.endsWith('/agent/self'));
    assert.equal(reportsOf(srv).length, 0, 'no POST /agent/reports');
    assert.equal(spoolText(home), '', 'nothing queued');
  } finally { await srv.close(); }
});

test('start with local "report": false and SPM unreachable exits 7 and changes nothing', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  fs.writeFileSync(config, JSON.stringify({ ...readJson(config), report: false }) + '\n');
  const before = fs.readFileSync(config, 'utf8');
  const r = await run(kit, home, ['start', '--role', 'listener', '--config', config], await deadBase());
  assert.equal(r.code, 7, r.err);
  assert.ok(hasLine(r.lines, /could not reach SPM/), JSON.stringify(r.lines));
  assert.equal(fs.readFileSync(config, 'utf8'), before);
});

test('start with local "report": false and a refused key exits 6 and changes nothing', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  fs.writeFileSync(config, JSON.stringify({ ...readJson(config), report: false }) + '\n');
  const before = fs.readFileSync(config, 'utf8');
  const srv = await server((rec) => (rec.url.endsWith('/agent/self') ? { status: 401, body: {} } : null));
  try {
    const r = await run(kit, home, ['start', '--role', 'listener', '--config', config], srv.base);
    assert.equal(r.code, 6, r.err);
    assert.ok(hasLine(r.lines, /refused the key/), JSON.stringify(r.lines));
    assert.equal(fs.readFileSync(config, 'utf8'), before);
    assert.equal(reportsOf(srv).length, 0);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- Kit 0.2.0: usage counts the session that runs it
// CLAUDE_CODE_SESSION_ID names the session; the newest log file never does. run() gives a clean environment,
// so the variable is set only where a test sets it.
const SESSION_ENV = 'CLAUDE_CODE_SESSION_ID';
const NO_SESSION_LINE = 'health: no session id (no --session and CLAUDE_CODE_SESSION_ID is not set); usage not counted';

// Two sessions in one environment. A has the older files; B has the newest. Each has a log in two project
// folders and a sub-agent file.
function twoSessions(home) {
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA(), 3600);
  writeTranscript(home, '-other-proj', SESSION_A, [callLine(SESSION_A, 'a-other-1', 'claude-a-model-5', 5, 5)], 3600);
  subFile(home, '-work-proj', SESSION_A, 'agent-a', [callLine(SESSION_A, 'sub-a', 'claude-a-sub-7', 13, 1)]);
  writeTranscript(home, '-work-proj', SESSION_B, [callLine(SESSION_B, 'b-1', 'claude-b-model-8', 21, 2)], 60);
  writeTranscript(home, '-other-proj', SESSION_B, [callLine(SESSION_B, 'b-2', 'claude-b-model-8', 34, 3)], 60);
  subFile(home, '-other-proj', SESSION_B, 'agent-b', [callLine(SESSION_B, 'sub-b', 'claude-b-sub-9', 55, 4)]);
}

test('K0.2.0 T1 usage with CLAUDE_CODE_SESSION_ID=A counts all of A and none of the newest session B', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  twoSessions(home);
  const srv = await server();
  try {
    const r = await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base, { [SESSION_ENV]: SESSION_A });
    assert.equal(r.code, 0, r.err);
    const rows = usageRows(srv);
    assert.ok(rows.length > 0, JSON.stringify(r.lines));
    assert.ok(rows.every((x) => x.session_key === KEY_OF(home, SESSION_A)), 'every row is session A');
    assert.ok(rows.every((x) => !/^claude-b-/.test(x.model)), 'no model that only session B used');
    assert.ok(rows.some((x) => x.model === 'claude-a-sub-7'), 'the sub-agent file of A counts');
    assert.ok(rows.some((x) => x.model === 'claude-a-model-5'), 'the copy of A in the other folder counts');
    assert.equal(rows.find((x) => x.model === 'claude-test-model-1').numbers.calls, 2);
  } finally { await srv.close(); }
});

test('K0.2.0 T2 --session B with CLAUDE_CODE_SESSION_ID=A counts B: the flag wins', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  twoSessions(home);
  const srv = await server();
  try {
    const r = await run(kit, home, ['usage', '--role', 'main', '--config', config, '--session', SESSION_B], srv.base, { [SESSION_ENV]: SESSION_A });
    assert.equal(r.code, 0, r.err);
    const rows = usageRows(srv);
    assert.ok(rows.length > 0, JSON.stringify(r.lines));
    assert.ok(rows.every((x) => x.session_key === KEY_OF(home, SESSION_B)), 'every row is session B');
    assert.ok(rows.every((x) => !/^claude-a-/.test(x.model) && !/^claude-test-model-/.test(x.model)), 'nothing from A');
  } finally { await srv.close(); }
});

test('K0.2.0 T3 usage with no session id prints one line, queues nothing, sends nothing, exits 0', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA(), 60);
  const srv = await server();
  try {
    const r = await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, NO_SESSION_LINE + '\n');
    assert.equal(r.err, '');
    assert.equal(srv.seen.length, 0, 'no request to SPM');
    assert.equal(spoolText(home), '', 'nothing queued');
  } finally { await srv.close(); }
});

test('K0.2.0 T4 CLAUDE_CODE_SESSION_ID that is not a valid id (../x, or 5 characters) counts as not set', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  writeTranscript(home, '-work-proj', SESSION_A, fixtureA(), 60);
  const srv = await server();
  try {
    for (const bad of ['../x', 'abcde']) {
      const r = await run(kit, home, ['usage', '--role', 'main', '--config', config], srv.base, { [SESSION_ENV]: bad });
      assert.equal(r.code, 0, bad);
      assert.equal(r.out, NO_SESSION_LINE + '\n', bad);
    }
    assert.equal(srv.seen.length, 0, 'no request to SPM');
    assert.equal(spoolText(home), '', 'nothing queued');
  } finally { await srv.close(); }
});

test('K0.2.0 T5 settings sends the key of session A from the environment, and no session_key without it', async () => {
  const kit = makeKit(); const { home, config } = makeHome();
  twoSessions(home);
  fs.mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir(home), 'report-salt'), 'ab'.repeat(16) + '\n', { mode: 0o600 });
  const srv = await server(settingsHandler(200, { autostart: false, reports: true }));
  try {
    const r = await run(kit, home, ['settings', '--autostart', 'off', '--config', config], srv.base, { [SESSION_ENV]: SESSION_A });
    assert.equal(r.code, 0, r.err);
    const body = srv.seen.find((q) => q.url.endsWith('/agent/settings')).json;
    assert.equal(body.session_key, KEY_OF(home, SESSION_A), 'the key of A, not of the newest file (B)');
    const r2 = await run(kit, home, ['settings', '--autostart', 'on', '--config', config], srv.base);
    assert.equal(r2.code, 0, r2.err);
    const body2 = srv.seen.filter((q) => q.url.endsWith('/agent/settings')).pop().json;
    assert.equal(Object.prototype.hasOwnProperty.call(body2, 'session_key'), false, 'no environment variable, no session_key');
  } finally { await srv.close(); }
});

test('K0.2.0 T6 heartbeat with CLAUDE_CODE_SESSION_ID=A reads the files of A, not of the newest session B', async () => {
  const kit = makeKit(); const { home, config } = makeHome({ name: SPM_NAME, email: SPM_ADDRESS });
  twoSessions(home);
  fs.mkdirSync(stateDir(home), { recursive: true });
  fs.writeFileSync(path.join(stateDir(home), 'listener.log'), '{"kind":"wrapper.start","t":"x"}\n');
  const srv = await server();
  try {
    const r = await run(kit, home, ['heartbeat', '--config', config], srv.base, { [SESSION_ENV]: SESSION_A });
    assert.equal(r.code, 0, r.err);
    const hb = reportsOf(srv).filter((x) => x.kind === 'heartbeat');
    assert.equal(hb.length, 1, JSON.stringify(r.lines));
    assert.equal(hb[0].session_key, KEY_OF(home, SESSION_A));
  } finally { await srv.close(); }
});
