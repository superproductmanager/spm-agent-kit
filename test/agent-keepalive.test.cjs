// Tests for 
// Real bash, real files, real child processes. No fakes. Thresholds are scaled with env vars so
// the suite runs in seconds; no test waits 30 s or 60 s.
// Run: node --test 
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'agent-keepalive.sh');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-test-'));
}

// Runs the wrapper once to completion (KEEPALIVE_MAX_RUNS must be set so it returns).
function run(log, cmd, env) {
  return spawnSync('bash', [SCRIPT, log, cmd], {
    encoding: 'utf8',
    timeout: 60000,
    env: { PATH: process.env.PATH, ...env },
  });
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
}

function restartLines(log) {
  return readLines(log)
    .filter((l) => l.startsWith('{"kind":"listener.restart"'))
    .map((l) => JSON.parse(l));
}

function failingLines(log) {
  return readLines(log)
    .filter((l) => l.startsWith('{"kind":"listener.failing"'))
    .map((l) => JSON.parse(l));
}

test('usage: no arguments exits 2 with one usage line', () => {
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^usage: agent-keepalive\.sh <LOG> '<shell command>'\n$/);
});

test('usage: LOG without a command exits 2', () => {
  const dir = tmpdir();
  const r = spawnSync('bash', [SCRIPT, path.join(dir, 'LOG')], { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

test('restart line shape: one valid JSON line per run, exit 0 after KEEPALIVE_MAX_RUNS', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'LOG');
  const r = run(log, 'echo hi', { KEEPALIVE_MAX_RUNS: '3', RESTART_DELAY_S: '0', RESTART_MAX_DELAY_S: '0' });
  assert.equal(r.status, 0, r.stderr);
  const restarts = restartLines(log);
  assert.equal(restarts.length, 3);
  for (const x of restarts) {
    assert.deepEqual(Object.keys(x).sort(), ['delay_s', 'exit_code', 'kind', 't']);
    assert.equal(x.kind, 'listener.restart');
    assert.equal(x.exit_code, 0);
    assert.equal(x.delay_s, 0);
    assert.match(x.t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }
  assert.equal(readLines(log).filter((l) => l === 'hi').length, 3);
});

test('exit code of the command is recorded in its restart line', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'LOG');
  const r = run(log, 'exit 7', { KEEPALIVE_MAX_RUNS: '1', RESTART_DELAY_S: '0' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(restartLines(log)[0].exit_code, 7);
});

test('stdout goes to LOG and stderr goes to LOG.err', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'LOG');
  const r = run(log, 'echo out-line; echo err-line >&2', { KEEPALIVE_MAX_RUNS: '1', RESTART_DELAY_S: '0' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readLines(log).includes('out-line'));
  assert.ok(!readLines(log).includes('err-line'));
  assert.deepEqual(readLines(`${log}.err`), ['err-line']);
});

test('back-off: fast runs double the wait, capped at RESTART_MAX_DELAY_S', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'LOG');
  // Every run exits at once (under the default 30 s), so every run is fast.
  // Waits: 1 (base), then doubled 2, then 4, then capped at 4.
  const r = run(log, 'exit 1', { KEEPALIVE_MAX_RUNS: '4', RESTART_DELAY_S: '1', RESTART_MAX_DELAY_S: '4' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(restartLines(log).map((x) => x.delay_s), [1, 2, 4, 4]);
});

test('a run of KEEPALIVE_LONG_S or more resets the wait to the base', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'LOG');
  const counter = path.join(dir, 'count');
  // Run 1 is fast (wait 1, then doubled to 2). Run 2 lasts 2 s (>= LONG_S=2): reset to base 1.
  // Run 3 is fast. Without the reset, run 2 would wait 2 and the sequence would be [1, 2, 2].
  const cmd = `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"; if [ $n -eq 2 ]; then sleep 2; fi; exit 1`;
  const r = run(log, cmd, { KEEPALIVE_MAX_RUNS: '3', KEEPALIVE_FAST_S: '1', KEEPALIVE_LONG_S: '2', RESTART_DELAY_S: '1', RESTART_MAX_DELAY_S: '8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(restartLines(log).map((x) => x.delay_s), [1, 1, 1]);
});

test('a run between KEEPALIVE_FAST_S and KEEPALIVE_LONG_S keeps the wait unchanged', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'LOG');
  const counter = path.join(dir, 'count');
  // Run 1 fast: wait 1, next wait 2. Run 2 lasts 1 s (not under FAST_S=1, under LONG_S=3): wait stays 2.
  // Run 3 waits 2 (unchanged).
  const cmd = `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"; if [ $n -eq 2 ]; then sleep 1; fi; exit 1`;
  const r = run(log, cmd, { KEEPALIVE_MAX_RUNS: '3', KEEPALIVE_FAST_S: '1', KEEPALIVE_LONG_S: '3', RESTART_DELAY_S: '1', RESTART_MAX_DELAY_S: '8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(restartLines(log).map((x) => x.delay_s), [1, 2, 2]);
});

test('listener.failing is written once per streak of 3 fast restarts, with escaped last_err', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'LOG');
  // 5 fast runs: the streak reaches 3 once, so exactly one failing line.
  const cmd = String.raw`echo 'boom "q" back\slash' >&2; exit 1`;
  const r = run(log, cmd, { KEEPALIVE_MAX_RUNS: '5', RESTART_DELAY_S: '0' });
  assert.equal(r.status, 0, r.stderr);
  const failing = failingLines(log);
  assert.equal(failing.length, 1);
  assert.equal(failing[0].kind, 'listener.failing');
  assert.equal(failing[0].restarts, 3);
  assert.match(failing[0].t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(failing[0].last_err, 'boom "q" back\\slash');
});

test('last_err is cut to 200 characters', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'LOG');
  const cmd = `printf 'x%.0s' $(seq 1 300) >&2; echo >&2; exit 1`;
  const r = run(log, cmd, { KEEPALIVE_MAX_RUNS: '3', RESTART_DELAY_S: '0' });
  assert.equal(r.status, 0, r.stderr);
  const failing = failingLines(log);
  assert.equal(failing.length, 1);
  assert.equal(failing[0].last_err.length, 200);
  assert.equal(failing[0].last_err, 'x'.repeat(200));
});

