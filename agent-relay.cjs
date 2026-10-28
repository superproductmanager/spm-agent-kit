#!/usr/bin/env node
'use strict';
/**
 * agent-relay.cjs -- the listener session's hand-over bookkeeping for the keep-alive kit.
 * Reads the listener LOG (one JSON object per line, as `agent-listen.cjs --inbox --mode stream` prints it)
 * and keeps a STATE file of what has been handed over. Never prints comment text: the notice line carries none.
 *
 *   node agent-relay.cjs next --log <LOG> --state <STATE>
 *   node agent-relay.cjs done <notification_id> --state <STATE>
 *   node agent-relay.cjs seen <notification_id> --state <STATE>
 *   node agent-relay.cjs unseen --log <LOG> --state <STATE>
 *   node agent-relay.cjs delayed <comment_id> --state <STATE>
 *   node agent-relay.cjs pending --log <LOG> --state <STATE>
 *
 * STATE is JSON: { "relayed": { "<notification_id>": { "t": "<IST>", "seen": true|false } }, "delayed": { "<comment_id>": { "t": "<IST>" } } }.
 * A STATE file that does not exist yet counts as nothing relayed and nothing delayed; `done` and `delayed` create it.
 * Every STATE write goes to a temp file in the same folder, is fsynced, then renamed over STATE (atomic).
 * Every STATE write also prunes : `relayed` keeps only the 500 newest entries by their "t", `delayed` the 500 newest.
 * Entries from before `seen` existed have no `seen` key; they count as seen (true), so `unseen` never lists them.
 *
 * ORDER : "oldest" means the lowest numeric "seq" of the notice. Ties, and notices with no numeric seq, fall back to
 *          LOG order (first appearance); a notice with no seq sorts after every notice that has one.
 * TIME : a notice "t" is read with Date.parse, so both "+05:30" (the listener's IST) and "Z" (the wrapper's UTC) work.
 *
 * next: prints the oldest unrelayed notice line (see ORDER) whose notification_id is not in relayed, as it is in LOG, one
 *          line. Only lines with "kind":"notice" count. A notice seen again (a re-raise line, a repeat after a listener restart)
 *          is the same notice: dedupe by notification_id, the first appearance wins.
 * done: marks notification_id relayed, with seen false. Idempotent: a second call changes nothing and exits 0.
 * seen: marks notification_id seen (after its "Seen" ack). Exit 0; exit 5 with one line if it was never relayed.
 * unseen: prints, one LOG notice line each, oldest first (see ORDER), the notices that are relayed with seen false and not older
 *          than 24 hours. Print nothing and exit 0 when there are none. These are the acks that still need a retry.
 * delayed: marks comment_id as passed on again (the one "Delayed:" line per comment). Exit 0 and marks it if not yet marked;
 *          exit 4 if it was already marked (print nothing).
 * pending: one JSON line: {"unrelayed": n, "oldest_age_min": m | null, "malformed": k, "stale": s}. unrelayed = notices not
 *          yet relayed (deduped) and not older than 24 hours; stale = unrelayed ones older than that (next skips them too).
 *          oldest_age_min = whole minutes since the "t" of the oldest unrelayed notice (see ORDER); null if that notice has no readable t.
 *          malformed = LOG lines that are not a JSON object, plus notice lines with no notification_id. Other kinds are not malformed.
 *
 * EXIT: 0 ok (including "nothing to print"); 2 usage (one line on stderr); 3 LOG or STATE cannot be read, or STATE cannot be
 *       written, or STATE is not valid JSON (one plain line on stderr); 4 delayed: comment already marked; 5 seen: never relayed.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXIT_USAGE = 2;
const EXIT_IO = 3;
const EXIT_ALREADY = 4;
const EXIT_NOT_RELAYED = 5;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RELAYED = 500;
const MAX_DELAYED = 500;

function usage(msg) {
  process.stderr.write(`agent-relay: ${msg}\nusage: agent-relay.cjs next|pending --log <LOG> --state <STATE> | unseen --log <LOG> --state <STATE> | done|seen <notification_id> --state <STATE> | delayed <comment_id> --state <STATE>\n`);
  process.exit(EXIT_USAGE);
}

function fail(msg) {
  process.stderr.write(`agent-relay: ${msg}\n`);
  process.exit(EXIT_IO);
}

function isObj(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function istIso(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().replace('Z', '+05:30');
}

function parseArgs(argv) {
  const cmd = argv[0];
  if (!['next', 'done', 'seen', 'unseen', 'delayed', 'pending'].includes(cmd)) usage(cmd ? `unknown command "${cmd}"` : 'missing command');
  const opts = {};
  const pos = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--log' || a === '--state') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else if (a.startsWith('--')) {
      usage(`unknown option ${a}`);
    } else {
      pos.push(a);
    }
  }
  if (!opts.state) usage('--state is required');
  if (cmd === 'next' || cmd === 'pending' || cmd === 'unseen') {
    if (!opts.log) usage('--log is required');
    if (pos.length) usage(`${cmd} takes no positional argument`);
  } else {
    if (opts.log) usage(`${cmd} takes no --log`);
    if (pos.length !== 1 || !pos[0]) usage(`${cmd} needs exactly one id`);
  }
  return { cmd, log: opts.log, state: opts.state, id: pos[0] };
}

/** Reads STATE. A missing file is an empty state; an unreadable or corrupt one exits 3. */
function readState(statePath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { relayed: Object.create(null), delayed: Object.create(null) };
    fail(`cannot read STATE ${statePath}: ${e.code || e.message}`);
  }
  let s;
  try {
    s = JSON.parse(raw);
  } catch {
    fail(`STATE is not valid JSON: ${statePath}`);
  }
  if (!isObj(s)) fail(`STATE is not a JSON object: ${statePath}`);
  // null-prototype maps: a notification or comment id of "__proto__" is an ordinary key
  return {
    relayed: Object.assign(Object.create(null), isObj(s.relayed) ? s.relayed : {}),
    delayed: Object.assign(Object.create(null), isObj(s.delayed) ? s.delayed : {}),
  };
}

