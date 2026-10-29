'use strict';
// agent-wait.sh: the listener session's wait. It ends at the first new notice line, FAIL line or fatal line
// written to the log after it starts, or at the timeout. It prints one line (notice, fail or timeout) and never
// prints log content. Exit codes: 0 notice, 3 fail, 124 timeout, 2 usage.
// Real bash and real files; a scratch log in os.tmpdir(). Run: node --test test/agent-wait.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const KIT = path.join(__dirname, '..');
const WAIT = path.join(KIT, 'agent-wait.sh');
const NOTICE = '{"t": "2026-10-29T10:00:00+05:30", "kind": "notice", "notification_id": "00000000-0000-4000-8000-000000000001"}';
const FAIL_LINE = 'FAIL example: the selfcheck said no';
const FATAL_LINE = 'fatal: example stop';

function scratchLog(initial = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wait-test-'));
  const log = path.join(dir, 'listener.log');
  fs.writeFileSync(log, initial);
  return { dir, log };
}

// Runs the wait; appendAfterMs writes `line` to the log while the wait is running.
function runWait(args, { appendAfterMs = null, line = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', [WAIT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    if (appendAfterMs !== null) {
      setTimeout(() => fs.appendFileSync(args[1], line + '\n'), appendAfterMs);
    }
    child.on('close', (status) => resolve({ status, out, err }));
  });
}

test('a notice line written after the start ends the wait with 0 within seconds, and prints no log content', async () => {
  const { dir, log } = scratchLog('old line\n');
  try {
    const t0 = Date.now();
    const r = await runWait(['--log', log, '--seconds', '30'], { appendAfterMs: 800, line: NOTICE });
    assert.equal(r.status, 0, r.err);
    assert.ok(Date.now() - t0 < 10000, 'the wait should end within seconds, not at the timeout');
    assert.match(r.out, /^agent-wait: notice\n?$/);
    assert.equal(r.out.includes('00000000-0000-4000-8000-000000000001'), false, 'no log content in the output');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a FAIL line written after the start ends the wait with 3', async () => {
  const { dir, log } = scratchLog('');
  try {
    const r = await runWait(['--log', log, '--seconds', '30'], { appendAfterMs: 800, line: FAIL_LINE });
    assert.equal(r.status, 3, r.err);
    assert.match(r.out, /^agent-wait: fail\n?$/);
    assert.equal(r.out.includes('example'), false, 'no log content in the output');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a fatal line written after the start ends the wait with 3', async () => {
  const { dir, log } = scratchLog('');
  try {
    const r = await runWait(['--log', log, '--seconds', '30'], { appendAfterMs: 800, line: FATAL_LINE });
    assert.equal(r.status, 3, r.err);
    assert.match(r.out, /^agent-wait: fail\n?$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no new line gives 124 at the timeout (--seconds 2), printed as timeout', async () => {
  const { dir, log } = scratchLog('');
  try {
    const t0 = Date.now();
    const r = await runWait(['--log', log, '--seconds', '2']);
    assert.equal(r.status, 124, r.err);
    assert.ok(Date.now() - t0 >= 1500, 'the wait should run about the timeout');
    assert.match(r.out, /^agent-wait: timeout\n?$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a notice line already in the log before the start does not end the wait', async () => {
  const { dir, log } = scratchLog(NOTICE + '\n' + FAIL_LINE + '\n');
  try {
    const r = await runWait(['--log', log, '--seconds', '2']);
    assert.equal(r.status, 124, `old lines must not end the wait: ${r.out} ${r.err}`);
    assert.match(r.out, /^agent-wait: timeout\n?$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('usage errors exit 2: a relative log path, and a missing log option', () => {
  const relative = spawnSync('bash', [WAIT, '--log', 'listener.log', '--seconds', '2'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(relative.status, 2, relative.stderr);
  const none = spawnSync('bash', [WAIT, '--seconds', '2'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(none.status, 2, none.stderr);
});
