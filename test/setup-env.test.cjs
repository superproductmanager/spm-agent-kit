'use strict';
// Tests for setup-env.sh, the one-line setup. Real bash and node, a temp HOME for every test, and a
// fake npm on PATH for the SDK step (no network). Each test runs a copy of the kit folder (setup-env.sh,
// cloud-agent-setup.sh, the skill file), so the script finds its files the way it does in a release archive.
// Every sandbox lives in os.tmpdir(), which is never inside a git work tree.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const NAME = 'Example agent';
const EMAIL = 'spm-example-agent@agents.invalid';
const APP_ID = 'example-app-id-0000000000000000';
const PIN = '12.4.0';

// The six allow rules, absolute, built from the kit folder that setup-env.sh runs from.
function rulesFor(kit) {
  return [
    `Bash(node ${kit}/agent-reply.cjs *)`,
    `Bash(node ${kit}/agent-ack.cjs *)`,
    `Bash(node ${kit}/agent-resolve.cjs *)`,
    `Bash(node ${kit}/agent-relay.cjs *)`,
    `Bash(node ${kit}/agent-selfcheck.cjs *)`,
    `Bash(bash ${kit}/start.sh *)`,
  ];
}

// A fresh sandbox: root, home (HOME), runtime (SPM_AGENT_RUNTIME_DIR), bin (fake npm), kit (copied kit folder).
function sandbox({ version, npmFail = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-env-test-'));
  const sb = {
    root,
    home: path.join(root, 'home'),
    runtime: path.join(root, 'runtime', 'rt'),
    bin: path.join(root, 'bin'),
    kit: path.join(root, 'kit'),
    npmLog: path.join(root, 'npm-calls.log'),
  };
  fs.mkdirSync(sb.home);
  fs.mkdirSync(sb.bin);
  fs.mkdirSync(path.join(sb.kit, 'skill', 'spm-agent'), { recursive: true });
  for (const f of ['setup-env.sh', 'cloud-agent-setup.sh']) fs.copyFileSync(path.join(ROOT, f), path.join(sb.kit, f));
  fs.copyFileSync(SKILL_SRC, path.join(sb.kit, 'skill', 'spm-agent', 'SKILL.md'));
  if (version !== undefined) fs.writeFileSync(path.join(sb.kit, 'VERSION'), version);
  fakeNpm(sb, npmFail);
  return sb;
}

function cleanup(sb) {
  fs.rmSync(sb.root, { recursive: true, force: true });
}

// Fake npm: logs its call; on success writes the package.json the real install would write, at version 12.4.0.
function fakeNpm(sb, fail) {
  const body = fail
    ? 'exit 1\n'
    : [
        'prefix=""',
        'while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift 2;; *) shift;; esac; done',
        'mkdir -p "$prefix/node_modules/firebase"',
        `printf '%s' '{"name":"firebase","version":"${PIN}"}' > "$prefix/node_modules/firebase/package.json"`,
        '',
      ].join('\n');
  fs.writeFileSync(path.join(sb.bin, 'npm'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${sb.npmLog}'\n${body}`, { mode: 0o755 });
}

function runSetup(sb, args, env = {}) {
  return spawnSync('bash', [path.join(sb.kit, 'setup-env.sh'), ...args], {
    encoding: 'utf8',
    env: { PATH: `${sb.bin}:${process.env.PATH}`, HOME: sb.home, SPM_AGENT_RUNTIME_DIR: sb.runtime, ...env },
  });
}

const ok = (extra = []) => ['--name', NAME, '--email', EMAIL, '--app-id', APP_ID, ...extra];
const CONFIG = (sb) => path.join(sb.home, '.spm-agent-state', 'config.json');
const CLAUDE_DIR = (sb) => path.join(sb.home, '.claude');
const SETTINGS = (sb) => path.join(sb.home, '.claude', 'settings.json');
const SKILL_DEST = (sb) => path.join(sb.home, '.claude', 'skills', 'spm-agent', 'SKILL.md');
const SKILL_SRC = path.join(ROOT, 'skill', 'spm-agent', 'SKILL.md');
const mode = (p) => fs.statSync(p).mode & 0o777;
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function assertOneLine(r) {
  assert.equal(r.stdout, '', 'stdout must be empty on a refusal');
  const lines = r.stderr.replace(/\n$/, '').split('\n');
  assert.equal(lines.length, 1, 'expected one line on stderr, got: ' + JSON.stringify(r.stderr));
}

function assertNothingWritten(sb) {
  assert.equal(fs.existsSync(path.join(sb.home, '.spm-agent-state')), false, 'no state folder');
  assert.equal(fs.existsSync(CLAUDE_DIR(sb)), false, 'no Claude folder');
  assert.equal(fs.existsSync(sb.runtime), false, 'no runtime folder');
}

// ---- arguments: refused with exit 2, one line, nothing written ----

test('--help prints usage, exits 0, and writes nothing', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--name/);
    assert.match(r.stdout, /--email/);
    assert.match(r.stdout, /--app-id/);
    assertNothingWritten(sb);
  } finally { cleanup(sb); }
});