test('a non-fast run ends a streak; the next streak writes a second failing line', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'LOG');
  const counter = path.join(dir, 'count');
  // Runs 1-3 fast (failing #1). Run 4 lasts 1 s (not fast with FAST_S=1): streak ends.
  // Runs 5-7 fast again (failing #2).
  const cmd = `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"; if [ $n -eq 4 ]; then sleep 1; fi; echo boom >&2; exit 1`;
  const r = run(log, cmd, { KEEPALIVE_MAX_RUNS: '7', KEEPALIVE_FAST_S: '1', RESTART_DELAY_S: '0' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(failingLines(log).length, 2);
});

// Stopping the wrapper (a Monitor ending, a kill) must stop the listener under it too, or the next start
// runs a second listener next to the orphan (two "Seen" marks per tag).
test('stopping the wrapper stops the running command and its children', async () => {
  const { spawn } = require('node:child_process');
  const dir = tmpdir();
  const log = path.join(dir, 'listener.log');
  const pidFile = path.join(dir, 'child.pid');
  // a pipeline, so bash -c cannot simply exec it: the grandchild must die too
  const cmd = `sleep 30 & echo $! > ${pidFile}; wait; echo done | cat`;
  const w = spawn('bash', [SCRIPT, log, cmd], { env: { PATH: process.env.PATH, RESTART_DELAY_S: '1' }, stdio: 'ignore' });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await sleepMs(100);
  const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(alive(childPid), 'the command is running');
  const exited = new Promise((r) => w.on('exit', (code, sig) => r({ code, sig })));
  w.kill('SIGTERM');
  const res = await Promise.race([exited, sleepMs(5000).then(() => 'timeout')]);
  assert.notEqual(res, 'timeout', 'the wrapper exits within 5 s of SIGTERM');
  for (let i = 0; i < 20 && alive(childPid); i++) await sleepMs(100);
  assert.equal(alive(childPid), false, 'the command started by the wrapper is gone');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stopping the wrapper during its back-off wait exits at once', async () => {
  const { spawn } = require('node:child_process');
  const dir = tmpdir();
  const log = path.join(dir, 'listener.log');
  const w = spawn('bash', [SCRIPT, log, 'true'], { env: { PATH: process.env.PATH, RESTART_DELAY_S: '60' }, stdio: 'ignore' });
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 50 && restartLines(log).length === 0; i++) await sleepMs(100);
  const exited = new Promise((r) => w.on('exit', () => r('exited')));
  w.kill('SIGTERM');
  const res = await Promise.race([exited, sleepMs(5000).then(() => 'timeout')]);
  assert.equal(res, 'exited', 'no 60 s sleep holds the wrapper');
  fs.rmSync(dir, { recursive: true, force: true });
});

