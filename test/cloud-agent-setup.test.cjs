'use strict';
// Tests for cloud-agent-setup.sh. The install itself runs against a fake npm on PATH, so no network is used.
// FAKE: the fake npm stands in for the real npm. It records its arguments, and for `ci` it writes a package.json
// for every dependency of the runtime package.json (version taken from that dependency's spec, or from
// FAKE_NPM_VERSION when the test asks for a wrong version). A real install needs the network, so the real
// install is evidence in the lane report, not a test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KIT = path.join(__dirname, '..');
const SCRIPT = path.join(KIT, 'cloud-agent-setup.sh');
const KIT_RUNTIME = path.join(KIT, 'runtime');
const KIT_PKG = path.join(KIT_RUNTIME, 'package.json');
const KIT_LOCK = path.join(KIT_RUNTIME, 'package-lock.json');
// The three SDK packages the listener uses, at the versions firebase 12.4.0 itself declares.
const PINS = { '@firebase/app': '0.14.4', '@firebase/auth': '1.11.0', '@firebase/firestore': '4.9.2' };
const esc = (s) => s.replace(/\./g, '\\.');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(args, env = {}) {
  return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir(), ...env } });
}

// FAKE npm (see the header). The helper below is written once per test run and called by the fake.
const WRITER = path.join(tmp('setup-writer-'), 'write-packages.cjs');
fs.writeFileSync(WRITER, `'use strict';
const fs = require('node:fs'); const path = require('node:path');
const [prefix, forced] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(prefix, 'package.json'), 'utf8'));
for (const [name, spec] of Object.entries(pkg.dependencies)) {
  const dir = path.join(prefix, 'node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: forced || spec }));
}
`);

function fakeNpm(options = {}) {
  const bin = tmp('setup-fakenpm-');
  const argsLog = path.join(tmp('setup-args-'), 'argv.txt');
  const body = [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$@" > "${argsLog}"`,
    'prefix=""',
    'while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift 2;; *) shift;; esac; done',
    options.exit ? `exit ${options.exit}` : '',
    `node "${WRITER}" "$prefix" "${options.version || ''}"`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'npm'), body, { mode: 0o755 });
  return { bin, argsLog };
}

function npmArgs(argsLog) {
  return fs.readFileSync(argsLog, 'utf8').split('\n').filter(Boolean);
}

