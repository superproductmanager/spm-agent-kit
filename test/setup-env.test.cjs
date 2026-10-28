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

// The seven allow rules, absolute, built from the kit folder that setup-env.sh runs from (0.2.0 adds agent-health last).
function rulesFor(kit) {
  return [
    `Bash(node ${kit}/agent-reply.cjs *)`,
    `Bash(node ${kit}/agent-ack.cjs *)`,
    `Bash(node ${kit}/agent-resolve.cjs *)`,
    `Bash(node ${kit}/agent-relay.cjs *)`,
    `Bash(node ${kit}/agent-selfcheck.cjs *)`,
    `Bash(bash ${kit}/start.sh *)`,
    `Bash(node ${kit}/agent-health.cjs *)`,
  ];
}

// A fresh sandbox: root, home (HOME), runtime (SPM_AGENT_RUNTIME_DIR), bin (fake npm), kit (copied kit folder).
// claudeMdBlock: the sandbox kit gets hook/claude-md-block.md (the main loop writes the real one; tests make a fixture).
// selfcheckFail: the stand-in selfcheck exits 1.
function sandbox({ version, npmFail = false, claudeMdBlock = false, selfcheckFail = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-env-test-'));
  const sb = {
    root,
    home: path.join(root, 'home'),
    runtime: path.join(root, 'runtime', 'rt'),
    bin: path.join(root, 'bin'),
    kit: path.join(root, 'kit'),
    npmLog: path.join(root, 'npm-calls.log'),
    selfcheckLog: path.join(root, 'selfcheck-calls.log'),
  };
  fs.mkdirSync(sb.home);
  fs.mkdirSync(sb.bin);
  fs.mkdirSync(path.join(sb.kit, 'skill', 'spm-agent'), { recursive: true });
  for (const f of ['setup-env.sh', 'cloud-agent-setup.sh']) fs.copyFileSync(path.join(ROOT, f), path.join(sb.kit, f));
  fs.mkdirSync(path.join(sb.kit, 'runtime'));
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, 'runtime', f), path.join(sb.kit, 'runtime', f));
  fs.copyFileSync(SKILL_SRC, path.join(sb.kit, 'skill', 'spm-agent', 'SKILL.md'));
  if (version !== undefined) fs.writeFileSync(path.join(sb.kit, 'VERSION'), version);
  if (claudeMdBlock) {
    fs.mkdirSync(path.join(sb.kit, 'hook'));
    fs.writeFileSync(path.join(sb.kit, 'hook', 'claude-md-block.md'), CLAUDE_MD_FIXTURE);
  }
  stubSelfcheck(sb, selfcheckFail);
  fakeNpm(sb, npmFail);
  return sb;
}

// Stand-in for agent-selfcheck.cjs: logs its arguments and exits 0 (or 1 when selfcheckFail). The real script is tested in its own file;
// setup-env must not reach the real hosts from a test.
function stubSelfcheck(sb, fail) {
  const body = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `fs.appendFileSync(path.join(__dirname, '..', 'selfcheck-calls.log'), JSON.stringify(process.argv.slice(2)) + '\\n');`,
    "process.exit(fs.existsSync(path.join(__dirname, 'stub-fail')) ? 1 : 0);",
    '',
  ].join('\n');
  fs.writeFileSync(path.join(sb.kit, 'agent-selfcheck.cjs'), body);
  if (fail) fs.writeFileSync(path.join(sb.kit, 'stub-fail'), '');
}

function cleanup(sb) {
  fs.rmSync(sb.root, { recursive: true, force: true });
}

// The SDK packages and their pins, read from the kit's runtime/package.json (not hard-coded here).
const SDK_PINS = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'package.json'), 'utf8')).dependencies;

