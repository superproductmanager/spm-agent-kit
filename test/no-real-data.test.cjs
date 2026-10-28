'use strict';
// Guard: the public repo must hold no real people, customers, addresses, internal paths or keys.
// Walks every file in the repo at run time (no fixed list), except .git/ and node_modules/
// and the files that hold the guard's own shapes (SKIP_FILES).
// Names and internal words are never written in this repo as text: test/banned-hashes.json holds
// only their SHA-256 hashes (made by scripts/hash-term.cjs). Key shapes live in lib/secret-patterns.txt,
// and the exact test fakes that may carry them live in scripts/allowed-fakes.txt.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findSecrets, loadAllowedFakes } = require('../lib/secret-patterns.cjs');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules']);
// This guard, the secret scanner, its test, and the licence skip themselves by path.
const SKIP_FILES = new Set([
  'test/no-real-data.test.cjs',
  'scripts/secret-scan.sh',
  'test/secret-scan.test.cjs',
  'LICENSE',
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// Text of every scanned file, split into lines, skipping binary files and SKIP_FILES.
function textFiles() {
  const result = [];
  for (const abs of walk(ROOT)) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (SKIP_FILES.has(rel)) continue;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) continue;
    result.push({ rel, lines: buf.toString('utf8').split('\n') });
  }
  return result;
}

// "file:line: label match" for every match of regex that allowed() does not accept.
function findAll(files, regex, allowed = () => false, label = '') {
  const hits = [];
  for (const f of files) {
    f.lines.forEach((line, i) => {
      for (const m of line.matchAll(regex)) {
        if (!allowed(m)) hits.push(`${f.rel}:${i + 1}: ${label}${m[0]}`);
      }
    });
  }
  return hits;
}

// The hashing rule for banned terms: the tokens of the term (lower-cased unless cs), joined by one space, SHA-256.
const tokens = (s) => s.match(/[A-Za-z0-9]+/g) || [];
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
function hashTerm(term, cs) {
  return sha256(tokens(cs ? term : term.toLowerCase()).join(' '));
}

// "file:line: banned term <8 hex>" for each line holding a banned 1-to-4-token gram. Never the text itself.
function bannedHits(files, entries) {
  const byHash = new Map(entries.map((e) => [e.h, e]));
  const hits = [];
  for (const f of files) {
    f.lines.forEach((line, i) => {
      const toks = tokens(line);
      const reported = new Set();
      for (let n = 1; n <= 4; n++) {
        for (let s = 0; s + n <= toks.length; s++) {
          const gram = toks.slice(s, s + n).join(' ');
          const raw = byHash.get(sha256(gram));
          const low = byHash.get(sha256(gram.toLowerCase()));
          const e = raw && raw.cs ? raw : low && !low.cs ? low : null;
          if (e && !reported.has(e.h)) {
            reported.add(e.h);
            hits.push(`${f.rel}:${i + 1}: banned term ${e.h.slice(0, 8)}`);
          }
        }
      }
    });
  }
  return hits;
}

const FILES = textFiles();

test('scans files found on disk at run time (not a fixed list)', () => {
  const names = FILES.map((f) => f.rel);
  assert.ok(names.includes('README.md'), 'README.md should be in the scan');
  assert.ok(names.includes('templates/org-repo/spm-agent.config.example.json'), 'templates should be in the scan');
  assert.ok(!names.includes('LICENSE'), 'LICENSE skips itself');
});

const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
test('no real UUIDs (only the 00000000-0000-4000-8000-xxxxxxxxxxxx form)', () => {
  const hits = findAll(FILES, UUID, (m) => /^00000000-0000-4000-8000-[0-9a-f]{12}$/i.test(m[0]), 'uuid ');
  assert.deepEqual(hits, []);
});

// Addresses allowed at example.com, example.org, and any *.invalid.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
test('no real email addresses (only example.com, example.org, *.invalid)', () => {
  const hits = findAll(FILES, EMAIL, (m) => {
    const host = m[0].split('@')[1].toLowerCase();
    return host === 'example.com' || host.endsWith('.example.com')
      || host === 'example.org' || host.endsWith('.example.org')
      || host === 'invalid' || host.endsWith('.invalid');
  }, 'address ');
  assert.deepEqual(hits, []);
});

// Banned names and words: hashes only (test/banned-hashes.json, one { h, cs } per entry).
const BANNED = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'banned-hashes.json'), 'utf8'));
test('banned-hashes.json holds only { h, cs } entries (sha-256 hex, boolean cs)', () => {
  assert.ok(Array.isArray(BANNED) && BANNED.length > 0);
  for (const e of BANNED) {
    assert.deepEqual(Object.keys(e).sort(), ['cs', 'h']);
    assert.match(e.h, /^[0-9a-f]{64}$/);
    assert.equal(typeof e.cs, 'boolean');
  }
});

// Generic shapes stay as plain regexes: they name no person, customer or company.
const PLAIN = [
  '/Users/',
  '/home/user',
  '\\.(js|cjs|mjs):\\d+',
  '\\bRS-\\d+',
  '-spec-20',
  '\\b\\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* 20\\d\\d\\b',
];
test('no banned names (hashed), internal paths, file:line references or dated build notes', () => {
  const hits = bannedHits(FILES, BANNED);
  for (const src of PLAIN) hits.push(...findAll(FILES, new RegExp(src, 'g'), () => false, `[${src}] `));
  assert.deepEqual(hits, []);
});

test('self-test: a planted banned term is a hit, its case-sensitive twin and an ordinary sentence are not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-real-data-'));
  try {
    const f = path.join(dir, 'planted.txt');
    fs.writeFileSync(f, 'first line\nthe ZEBRA quokka came back\n');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const ci = [{ h: hashTerm('Zebra Quokka', false), cs: false }];
    assert.deepEqual(bannedHits([{ rel: 'planted.txt', lines }], ci), [`planted.txt:2: banned term ${ci[0].h.slice(0, 8)}`]);
    const cs = [{ h: hashTerm('Zebra Quokka', true), cs: true }];
    assert.deepEqual(bannedHits([{ rel: 'planted.txt', lines }], cs), []);
    fs.writeFileSync(f, 'the settings file is in the kit folder\n');
    const plain = fs.readFileSync(f, 'utf8').split('\n');
    assert.deepEqual(bannedHits([{ rel: 'planted.txt', lines: plain }], ci), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Key shapes: the one list in lib/secret-patterns.txt, with the exact fakes in scripts/allowed-fakes.txt.
const ALLOWED = loadAllowedFakes();
test('allowed fakes: every listed value holds FAKE or TEST, and no value is listed twice', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'scripts', 'allowed-fakes.txt'), 'utf8').split('\n').filter(Boolean);
  assert.equal(new Set(lines).size, lines.length, 'a value is listed twice');
  const bad = [];
  lines.forEach((v, i) => { if (!/fake|test/i.test(v)) bad.push(i + 1); });
  assert.deepEqual(bad, [], 'line numbers of values that hold neither FAKE nor TEST');
});

test('no secret-shaped value outside the exact allowed list', () => {
  const hits = [];
  for (const f of FILES) {
    for (const h of findSecrets(f.lines.join('\n'), ALLOWED)) hits.push(`${f.rel}:${h.line}: ${h.name}`);
  }
  assert.deepEqual(hits, []);
});
