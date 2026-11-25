#!/usr/bin/env node
'use strict';
/**
 * agent-call.cjs: make ONE SPM API call as the agent named in a settings file (0.4.0).
 * Optionally it acts on behalf of the person who tagged the agent, by sending that comment's id (--for-comment).
 *
 *   node agent-call.cjs --config <absolute path> --method GET|POST --path <api path>
 *                       [--workspace <slug or id>] [--for-comment <comment id>] [--body-file <absolute path>]
 *
 * --path is an API path such as /boardsApi/tasks/<id>/comments. It must start with one "/". The host is always the
 * settings file's backend.api_base: a full URL, a "//" path, a ".." segment or any other host is refused (exit 2) before any call.
 * Headers: X-SPM-API-Key (the key from key_file, or the network-secret placeholder when there is no key_file, as agent-reply.cjs does),
 * X-SPM-User-Email (the agent's address from the settings), X-SPM-Workspace when --workspace is given,
 * X-SPM-On-Behalf-Of-Comment when --for-comment is given.
 * Output: the JSON reply body on stdout and exit 0 on a 2xx. A 4xx prints "agent-call: HTTP <status> <error code>" on stderr and exits 2.
 * Anything else (a 5xx, no answer, an unreadable key) exits 1. The key is never printed.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { loadConfig, ConfigError } = require(path.join(__dirname, 'lib', 'config.cjs'));
const { keyMode, NETWORK_SECRET_VALUE, proxyUrl } = require(path.join(__dirname, 'lib', 'key-mode.cjs'));

const METHODS = ['GET', 'POST'];
const ORIGIN = 'https://app.superproductmanager.ai'; // sent on documentsApi paths, as agent-reply.cjs does on documents posts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKSPACE_RE = /^[A-Za-z0-9_-]{1,80}$/;
const PATH_RE = /^\/[A-Za-z0-9_\-./]+(\?[A-Za-z0-9_\-.=&%]*)?$/;
const MAX_PATH = 512;
const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 90000;
const USAGE = 'usage: node agent-call.cjs --config <absolute path> --method GET|POST --path <api path> [--workspace <slug or id>] [--for-comment <comment id>] [--body-file <absolute path>]';

const word = (x) => (typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(x) ? x : 'none');
const parseJson = (text) => { try { return JSON.parse(text); } catch (_) { return null; } };

/** An API path: one leading "/", no "//", no ".." segment, no full URL, no credentials, fragment or backslash. */
function isApiPath(p) {
  if (typeof p !== 'string' || p.length > MAX_PATH || !PATH_RE.test(p) || p.includes('//')) return false;
  return !p.split('?')[0].split('/').includes('..');
}

function withoutConfig(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--config') i++; else out.push(argv[i]); }
  return out;
}

/** Parses the flags other than --config. { ok: true, ... } or { ok: false, error }. Values are never echoed back. */
function parseCallArgs(argv) {
  const bad = (why) => ({ ok: false, error: why });
  const valued = ['--method', '--path', '--workspace', '--for-comment', '--body-file'];
  const v = {};
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (!valued.includes(f)) return bad('unknown or misplaced argument');
    if (Object.prototype.hasOwnProperty.call(v, f)) return bad(`${f} given twice`);
    if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) return bad(`${f} needs a value`);
    v[f] = String(argv[++i]);
  }
  const has = (f) => Object.prototype.hasOwnProperty.call(v, f);
  const method = (v['--method'] || '').toUpperCase();
  if (!METHODS.includes(method)) return bad('--method must be GET or POST');
  const apiPath = v['--path'];
  if (!has('--path') || !isApiPath(apiPath)) return bad('--path must be an API path starting with a single "/" (no full URL, no "//", no "..")');
  let workspace = null;
  if (has('--workspace')) {
    if (!WORKSPACE_RE.test(v['--workspace'])) return bad('--workspace must be a workspace slug or id (letters, digits, hyphens, underscores)');
    workspace = v['--workspace'];
  }
  let forComment = null;
  if (has('--for-comment')) {
    const fc = v['--for-comment'].trim().toLowerCase();
    if (!UUID_RE.test(fc)) return bad('--for-comment must be a comment id (a uuid)');
    forComment = fc;
  }
  let bodyFile = null;
  if (has('--body-file')) {
    if (method !== 'POST') return bad('--body-file goes with --method POST only');
    if (!path.isAbsolute(v['--body-file'])) return bad('--body-file must be an absolute path');
    bodyFile = v['--body-file'];
  }
  return { ok: true, method, path: apiPath, workspace, forComment, bodyFile };
}

// ---------------------------------------------------------------- the proxy: a real https call goes through HTTPS_PROXY when one is set (as agent-reply.cjs does)
let PROXY_AGENT = null; let PROXY_AGENT_FOR = null;
function proxyAgentFor(lib) {
  const p = proxyUrl(process.env);
  if (lib === http || !p) return false;
  if (PROXY_AGENT === null || PROXY_AGENT_FOR !== p) { PROXY_AGENT = new https.Agent({ proxyEnv: { HTTPS_PROXY: p } }); PROXY_AGENT_FOR = p; }
  return PROXY_AGENT;
}