// FAKE npm (no network): logs its call; on success writes, for `npm ci --prefix <dir>`, a package.json for each
// SDK package at the version the runtime/package.json pins, as the real npm ci would.
function fakeNpm(sb, fail) {
  const writes = Object.entries(SDK_PINS).flatMap(([name, version]) => [
    `mkdir -p "$prefix/node_modules/${name}"`,
    `printf '%s' '{"name":"${name}","version":"${version}"}' > "$prefix/node_modules/${name}/package.json"`,
  ]);
  const body = fail
    ? 'exit 1\n'
    : [
        'prefix=""',
        'while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift 2;; *) shift;; esac; done',
        ...writes,
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
// The CLAUDE.md block fixture: the two literal paths the installed copy must replace.
const CLAUDE_MD_FIXTURE = 'Kit folder: /root/spm-agent-kit\nState folder: /root/.spm-agent-state\n';
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


test('--name without --email exits 2 with one line and writes nothing (0.2.0: the two come together)', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ['--name', NAME, '--app-id', APP_ID]);
    assert.equal(r.status, 2);
    assertOneLine(r);
    assert.match(r.stderr, /--email/);
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
    'someone@example.invalid', // not agents.invalid
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

test('absent settings.json: created at 0600 with exactly the seven absolute rules, in order', () => {
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

test('settings with other keys and rules keeps them all and appends only the seven missing rules', () => {
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
    assert.deepEqual(readJson(SETTINGS(sb)).permissions.allow, [R[1], 'Bash(x)', R[4], R[0], R[2], R[3], R[5], R[6]]);
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

test('an empty or whitespace-only settings.json is treated as {} and gets the seven rules, keeping its mode', () => {
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

test('without --no-sdk the SDK step runs npm ci for the pinned SDK packages, and the output is still one line', () => {
  const sb = sandbox({ version: '0.1.0\n' });
  try {
    const r = runSetup(sb, ok());
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(sb.npmLog, 'utf8'), /^ci --prefix .* --ignore-scripts/m);
    for (const [name, version] of Object.entries(SDK_PINS)) {
      assert.equal(readJson(path.join(sb.runtime, 'node_modules', ...name.split('/'), 'package.json')).version, version);
    }
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

test('a checkout with no VERSION file (the real setup-env.sh) runs with --no-sdk, says dev, and gets all seven rules', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `spm-agent-kit dev: set up for ${NAME}\n`);
    assert.deepEqual(readJson(SETTINGS(sb)).permissions.allow, rulesFor(sb.kit));
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

// ---- 0.2.0: identity optional, session hook, setup report spool, selfcheck call ----
const SPOOL = (sb) => path.join(sb.home, '.spm-agent-state', 'setup-report.jsonl');
const RUN_ID_FILE = (sb) => path.join(sb.home, '.spm-agent-state', 'setup-run-id');
const SPOOL_RE = { id: /^[a-f0-9-]{16,64}$/, run_id: /^[a-f0-9-]{8,64}$/, step: /^[a-z0-9-]{1,32}$/, code: /^[a-z0-9_]{1,64}$/ };
function spoolLines(sb) {
  if (!fs.existsSync(SPOOL(sb))) return [];
  return fs.readFileSync(SPOOL(sb), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('a line without --name and --email installs: config has app_id and no agent, the output has no name', () => {
  const sb = sandbox({ version: '0.2.0\n' });
  try {
    const r = runSetup(sb, ['--app-id', APP_ID, '--no-sdk']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "spm-agent-kit 0.2.0: set up; the agent's name and address come from SPM at first start\n");
    assert.deepEqual(readJson(CONFIG(sb)), { app_id: APP_ID });
    assert.deepEqual(readJson(SETTINGS(sb)).permissions.allow, rulesFor(sb.kit));
  } finally { cleanup(sb); }
});

test('a second run without --name keeps the agent block already in the config', () => {
  const sb = sandbox({ version: '0.2.0\n' });
  try {
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.equal(runSetup(sb, ['--app-id', APP_ID, '--no-sdk']).status, 0);
    assert.deepEqual(readJson(CONFIG(sb)), { agent: { name: NAME, email: EMAIL }, app_id: APP_ID });
  } finally { cleanup(sb); }
});

test('--email alone exits 2 with one line and writes nothing', () => {
  const sb = sandbox();
  try {
    const r = runSetup(sb, ['--email', EMAIL, '--app-id', APP_ID]);
    assert.equal(r.status, 2);
    assertOneLine(r);
    assert.match(r.stderr, /--name/);
    assertNothingWritten(sb);
  } finally { cleanup(sb); }
});

test('each run spools one setup line per step in order, all valid against the spool contract, with one run id and kit_version', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  try {
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    const lines = spoolLines(sb);
    assert.deepEqual(lines.map((l) => [l.step, l.status]), [['config', 'pass'], ['skill', 'pass'], ['claude-md', 'pass'], ['settings', 'pass'], ['sdk', 'skip']]);
    const runId = fs.readFileSync(RUN_ID_FILE(sb), 'utf8').trim();
    for (const l of lines) {
      assert.equal(l.kind, 'setup');
      assert.equal(l.role, 'setup');
      assert.match(l.id, SPOOL_RE.id);
      assert.match(l.run_id, SPOOL_RE.run_id);
      assert.equal(l.run_id, runId);
      assert.match(l.step, SPOOL_RE.step);
      assert.equal(l.kit_version, '0.2.0');
      assert.match(l.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      assert.equal(l.code, undefined, 'no code on a pass or skip');
    }
    assert.equal(new Set(lines.map((l) => l.id)).size, 5);
    assert.equal(lines.some((l) => l.step === 'hook'), false, 'Addendum B1: no hook step');
    assert.equal(fs.statSync(path.join(sb.home, '.spm-agent-state')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(SPOOL(sb)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(RUN_ID_FILE(sb)).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(SPOOL(sb), 'utf8').includes(EMAIL), false, 'the spool holds no address');
  } finally { cleanup(sb); }
});

test('an SDK run spools sdk pass; a failing SDK spools sdk fail with code sdk_failed, and setup still exits 1', () => {
  const sb = sandbox({ version: '0.2.0\n' });
  try {
    assert.equal(runSetup(sb, ok()).status, 0);
    assert.deepEqual(spoolLines(sb).filter((l) => l.step === 'sdk').map((l) => l.status), ['pass']);
  } finally { cleanup(sb); }
  const bad = sandbox({ version: '0.2.0\n', npmFail: true });
  try {
    const r = runSetup(bad, ok());
    assert.equal(r.status, 1);
    assertOneLine(r);
    const sdk = spoolLines(bad).find((l) => l.step === 'sdk');
    assert.deepEqual([sdk.status, sdk.code], ['fail', 'sdk_failed']);
    assert.equal(fs.existsSync(path.join(bad.home, '.spm-agent-state', 'config.json')), true, 'config written before the SDK step');
    assert.deepEqual(JSON.parse('[' + fs.readFileSync(bad.selfcheckLog, 'utf8').trim().split('\n').join(',') + ']'), [['--setup', '--config', path.join(bad.home, '.spm-agent-state', 'config.json')]], 'Addendum B8: selfcheck --setup still runs after an SDK failure');
    assert.equal(r.stdout, '', 'nothing on stdout when the SDK step fails');
  } finally { cleanup(bad); }
});

test('a spool write that fails never stops setup: exit 0, config and settings written', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  try {
    fs.mkdirSync(SPOOL(sb), { recursive: true });
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `spm-agent-kit 0.2.0: set up for ${NAME}\n`);
    assert.equal(fs.existsSync(CONFIG(sb)), true);
    assert.deepEqual(readJson(SETTINGS(sb)).permissions.allow, rulesFor(sb.kit));
  } finally { cleanup(sb); }
});

test('the run id file is reused while younger than an hour, and replaced when older', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  const old = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  try {
    fs.mkdirSync(path.dirname(RUN_ID_FILE(sb)), { recursive: true });
    fs.writeFileSync(RUN_ID_FILE(sb), 'abcdef0123456789\n');
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.deepEqual([...new Set(spoolLines(sb).map((l) => l.run_id))], ['abcdef0123456789']);
    fs.mkdirSync(path.dirname(RUN_ID_FILE(old)), { recursive: true });
    fs.writeFileSync(RUN_ID_FILE(old), 'abcdef0123456789\n');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(RUN_ID_FILE(old), twoHoursAgo, twoHoursAgo);
    assert.equal(runSetup(old, ok(['--no-sdk'])).status, 0);
    const fresh = fs.readFileSync(RUN_ID_FILE(old), 'utf8').trim();
    assert.notEqual(fresh, 'abcdef0123456789');
    assert.match(fresh, SPOOL_RE.run_id);
    assert.deepEqual([...new Set(spoolLines(old).map((l) => l.run_id))], [fresh]);
  } finally { cleanup(sb); cleanup(old); }
});

test('no VERSION file: no spool lines are written (kit_version cannot be filled in); setup still exits 0', () => {
  const sb = sandbox();
  try {
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.equal(fs.existsSync(SPOOL(sb)), false);
  } finally { cleanup(sb); }
});

test('the selfcheck runs as --setup with --config after the steps; its failure never makes setup exit non-zero; stdout stays one line', () => {
  const sb = sandbox({ version: '0.2.0\n', selfcheckFail: true });
  try {
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `spm-agent-kit 0.2.0: set up for ${NAME}\n`);
    const calls = fs.readFileSync(sb.selfcheckLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls, [['--setup', '--config', CONFIG(sb)]]);
  } finally { cleanup(sb); }
});

// ---- Addendum A (28 Oct): app id optional; --report on|off; report-salt ----
const SALT = (sb) => path.join(sb.home, '.spm-agent-state', 'report-salt');

test('a line without --app-id installs: config has no app_id, and an app_id already there is kept', () => {
  const sb = sandbox({ version: '0.2.0\n' });
  try {
    const r = runSetup(sb, ['--name', NAME, '--email', EMAIL, '--no-sdk']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readJson(CONFIG(sb)), { agent: { name: NAME, email: EMAIL } });
    fs.writeFileSync(CONFIG(sb), JSON.stringify({ agent: { name: NAME, email: EMAIL }, app_id: APP_ID }));
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.equal(readJson(CONFIG(sb)).app_id, APP_ID);
    assert.equal(runSetup(sb, ['--no-sdk']).status, 0);
    assert.equal(readJson(CONFIG(sb)).app_id, APP_ID, 'a run without --app-id keeps the one in the config');
  } finally { cleanup(sb); }
});

test('--report off writes report false into the config; --report on removes it; any other value exits 2 and writes nothing', () => {
  const sb = sandbox({ version: '0.2.0\n' });
  try {
    assert.equal(runSetup(sb, ok(['--report', 'off', '--no-sdk'])).status, 0);
    assert.equal(readJson(CONFIG(sb)).report, false);
    assert.equal(runSetup(sb, ok(['--report', 'on', '--no-sdk'])).status, 0);
    assert.equal('report' in readJson(CONFIG(sb)), false, 'on writes nothing');
    assert.equal(runSetup(sb, ok(['--report', 'off', '--no-sdk'])).status, 0);
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.equal(readJson(CONFIG(sb)).report, false, 'a run without --report keeps the opt-out');
  } finally { cleanup(sb); }
  const bad = sandbox({ version: '0.2.0\n' });
  try {
    const r = runSetup(bad, ok(['--report', 'maybe', '--no-sdk']));
    assert.equal(r.status, 2);
    assertOneLine(r);
    assertNothingWritten(bad);
  } finally { cleanup(bad); }
});

test('report-salt is 32 lower-case hex, mode 0600, written once; a second run keeps the same salt', () => {
  const sb = sandbox({ version: '0.2.0\n' });
  try {
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    const salt = fs.readFileSync(SALT(sb), 'utf8').trim();
    assert.match(salt, /^[a-f0-9]{32}$/);
    assert.equal(mode(SALT(sb)), 0o600);
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.equal(fs.readFileSync(SALT(sb), 'utf8').trim(), salt);
  } finally { cleanup(sb); }
});

// ---- Addendum B1: the CLAUDE.md block (replaces the SessionStart hook) ----
const CLAUDE_MD = (sb) => path.join(sb.home, '.claude', 'CLAUDE.md');
const START_MARK = '<!-- spm-agent-kit:start -->';
const END_MARK = '<!-- spm-agent-kit:end -->';

test('CLAUDE.md block: created at 0600 when missing, between the markers, with the two literal paths replaced', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  try {
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.equal(mode(CLAUDE_MD(sb)), 0o600);
    const text = fs.readFileSync(CLAUDE_MD(sb), 'utf8');
    assert.equal(text, `${START_MARK}\nKit folder: ${sb.kit}\nState folder: ${path.join(sb.home, '.spm-agent-state')}\n${END_MARK}\n`);
    assert.equal(text.includes('/root/'), false);
    const cl = spoolLines(sb).find((l) => l.step === 'claude-md');
    assert.deepEqual([cl.status, cl.code], ['pass', undefined]);
  } finally { cleanup(sb); }
});

test('CLAUDE.md block: an existing file keeps every byte outside the markers and its mode; a re-run replaces the block only', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  try {
    fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
    const before = '# My notes\n\nKeep this line, ümlaut and all.\n';
    fs.writeFileSync(CLAUDE_MD(sb), before + `${START_MARK}\nold block\n${END_MARK}\n` + 'After the block: no newline at the end');
    fs.chmodSync(CLAUDE_MD(sb), 0o640);
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    const after = fs.readFileSync(CLAUDE_MD(sb), 'utf8');
    assert.ok(after.startsWith(before), 'the text before the block changed');
    assert.ok(after.endsWith('After the block: no newline at the end'), 'the text after the block changed');
    assert.equal(after.split(START_MARK).length, 2, 'a second block was added');
    assert.ok(after.includes(`Kit folder: ${sb.kit}`), 'the block was not written');
    assert.equal(mode(CLAUDE_MD(sb)), 0o640);
    // a second run with the same fixture: same bytes
    const once = fs.readFileSync(CLAUDE_MD(sb));
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.deepEqual(fs.readFileSync(CLAUDE_MD(sb)), once);
  } finally { cleanup(sb); }
});

test('CLAUDE.md block: when the block text changes, a re-run replaces the old block and keeps the rest', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  try {
    fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
    fs.writeFileSync(CLAUDE_MD(sb), `head\n${START_MARK}\nstale text\n${END_MARK}\ntail\n`);
    fs.writeFileSync(path.join(sb.kit, 'hook', 'claude-md-block.md'), 'fresh text /root/spm-agent-kit\n');
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.equal(fs.readFileSync(CLAUDE_MD(sb), 'utf8'), `head\n${START_MARK}\nfresh text ${sb.kit}\n${END_MARK}\ntail\n`);
  } finally { cleanup(sb); }
});

test('CLAUDE.md block: a symlinked CLAUDE.md is refused: exit 2, one line, link and target untouched, nothing written', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  try {
    fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
    const target = path.join(sb.root, 'real-claude.md');
    fs.writeFileSync(target, 'keep\n');
    fs.symlinkSync(target, CLAUDE_MD(sb));
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 2);
    assertOneLine(r);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n');
    assert.ok(fs.lstatSync(CLAUDE_MD(sb)).isSymbolicLink());
    assert.equal(fs.existsSync(CONFIG(sb)), false, 'no config when CLAUDE.md is refused');
  } finally { cleanup(sb); }
});

test('CLAUDE.md block: unbalanced markers are refused: exit 2, one line, file untouched, nothing written', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  try {
    fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
    const text = `${START_MARK}\nno end marker\n`;
    fs.writeFileSync(CLAUDE_MD(sb), text);
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 2);
    assertOneLine(r);
    assert.equal(fs.readFileSync(CLAUDE_MD(sb), 'utf8'), text);
    assert.equal(fs.existsSync(CONFIG(sb)), false);
  } finally { cleanup(sb); }
});

test('CLAUDE.md block: a missing block file spools claude-md fail with code missing_claude_md_block, setup exits 0, CLAUDE.md not created', () => {
  const sb = sandbox({ version: '0.2.0\n' });
  try {
    const r = runSetup(sb, ok(['--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(CLAUDE_MD(sb)), false);
    const cl = spoolLines(sb).find((l) => l.step === 'claude-md');
    assert.deepEqual([cl.status, cl.code], ['fail', 'missing_claude_md_block']);
    assert.deepEqual(readJson(SETTINGS(sb)).permissions.allow, rulesFor(sb.kit));
  } finally { cleanup(sb); }
});

// ---- Addendum B1 / A4: --autostart on|off ----
test('--autostart off writes autostart false into the config; on removes it; not given keeps it; another value exits 2 and writes nothing', () => {
  const sb = sandbox({ version: '0.2.0\n' });
  try {
    assert.equal(runSetup(sb, ok(['--autostart', 'off', '--no-sdk'])).status, 0);
    assert.equal(readJson(CONFIG(sb)).autostart, false);
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.equal(readJson(CONFIG(sb)).autostart, false, 'a run without --autostart keeps the override');
    assert.equal(runSetup(sb, ok(['--autostart', 'on', '--no-sdk'])).status, 0);
    assert.equal('autostart' in readJson(CONFIG(sb)), false, 'on writes nothing');
  } finally { cleanup(sb); }
  const bad = sandbox({ version: '0.2.0\n' });
  try {
    const r = runSetup(bad, ok(['--autostart', 'maybe', '--no-sdk']));
    assert.equal(r.status, 2);
    assertOneLine(r);
    assertNothingWritten(bad);
  } finally { cleanup(bad); }
});

// ---- Rework C1: --autostart off writes no CLAUDE.md block and removes the kit's block ----
test('C1 --autostart off with no CLAUDE.md creates none (block source present), spools claude-md skip autostart_off, exits 0', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  try {
    const r = runSetup(sb, ok(['--autostart', 'off', '--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(CLAUDE_MD(sb)), false, 'CLAUDE.md was created');
    const cl = spoolLines(sb).find((l) => l.step === 'claude-md');
    assert.deepEqual([cl.status, cl.code], ['skip', 'autostart_off']);
  } finally { cleanup(sb); }
});

test('C1 --autostart off removes only the kit block: other text stays byte for byte, the file keeps its mode', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  try {
    fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
    const other = '# My notes\n\nKeep this line, ümlaut and all.\n';
    fs.writeFileSync(CLAUDE_MD(sb), other + `${START_MARK}\nKit folder: ${sb.kit}\n${END_MARK}\n`);
    fs.chmodSync(CLAUDE_MD(sb), 0o640);
    const r = runSetup(sb, ok(['--autostart', 'off', '--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(CLAUDE_MD(sb), 'utf8'), other);
    assert.equal(mode(CLAUDE_MD(sb)), 0o640);
    assert.equal(readJson(CONFIG(sb)).autostart, false);
  } finally { cleanup(sb); }
});

test('C1 --autostart off on a CLAUDE.md without the kit block leaves it byte-identical, and spools skip autostart_off', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  try {
    fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
    fs.writeFileSync(CLAUDE_MD(sb), 'no block here\r\nlast line without newline');
    const before = fs.readFileSync(CLAUDE_MD(sb));
    const r = runSetup(sb, ok(['--autostart', 'off', '--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readFileSync(CLAUDE_MD(sb)), before);
    const cl = spoolLines(sb).find((l) => l.step === 'claude-md');
    assert.deepEqual([cl.status, cl.code], ['skip', 'autostart_off']);
  } finally { cleanup(sb); }
});

test('C1 --autostart off still exits 0 when the block source file is deleted, and writes no fail line', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: false });
  try {
    const r = runSetup(sb, ok(['--autostart', 'off', '--no-sdk']));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(CLAUDE_MD(sb)), false);
    const cl = spoolLines(sb).find((l) => l.step === 'claude-md');
    assert.deepEqual([cl.status, cl.code], ['skip', 'autostart_off']);
    assert.equal(spoolLines(sb).some((l) => l.status === 'fail'), false, 'a fail line was spooled');
  } finally { cleanup(sb); }
});

test('C1 --autostart off on a symlinked CLAUDE.md is refused as on is: exit 2, one line, link and target untouched', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  try {
    fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
    const target = path.join(sb.root, 'target.md');
    fs.writeFileSync(target, `${START_MARK}\nold\n${END_MARK}\n`);
    fs.symlinkSync(target, CLAUDE_MD(sb));
    const r = runSetup(sb, ok(['--autostart', 'off', '--no-sdk']));
    assert.equal(r.status, 2);
    assertOneLine(r);
    assert.ok(fs.lstatSync(CLAUDE_MD(sb)).isSymbolicLink());
    assert.equal(fs.readFileSync(target, 'utf8'), `${START_MARK}\nold\n${END_MARK}\n`);
  } finally { cleanup(sb); }
});

// ---- Rework C1 (review fix): the CLAUDE.md step follows the effective autostart value, kept from the config when no flag is given ----
test('C1 two runs: --autostart off, then no flag: the config keeps autostart false, so no block is written and the step spools skip autostart_off; a third run with --autostart on writes the block and drops the key', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  try {
    assert.equal(runSetup(sb, ok(['--autostart', 'off', '--no-sdk'])).status, 0);
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.equal(readJson(CONFIG(sb)).autostart, false, 'the config lost autostart false');
    assert.equal(fs.existsSync(CLAUDE_MD(sb)), false, 'a block was written on the run with no flag');
    const runs = spoolLines(sb).filter((l) => l.step === 'claude-md');
    const last = runs[runs.length - 1];
    assert.deepEqual([last.status, last.code], ['skip', 'autostart_off']);
    assert.equal(runSetup(sb, ok(['--autostart', 'on', '--no-sdk'])).status, 0);
    assert.equal('autostart' in readJson(CONFIG(sb)), false, 'on did not drop autostart from the config');
    const text = fs.readFileSync(CLAUDE_MD(sb), 'utf8');
    assert.ok(text.includes(START_MARK) && text.includes(END_MARK), 'the block was not written by --autostart on');
    const cl = spoolLines(sb).filter((l) => l.step === 'claude-md');
    assert.deepEqual([cl[cl.length - 1].status, cl[cl.length - 1].code], ['pass', undefined]);
  } finally { cleanup(sb); }
});

test('C1 a run with no flag and the config holding autostart true writes the block as before', () => {
  const sb = sandbox({ version: '0.2.0\n', claudeMdBlock: true });
  try {
    fs.mkdirSync(path.join(sb.home, '.spm-agent-state'), { recursive: true });
    fs.writeFileSync(CONFIG(sb), JSON.stringify({ autostart: true }) + '\n');
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.ok(fs.readFileSync(CLAUDE_MD(sb), 'utf8').includes(START_MARK));
    assert.equal(readJson(CONFIG(sb)).autostart, true);
  } finally { cleanup(sb); }
});

// ---- Rework C4: the kit never sets the permission mode ----
test('C4 setup leaves an existing permissions.defaultMode unchanged, and adds no defaultMode when there was none', () => {
  const withMode = sandbox({ version: '0.2.0\n' });
  try {
    fs.mkdirSync(CLAUDE_DIR(withMode), { recursive: true });
    fs.writeFileSync(SETTINGS(withMode), JSON.stringify({ permissions: { defaultMode: 'acceptEdits', allow: [] } }, null, 2) + '\n');
    assert.equal(runSetup(withMode, ok(['--no-sdk'])).status, 0);
    assert.equal(readJson(SETTINGS(withMode)).permissions.defaultMode, 'acceptEdits');
    assert.deepEqual(readJson(SETTINGS(withMode)).permissions.allow, rulesFor(withMode.kit));
  } finally { cleanup(withMode); }
  const noMode = sandbox({ version: '0.2.0\n' });
  try {
    fs.mkdirSync(CLAUDE_DIR(noMode), { recursive: true });
    fs.writeFileSync(SETTINGS(noMode), JSON.stringify({ permissions: { allow: [] } }, null, 2) + '\n');
    assert.equal(runSetup(noMode, ok(['--no-sdk'])).status, 0);
    assert.equal('defaultMode' in readJson(SETTINGS(noMode)).permissions, false, 'defaultMode was added');
    assert.equal(/defaultMode/.test(fs.readFileSync(SETTINGS(noMode), 'utf8')), false);
  } finally { cleanup(noMode); }
});

// ---- Addendum item 5: the six old rules gain only the seventh ----
test('settings with the six old allow rules gains only the agent-health rule, in place order, nothing else changed', () => {
  const sb = sandbox({ version: '0.2.0\n' });
  try {
    const six = rulesFor(sb.kit).slice(0, 6);
    fs.mkdirSync(CLAUDE_DIR(sb), { recursive: true });
    fs.writeFileSync(SETTINGS(sb), JSON.stringify({ model: 'x', permissions: { allow: six, deny: ['Bash(rm -rf *)'] } }, null, 2) + '\n');
    assert.equal(runSetup(sb, ok(['--no-sdk'])).status, 0);
    assert.deepEqual(readJson(SETTINGS(sb)), { model: 'x', permissions: { allow: rulesFor(sb.kit), deny: ['Bash(rm -rf *)'] } });
  } finally { cleanup(sb); }
});

// ---- Addendum B8: the final line when no name is given ----
test('no --name: the final line says the name and address come from SPM at first start', () => {
  const sb = sandbox({ version: '0.2.0\n' });
  try {
    const r = runSetup(sb, ['--app-id', APP_ID, '--no-sdk']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "spm-agent-kit 0.2.0: set up; the agent's name and address come from SPM at first start\n");
  } finally { cleanup(sb); }
});
