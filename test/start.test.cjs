'use strict';
// start.sh (K-A3 item 3): selfcheck first, then the keepalive wrapper around the listener, in the foreground.
// Real bash, real files, real child processes. The selfcheck and listener commands are replaced through
// SPM_AGENT_START_SELFCHECK_CMD and SPM_AGENT_START_LISTENER_CMD (test-only overrides); KEEPALIVE_MAX_RUNS=1 ends the wrapper.
// Run: node --test test/start.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const KIT = path.join(__dirname, '..');
const START = path.join(KIT, 'start.sh');

function workdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `start-test-${label}-`));
}

// Addendum B2: the identify step is replaced in every test that is not about it (no real SPM call from tests).
function runStart(args, env = {}, script = START) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: { PATH: process.env.PATH, HOME: workdir('home'), SPM_AGENT_START_HEALTH_CMD: 'exit 0', ...env },
  });
}

const CONFIG = '/abs/example/agent.config.json'; // synthetic; the selfcheck override does not read it

test('start.sh: a relative --config is refused with exit 2 and nothing runs', () => {
  const dir = workdir('rel');
  const marker = path.join(dir, 'marker');
  const r = runStart(['--config', 'relative.json', '--state-dir', path.join(dir, 'state')], {
    SPM_AGENT_START_SELFCHECK_CMD: 'exit 0',
    SPM_AGENT_START_LISTENER_CMD: `echo started >> ${marker}`,
    KEEPALIVE_MAX_RUNS: '1',
  });
  assert.equal(r.status, 2, `status ${r.status}, stderr ${r.stderr}`);
  assert.ok(!fs.existsSync(marker), 'the listener started');
});

test('start.sh: a failing selfcheck prints its FAIL line, exits 1, and starts nothing', () => {
  const dir = workdir('fail');
  const marker = path.join(dir, 'marker');
  const r = runStart(['--config', CONFIG, '--state-dir', path.join(dir, 'state')], {
    SPM_AGENT_START_SELFCHECK_CMD: `echo 'FAIL spm-key: the check failed. Fix: fix it.'; exit 1`,
    SPM_AGENT_START_LISTENER_CMD: `echo started >> ${marker}`,
    KEEPALIVE_MAX_RUNS: '1',
  });
  assert.equal(r.status, 1, `status ${r.status}, stderr ${r.stderr}`);
  assert.equal(r.stdout, 'FAIL spm-key: the check failed. Fix: fix it.\n');
  assert.ok(!fs.existsSync(marker), 'the listener started after a failed check');
});

test('start.sh: a passing selfcheck prints ONE start line, runs the wrapper, and the listener runs', () => {
  const dir = workdir('ok');
  const marker = path.join(dir, 'marker');
  const state = path.join(dir, 'state');
  const r = runStart(['--config', CONFIG, '--state-dir', state], {
    SPM_AGENT_START_SELFCHECK_CMD: `echo 'ok spm-key'; exit 0`,
    SPM_AGENT_START_LISTENER_CMD: `echo started >> ${marker}`,
    KEEPALIVE_MAX_RUNS: '1',
  });
  assert.equal(r.status, 0, `status ${r.status}, stderr ${r.stderr}`);
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1, `stdout had ${lines.length} lines: ${JSON.stringify(r.stdout)}`);
  assert.deepEqual(JSON.parse(lines[0]), { kind: 'start', log: path.join(state, 'listener.log'), version: 'dev' });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'started\n');
  assert.ok(fs.statSync(state).isDirectory());
  assert.equal(fs.statSync(state).mode & 0o777, 0o700, 'the state dir is not 700');
});

