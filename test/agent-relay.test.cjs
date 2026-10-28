#!/usr/bin/env node
'use strict';
/**
 * agent-relay.test.cjs -- node:test for agent-relay.cjs.
 * Real files and real processes: every case spawns agent-relay.cjs with node and uses temp LOG and STATE files.
 * No network, no keys. Run: node --test 
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'agent-relay.cjs');
const DOC = '00000000-0000-4000-8000-00000000000d';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-test-'));
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/** A notice line exactly as agent-listen.cjs prints it (no comment text in it). */
function notice(id, seq, extra = {}) {
  return JSON.stringify({
    t: new Date(Date.now() - 60 * 60000).toISOString(), // one hour ago: inside the 24-hour window whatever day the test runs
    kind: 'notice',
    notification_id: id,
    seq,
    reason: 'mentioned',
    lane: 'customer',
    verb: 'comment.created',
    item: { type: 'document', id: DOC },
    comment_id: `c-${id}`,
    thread_root_id: null,
    task_id: null,
    target: null,
    item_seq: seq,
    actor_kind: 'human',
    ...extra,
  });
}

function writeLog(dir, lines) {
  const p = path.join(dir, 'listener.log');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

test('next then done walks the log in order across separate processes', () => {
  const dir = tmpDir();
  const log = writeLog(dir, [notice('n-a', 1), notice('n-b', 2), notice('n-c', 3)]);
  const state = path.join(dir, 'relay-state.json'); // does not exist yet: nothing relayed
  try {
    const r1 = run(['next', '--log', log, '--state', state]);
    assert.equal(r1.code, 0, r1.err);
    assert.equal(JSON.parse(r1.out).notification_id, 'n-a');
    assert.equal(run(['done', 'n-a', '--state', state]).code, 0);

    const r2 = run(['next', '--log', log, '--state', state]);
    assert.equal(JSON.parse(r2.out).notification_id, 'n-b');
    assert.equal(run(['done', 'n-b', '--state', state]).code, 0);

    const r3 = run(['next', '--log', log, '--state', state]);
    assert.equal(JSON.parse(r3.out).notification_id, 'n-c');
    assert.equal(run(['done', 'n-c', '--state', state]).code, 0);

    const r4 = run(['next', '--log', log, '--state', state]);
    assert.equal(r4.code, 0);
    assert.equal(r4.out, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('next prints the notice line exactly as logged, with no fields added', () => {
  const dir = tmpDir();
  const line = notice('n-raw', 7);
  const log = writeLog(dir, [line]);
  const state = path.join(dir, 'relay-state.json');
  try {
    const r = run(['next', '--log', log, '--state', state]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), line);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('next dedupes re-raise lines and prints the first appearance of a notice', () => {
  const dir = tmpDir();
  const first = notice('n-a', 1);
  const log = writeLog(dir, [
    first,
    notice('n-b', 2),
    notice('n-a', 1, { reraise: 1 }),
    notice('n-a', 1, { reraise: 2 }),
  ]);
  const state = path.join(dir, 'relay-state.json');
  try {
    const r1 = run(['next', '--log', log, '--state', state]);
    assert.equal(r1.out.trim(), first, 'the first appearance is printed, not a re-raise line');
    assert.equal(run(['done', 'n-a', '--state', state]).code, 0);
    // the re-raise lines of n-a must not bring it back; the next notice is n-b
    const r2 = run(['next', '--log', log, '--state', state]);
    assert.equal(JSON.parse(r2.out).notification_id, 'n-b');
    assert.equal(run(['pending', '--log', log, '--state', state]).out.includes('"unrelayed":1'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('next and pending skip malformed LOG lines and count them', () => {
  const dir = tmpDir();
  const good = notice('n-ok', 1);
  const log = writeLog(dir, [
    'this is not json',                                  // malformed 1: not JSON
    '{"kind":"notice","notification_id":"n-trunc"',      // malformed 2: truncated JSON
    '[1,2,3]',                                           // malformed 3: JSON but not an object
    JSON.stringify({ kind: 'notice', seq: 9 }),          // malformed 4: notice with no notification_id
    JSON.stringify({ t: 'x', kind: 'listener.restart', exit_code: 1, delay_s: 5 }), // other kind: not malformed
    JSON.stringify({ t: 'x', kind: 'listener.failing', restarts: 3, last_err: 'boom' }), // other kind: not malformed
    good,
  ]);
  const state = path.join(dir, 'relay-state.json');
  try {
    const r = run(['next', '--log', log, '--state', state]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), good);
    const p = run(['pending', '--log', log, '--state', state]);
    assert.equal(p.code, 0, p.err);
    const j = JSON.parse(p.out);
    assert.equal(j.unrelayed, 1);
    assert.equal(j.malformed, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('done is idempotent', () => {
  const dir = tmpDir();
  const log = writeLog(dir, [notice('n-a', 1)]);
  const state = path.join(dir, 'relay-state.json');
  try {
    assert.equal(run(['done', 'n-a', '--state', state]).code, 0);
    assert.equal(run(['done', 'n-a', '--state', state]).code, 0);
    assert.equal(run(['next', '--log', log, '--state', state]).out, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('next prints nothing and exits 0 when every notice is relayed', () => {
  const dir = tmpDir();
  const log = writeLog(dir, [notice('n-a', 1)]);
  const state = path.join(dir, 'relay-state.json');
  try {
    run(['done', 'n-a', '--state', state]);
    const r = run(['next', '--log', log, '--state', state]);
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('delayed marks a comment once: the second call exits 4', () => {
  const dir = tmpDir();
  const state = path.join(dir, 'relay-state.json');
  try {
    assert.equal(run(['delayed', 'c-1', '--state', state]).code, 0);
    assert.equal(run(['delayed', 'c-1', '--state', state]).code, 4);
    assert.equal(run(['delayed', 'c-2', '--state', state]).code, 0, 'another comment is marked separately');
    const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
    assert.ok(saved.delayed['c-1'] && saved.delayed['c-1'].t, 'c-1 has a time');
    assert.ok(saved.delayed['c-2'], 'c-2 is marked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an interrupted write leaves the state file valid; a leftover temp file is ignored', () => {
  const dir = tmpDir();
  const log = writeLog(dir, [notice('n-a', 1), notice('n-b', 2)]);
  const state = path.join(dir, 'relay-state.json');
  try {
    assert.equal(run(['done', 'n-a', '--state', state]).code, 0);
    // simulate a crash between write and rename: a half-written temp file sits in the same folder
    fs.writeFileSync(path.join(dir, 'relay-state.json.tmp-999-abc'), '{"relayed": {"n-b"');
    const saved = JSON.parse(fs.readFileSync(state, 'utf8')); // the real state is still valid JSON
    assert.ok(saved.relayed['n-a'], 'n-a is recorded in the real state');
    const r = run(['next', '--log', log, '--state', state]);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).notification_id, 'n-b', 'the leftover temp file did not mark n-b');
    assert.equal(run(['done', 'n-b', '--state', state]).code, 0);
    assert.ok(JSON.parse(fs.readFileSync(state, 'utf8')).relayed['n-b']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending reports the unrelayed count and the oldest age in minutes', () => {
  const dir = tmpDir();
  const oldT = new Date(Date.now() - 65 * 60000).toISOString();
  const newT = new Date(Date.now() - 1 * 60000).toISOString();
  const log = writeLog(dir, [
    notice('n-old', 1, { t: oldT }),
    notice('n-new', 2, { t: newT }),
  ]);
  const state = path.join(dir, 'relay-state.json');
  try {
    const p = run(['pending', '--log', log, '--state', state]);
    assert.equal(p.code, 0, p.err);
    const j = JSON.parse(p.out);
    assert.equal(j.unrelayed, 2);
    assert.ok(j.oldest_age_min >= 64 && j.oldest_age_min <= 66, `age ${j.oldest_age_min}`);
    assert.equal(j.malformed, 0);
    run(['done', 'n-old', '--state', state]);
    const j2 = JSON.parse(run(['pending', '--log', log, '--state', state]).out);
    assert.equal(j2.unrelayed, 1);
    assert.ok(j2.oldest_age_min >= 0 && j2.oldest_age_min <= 2, `age after done ${j2.oldest_age_min}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lost STATE file does not hand over notices older than 24 hours again', () => {
  const dir = tmpDir();
  const stale = new Date(Date.now() - 30 * 3600000).toISOString();
  const log = writeLog(dir, [notice('n-stale', 1, { t: stale }), notice('n-fresh', 2), notice('n-no-t', 3, { t: undefined })]);
  const state = path.join(dir, 'relay-state.json'); // missing, as after a lost state file
  try {
    const r = run(['next', '--log', log, '--state', state]);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).notification_id, 'n-fresh');
    const j = JSON.parse(run(['pending', '--log', log, '--state', state]).out);
    assert.equal(j.unrelayed, 2, 'the fresh notice and the one with no readable time; the stale one is skipped');
    assert.equal(j.stale, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable LOG exits 3 with one plain line', () => {
  const dir = tmpDir();
  const state = path.join(dir, 'relay-state.json');
  try {
    const r = run(['next', '--log', path.join(dir, 'missing.log'), '--state', state]);
    assert.equal(r.code, 3);
    assert.equal(r.out, '');
    assert.equal(r.err.trim().split('\n').length, 1, `stderr: ${r.err}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt STATE file exits 3 with one plain line', () => {
  const dir = tmpDir();
  const log = writeLog(dir, [notice('n-a', 1)]);
  const state = path.join(dir, 'relay-state.json');
  fs.writeFileSync(state, '{not valid');
  try {
    const r = run(['next', '--log', log, '--state', state]);
    assert.equal(r.code, 3);
    assert.equal(r.out, '');
    assert.equal(r.err.trim().split('\n').length, 1, `stderr: ${r.err}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('usage errors exit 2', () => {
  const dir = tmpDir();
  const state = path.join(dir, 'relay-state.json');
  try {
    assert.equal(run([]).code, 2);
    assert.equal(run(['bogus', '--state', state]).code, 2);
    assert.equal(run(['next', '--state', state]).code, 2, 'next needs --log');
    assert.equal(run(['done', '--state', state]).code, 2, 'done needs a notification id');
    assert.equal(run(['delayed', 'c-1']).code, 2, 'delayed needs --state');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- : seq ordering, seen/unseen, legacy state, prune, both time formats ----
const IST_MS = 5.5 * 60 * 60 * 1000;
/** A time string in the listener's IST form ("+05:30"), `agoMs` before now. */
function istAgo(agoMs) {
  return new Date(Date.now() - agoMs + IST_MS).toISOString().replace('Z', '+05:30');
}
function readState(state) {
  return JSON.parse(fs.readFileSync(state, 'utf8'));
}

test('next prints the lowest seq, not the first line of the LOG', () => {
  const dir = tmpDir();
  const log = writeLog(dir, [notice('n-late', 9), notice('n-early', 2), notice('n-mid', 5)]);
  const state = path.join(dir, 'relay-state.json');
  try {
    const order = [];
    for (let i = 0; i < 3; i++) {
      const r = run(['next', '--log', log, '--state', state]);
      assert.equal(r.code, 0, r.err);
      const id = JSON.parse(r.out).notification_id;
      order.push(id);
      assert.equal(run(['done', id, '--state', state]).code, 0);
    }
    assert.deepEqual(order, ['n-early', 'n-mid', 'n-late']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ties and a missing seq fall back to LOG order (a missing seq sorts after numbered ones)', () => {
  const dir = tmpDir();
  const log = writeLog(dir, [notice('n-x', 4), notice('n-y', 4), notice('n-z', undefined), notice('n-first', 1)]);
  const state = path.join(dir, 'relay-state.json');
  try {
    const order = [];
    for (let i = 0; i < 4; i++) {
      const r = run(['next', '--log', log, '--state', state]);
      assert.equal(r.code, 0, r.err);
      const id = JSON.parse(r.out).notification_id;
      order.push(id);
      run(['done', id, '--state', state]);
    }
    assert.deepEqual(order, ['n-first', 'n-x', 'n-y', 'n-z']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('done then unseen lists the notice; seen then unseen is empty', () => {
  const dir = tmpDir();
  const lineA = notice('n-a', 1);
  const log = writeLog(dir, [lineA, notice('n-b', 2)]);
  const state = path.join(dir, 'relay-state.json');
  try {
    assert.equal(run(['done', 'n-a', '--state', state]).code, 0);
    const u1 = run(['unseen', '--log', log, '--state', state]);
    assert.equal(u1.code, 0, u1.err);
    assert.equal(u1.out, lineA + '\n', 'the relayed, unseen notice is printed as logged');
    assert.equal(run(['seen', 'n-a', '--state', state]).code, 0);
    const u2 = run(['unseen', '--log', log, '--state', state]);
    assert.equal(u2.code, 0, u2.err);
    assert.equal(u2.out, '');
    assert.equal(readState(state).relayed['n-a'].seen, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('done writes seen: false on the new entry', () => {
  const dir = tmpDir();
  const state = path.join(dir, 'relay-state.json');
  try {
    assert.equal(run(['done', 'n-a', '--state', state]).code, 0);
    const e = readState(state).relayed['n-a'];
    assert.equal(e.seen, false);
    assert.ok(e.t, 'the entry has a time');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seen on a notice that was never relayed exits 5 with one line', () => {
  const dir = tmpDir();
  const state = path.join(dir, 'relay-state.json');
  try {
    const r = run(['seen', 'n-never', '--state', state]);
    assert.equal(r.code, 5, r.err);
    assert.equal(r.out, '');
    assert.equal(r.err.trim().split('\n').length, 1, `stderr: ${r.err}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unseen lists oldest first by seq and skips notices older than 24 hours', () => {
  const dir = tmpDir();
  const lineB = notice('n-b', 2);
  const lineA = notice('n-a', 1);
  const lineOld = notice('n-old', 0, { t: istAgo(30 * 3600000) });
  const log = writeLog(dir, [lineB, lineA, lineOld]);
  const state = path.join(dir, 'relay-state.json');
  try {
    run(['done', 'n-b', '--state', state]);
    run(['done', 'n-a', '--state', state]);
    run(['done', 'n-old', '--state', state]);
    const u = run(['unseen', '--log', log, '--state', state]);
    assert.equal(u.code, 0, u.err);
    assert.equal(u.out, lineA + '\n' + lineB + '\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy relayed entry without seen counts as seen: unseen does not list it', () => {
  const dir = tmpDir();
  const log = writeLog(dir, [notice('n-legacy', 1)]);
  const state = path.join(dir, 'relay-state.json');
  try {
    fs.writeFileSync(state, JSON.stringify({ relayed: { 'n-legacy': { t: '2026-10-20T10:00:00+05:30' } }, delayed: {} }));
    const u = run(['unseen', '--log', log, '--state', state]);
    assert.equal(u.code, 0, u.err);
    assert.equal(u.out, '');
    assert.equal(run(['next', '--log', log, '--state', state]).out, '', 'and it is not handed over again');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prune: relayed keeps the 500 newest by t, whatever the insertion order', () => {
  const dir = tmpDir();
  const state = path.join(dir, 'relay-state.json');
  try {
    // 510 entries inserted newest first; r-0 is the oldest by t
    const relayed = {};
    for (let i = 509; i >= 0; i--) relayed[`r-${i}`] = { t: istAgo(3600000 + (510 - i) * 60000), seen: true };
    fs.writeFileSync(state, JSON.stringify({ relayed, delayed: {} }));
    assert.equal(run(['done', 'n-new', '--state', state]).code, 0);
    const saved = readState(state);
    assert.equal(Object.keys(saved.relayed).length, 500);
    assert.ok(saved.relayed['n-new'], 'the new entry is kept');
    for (let i = 0; i <= 10; i++) assert.equal(saved.relayed[`r-${i}`], undefined, `r-${i} (old) is pruned`);
    assert.ok(saved.relayed['r-11'], 'r-11 is kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prune: delayed keeps the 500 newest by t', () => {
  const dir = tmpDir();
  const state = path.join(dir, 'relay-state.json');
  try {
    const delayed = {};
    for (let i = 509; i >= 0; i--) delayed[`c-${i}`] = { t: istAgo(3600000 + (510 - i) * 60000) };
    fs.writeFileSync(state, JSON.stringify({ relayed: {}, delayed }));
    assert.equal(run(['delayed', 'c-new', '--state', state]).code, 0);
    const saved = readState(state);
    assert.equal(Object.keys(saved.delayed).length, 500);
    assert.ok(saved.delayed['c-new']);
    for (let i = 0; i <= 10; i++) assert.equal(saved.delayed[`c-${i}`], undefined, `c-${i} (old) is pruned`);
    assert.ok(saved.delayed['c-11']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('both time formats: a +05:30 time and a Z time are read correctly', () => {
  const dir = tmpDir();
  const log = writeLog(dir, [
    notice('n-ist', 1, { t: istAgo(3 * 3600000) }),                               // IST, 3 h ago
    notice('n-utc', 2, { t: new Date(Date.now() - 3600000).toISOString() }),        // Z, 1 h ago
    notice('n-ist-stale', 3, { t: istAgo(25 * 3600000) }),                          // IST, 25 h ago: stale
  ]);
  const state = path.join(dir, 'relay-state.json');
  try {
    const j = JSON.parse(run(['pending', '--log', log, '--state', state]).out);
    assert.equal(j.unrelayed, 2, 'the two fresh notices');
    assert.equal(j.stale, 1, 'the 25-hour-old IST notice is stale');
    assert.ok(j.oldest_age_min >= 179 && j.oldest_age_min <= 181, `oldest age ${j.oldest_age_min} (expect about 180 min for the IST notice)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seen and unseen usage errors exit 2', () => {
  const dir = tmpDir();
  const state = path.join(dir, 'relay-state.json');
  const log = writeLog(dir, [notice('n-a', 1)]);
  try {
    assert.equal(run(['seen', '--state', state]).code, 2, 'seen needs an id');
    assert.equal(run(['seen', 'n-a']).code, 2, 'seen needs --state');
    assert.equal(run(['unseen', '--state', state]).code, 2, 'unseen needs --log');
    assert.equal(run(['unseen', '--log', log]).code, 2, 'unseen needs --state');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