test('missing --name exits 2 with one line and writes nothing', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ['--email', EMAIL, '--app-id', APP_ID]);
    assert.equal(r.status, 2);
    assertOneLine(r);
    assert.match(r.stderr, /--name/);
    assertNothingWritten(sb);
  } finally { cleanup(sb); }
});

test('missing --email exits 2 with one line and writes nothing', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ['--name', NAME, '--app-id', APP_ID]);
    assert.equal(r.status, 2);
    assertOneLine(r);
    assert.match(r.stderr, /--email/);
    assertNothingWritten(sb);
  } finally { cleanup(sb); }
});

test('missing --app-id exits 2 with one line and writes nothing', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ['--name', NAME, '--email', EMAIL]);
    assert.equal(r.status, 2);
    assertOneLine(r);
    assert.match(r.stderr, /--app-id/);
    assertNothingWritten(sb);
  } finally { cleanup(sb); }
});

test('an app id outside ^[A-Za-z0-9_-]{20,60}$ exits 2 and writes nothing', () => {
  const bad = ['short-id', 'has space in it 000000000000000', 'a'.repeat(61), 'example/app/id/0000000000000000', 'example.app.id.000000000000000'];
  for (const id of bad) {
    const sb = sandbox();
    try {
      const r = runSetup(sb, ['--name', NAME, '--email', EMAIL, '--app-id', id]);
      assert.equal(r.status, 2, `app id ${id} should be refused`);
      assertOneLine(r);
      assertNothingWritten(sb);
    } finally { cleanup(sb); }
  }
});

test('a flag with no value (--name followed by another flag) exits 2 and writes nothing', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ['--name', '--email', EMAIL, '--app-id', APP_ID]);
    assert.equal(r.status, 2);
    assertOneLine(r);
    assertNothingWritten(sb);
  } finally { cleanup(sb); }
});

test('a blank name exits 2 and writes nothing', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ['--name', '   ', '--email', EMAIL, '--app-id', APP_ID]);
    assert.equal(r.status, 2);
    assertOneLine(r);
    assertNothingWritten(sb);
  } finally { cleanup(sb); }
});

test('a name outside ^[A-Za-z0-9 ._()-]{1,60}$ exits 2 and writes nothing', () => {
  const bad = ['Example "quoted" agent', 'Example agent!', 'Example\\agent', 'a'.repeat(61), 'Ex\u00e9mple'];
  for (const name of bad) {
    const sb = sandbox();
    try {
      const r = runSetup(sb, ['--name', name, '--email', EMAIL, '--app-id', APP_ID]);
      assert.equal(r.status, 2, `name ${JSON.stringify(name)} should be refused`);
      assertOneLine(r);
      assertNothingWritten(sb);
    } finally { cleanup(sb); }
  }
});

test('emails that break the lib/config.cjs rule exit 2 with one line and write nothing', () => {
  const bad = [
    'Spm-Example@agents.invalid', // upper case
    'someone@example.com', // not .invalid
    'spm-example@agents.invalid extra', // suffix after the domain
    'spm example@agents.invalid', // space
    '@agents.invalid', // no local part
  ];
  for (const email of bad) {
    const sb = sandbox();
    try {
      const r = runSetup(sb, ['--name', NAME, '--email', email, '--app-id', APP_ID]);
      assert.equal(r.status, 2, `email ${email} should be refused`);
      assertOneLine(r);
      assertNothingWritten(sb);
    } finally { cleanup(sb); }
  }
});

test('an unknown argument exits 2 with one line and writes nothing', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ok(['--bogus']));
    assert.equal(r.status, 2);
    assertOneLine(r);
    assert.match(r.stderr, /--bogus/);
    assertNothingWritten(sb);
  } finally { cleanup(sb); }
});

test('a transport other than node or webchannel exits 2 and writes nothing', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ok(['--transport', 'carrier-pigeon']));
    assert.equal(r.status, 2);
    assertOneLine(r);
    assertNothingWritten(sb);
  } finally { cleanup(sb); }
});

test('--transport with no value exits 2 and writes nothing', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ok(['--transport']));
    assert.equal(r.status, 2);
    assertOneLine(r);
    assertNothingWritten(sb);
  } finally { cleanup(sb); }
});

