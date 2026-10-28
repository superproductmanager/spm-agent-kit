'use strict';
// Guard: the public repo must hold no real people, customers, addresses, internal paths or keys.
// Walks every file in the repo at run time (no fixed list), except .git/ and node_modules/
// and the files that hold the guard's own shapes (SKIP_FILES).
// Names and internal words are not written in this repo; a private check for them runs before each release push.
// Key shapes live in lib/secret-patterns.txt, and the exact test fakes that may carry them live in scripts/allowed-fakes.txt.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

const FILES = textFiles();

test('scans files found on disk at run time (not a fixed list)', () => {
  const names = FILES.map((f) => f.rel);
  assert.ok(names.includes('README.md'), 'README.md should be in the scan');
  assert.ok(names.includes('setup-env.sh'), 'the kit scripts should be in the scan');
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

// Generic shapes stay as plain regexes: they name no person, customer or company.
const PLAIN = [
  '/Users/',
  '/home/user',
  '\\.(js|cjs|mjs):\\d+',
  '\\bRS-\\d+',
  '-spec-20',
  '\\b\\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* 20\\d\\d\\b',
];
test('no internal paths, file:line references, RS numbers or dated build notes', () => {
  const hits = [];
  for (const src of PLAIN) hits.push(...findAll(FILES, new RegExp(src, 'g'), () => false, `[${src}] `));
  assert.deepEqual(hits, []);
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