/** Keeps the `keep` newest entries of a map by their "t" (Date.parse; an unreadable t counts as oldest). Ties keep the later insertion. */
function pruneNewest(map, keep) {
  const keys = Object.keys(map);
  if (keys.length <= keep) return;
  const ranked = keys.map((k, i) => {
    const ms = isObj(map[k]) && typeof map[k].t === 'string' ? Date.parse(map[k].t) : NaN;
    return { k, ms: Number.isFinite(ms) ? ms : -Infinity, i };
  });
  ranked.sort((a, b) => (b.ms - a.ms) || (b.i - a.i));
  for (const r of ranked.slice(keep)) delete map[r.k];
}

/** Atomic write: prune , temp file in the same folder, fsync, rename over STATE. A crash before the rename leaves STATE as it was. */
function writeStateAtomic(statePath, state) {
  pruneNewest(state.relayed, MAX_RELAYED);
  pruneNewest(state.delayed, MAX_DELAYED);
  const dir = path.dirname(statePath);
  const tmp = path.join(dir, `${path.basename(statePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const buf = Buffer.from(JSON.stringify({ relayed: state.relayed, delayed: state.delayed }) + '\n', 'utf8');
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      let off = 0;
      while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, statePath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    fail(`cannot write STATE ${statePath}: ${e.code || e.message}`);
  }
}

/** Reads LOG. Returns the deduped notices in first-appearance order and the count of malformed lines. */
function scanLog(logPath) {
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch (e) {
    fail(`cannot read LOG ${logPath}: ${e.code || e.message}`);
  }
  const notices = [];
  const seen = new Set();
  let malformed = 0;
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      malformed++;
      continue;
    }
    if (!isObj(o)) {
      malformed++;
      continue;
    }
    if (o.kind !== 'notice') continue;
    if (typeof o.notification_id !== 'string' || !o.notification_id) {
      malformed++;
      continue;
    }
    if (seen.has(o.notification_id)) continue; // re-raise lines and repeats: the first appearance wins
    seen.add(o.notification_id);
    const seq = typeof o.seq === 'number' && Number.isFinite(o.seq) ? o.seq : null;
    notices.push({ id: o.notification_id, line: text, t: typeof o.t === 'string' ? Date.parse(o.t) : NaN, seq, idx: notices.length });
  }
  return { notices, malformed };
}

/** ORDER : lowest numeric seq first; ties and missing seq fall back to LOG order (idx); a missing seq sorts last. */
function bySeq(a, b) {
  if (a.seq !== null && b.seq !== null) return (a.seq - b.seq) || (a.idx - b.idx);
  if (a.seq !== null) return -1;
  if (b.seq !== null) return 1;
  return a.idx - b.idx;
}

/** A relayed entry whose `seen` is exactly false. Entries without `seen` (written before ) count as seen. */
function isUnseen(s, n) {
  if (!(n.id in s.relayed)) return false;
  const e = s.relayed[n.id];
  return isObj(e) && e.seen === false;
}

function main() {
  const { cmd, log, state: statePath, id } = parseArgs(process.argv.slice(2));

  if (cmd === 'done') {
    const s = readState(statePath);
    if (!(id in s.relayed)) {
      s.relayed[id] = { t: istIso(Date.now()), seen: false };
      writeStateAtomic(statePath, s);
    }
    process.exit(0);
  }

  if (cmd === 'seen') {
    const s = readState(statePath);
    if (!(id in s.relayed)) {
      process.stderr.write(`agent-relay: cannot mark seen: ${id} was never relayed\n`);
      process.exit(EXIT_NOT_RELAYED);
    }
    const e = isObj(s.relayed[id]) ? s.relayed[id] : {};
    if (e.seen !== true) {
      s.relayed[id] = { ...e, seen: true };
      writeStateAtomic(statePath, s);
    }
    process.exit(0);
  }

  if (cmd === 'delayed') {
    const s = readState(statePath);
    if (id in s.delayed) process.exit(EXIT_ALREADY);
    s.delayed[id] = { t: istIso(Date.now()) };
    writeStateAtomic(statePath, s);
    process.exit(0);
  }

  const s = readState(statePath);
  const { notices, malformed } = scanLog(log);
  // A notice older than 24 hours is never handed over (the listener's own catch-up window is 24 hours): a lost STATE file
  // must not re-send days of old tags. A notice with no readable time is kept.
  const cutoff = Date.now() - MAX_AGE_MS;
  const fresh = (n) => !(Number.isFinite(n.t) && n.t < cutoff);

  if (cmd === 'unseen') {
    const rows = notices.filter((n) => isUnseen(s, n) && fresh(n)).sort(bySeq);
    process.stdout.write(rows.map((n) => n.line + '\n').join(''));
    process.exit(0);
  }

  const open = notices.filter((n) => !(n.id in s.relayed));
  const unrelayed = open.filter(fresh).sort(bySeq);
  const stale = open.length - unrelayed.length;

  if (cmd === 'next') {
    if (unrelayed.length) process.stdout.write(unrelayed[0].line + '\n');
    process.exit(0);
  }

  // pending: the oldest is the lowest seq (ORDER); its age is null when its "t" cannot be read
  const oldest = unrelayed[0];
  const ageMin = oldest && Number.isFinite(oldest.t) ? Math.max(0, Math.floor((Date.now() - oldest.t) / 60000)) : null;
  process.stdout.write(JSON.stringify({ unrelayed: unrelayed.length, oldest_age_min: ageMin, malformed, stale }) + '\n');
  process.exit(0);
}

main();