test('start.sh: the version in the start line is the VERSION file next to the script', () => {
  const dir = workdir('version');
  const kit = path.join(dir, 'kit');
  fs.mkdirSync(kit);
  fs.copyFileSync(START, path.join(kit, 'start.sh'));
  fs.copyFileSync(path.join(KIT, 'agent-keepalive.sh'), path.join(kit, 'agent-keepalive.sh'));
  fs.writeFileSync(path.join(kit, 'VERSION'), '0.1.0\n');
  const state = path.join(dir, 'state');
  const r = runStart(['--config', CONFIG, '--state-dir', state], {
    SPM_AGENT_START_SELFCHECK_CMD: 'exit 0',
    SPM_AGENT_START_LISTENER_CMD: 'true',
    KEEPALIVE_MAX_RUNS: '1',
  }, path.join(kit, 'start.sh'));
  assert.equal(r.status, 0, `status ${r.status}, stderr ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout.trim()).version, '0.1.0');
});

test('start.sh: a state dir inside a git work tree is refused with exit 2, and nothing starts', () => {
  const dir = workdir('gittree');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  const marker = path.join(dir, 'marker');
  const r = runStart(['--config', CONFIG, '--state-dir', path.join(repo, 'state')], {
    SPM_AGENT_START_SELFCHECK_CMD: 'exit 0',
    SPM_AGENT_START_LISTENER_CMD: `echo started >> ${marker}`,
    KEEPALIVE_MAX_RUNS: '1',
  });
  assert.equal(r.status, 2, `status ${r.status}, stderr ${r.stderr}`);
  assert.ok(/git/.test(r.stderr), `stderr ${JSON.stringify(r.stderr)}`);
  assert.ok(!fs.existsSync(marker), 'the listener started inside a git tree');
});

test('start.sh: the default state dir comes from SPM_AGENT_STATE_DIR when no --state-dir is given', () => {
  const dir = workdir('envdir');
  const state = path.join(dir, 'from-env');
  const r = runStart(['--config', CONFIG], {
    SPM_AGENT_START_SELFCHECK_CMD: 'exit 0',
    SPM_AGENT_START_LISTENER_CMD: 'true',
    SPM_AGENT_STATE_DIR: state,
    KEEPALIVE_MAX_RUNS: '1',
  });
  assert.equal(r.status, 0, `status ${r.status}, stderr ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout.trim()).log, path.join(state, 'listener.log'));
  assert.ok(fs.existsSync(path.join(state, 'listener.log')));
});

test('start.sh: the listener command sees NODE_USE_ENV_PROXY=1 (set before the listener starts)', () => {
  const dir = workdir('envproxy');
  const seen = path.join(dir, 'seen');
  const r = runStart(['--config', CONFIG, '--state-dir', path.join(dir, 'state')], {
    SPM_AGENT_START_SELFCHECK_CMD: `echo 'ok spm-key'; exit 0`,
    SPM_AGENT_START_LISTENER_CMD: `printf '%s' "$NODE_USE_ENV_PROXY" > ${seen}`,
    KEEPALIVE_MAX_RUNS: '1',
  });
  assert.equal(r.status, 0, `status ${r.status}, stderr ${r.stderr}`);
  assert.equal(fs.readFileSync(seen, 'utf8'), '1');
});