test('an empty --ignore-agent exits 2 and writes nothing', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ok(['--ignore-agent', ' ']));
    assert.equal(r.status, 2);
    assertOneLine(r);
    assertNothingWritten(sb);
  } finally { cleanup(sb); }
});

// ---- config file ----

test('config is written with the agent block and app_id, folder 0700 and file 0600', () => {
  const sb = sandbox({ version: '0.1.0\n' });
  try {
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readJson(CONFIG(sb)), { agent: { name: NAME, email: EMAIL }, app_id: APP_ID });
    assert.equal(mode(path.dirname(CONFIG(sb))), 0o700);
    assert.equal(mode(CONFIG(sb)), 0o600);
  } finally { cleanup(sb); }
});

test('an existing config with looser permissions is rewritten at 0700 and 0600', () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(path.dirname(CONFIG(sb)), { mode: 0o755 });
    fs.chmodSync(path.dirname(CONFIG(sb)), 0o755);
    fs.writeFileSync(CONFIG(sb), '{"agent":{"name":"Old","email":"old@agents.invalid"}}', { mode: 0o644 });
    fs.chmodSync(CONFIG(sb), 0o644);
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readJson(CONFIG(sb)), { agent: { name: NAME, email: EMAIL }, app_id: APP_ID });
    assert.equal(mode(path.dirname(CONFIG(sb))), 0o700);
    assert.equal(mode(CONFIG(sb)), 0o600);
  } finally { cleanup(sb); }
});

test('ignore_agents and transport are written when given, and only then', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ok(['--no-sdk', '--ignore-agent', 'Other agent', '--ignore-agent', 'Third agent', '--transport', 'webchannel']));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readJson(CONFIG(sb)), {
      agent: { name: NAME, email: EMAIL },
      app_id: APP_ID,
      ignore_agents: ['Other agent', 'Third agent'],
      transport: 'webchannel',
    });
  } finally { cleanup(sb); }
});

test('transport node is accepted and written; without --ignore-agent there is no ignore_agents key', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ok(['--no-sdk', '--transport', 'node']));
    assert.equal(r.status, 0, r.stderr);
    const c = readJson(CONFIG(sb));
    assert.equal(c.transport, 'node');
    assert.equal('ignore_agents' in c, false);
  } finally { cleanup(sb); }
});

test('a name with allowed punctuation is stored as the same text (JSON is built by node)', () => {
  const sb = sandbox();
  try {
    const name = 'Example agent (v2).';
    const r = runSetup(sb, ['--name', name, '--email', EMAIL, '--app-id', APP_ID, '--no-sdk']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readJson(CONFIG(sb)).agent.name, name);
    assert.equal(r.stdout, `spm-agent-kit dev: set up for ${name}\n`);
  } finally { cleanup(sb); }
});

// ---- skill ----

// The expected skill text: the two literal paths replaced, nothing else changed.
function expectedSkill(sb) {
  return fs.readFileSync(SKILL_SRC, 'utf8')
    .split('/root/spm-agent-kit').join(sb.kit)
    .split('/root/.spm-agent-state').join(path.join(sb.home, '.spm-agent-state'));
}

test('the skill is copied with the two literal paths replaced (kit folder and the real state folder)', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    const text = fs.readFileSync(SKILL_DEST(sb), 'utf8');
    assert.equal(text, expectedSkill(sb));
    // the file tool does not expand variables, so the skill must name the real folder
    assert.equal(text.includes('$HOME'), false, 'the skill must not contain a literal $HOME');
    assert.ok(text.includes(path.join(sb.home, '.spm-agent-state', 'config.json')), 'the skill names the real config path');
  } finally { cleanup(sb); }
});

test('the written skill has no /root/ left, and every node or bash kit command matches one allow rule', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    const text = fs.readFileSync(SKILL_DEST(sb), 'utf8');
    assert.equal(text.includes('/root/'), false, 'a /root/ path is left in the skill');
    const rules = readJson(SETTINGS(sb)).permissions.allow;
    const re = new RegExp(`(node|bash) (${sb.kit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[A-Za-z0-9_.-]+)`, 'g');
    const found = [...text.matchAll(re)].map((m) => `${m[1]} ${m[2]}`);
    assert.ok(found.length >= 3, 'the skill should name kit commands');
    for (const prefix of found) {
      assert.ok(rules.includes(`Bash(${prefix} *)`), `no allow rule for: ${prefix}`);
    }
  } finally { cleanup(sb); }
});

