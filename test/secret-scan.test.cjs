'use strict';
// Tests for scripts/secret-scan.sh and lib/secret-patterns.txt. Planted secrets are built at run time from pieces,
// so this file never contains a secret-shaped string itself.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PATTERNS, findSecrets, loadAllowedFakes } = require('../lib/secret-patterns.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCAN = path.join(ROOT, 'scripts', 'secret-scan.sh');
const LISTED_FAKE = 'spm_k_test_selfcheck_5d1e9a77'; // a line of scripts/allowed-fakes.txt

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skit-scan-'));
}

function scanFile(content) {
  const dir = tmpDir();
  const f = path.join(dir, 'planted.txt');
  fs.writeFileSync(f, content);
  const r = spawnSync('bash', [SCAN, f], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

const PLANTED = {
  'spm_k_ key': 'key = "spm_k_' + 'Zq9xLm2P' + '"\n',
  'PEM private key header': '-----' + 'BEGIN' + ' RSA PRIVATE KEY-----\n',
  'AWS access key id': 'id=' + 'AKIA' + 'ABCDEFGH' + 'IJKLMNOP' + '\n',
  'Anthropic key': 'token=' + 'sk-ant-' + 'api03xYz9QwR7tUvW2sKp' + '\n',
  'Postgres URI with password': 'url=' + 'postgres' + '://app:' + 'hunter2pw' + '@db.example.com/x\n',
};

for (const [name, content] of Object.entries(PLANTED)) {
  test(`catches ${name}`, () => {
    const r = scanFile(content);
    assert.equal(r.status, 1, `expected exit 1 (hit), got ${r.status}; stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout + r.stderr, /Zq9xLm2P|hunter2pw|api03xYz9Qw|ABCDEFGHIJKLMNOP/,
      'the scan must not print the secret it found');
  });
}

test('passes a clean file', () => {
  const r = scanFile('just some notes about the settings file\n');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('passes a listed fake value (scripts/allowed-fakes.txt, exact match)', () => {
  const r = scanFile('key = "' + LISTED_FAKE + '"\n');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('flags a spm_k_ value that starts with test but is not listed', () => {
  const r = scanFile('key = "spm_k_' + 'testZq7mK3pw' + '"\n');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /Zq7mK3pw/);
});

test('the allowlist is exact: a listed value with one extra character is flagged', () => {
  const r = scanFile('key = "' + LISTED_FAKE + 'X"\n');
  assert.equal(r.status, 1, r.stdout + r.stderr);
});

test('flags a GitHub fine-grained token and a Slack token, and never prints them', () => {
  const cases = [
    'pat ' + 'github' + '_pat_' + 'Ab12_'.repeat(7) + '\n',
    'slack ' + 'xox' + 'b-' + '1234567890-abcdefghij' + '\n',
  ];
  for (const content of cases) {
    const r = scanFile(content);
    assert.equal(r.status, 1, `expected exit 1; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout + r.stderr, /Ab12_|abcdefghij/);
  }
});

// One fixture line per pattern (built from pieces), plus one line that holds nothing.
const FIXTURE = [
  'plain line with nothing in it',
  '-----' + 'BEGIN' + ' OPENSSH PRIVATE KEY-----',
  'id ' + 'AKIA' + 'ABCDEFGHIJKLMNOP',
  'token ' + 'sk-ant-' + 'api03xYz9QwR7tUvW2sKp',
  'x=' + 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6',
  'pat ' + 'gh' + 'p_' + 'a'.repeat(36),
  'pat ' + 'github' + '_pat_' + 'Ab12_'.repeat(7),
  'maps ' + 'AIza' + 'Ab1-'.repeat(8) + 'xyz',
  'db ' + 'sbp_' + '0123456789abcdef'.repeat(2) + '01234567',
  'slack ' + 'xox' + 'b-' + '1234567890-abcdefghij',
  'hook ' + 'https://hooks' + '.slack.com/services/' + 'T000/B000/abcdefghijklmnop',
  'url ' + 'postgres' + '://app:' + 'hunter2pw' + '@db.example.com/x',
  'key ' + 'spm_k_' + 'Zq9xLm2P',
];
const FIXTURE_TEXT = FIXTURE.join('\n') + '\n';

test('each shape compiles in JS and in grep -E, and both find the same hit lines', () => {
  assert.ok(PATTERNS.length >= 12, `expected the full list, got ${PATTERNS.length}`);
  const dir = tmpDir();
  const f = path.join(dir, 'fixture.txt');
  fs.writeFileSync(f, FIXTURE_TEXT);
  try {
    for (const { name, re } of PATTERNS) {
      const jsLines = FIXTURE.map((l, i) => [l, i + 1]).filter(([l]) => new RegExp(re.source).test(l)).map(([, n]) => n);
      const g = spawnSync('grep', ['-n', '-E', '-e', re.source, f], { encoding: 'utf8' });
      assert.ok(g.status === 0 || g.status === 1, `grep failed for ${name}: ${g.stderr}`);
      const grepLines = g.stdout.split('\n').filter(Boolean).map((l) => Number(l.split(':')[0]));
      assert.ok(jsLines.length >= 1, `the fixture has no line for ${name}`);
      assert.deepEqual(jsLines, grepLines, `JS and grep -E disagree for ${name}`);
      const fsLines = findSecrets(FIXTURE_TEXT).filter((h) => h.name === name).map((h) => h.line);
      assert.deepEqual([...new Set(fsLines)], jsLines, `findSecrets disagrees for ${name}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findSecrets returns only name and line, and honours the allowed set', () => {
  const text = 'key ' + 'spm_k_' + 'Zq9xLm2P' + '\n' + 'key ' + LISTED_FAKE + '\n';
  // With no allowlist, both lines are hits (the listed fake is a shape match too).
  const hits = findSecrets(text);
  assert.deepEqual(hits.map((h) => h.line), [1, 2]);
  assert.ok(hits.every((h) => Object.keys(h).sort().join() === 'line,name'), 'only name and line');
  // With the exact allowlist, only the unlisted value is left.
  const allowed = loadAllowedFakes();
  assert.deepEqual(findSecrets(text, allowed).map((h) => h.line), [1]);
  assert.deepEqual(findSecrets('key ' + LISTED_FAKE + '\n', allowed), []);
});

test('the whole shared fixture is flagged by the scan script, and no matched text is printed', () => {
  const r = scanFile(FIXTURE_TEXT);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /Zq9xLm2P|hunter2pw|ABCDEFGHIJKLMNOP|Ab12_|abcdefghij|a1B2c3D4/);
});

test('--all fails on a planted key in an untracked file of a temp git repo', () => {
  const dir = tmpDir();
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'clean\n');
  git('add', 'ok.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'leak.txt'), 'k=spm_k_' + 'Zq9xLm2P' + '\n');
  // The kit's script run from inside the temp repo scans that repo.
  const r = spawnSync('bash', [SCAN, '--all'], { encoding: 'utf8', cwd: dir});
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /leak\.txt/);
});

test('--staged checks the staged content, not the working copy', () => {
  const dir = tmpDir();
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'k=spm_k_' + 'Zq9xLm2P' + '\n');
  git('add', 'a.txt');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'clean now\n');
  const r = spawnSync('bash', [SCAN, '--staged'], { encoding: 'utf8', cwd: dir});
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 1, r.stdout + r.stderr);
});