// Node 22.21 or newer: the proxy agent is ignored by older Node, so start.sh refuses before the selfcheck.
function fakeNodeDir(label, version) {
  const bin = path.join(workdir(label), 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nexit 0\n`, { mode: 0o755 });
  return bin;
}

for (const version of ['v20.20.2', 'v22.20.9']) {
  test(`start.sh: Node ${version} is refused with exit 2, one line, and nothing starts`, () => {
    const dir = workdir('oldnode');
    const marker = path.join(dir, 'marker');
    const r = runStart(['--config', CONFIG, '--state-dir', path.join(dir, 'state')], {
      PATH: `${fakeNodeDir('oldnode-bin', version)}:${process.env.PATH}`,
      SPM_AGENT_START_SELFCHECK_CMD: `echo selfcheck >> ${marker}; exit 0`,
      SPM_AGENT_START_LISTENER_CMD: `echo started >> ${marker}`,
      KEEPALIVE_MAX_RUNS: '1',
    });
    assert.equal(r.status, 2, `status ${r.status}, stderr ${r.stderr}`);
    assert.equal(r.stderr.trim(), `start.sh: Node 22.21 or newer is needed (found ${version})`);
    assert.equal(r.stdout, '');
    assert.ok(!fs.existsSync(marker), 'the selfcheck or the listener ran on an old Node');
  });
}

test('start.sh: Node 22.21.0 passes the version check and the selfcheck runs', () => {
  const dir = workdir('newnode');
  const marker = path.join(dir, 'marker');
  const r = runStart(['--config', CONFIG, '--state-dir', path.join(dir, 'state')], {
    PATH: `${fakeNodeDir('newnode-bin', 'v22.21.0')}:${process.env.PATH}`,
    SPM_AGENT_START_SELFCHECK_CMD: `echo selfcheck >> ${marker}; exit 0`,
    SPM_AGENT_START_LISTENER_CMD: `echo started >> ${marker}`,
    KEEPALIVE_MAX_RUNS: '1',
  });
  assert.equal(r.status, 0, `status ${r.status}, stderr ${r.stderr}`);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'selfcheck\nstarted\n');
});

// ---- Addendum B2: start.sh first runs node <kit>/agent-health.cjs start --role listener --config <cfg>; exit 7 stops before the selfcheck ----
// A sandbox copy of the kit with a stub agent-health.cjs (records its arguments; exit 7 when stub-exit7 exists) and a stub selfcheck.
function healthSandbox() {
  const dir = workdir('health');
  const kit = path.join(dir, 'kit');
  fs.mkdirSync(kit);
  fs.copyFileSync(START, path.join(kit, 'start.sh'));
  fs.copyFileSync(path.join(KIT, 'agent-keepalive.sh'), path.join(kit, 'agent-keepalive.sh'));
  fs.writeFileSync(path.join(kit, 'agent-health.cjs'), [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.appendFileSync(path.join(__dirname, 'health-calls.log'), JSON.stringify(process.argv.slice(2)) + '\\n');",
    "if (fs.existsSync(path.join(__dirname, 'stub-exit7'))) { console.log('could not reach SPM, run again'); process.exit(7); }",
    'process.exit(0);',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(kit, 'agent-selfcheck.cjs'), "'use strict';\nrequire('node:fs').writeFileSync(require('node:path').join(__dirname, 'selfcheck-ran'), 'yes');\nprocess.exit(0);\n");
  return { dir, kit };
}

function runSandboxStart(kit, dir, extra = {}) {
  return spawnSync('bash', [path.join(kit, 'start.sh'), '--config', CONFIG, '--state-dir', path.join(dir, 'state')], {
    encoding: 'utf8',
    timeout: 60000,
    env: { PATH: process.env.PATH, HOME: workdir('home'), SPM_AGENT_START_LISTENER_CMD: 'exit 0', KEEPALIVE_MAX_RUNS: '1', ...extra },
  });
}

test('start.sh (B2): the identify step runs first with --role listener and --config; exit 0 lets the selfcheck run', () => {
  const { dir, kit } = healthSandbox();
  const r = runSandboxStart(kit, dir);
  assert.equal(r.status, 0, `status ${r.status}, stderr ${r.stderr}`);
  assert.deepEqual(fs.readFileSync(path.join(kit, 'health-calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)), [['start', '--role', 'listener', '--config', CONFIG]]);
  assert.equal(fs.readFileSync(path.join(kit, 'selfcheck-ran'), 'utf8'), 'yes');
});

test('start.sh (B2): identify exit 7 prints its line, exits 1, and the selfcheck and the listener never run', () => {
  const { dir, kit } = healthSandbox();
  fs.writeFileSync(path.join(kit, 'stub-exit7'), '');
  const marker = path.join(dir, 'listener-ran');
  const r = runSandboxStart(kit, dir, { SPM_AGENT_START_LISTENER_CMD: `echo started >> ${marker}` });
  assert.equal(r.status, 1, `status ${r.status}, stderr ${r.stderr}`);
  assert.equal(r.stdout, 'could not reach SPM, run again\n');
  assert.equal(fs.existsSync(path.join(kit, 'selfcheck-ran')), false, 'the selfcheck ran after a failed identify');
  assert.equal(fs.existsSync(marker), false, 'the listener started after a failed identify');
});

test('start.sh (B2): the identify override is used when set, and its failure stops before the selfcheck', () => {
  const dir = workdir('healthover');
  const marker = path.join(dir, 'marker');
  const r = runStart(['--config', CONFIG, '--state-dir', path.join(dir, 'state')], {
    SPM_AGENT_START_HEALTH_CMD: `echo 'could not reach SPM, run again'; exit 7`,
    SPM_AGENT_START_SELFCHECK_CMD: `echo selfcheck >> ${marker}; exit 0`,
    KEEPALIVE_MAX_RUNS: '1',
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'could not reach SPM, run again\n');
  assert.equal(fs.existsSync(marker), false);
});