test('an existing skill file is replaced on every run', () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(path.dirname(SKILL_DEST(sb)), { recursive: true });
    fs.writeFileSync(SKILL_DEST(sb), 'stale skill text\n');
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(SKILL_DEST(sb), 'utf8'), expectedSkill(sb));
  } finally { cleanup(sb); }
});

// ---- settings.json merge ----

test('absent settings.json: created at 0600 with exactly the six absolute rules, in order', () => {
  const sb = sandbox();
  try {
    assert.equal(fs.existsSync(CLAUDE_DIR(sb)), false);
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readJson(SETTINGS(sb)), { permissions: { allow: rulesFor(sb.kit) } });
    assert.equal(mode(SETTINGS(sb)), 0o600);
  } finally { cleanup(sb); }
});

test('a missing ~/.claude folder is created at 0700', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(mode(CLAUDE_DIR(sb)), 0o700);
  } finally { cleanup(sb); }
});

test('settings with other keys and rules keeps them all and appends only the six missing rules', () => {
  const sb = sandbox();
  try {
    const before = {
      model: 'claude-example',
      env: { EXAMPLE_FLAG: '1' },
      permissions: { allow: ['Bash(git status *)'], deny: ['Bash(rm -rf *)'] },
      hooks: { Stop: [] },
    };
    fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
    fs.writeFileSync(SETTINGS(sb), JSON.stringify(before, null, 2) + '\n');
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readJson(SETTINGS(sb)), {
      model: 'claude-example',
      env: { EXAMPLE_FLAG: '1' },
      permissions: { allow: ['Bash(git status *)', ...rulesFor(sb.kit)], deny: ['Bash(rm -rf *)'] },
      hooks: { Stop: [] },
    });
  } finally { cleanup(sb); }
});

test('rules already present are not duplicated; the missing ones are appended in the listed order', () => {
  const sb = sandbox();
  try {
    const R = rulesFor(sb.kit);
    fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
    fs.writeFileSync(SETTINGS(sb), JSON.stringify({ permissions: { allow: [R[1], 'Bash(x)', R[4]] } }));
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readJson(SETTINGS(sb)).permissions.allow, [R[1], 'Bash(x)', R[4], R[0], R[2], R[3], R[5]]);
  } finally { cleanup(sb); }
});

test('a second run leaves settings.json untouched: same bytes and same file (not rewritten)', () => {
  const sb = sandbox();
  try {
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    const bytes = fs.readFileSync(SETTINGS(sb));
    const ino = fs.statSync(SETTINGS(sb)).ino;
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.ok(fs.readFileSync(SETTINGS(sb)).equals(bytes), 'settings bytes changed on the second run');
    assert.equal(fs.statSync(SETTINGS(sb)).ino, ino, 'settings file was replaced although nothing was missing');
  } finally { cleanup(sb); }
});

test('an existing settings.json keeps its file mode when it is rewritten', () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
    fs.writeFileSync(SETTINGS(sb), '{"model":"x"}\n', { mode: 0o644 });
    fs.chmodSync(SETTINGS(sb), 0o644);
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.equal(mode(SETTINGS(sb)), 0o644);
  } finally { cleanup(sb); }
});

test('an empty or whitespace-only settings.json is treated as {} and gets the six rules, keeping its mode', () => {
  for (const text of ['', '   \n\t ']) {
    const sb = sandbox();
    try {
      fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
      fs.writeFileSync(SETTINGS(sb), text);
      fs.chmodSync(SETTINGS(sb), 0o640);
      const r = runSetup(sb, ok(['--no-sdk']));
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(readJson(SETTINGS(sb)), { permissions: { allow: rulesFor(sb.kit) } });
      assert.equal(mode(SETTINGS(sb)), 0o640);
    } finally { cleanup(sb); }
  }
});

test('a leading UTF-8 BOM is stripped before the parse, and the other keys survive', () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
    fs.writeFileSync(SETTINGS(sb), '\uFEFF{"model":"x"}');
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    const raw = fs.readFileSync(SETTINGS(sb));
    assert.notDeepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.deepEqual(readJson(SETTINGS(sb)), { model: 'x', permissions: { allow: rulesFor(sb.kit) } });
  } finally { cleanup(sb); }
});

test('a symlinked settings.json is refused: exit 2, one line, link and target untouched, nothing written', () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
    const target = path.join(sb.root, 'real-settings.json');
    fs.writeFileSync(target, '{"keep":true}\n');
    fs.symlinkSync(target, SETTINGS(sb));
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 2);
    assertOneLine(r);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"keep":true}\n');
    assert.ok(fs.lstatSync(SETTINGS(sb)).isSymbolicLink(), 'the link must still be a link');
    assert.equal(fs.existsSync(CONFIG(sb)), false, 'no config when settings are refused');
  } finally { cleanup(sb); }
});

