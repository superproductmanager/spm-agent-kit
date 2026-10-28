'use strict';
// Tests for cloud-agent-setup.sh. The install itself runs against a fake npm on PATH, so no network is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'cloud-agent-setup.sh');
const PIN = '12.4.0';

function run(args, env = {}) {
  return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env } });
}

test('dry run prints the constant pin and installs nothing', () => {
  const runtime = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-dry-')), 'rt');
  const r = run(['--runtime-dir', runtime]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`firebase@${PIN.replace(/\./g, '\\.')}`));
  assert.equal(fs.existsSync(runtime), false);
});

test('the lock-file flag is gone: it is refused as an unknown argument', () => {
  const r = run(['--lock-file', '/tmp/x/package-lock.json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument: --lock-file/);
});

test('a relative runtime folder is refused', () => {
  const r = run(['--runtime-dir', 'relative/rt']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must be an absolute path/);
});

test('the default runtime folder comes from SPM_AGENT_RUNTIME_DIR when it is set', () => {
  const runtime = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-env-')), 'from-env');
  const r = run([], { SPM_AGENT_RUNTIME_DIR: runtime });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(runtime), r.stdout);
});

test('a runtime folder inside a git work tree is refused', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-repo-'));
  assert.equal(spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf8' }).status, 0);
  const r = run(['--runtime-dir', path.join(repo, 'rt'), '--apply']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /git work tree/);
});

test('apply installs with the pinned version and checks the installed version against the pin', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-npm-'));
  // fake npm: writes the package.json that the real install would write, at the version it was asked for
  fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env bash
prefix=""; spec=""
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift 2;; firebase@*) spec="$1"; shift;; *) shift;; esac; done
v="\${spec#firebase@}"; mkdir -p "$prefix/node_modules/firebase"; printf '{"name":"firebase","version":"%s"}' "$v" > "$prefix/node_modules/firebase/package.json"
`, { mode: 0o755 });
  const runtime = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-apply-')), 'rt');
  const r = run(['--runtime-dir', runtime, '--apply'], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`installed firebase ${PIN.replace(/\./g, '\\.')} into`));
});

// A runtime folder that already holds firebase at the pinned version must not run npm again.
function fakeNpmThatLogs(logPath) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-npmlog-'));
  fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env bash
echo "npm called" >> "${logPath}"
exit 1
`, { mode: 0o755 });
  return bin;
}

test('apply with firebase already at the pinned version prints one line, exits 0, and never runs npm', () => {
  const runtime = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-have-')), 'rt');
  fs.mkdirSync(path.join(runtime, 'node_modules', 'firebase'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'node_modules', 'firebase', 'package.json'), JSON.stringify({ name: 'firebase', version: PIN }));
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-log-')), 'npm.log');
  const bin = fakeNpmThatLogs(log);
  const r = run(['--runtime-dir', runtime, '--apply'], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(log), false, 'npm must not run');
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'expected one line, got: ' + lines.join(' | '));
  assert.match(lines[0], new RegExp(`firebase ${PIN.replace(/\./g, '\\.')} is already installed`));
});

test('apply with firebase at a different version still runs npm', () => {
  const runtime = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-other-')), 'rt');
  fs.mkdirSync(path.join(runtime, 'node_modules', 'firebase'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'node_modules', 'firebase', 'package.json'), JSON.stringify({ name: 'firebase', version: '12.3.0' }));
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-log-')), 'npm.log');
  const bin = fakeNpmThatLogs(log);
  const r = run(['--runtime-dir', runtime, '--apply'], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(fs.existsSync(log), true, 'npm should run for a different version');
  assert.equal(r.status, 1, r.stdout + r.stderr);
});
