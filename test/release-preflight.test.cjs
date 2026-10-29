// Tests for scripts/release-preflight.sh. Real git in temp dirs: a bare repo as origin, and a clone that has
// README.md and RELEASE-NOTES.md committed. The real script runs as a child process. Synthetic content only.
// Run: node --test test/release-preflight.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const KIT_SRC = path.join(__dirname, '..');
const SCRIPT = path.join(KIT_SRC, 'scripts', 'release-preflight.sh');
const VERSION = '0.2.1';
const TAG = `v${VERSION}`;

const dirs = [];
function tmpdir(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `preflight-${label}-`));
  dirs.push(d);
  return d;
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// A bare origin and a clone with README.md and RELEASE-NOTES.md committed on main and pushed.
function makeFixture() {
  const base = tmpdir('fixture');
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  git(base, ['init', '--bare', '-b', 'main', origin]);
  git(base, ['init', '-b', 'main', work]);
  git(work, ['config', 'user.name', 'Example Maintainer']);
  git(work, ['config', 'user.email', 'maintainer@example.invalid']);
  git(work, ['remote', 'add', 'origin', origin]);
  fs.writeFileSync(path.join(work, 'README.md'), `# Example kit\n\nCurrent version: ${VERSION}\n`);
  fs.writeFileSync(path.join(work, 'RELEASE-NOTES.md'), `# Release notes\n\n## ${VERSION}\n\nSynthetic notes.\n`);
  git(work, ['add', 'README.md', 'RELEASE-NOTES.md']);
  git(work, ['commit', '-m', 'Initial synthetic commit']);
  git(work, ['push', '-u', 'origin', 'main']);
  return { origin, work };
}

// Runs the real script in the clone. GITHUB_REF is set only when given; it is removed from the inherited env otherwise.
function run(work, args, { githubRef } = {}) {
  const env = { ...process.env };
  delete env.GITHUB_REF;
  if (githubRef !== undefined) env.GITHUB_REF = githubRef;
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: work, env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function rewriteReadme(work, text) {
  fs.writeFileSync(path.join(work, 'README.md'), text);
}

test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('dispatch mode: all checks pass on main with a free tag', () => {
  const { work } = makeFixture();
  const r = run(work, [VERSION, 'dispatch'], { githubRef: 'refs/heads/main' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('tag mode: all checks pass without GITHUB_REF', () => {
  const { work } = makeFixture();
  const r = run(work, [VERSION, 'tag']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('bad version with a shell separator is a usage error, exit 2', () => {
  const { work } = makeFixture();
  const r = run(work, ['0.2.1; echo x', 'tag']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^release-preflight: /);
});

test('version with a leading v is a usage error, exit 2', () => {
  const { work } = makeFixture();
  const r = run(work, ['v0.2.1', 'tag']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^release-preflight: /);
});

test('unknown mode is a usage error, exit 2', () => {
  const { work } = makeFixture();
  const r = run(work, [VERSION, 'push']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^release-preflight: /);
});

test('README names another version: exit 1', () => {
  const { work } = makeFixture();
  rewriteReadme(work, '# Example kit\n\nCurrent version: 0.2.0\n');
  const r = run(work, [VERSION, 'tag']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^release-preflight: README\.md does not say 'Current version: 0\.2\.1'/);
});

test('RELEASE-NOTES heading missing: exit 1', () => {
  const { work } = makeFixture();
  fs.writeFileSync(path.join(work, 'RELEASE-NOTES.md'), '# Release notes\n\n## 0.2.10\n\nSynthetic notes.\n');
  const r = run(work, [VERSION, 'tag']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^release-preflight: RELEASE-NOTES\.md has no heading '## 0\.2\.1'/);
});

test('dispatch from another branch: exit 1', () => {
  const { work } = makeFixture();
  const r = run(work, [VERSION, 'dispatch'], { githubRef: 'refs/heads/other' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^release-preflight: .*refs\/heads\/main/);
});

test('dispatch with the tag already local: exit 1', () => {
  const { work } = makeFixture();
  git(work, ['tag', '-a', TAG, '-m', 'synthetic']);
  const r = run(work, [VERSION, 'dispatch'], { githubRef: 'refs/heads/main' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^release-preflight: tag v0\.2\.1 already exists locally/);
});

test('dispatch with the tag only on origin: exit 1', () => {
  const { work } = makeFixture();
  git(work, ['tag', '-a', TAG, '-m', 'synthetic']);
  git(work, ['push', 'origin', `refs/tags/${TAG}`]);
  git(work, ['tag', '-d', TAG]);
  const r = run(work, [VERSION, 'dispatch'], { githubRef: 'refs/heads/main' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^release-preflight: tag v0\.2\.1 already exists on origin/);
});

test('tag mode ignores GITHUB_REF and an existing local tag: exit 0', () => {
  const { work } = makeFixture();
  git(work, ['tag', '-a', TAG, '-m', 'synthetic']);
  const r = run(work, [VERSION, 'tag'], { githubRef: 'refs/heads/other' });
  assert.equal(r.code, 0, r.stderr);
});

test('dispatch when origin cannot be read: exit 1 with the reason', () => {
  const { work } = makeFixture();
  git(work, ['remote', 'remove', 'origin']);
  const r = run(work, [VERSION, 'dispatch'], { githubRef: 'refs/heads/main' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^release-preflight: could not read tags from origin/);
});