test('no temporary settings file is left in ~/.claude after a run', () => {
  const sb = sandbox();
  try {
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.deepEqual(fs.readdirSync(CLAUDE_DIR(sb)).filter((n) => n.startsWith('.settings.json.')), []);
  } finally { cleanup(sb); }
});

test('invalid JSON in settings.json is refused: exit 2, one line, file untouched, nothing else written', () => {
  const sb = sandbox();
  try {
    const broken = '{"permissions": ';
    fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
    fs.writeFileSync(SETTINGS(sb), broken);
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 2);
    assertOneLine(r);
    assert.equal(fs.readFileSync(SETTINGS(sb), 'utf8'), broken);
    assert.equal(fs.existsSync(CONFIG(sb)), false, 'no config when settings are refused');
    assert.equal(fs.existsSync(SKILL_DEST(sb)), false, 'no skill when settings are refused');
  } finally { cleanup(sb); }
});

test('settings.json that is valid JSON but not a usable object is refused: exit 2 and untouched', () => {
  const shapes = ['[]', '"text"', 'null', '{"permissions": []}', '{"permissions": "Bash(x)"}', '{"permissions": {"allow": "Bash(x)"}}'];
  for (const text of shapes) {
    const sb = sandbox();
    try {
      fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
      fs.writeFileSync(SETTINGS(sb), text);
      const r = runSetup(sb, ok(['--no-sdk']));
      assert.equal(r.status, 2, `shape ${text} should be refused`);
      assertOneLine(r);
      assert.equal(fs.readFileSync(SETTINGS(sb), 'utf8'), text);
    } finally { cleanup(sb); }
  }
});

// ---- the Firebase SDK step ----

test('--no-sdk never runs npm or cloud-agent-setup', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(sb.npmLog), false, 'npm must not run');
    assert.equal(fs.existsSync(sb.runtime), false, 'no runtime folder');
  } finally { cleanup(sb); }
});

test('without --no-sdk the SDK step installs firebase 12.4.0, and the output is still one line', () => {
  const sb = sandbox({ version: '0.1.0\n' });
  try {
    const r = runSetup(sb, ok());
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(sb.npmLog, 'utf8'), /firebase@12\.4\.0/);
    assert.equal(readJson(path.join(sb.runtime, 'node_modules', 'firebase', 'package.json')).version, PIN);
    assert.equal(r.stdout, `spm-agent-kit 0.1.0: set up for ${NAME}\n`);
  } finally { cleanup(sb); }
});

test('a failing SDK step makes setup-env exit 1 with one line on stderr and no success line', () => {
  const sb = sandbox({ npmFail: true });
  try {
    const r = runSetup(sb, ok());
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr.replace(/\n$/, '').split('\n').length, 1, JSON.stringify(r.stderr));
  } finally { cleanup(sb); }
});

// ---- the one success line and the end-to-end rerun ----

test('a kit with no VERSION file reports version dev', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `spm-agent-kit dev: set up for ${NAME}\n`);
  } finally { cleanup(sb); }
});

test('the real kit folder (no VERSION file) runs with --no-sdk and says dev', () => {
  const sb = sandbox();
  try {
    const r = spawnSync('bash', [path.join(ROOT, 'setup-env.sh'), ...ok(['--no-sdk'])], {
      encoding: 'utf8',
      env: { PATH: `${sb.bin}:${process.env.PATH}`, HOME: sb.home, SPM_AGENT_RUNTIME_DIR: sb.runtime },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `spm-agent-kit dev: set up for ${NAME}\n`);
    assert.deepEqual(readJson(SETTINGS(sb)).permissions.allow, rulesFor(ROOT));
  } finally { cleanup(sb); }
});

test('a second full run changes nothing: same output, same config, skill and settings bytes', () => {
  const sb = sandbox({ version: '0.1.0\n' });
  try {
    const snap = () => ({
      config: fs.readFileSync(CONFIG(sb)).toString('base64'),
      skill: fs.readFileSync(SKILL_DEST(sb)).toString('base64'),
      settings: fs.readFileSync(SETTINGS(sb)).toString('base64'),
      settingsIno: fs.statSync(SETTINGS(sb)).ino,
    });
    const first = runSetup(sb, ok(['--transport', 'node']));
    assert.equal(first.status, 0, first.stderr);
    const before = snap();
    const second = runSetup(sb, ok(['--transport', 'node']));
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
    assert.deepEqual(snap(), before);
  } finally { cleanup(sb); }
});
