'use strict';
// Tests for install/install-kit.sh. No network: the release tarball is built here in a
// temp folder, and SPM_AGENT_KIT_URL_BASE points curl at it through a file:// URL.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INSTALL = path.join(ROOT, 'install', 'install-kit.sh');
const VERSION = '9.9.9';

// Builds <base>/v9.9.9/spm-agent-kit-9.9.9.tar.gz with the same layout release.sh uses.
function makeRelease() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skit-rel-'));
  const src = path.join(base, 'src', `spm-agent-kit-${VERSION}`);
  fs.mkdirSync(path.join(src, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(src, 'README.md'), '# fixture kit\n');
  fs.writeFileSync(path.join(src, 'scripts', 'marker.txt'), 'fixture\n');
  const relDir = path.join(base, 'v' + VERSION);
  fs.mkdirSync(relDir);
  const tgz = path.join(relDir, `spm-agent-kit-${VERSION}.tar.gz`);
  const r = spawnSync('tar', ['-czf', tgz, '-C', path.join(base, 'src'), `spm-agent-kit-${VERSION}`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  return { base, sha, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// One temp HOME for the whole file, so the setup report spool never lands in the real home. A test that reads the spool passes its own home.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skit-home-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

function install(args, env, home = HOME) {
  return spawnSync('bash', [INSTALL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...env },
  });
}

// 0.2.0 setup report spool: one JSON line per step in <home>/.spm-agent-state/setup-report.jsonl (kit_version from the version argument, Addendum B7).
const SPOOL_RE = {
  id: /^[a-f0-9-]{16,64}$/,
  run_id: /^[a-f0-9-]{8,64}$/,
  step: /^[a-z0-9-]{1,32}$/,
  code: /^[a-z0-9_]{1,64}$/,
};
function spoolLines(home) {
  const f = path.join(home, '.spm-agent-state', 'setup-report.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('good checksum installs the release and writes VERSION', () => {
  const rel = makeRelease();
  const dir = path.join(rel.base, 'install-here');
  try {
    const r = install([VERSION, rel.sha], { SPM_AGENT_KIT_URL_BASE: 'file://' + rel.base, SPM_AGENT_KIT_DIR: dir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(), VERSION);
    assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'README.md should be unpacked');
    assert.ok(fs.existsSync(path.join(dir, 'scripts', 'marker.txt')), 'nested files should be unpacked');
  } finally {
    rel.cleanup();
  }
});

test('running again for the same version is a no-op that exits 0', () => {
  const rel = makeRelease();
  const dir = path.join(rel.base, 'install-here');
  const env = { SPM_AGENT_KIT_URL_BASE: 'file://' + rel.base, SPM_AGENT_KIT_DIR: dir };
  try {
    assert.equal(install([VERSION, rel.sha], env).status, 0);
    const again = install([VERSION, rel.sha], env);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout + again.stderr, /already/i);
  } finally {
    rel.cleanup();
  }
});

test('bad checksum refuses with exit 3, one plain line, and leaves nothing behind', () => {
  const rel = makeRelease();
  const dir = path.join(rel.base, 'install-here');
  try {
    const r = install([VERSION, '0'.repeat(64)], { SPM_AGENT_KIT_URL_BASE: 'file://' + rel.base, SPM_AGENT_KIT_DIR: dir });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    const lines = (r.stdout + r.stderr).trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'expected one line of output, got: ' + lines.join(' | '));
    assert.equal(fs.existsSync(dir), false, 'the install folder must not be created');
  } finally {
    rel.cleanup();
  }
});

test('bad arguments exit 2 without touching the network', () => {
  const r = install(['not-a-version', 'abc'], { SPM_AGENT_KIT_URL_BASE: 'file:///nonexistent' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

test('a missing release exits non-zero and leaves no install folder', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skit-empty-'));
  const dir = path.join(base, 'install-here');
  try {
    const r = install([VERSION, '0'.repeat(64)], { SPM_AGENT_KIT_URL_BASE: 'file://' + base, SPM_AGENT_KIT_DIR: dir });
    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---- The kit marker: the installer deletes only a folder that carries .spm-agent-kit ----

const MARKER = '.spm-agent-kit';

function caseDir(rel) {
  return path.join(rel.base, 'install-here');
}

test('a non-empty folder with only a VERSION file and another file is refused, and both files stay', () => {
  const rel = makeRelease();
  const dir = caseDir(rel);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'VERSION'), '0.1.0\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine\n');
  try {
    const r = install([VERSION, rel.sha], { SPM_AGENT_KIT_URL_BASE: 'file://' + rel.base, SPM_AGENT_KIT_DIR: dir });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal((r.stdout + r.stderr).trim().split('\n').filter(Boolean).length, 1, 'expected one line of output');
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8'), '0.1.0\n');
    assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'mine\n');
  } finally {
    rel.cleanup();
  }
});

test('an empty folder is installed into', () => {
  const rel = makeRelease();
  const dir = caseDir(rel);
  fs.mkdirSync(dir);
  try {
    const r = install([VERSION, rel.sha], { SPM_AGENT_KIT_URL_BASE: 'file://' + rel.base, SPM_AGENT_KIT_DIR: dir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'README.md should be unpacked');
    assert.equal(fs.readFileSync(path.join(dir, MARKER), 'utf8'), `spm-agent-kit ${VERSION}\n`);
  } finally {
    rel.cleanup();
  }
});

test('a kit folder carrying the marker of another version is replaced', () => {
  const rel = makeRelease();
  const dir = caseDir(rel);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, MARKER), 'spm-agent-kit 0.1.0\n');
  fs.writeFileSync(path.join(dir, 'old-only.txt'), 'stale\n');
  try {
    const r = install([VERSION, rel.sha], { SPM_AGENT_KIT_URL_BASE: 'file://' + rel.base, SPM_AGENT_KIT_DIR: dir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(path.join(dir, 'old-only.txt')), false, 'the old kit files should be gone');
    assert.equal(fs.readFileSync(path.join(dir, MARKER), 'utf8'), `spm-agent-kit ${VERSION}\n`);
  } finally {
    rel.cleanup();
  }
});

test('a kit folder with the same version exits 0 without any download', () => {
  const rel = makeRelease();
  const dir = caseDir(rel);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, MARKER), `spm-agent-kit ${VERSION}\n`);
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'kept\n');
  try {
    // the URL base does not exist, so any download attempt would exit 4
    const r = install([VERSION, rel.sha], { SPM_AGENT_KIT_URL_BASE: 'file:///nonexistent', SPM_AGENT_KIT_DIR: dir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /already/i);
    assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'kept\n');
  } finally {
    rel.cleanup();
  }
});

test('a folder whose marker is malformed is refused and nothing is deleted', () => {
  const rel = makeRelease();
  const dir = caseDir(rel);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, MARKER), 'spm-agent-kit latest\n');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'kept\n');
  try {
    const r = install([VERSION, rel.sha], { SPM_AGENT_KIT_URL_BASE: 'file://' + rel.base, SPM_AGENT_KIT_DIR: dir });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'kept\n');
  } finally {
    rel.cleanup();
  }
});