/** The real transport. Tests pass lib = http and a resolveTarget that points at a local stub; production uses https on port 443. */
function makeTransport({ lib, resolveTarget }) {
  return function transport(url, method, headers, body, opts = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const t = resolveTarget(u);
      const h = { ...headers, host: u.host, accept: 'application/json' };
      if (body !== null && body !== undefined) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(body); }
      const ms = opts.timeoutMs || TIMEOUT_MS;
      let settled = false; let req = null;
      const done = (f, v) => { if (settled) return; settled = true; f(v); };
      const fail = (code) => { if (settled) return; if (req) req.destroy(); done(reject, Object.assign(new Error(code), { code })); };
      req = lib.request({ hostname: t.hostname, port: t.port, path: u.pathname + u.search, method, agent: proxyAgentFor(lib), headers: h }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => done(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('aborted', () => fail('ECONNRESET'));
        res.on('error', () => fail('ECONNRESET'));
      });
      req.setTimeout(ms, () => fail('ETIMEDOUT'));
      req.on('error', (e) => fail(word(e && e.code) === 'none' ? 'ECONNRESET' : e.code));
      if (body !== null && body !== undefined) req.write(body);
      req.end();
    });
  };
}

function realDeps() {
  return {
    io: { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') },
    env: process.env,
    http: makeTransport({ lib: https, resolveTarget: (u) => ({ hostname: u.hostname, port: 443 }) }),
    readKeyFile: (file) => { const k = fs.readFileSync(file, 'utf8').trim(); if (!k) throw Object.assign(new Error('empty key file'), { code: 'EMPTY' }); return k; },
  };
}

/** Runs one call. Returns the exit code: 0 (2xx), 2 (4xx or refused before any call), 1 (anything else). */
async function main(argv, deps = realDeps()) {
  const err = (s) => deps.io.err(`agent-call: ${s}`);
  let config;
  try { config = loadConfig({ argv, env: deps.env || process.env }); } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    err(e.message); return 2;
  }
  const parsed = parseCallArgs(withoutConfig(argv));
  if (!parsed.ok) { err(parsed.error); deps.io.err(USAGE); return 2; }
  // config.backend is the resolveBackend() output (lib/config.cjs), the same field agent-reply.cjs reads through applyBackend
  const backend = config.backend;
  const url = new URL(parsed.path, backend.api_base);
  if (url.hostname !== backend.api_host || url.origin !== new URL(backend.api_base).origin) { err('refused: the path leaves the configured host'); return 2; }
  const mode = keyMode(config, deps.env || process.env);
  if (mode.mode === 'refused') { err(mode.message); return 2; }
  let key;
  if (mode.mode === 'secret') key = NETWORK_SECRET_VALUE;
  else {
    try { key = deps.readKeyFile(config.keyFile); } catch (e) { err(`cannot read the key file (${word(e && e.code)})`); return 1; }
  }
  const scrub = (text) => (typeof key === 'string' && key.length >= 8 ? String(text).split(key).join('[redacted]') : String(text));
  let body = null;
  if (parsed.bodyFile) {
    let raw;
    try { raw = fs.readFileSync(parsed.bodyFile, 'utf8'); } catch (e) { err(`cannot read --body-file (${word(e && e.code)})`); return 2; }
    const obj = parseJson(raw);
    if (obj === null) { err('--body-file is not valid JSON'); return 2; }
    body = JSON.stringify(obj);
    if (Buffer.byteLength(body) > MAX_BODY) { err('--body-file is too large'); return 2; }
  }
  const headers = { 'X-SPM-API-Key': key, 'X-SPM-User-Email': config.email };
  if (parsed.workspace) headers['X-SPM-Workspace'] = parsed.workspace;
  if (parsed.forComment) headers['X-SPM-On-Behalf-Of-Comment'] = parsed.forComment;
  if (url.pathname.startsWith('/documentsApi/')) headers.Origin = ORIGIN;
  let res;
  try { res = await deps.http(url.href, parsed.method, headers, body, { timeoutMs: TIMEOUT_MS }); } catch (e) {
    err(`no answer from the server (${word(e && e.code)}); nothing was returned`); return 1;
  }
  if (res.status >= 200 && res.status < 300) { deps.io.out(scrub(res.text)); return 0; }
  const j = parseJson(res.text);
  const code = j && typeof j.code === 'string' && /^[a-z0-9_]{1,64}$/.test(j.code) ? j.code : 'none';
  err(`HTTP ${res.status} ${code}`);
  return res.status >= 400 && res.status < 500 ? 2 : 1;
}

module.exports = { main, parseCallArgs, makeTransport, realDeps, isApiPath };

if (require.main === module) {
  main(process.argv.slice(2), realDeps()).then((code) => { process.exitCode = code; }, () => {
    process.stderr.write('agent-call: unexpected failure\n'); process.exitCode = 1;
  });
}