function installedPackages(runtime, versions = PINS) {
  for (const [name, version] of Object.entries(versions)) {
    const dir = path.join(runtime, 'node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  }
}

test('dry run prints the npm ci command with --ignore-scripts and the three pinned packages, and installs nothing', () => {
  const runtime = path.join(tmp('setup-dry-'), 'rt');
  const r = run(['--runtime-dir', runtime]);
  assert.equal(r.status, 0, r.stderr);
  for (const [name, version] of Object.entries(PINS)) assert.match(r.stdout, new RegExp(`${name.replace('/', '\\/')}@${esc(version)}`));
  assert.match(r.stdout, /npm ci --prefix .* --ignore-scripts/);
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
  const runtime = path.join(tmp('setup-env-'), 'from-env');
  const r = run([], { SPM_AGENT_RUNTIME_DIR: runtime });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(runtime), r.stdout);
});

test('a runtime folder inside a git work tree is refused', () => {
  const repo = tmp('setup-repo-');
  assert.equal(spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf8' }).status, 0);
  const r = run(['--runtime-dir', path.join(repo, 'rt'), '--apply']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /git work tree/);
});

test('the kit runtime package.json lists exactly the three SDK packages, each at an exact pin', () => {
  const pkg = JSON.parse(fs.readFileSync(KIT_PKG, 'utf8'));
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.dependencies, PINS);
});

test('the kit lockfile is lockfileVersion 3, pins each SDK package exactly, and has no whole firebase package', () => {
  const lock = JSON.parse(fs.readFileSync(KIT_LOCK, 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  for (const [name, version] of Object.entries(PINS)) {
    assert.equal(lock.packages[''].dependencies[name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  assert.equal(lock.packages['node_modules/firebase'], undefined);
});

test('the script installs with npm ci and --ignore-scripts, and never with npm install', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /npm ci --prefix "\$RUNTIME_DIR" --ignore-scripts/);
  assert.doesNotMatch(src, /npm install/);
});

test('apply on a fresh runtime folder runs npm ci with --ignore-scripts, copies the kit files byte for byte, and checks the pins', () => {
  const runtime = path.join(tmp('setup-apply-'), 'rt');
  const { bin, argsLog } = fakeNpm();
  const r = run(['--runtime-dir', runtime, '--apply'], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const args = npmArgs(argsLog);
  assert.equal(args[0], 'ci');
  assert.ok(args.includes('--ignore-scripts'), args.join(' '));
  const at = args.indexOf('--prefix');
  assert.deepEqual(args.slice(at, at + 2), ['--prefix', runtime]);
  assert.equal(args.includes('install'), false);
  assert.ok(fs.readFileSync(path.join(runtime, 'package-lock.json')).equals(fs.readFileSync(KIT_LOCK)), 'lockfile must be byte-identical');
  assert.ok(fs.readFileSync(path.join(runtime, 'package.json')).equals(fs.readFileSync(KIT_PKG)), 'package.json must be byte-identical');
  for (const [name, version] of Object.entries(PINS)) assert.match(r.stdout, new RegExp(`${name.replace('/', '\\/')} ${esc(version)}`));
});

test('apply where an installed SDK package differs from its pin exits 1', () => {
  const runtime = path.join(tmp('setup-mismatch-'), 'rt');
  const { bin } = fakeNpm({ version: '9.9.9' });
  const r = run(['--runtime-dir', runtime, '--apply'], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /does not match the pin/);
});

test('apply where npm ci fails exits 1 and says so', () => {
  const runtime = path.join(tmp('setup-fail-'), 'rt');
  const { bin } = fakeNpm({ exit: 1 });
  const r = run(['--runtime-dir', runtime, '--apply'], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /npm ci failed/);
});

// A runtime folder that already holds all three packages at their pins skips npm only when its lockfile
// and package.json are byte-identical to the kit's. Anything else runs npm ci.
function fakeNpmThatLogs() {
  const bin = tmp('setup-npmlog-');
  const log = path.join(tmp('setup-log-'), 'npm.log');
  fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env bash\necho "npm called" >> "${log}"\nexit 1\n`, { mode: 0o755 });
  return { bin, log };
}

test('apply with all three packages at their pins and an identical lockfile prints one line, exits 0, and never runs npm', () => {
  const runtime = path.join(tmp('setup-have-'), 'rt');
  installedPackages(runtime);
  fs.copyFileSync(KIT_PKG, path.join(runtime, 'package.json'));
  fs.copyFileSync(KIT_LOCK, path.join(runtime, 'package-lock.json'));
  const { bin, log } = fakeNpmThatLogs();
  const r = run(['--runtime-dir', runtime, '--apply'], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(log), false, 'npm must not run');
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'expected one line, got: ' + lines.join(' | '));
  assert.match(lines[0], /are already installed/);
});

test('apply with the pinned packages but no lockfile in the runtime folder runs npm ci', () => {
  const runtime = path.join(tmp('setup-nolock-'), 'rt');
  installedPackages(runtime);
  const { bin, argsLog } = fakeNpm();
  const r = run(['--runtime-dir', runtime, '--apply'], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(npmArgs(argsLog)[0], 'ci', 'npm ci must run when the lockfile is missing');
});

test('apply with the pinned packages but a different lockfile in the runtime folder runs npm ci', () => {
  const runtime = path.join(tmp('setup-difflock-'), 'rt');
  installedPackages(runtime);
  fs.copyFileSync(KIT_PKG, path.join(runtime, 'package.json'));
  fs.writeFileSync(path.join(runtime, 'package-lock.json'), fs.readFileSync(KIT_LOCK, 'utf8').replace(/\n$/, '\n\n'));
  const { bin, argsLog } = fakeNpm();
  const r = run(['--runtime-dir', runtime, '--apply'], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(npmArgs(argsLog)[0], 'ci', 'npm ci must run when the lockfile differs');
  assert.ok(fs.readFileSync(path.join(runtime, 'package-lock.json')).equals(fs.readFileSync(KIT_LOCK)), 'kit lockfile must replace it');
});

test('apply with one package at a different version still runs npm', () => {
  const runtime = path.join(tmp('setup-other-'), 'rt');
  installedPackages(runtime, { ...PINS, '@firebase/auth': '1.10.0' });
  fs.copyFileSync(KIT_PKG, path.join(runtime, 'package.json'));
  fs.copyFileSync(KIT_LOCK, path.join(runtime, 'package-lock.json'));
  const { bin, log } = fakeNpmThatLogs();
  const r = run(['--runtime-dir', runtime, '--apply'], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(fs.existsSync(log), true, 'npm should run when one package differs');
  assert.equal(r.status, 1, r.stdout + r.stderr);
});
