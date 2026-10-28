#!/usr/bin/env node
'use strict';
/**
 * agent-resolve.cjs: marks notices as resolved in the agent's own notice inbox, so agent-listen.cjs stops re-raising them.
 * Run it after the agent has answered a notice. The agent is named by the settings file (see the README).
 *
 *   node agent-resolve.cjs --config <absolute path to settings file> --ids <uuid>[,<uuid>...] [--dry-run]
 *   node agent-resolve.cjs --selftest     OFFLINE: a local http server stands in for the route; a fake key; no network call, no real key file is read.
 *
 * SETTINGS FILE. --config <path>, or the environment variable SPM_AGENT_CONFIG. The file must name the agent and give key_file (see lib/config.cjs).
 *
 * WHAT IT SENDS. One POST https://asia-south1-litethink.cloudfunctions.net/accountApi/notifications/resolve with the headers X-SPM-API-Key
 * (the key from key_file) and X-SPM-User-Email (the agent's address), and the body {"ids":[...]}: 1 to 100 uuids, no repeats.
 * The key's owner is the caller, so only that agent's own notices are touched.
 * The reply is { results: [{ id, status }] }. Status is resolved (this call resolved it), already_resolved, not_found (not a notice of this agent)
 * or access_lost (the agent can no longer open the item).
 * OUTPUT: one line per id, "<notification id> <status>", in the order given. Exit 0 when every id is resolved or already_resolved;
 * exit 1 otherwise or when the call fails; exit 2 on bad arguments or a bad settings file.
 * The key and the address are never printed. --dry-run prints the request it would send and sends nothing; it reads no key file.
 * Nothing is retried. A failed call marks nothing, so running it again is safe: a second call answers already_resolved.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { loadConfig, ConfigError } = require(path.join(__dirname, 'lib', 'config.cjs'));
const { keyMode } = require(path.join(__dirname, 'lib', 'key-mode.cjs'));

const FN_HOST = 'asia-south1-litethink.cloudfunctions.net';
const RESOLVE_PATH = '/accountApi/notifications/resolve';
const MAX_IDS = 100;
const MAX_REPLY_BYTES = 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USAGE = 'usage: node agent-resolve.cjs --config <absolute path> --ids <uuid>[,<uuid>...] [--dry-run]  |  node agent-resolve.cjs --selftest';
const OK_STATUSES = ['resolved', 'already_resolved'];

const parseJson = (text) => { try { return JSON.parse(text); } catch (_) { return null; } };
const word = (x) => (typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(x) ? x : 'none');

// The command line without --config (main strips it). Reads nothing.
function parseArgs(argv) {
  const bad = (error) => ({ ok: false, error });
  const valued = ['--ids'];
  const v = {}; let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { if (dryRun) return bad('--dry-run given twice'); dryRun = true; continue; }
    if (!valued.includes(a)) return bad(`unknown argument ${JSON.stringify(String(a).slice(0, 40))}`);
    if (Object.prototype.hasOwnProperty.call(v, a)) return bad(`${a} given twice`);
    if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) return bad(`${a} needs a value`);
    v[a] = argv[++i];
  }
  if (!Object.prototype.hasOwnProperty.call(v, '--ids')) return bad('--ids is required');
  const ids = v['--ids'].split(',').map((s) => s.trim().toLowerCase());
  if (ids.length < 1 || ids.length > MAX_IDS) return bad(`--ids takes 1 to ${MAX_IDS} ids`);
  if (ids.some((id) => !UUID_RE.test(id))) return bad('every --ids entry must be a uuid');
  if (new Set(ids).size !== ids.length) return bad('--ids names the same id twice');
  return { ok: true, cfg: { ids, dryRun } };
}

// Drops the --config pair from argv (the settings file is read by loadConfig).
function withoutConfig(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--config') i++; else out.push(argv[i]); }
  return out;
}

function proxyAgentFor(lib) {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (lib === http || !p) return false;
  return new https.Agent({ proxyEnv: { HTTPS_PROXY: p } }); // only the proxy URL reaches the agent; the target host is unchanged
}

// One POST with a JSON body. The host header is always the production host; hostname and port only say where the socket goes.
function httpPost({ lib, hostname, port, pathname, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = lib.request({
      hostname, port, path: pathname, method: 'POST', agent: proxyAgentFor(lib),
      headers: { ...headers, host: FN_HOST, accept: 'application/json', 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_REPLY_BYTES) { req.destroy(new Error('TOOBIG')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => reject(new Error('ECONNRESET')));
    });
    req.setTimeout(timeoutMs || 30000, () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', (e) => reject(new Error(word(e && e.code) === 'none' ? (word(e && e.message) === 'none' ? 'ECONNRESET' : e.message) : e.code)));
    req.end(data);
  });
}

// Runs one resolve. deps: io { out, err }, readKeyFile(file), post({ pathname, headers, body }) -> { status, text }, env (for the settings file). Returns the exit code.
async function main(argv, deps) {
  let config;
  try { config = loadConfig({ argv, env: deps.env || process.env }); } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    deps.io.err(`agent-resolve: ${e.message}`); return 2;
  }
  const parsed = parseArgs(withoutConfig(argv));
  if (!parsed.ok) { deps.io.err(`agent-resolve: ${parsed.error}`); deps.io.err(USAGE); return 2; }
  const { cfg } = parsed;
  if (cfg.dryRun) {
    deps.io.out(`dry run, nothing sent: POST https://${FN_HOST}${RESOLVE_PATH} for the agent named in the settings file; headers X-SPM-API-Key and X-SPM-User-Email; body {"ids":[${cfg.ids.length} id(s)]}`);
    for (const id of cfg.ids) deps.io.out(`${id} would be resolved`);
    return 0;
  }
  const mode = keyMode(config, deps.env || process.env); // K-A3 item 1: no key_file means network-secret mode, which needs the proxy
  if (mode.mode === 'refused') { deps.io.err(`agent-resolve: ${mode.message}`); return 2; }
  let key;
  if (mode.mode === 'secret') key = mode.key;
  else { try { key = deps.readKeyFile(config.keyFile); } catch (_) { key = null; } }
  if (typeof key !== 'string' || !key) { deps.io.err(`agent-resolve: cannot read the key file of agent ${config.name}; nothing was marked`); return 1; }
  let r;
  try {
    r = await deps.post({ pathname: RESOLVE_PATH, headers: { 'X-SPM-API-Key': key, 'X-SPM-User-Email': config.email }, body: { ids: cfg.ids } });
  } catch (e) {
    deps.io.err(`agent-resolve: the call failed (${word(e && e.message)}); nothing is known to be marked, run it again`);
    return 1;
  }
  const j = parseJson(r.text);
  if (r.status !== 200 || !j || !Array.isArray(j.results)) {
    deps.io.err(`agent-resolve: the resolve call was refused (status ${word(String(r.status))}, code ${j && typeof j.code === 'string' ? word(j.code) : 'none'}); run it again after checking the settings file`);
    return 1;
  }
  const byId = new Map(j.results.filter((x) => x && typeof x.id === 'string').map((x) => [x.id.toLowerCase(), x.status]));
  let allOk = true;
  for (const id of cfg.ids) {
    const status = byId.has(id) ? word(byId.get(id)) : 'no_answer';
    if (!OK_STATUSES.includes(status)) allOk = false;
    deps.io.out(`${id} ${status}`);
  }
  return allOk ? 0 : 1;
}

function realDeps() {
  return {
    io: { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') },
    readKeyFile: (file) => { const k = fs.readFileSync(file, 'utf8').trim(); if (!k) throw new Error('empty key file'); return k; },
    post: (o) => httpPost({ ...o, lib: https, hostname: FN_HOST, port: 443, timeoutMs: 30000 }),
    env: process.env,
  };
}

// ============================================================================ SELFTEST (a local http server; a fake key; no production call; no real key file read)
async function selftest() {
  const FAKE_KEY = 'spm_k_test_resolve_agent_key_0123456789abcdef';
  const WRONG_KEY = 'spm_k_test_resolve_wrong_key_0123456789';
  const AGENT_EMAIL = 'spm-example-agent@agents.invalid';
  const ID1 = '00000000-0000-4000-8000-0000000000ab';
  const ID2 = '00000000-0000-4000-8000-000000000002';
  const ID3 = '00000000-0000-4000-8000-000000000003';
  const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-resolve-selftest-'));
  const CONFIG = path.join(RUN_DIR, 'agent.config.json');
  fs.writeFileSync(CONFIG, JSON.stringify({ agent: { name: 'Example agent', email: AGENT_EMAIL }, key_file: path.join(RUN_DIR, 'agent.key') }));
  const NO_KEY_CONFIG = path.join(RUN_DIR, 'no-key.config.json');
  fs.writeFileSync(NO_KEY_CONFIG, JSON.stringify({ agent: { name: 'Example agent', email: AGENT_EMAIL } }));
  const cases = [];
  const tc = (name, fn) => cases.push({ name, fn });
  const seen = []; // every request the local server received
  const answer = new Map(); // id -> status the stand-in reports; an id not in the map is not_found
  let server = null;
  const serve = (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['x-spm-api-key'], email: req.headers['x-spm-user-email'], ctype: req.headers['content-type'], origin: req.headers.origin, host: req.headers.host, raw });
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method !== 'POST' || req.url !== RESOLVE_PATH) return send(404, { error: 'unknown_route', code: 'unknown_route' });
      if (req.headers['x-spm-api-key'] !== FAKE_KEY) return send(401, { error: 'invalid_key', code: 'invalid_key' });
      if (req.headers['x-spm-user-email'] !== AGENT_EMAIL) return send(403, { error: 'email_mismatch', code: 'email_mismatch' });
      const body = parseJson(raw);
      const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
      if (keys.length !== 1 || keys[0] !== 'ids' || !Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > MAX_IDS || body.ids.some((x) => typeof x !== 'string' || !UUID_RE.test(x))) {
        return send(400, { error: 'invalid_request', code: 'invalid_request' });
      }
      return send(200, { results: body.ids.map((id) => ({ id, status: answer.has(id) ? answer.get(id) : 'not_found' })) });
    });
  };
  const fakeDeps = (over = {}) => {
    const out = []; const err = [];
    return {
      out, err,
      deps: {
        io: { out: (s) => out.push(s), err: (s) => err.push(s) },
        readKeyFile: over.readKeyFile || (() => FAKE_KEY),
        post: (o) => httpPost({ ...o, lib: http, hostname: '127.0.0.1', port: server.address().port, timeoutMs: 5000 }),
        env: over.env || {},
      },
    };
  };
  const run = async (argv, over) => { const f = fakeDeps(over); const code = await main(argv, f.deps); return { code, out: f.out, err: f.err, all: [...f.out, ...f.err].join('\n') }; };
  const check = (cond, msg) => { if (!cond) throw new Error(msg); };
  const cfgArg = ['--config', CONFIG];

  tc('S1 parse: a good command gives the ids in lower case, no dry run; --dry-run is read; the settings file supplies the agent', () => {
    const p = parseArgs(['--ids', ID1.toUpperCase()]);
    check(p.ok && same(p.cfg.ids, [ID1]) && !p.cfg.dryRun, `good ${JSON.stringify(p)}`);
    const q = parseArgs(['--ids', `${ID1},${ID2}`, '--dry-run']);
    check(q.ok && q.cfg.ids.length === 2 && q.cfg.dryRun, `dry ${JSON.stringify(q)}`);
  });

  tc('S2 parse refusals: each bad command is refused with exit 2 and a plain reason, nothing sent', async () => {
    const bad = [
      [['--ids', ID1, '--identity', 'cloud'], 'unknown argument'], [['--ids', ID1, '--key-file', 'k.key'], 'unknown argument'], [['--ids', ID1, '--email', 'x@agents.invalid'], 'unknown argument'],
      [[], '--ids is required'], [['--ids', 'not-a-uuid'], 'uuid'], [['--ids', `${ID1},${ID1}`], 'twice'],
      [['--ids', Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',')], '1 to 100'],
      [['--ids', ID1, '--ids', ID2], 'given twice'],
    ];
    for (const [argv, why] of bad) {
      const p = parseArgs(argv);
      check(!p.ok && p.error.includes(why), `${why}: ${JSON.stringify(p).slice(0, 200)}`);
      seen.length = 0;
      const r = await run([...cfgArg, ...argv]);
      check(r.code === 2 && seen.length === 0, `${why}: exit ${r.code}, requests ${seen.length}`);
    }
  });

  tc('S3 dry run: prints the request and the ids, sends nothing, reads no key file', async () => {
    seen.length = 0;
    let keyReads = 0;
    const r = await run([...cfgArg, '--ids', `${ID1},${ID2}`, '--dry-run'], { readKeyFile: () => { keyReads++; return FAKE_KEY; } });
    check(r.code === 0 && r.out.length === 3 && r.out[1] === `${ID1} would be resolved`, `dry run out ${JSON.stringify(r.out)}`);
    check(seen.length === 0 && keyReads === 0, `dry run sent ${seen.length} request(s), read the key ${keyReads} time(s)`);
  });

  tc('S4 real POST over http: one id resolved; one POST to accountApi/notifications/resolve with the key, the address and {"ids":[id]}, no Origin; one output line, exit 0', async () => {
    seen.length = 0; answer.clear(); answer.set(ID1, 'resolved');
    const r = await run([...cfgArg, '--ids', ID1]);
    check(r.code === 0 && same(r.out, [`${ID1} resolved`]), `exit ${r.code} out ${JSON.stringify(r.out)} err ${JSON.stringify(r.err)}`);
    check(seen.length === 1, `requests ${seen.length}`);
    const q = seen[0];
    check(q.method === 'POST' && q.url === RESOLVE_PATH && q.key === FAKE_KEY && q.email === AGENT_EMAIL && q.ctype === 'application/json' && q.origin === undefined && q.host === FN_HOST, `request ${JSON.stringify({ ...q, raw: undefined, key: !!q.key })}`);
    check(same(parseJson(q.raw), { ids: [ID1] }), `body ${q.raw}`);
  });

  tc('S5 mixed answers: resolved, already_resolved and not_found print in the order given; exit 1 because one is not resolved', async () => {
    seen.length = 0; answer.clear(); answer.set(ID1, 'resolved'); answer.set(ID2, 'already_resolved');
    const r = await run([...cfgArg, '--ids', `${ID2},${ID3},${ID1}`]);
    check(r.code === 1 && same(r.out, [`${ID2} already_resolved`, `${ID3} not_found`, `${ID1} resolved`]), `exit ${r.code} out ${JSON.stringify(r.out)}`);
  });

  tc('S6 refused call (wrong key on the server): exit 1, one plain line, nothing marked, the key is not printed', async () => {
    seen.length = 0;
    const r = await run([...cfgArg, '--ids', ID1], { readKeyFile: () => WRONG_KEY });
    check(r.code === 1 && r.out.length === 0 && r.err.length === 1 && /refused \(status 401, code invalid_key\)/.test(r.err[0]), `exit ${r.code} err ${JSON.stringify(r.err)}`);
    check(!r.all.includes(WRONG_KEY), 'the key was printed');
  });

  tc('S7 missing key file: exit 1 before any request; the message names the agent only', async () => {
    seen.length = 0;
    const r = await run([...cfgArg, '--ids', ID1], { readKeyFile: () => { throw new Error('ENOENT'); } });
    check(r.code === 1 && seen.length === 0 && /cannot read the key file of agent Example agent/.test(r.err.join(' ')), `exit ${r.code} err ${JSON.stringify(r.err)} requests ${seen.length}`);
  });

  tc('S8 output never contains the key or the address, on any path', async () => {
    seen.length = 0; answer.clear(); answer.set(ID1, 'resolved');
    const runs = [await run([...cfgArg, '--ids', ID1]), await run([...cfgArg, '--ids', ID1, '--dry-run']), await run([...cfgArg, '--ids', ID1], { readKeyFile: () => { throw new Error('x'); } })];
    for (const r of runs) check(!r.all.includes(FAKE_KEY) && !r.all.includes(AGENT_EMAIL), `a printed line holds the key or the address: ${r.all.slice(0, 120)}`);
  });

  tc('S9 settings file: no --config and no SPM_AGENT_CONFIG: exit 2, one plain line, nothing sent', async () => {
    seen.length = 0;
    const r = await run(['--ids', ID1], { env: {} });
    check(r.code === 2 && seen.length === 0 && r.err.length === 1 && r.err[0] === 'agent-resolve: no settings file: pass --config <absolute path> or set SPM_AGENT_CONFIG', `no config: exit ${r.code} err ${JSON.stringify(r.err)}`);
  });

  tc('S10 settings file: a relative --config path is refused (exit 2); a config with no key_file is refused by a real run, not by a dry run', async () => {
    seen.length = 0;
    const rel = await run(['--config', 'relative/agent.json', '--ids', ID1], { env: {} });
    check(rel.code === 2 && rel.err[0] === 'agent-resolve: the settings file path must be absolute' && seen.length === 0, `relative: exit ${rel.code} err ${JSON.stringify(rel.err)}`);
    const nokey = await run(['--config', NO_KEY_CONFIG, '--ids', ID1], { env: {} });
    check(nokey.code === 2 && nokey.err[0] === 'agent-resolve: network-secret mode needs the Claude cloud proxy; set key_file to run elsewhere' && seen.length === 0, `no key_file: exit ${nokey.code} err ${JSON.stringify(nokey.err)}`);
    const dry = await run(['--config', NO_KEY_CONFIG, '--ids', ID1, '--dry-run'], { env: {} });
    check(dry.code === 0 && seen.length === 0, `dry run without key_file: exit ${dry.code}`);
  });

  tc('S11 settings file: SPM_AGENT_CONFIG is used when --config is absent', async () => {
    seen.length = 0; answer.clear(); answer.set(ID1, 'resolved');
    const r = await run(['--ids', ID1], { env: { SPM_AGENT_CONFIG: CONFIG } });
    check(r.code === 0 && seen.length === 1 && seen[0].email === AGENT_EMAIL, `env config: exit ${r.code} err ${JSON.stringify(r.err)}`);
  });

  server = http.createServer(serve);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let pass = 0; let fail = 0;
  try {
    for (const c of cases) {
      try { await c.fn(); pass++; process.stdout.write(`PASS ${c.name}\n`); } catch (e) { fail++; process.stdout.write(`FAIL ${c.name}: ${String(e && e.message).slice(0, 300)}\n`); }
    }
  } finally { await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(RUN_DIR, { recursive: true, force: true }); }
  process.stdout.write(`SELFTEST ${pass} passed, ${fail} failed\n`);
  return fail === 0 ? 0 : 1;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

module.exports = { parseArgs, main, httpPost, RESOLVE_PATH };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const run = argv.length === 1 && argv[0] === '--selftest' ? selftest() : main(argv, realDeps());
  Promise.resolve(run).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`agent-resolve: unexpected failure (${word(e && e.name)})\n`); process.exitCode = 1; });
}