// : single-instance lock. A second wrapper on the same LOG must exit 0 at once with one line and never run its command.
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('single instance: a second wrapper on the same LOG exits 0 at once and its command never runs', async () => {
  const { spawn } = require('node:child_process');
  const dir = tmpdir();
  const log = path.join(dir, 'listener.log');
  const started = path.join(dir, 'started');
  const marker = path.join(dir, 'second-ran');
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const w1 = spawn('bash', [SCRIPT, log, `touch ${started}; sleep 30`], { env: { PATH: process.env.PATH, RESTART_DELAY_S: '1' }, stdio: 'ignore' });
  const exited = new Promise((r) => w1.on('exit', (code, sig) => r({ code, sig })));
  try {
    for (let i = 0; i < 50 && !fs.existsSync(started); i++) await sleepMs(100);
    assert.ok(fs.existsSync(started), 'the first wrapper started its command');
    const t0 = Date.now();
    const r2 = spawnSync('bash', [SCRIPT, log, `touch ${marker}`], {
      encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, KEEPALIVE_MAX_RUNS: '1', RESTART_DELAY_S: '0' },
    });
    const took = Date.now() - t0;
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stderr, /^agent-keepalive: another wrapper already runs for /);
    assert.equal(r2.stderr.trim().split('\n').length, 1, 'one line on stderr');
    assert.ok(took < 5000, `returned quickly (${took} ms)`);
    assert.equal(fs.existsSync(marker), false, 'the second command never ran');
  } finally {
    w1.kill('SIGTERM');
    await Promise.race([exited, sleepMs(5000)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('single instance: after the first wrapper is stopped with SIGTERM, a new wrapper starts normally', async () => {
  const { spawn } = require('node:child_process');
  const dir = tmpdir();
  const log = path.join(dir, 'listener.log');
  const started = path.join(dir, 'started');
  const again = path.join(dir, 'again-ran');
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const w1 = spawn('bash', [SCRIPT, log, `touch ${started}; sleep 30`], { env: { PATH: process.env.PATH, RESTART_DELAY_S: '1' }, stdio: 'ignore' });
  const exited = new Promise((r) => w1.on('exit', (code, sig) => r({ code, sig })));
  try {
    for (let i = 0; i < 50 && !fs.existsSync(started); i++) await sleepMs(100);
    w1.kill('SIGTERM');
    const res = await Promise.race([exited, sleepMs(5000).then(() => 'timeout')]);
    assert.notEqual(res, 'timeout', 'the first wrapper exits within 5 s of SIGTERM');
    const r = spawnSync('bash', [SCRIPT, log, `touch ${again}`], {
      encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, KEEPALIVE_MAX_RUNS: '1', RESTART_DELAY_S: '0' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr.includes('another wrapper'), false, 'the lock was released');
    assert.equal(fs.existsSync(again), true, 'the new wrapper ran its command');
  } finally {
    w1.kill('SIGTERM');
    await Promise.race([exited, sleepMs(5000)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('single instance: without flock, one warning line and the wrapper still runs', () => {
  const dir = tmpdir();
  const log = path.join(dir, 'listener.log');
  const binDir = path.join(dir, 'bin-without-flock');
  fs.mkdirSync(binDir);
  // a PATH with the commands the wrapper needs, and no flock
  for (const name of ['bash', 'sleep', 'date', 'tail', 'tr', 'sed', 'setsid', 'touch', 'cat', 'mkdir']) {
    const found = spawnSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(binDir, name));
  }
  const marker = path.join(dir, 'ran');
  const r = spawnSync('bash', [SCRIPT, log, `touch ${marker}`], {
    encoding: 'utf8', timeout: 20000, env: { PATH: binDir, KEEPALIVE_MAX_RUNS: '1', RESTART_DELAY_S: '0' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /flock/);
  assert.equal(r.stderr.trim().split('\n').length, 1, 'one warning line');
  assert.equal(fs.existsSync(marker), true, 'the command ran without a lock');
  fs.rmSync(dir, { recursive: true, force: true });
});