test('a symlink at the install folder is refused and the link target is untouched', () => {
  const rel = makeRelease();
  const target = path.join(rel.base, 'real-folder');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'kept\n');
  const dir = caseDir(rel);
  fs.symlinkSync(target, dir);
  try {
    const r = install([VERSION, rel.sha], { SPM_AGENT_KIT_URL_BASE: 'file://' + rel.base, SPM_AGENT_KIT_DIR: dir });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'kept\n');
    assert.ok(fs.lstatSync(dir).isSymbolicLink(), 'the symlink should still be there');
  } finally {
    rel.cleanup();
  }
});

test('the marker written after install is exactly one line: spm-agent-kit <version>', () => {
  const rel = makeRelease();
  const dir = caseDir(rel);
  try {
    const r = install([VERSION, rel.sha], { SPM_AGENT_KIT_URL_BASE: 'file://' + rel.base, SPM_AGENT_KIT_DIR: dir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, MARKER), 'utf8'), `spm-agent-kit ${VERSION}\n`);
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(), VERSION, 'VERSION is still written');
  } finally {
    rel.cleanup();
  }
});

// ---- 0.2.0: setup report spool (download, checksum, unpack) ----

test('a good install spools download, checksum and unpack as pass, with the spool contract fields and no kit_version', () => {
  const rel = makeRelease();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skit-spool-home-'));
  const dir = path.join(rel.base, 'install-here');
  try {
    const r = install([VERSION, rel.sha], { SPM_AGENT_KIT_URL_BASE: 'file://' + rel.base, SPM_AGENT_KIT_DIR: dir }, home);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = spoolLines(home);
    assert.deepEqual(lines.map((l) => [l.step, l.status]), [['download', 'pass'], ['checksum', 'pass'], ['unpack', 'pass']]);
    const runId = fs.readFileSync(path.join(home, '.spm-agent-state', 'setup-run-id'), 'utf8').trim();
    for (const l of lines) {
      assert.equal(l.kind, 'setup');
      assert.equal(l.role, 'setup');
      assert.match(l.id, SPOOL_RE.id);
      assert.equal(l.run_id, runId);
      assert.match(l.run_id, SPOOL_RE.run_id);
      assert.match(l.step, SPOOL_RE.step);
      assert.equal(l.code, undefined, 'a pass has no code');
      assert.match(l.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      assert.equal(l.kit_version, VERSION, 'Addendum B7: the installer fills kit_version from its version argument');
    }
    assert.equal(new Set(lines.map((l) => l.id)).size, 3, 'each line has its own id');
    assert.equal(fs.statSync(path.join(home, '.spm-agent-state')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, '.spm-agent-state', 'setup-report.jsonl')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(home, '.spm-agent-state', 'setup-run-id')).mode & 0o777, 0o600);
  } finally {
    rel.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a bad checksum spools checksum fail with code checksum_mismatch, stops there, and keeps the one-line output', () => {
  const rel = makeRelease();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skit-spool-home-'));
  try {
    const r = install([VERSION, '0'.repeat(64)], { SPM_AGENT_KIT_URL_BASE: 'file://' + rel.base, SPM_AGENT_KIT_DIR: path.join(rel.base, 'x') }, home);
    assert.equal(r.status, 3);
    assert.equal((r.stdout + r.stderr).trim().split('\n').filter(Boolean).length, 1, 'one line of output');
    assert.equal(r.stdout, '', 'spool lines never go to stdout');
    const lines = spoolLines(home);
    assert.deepEqual(lines.map((l) => [l.step, l.status, l.code]), [['download', 'pass', undefined], ['checksum', 'fail', 'checksum_mismatch']]);
  } finally {
    rel.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a failed download spools download fail with code download_failed and exits 4', () => {
  const rel = makeRelease();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skit-spool-home-'));
  try {
    const r = install([VERSION, rel.sha], { SPM_AGENT_KIT_URL_BASE: 'file://' + path.join(rel.base, 'missing'), SPM_AGENT_KIT_DIR: path.join(rel.base, 'x') }, home);
    assert.equal(r.status, 4, r.stdout + r.stderr);
    const lines = spoolLines(home);
    assert.deepEqual(lines.map((l) => [l.step, l.status, l.code]), [['download', 'fail', 'download_failed']]);
  } finally {
    rel.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a spool write that fails does not stop the install (exit 0, kit installed)', () => {
  const rel = makeRelease();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skit-spool-home-'));
  const dir = path.join(rel.base, 'install-here');
  try {
    fs.writeFileSync(path.join(home, '.spm-agent-state'), 'a file, not a folder\n');
    const r = install([VERSION, rel.sha], { SPM_AGENT_KIT_URL_BASE: 'file://' + rel.base, SPM_AGENT_KIT_DIR: dir }, home);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(), VERSION);
  } finally {
    rel.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
