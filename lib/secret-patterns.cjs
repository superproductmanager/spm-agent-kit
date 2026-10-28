'use strict';
// The one list of key shapes (lib/secret-patterns.txt). Used by the repo scan test, by agent-reply.cjs and,
// through the same file, by scripts/secret-scan.sh. Findings carry the shape name and the line number only.
const fs = require('node:fs');
const path = require('node:path');

const PATTERNS_FILE = path.join(__dirname, 'secret-patterns.txt');
const ALLOWED_FILE = path.join(__dirname, '..', 'scripts', 'allowed-fakes.txt');

// "name|pattern" lines; # comments and blank lines are skipped. The pattern is kept as written (a tab inside it counts).
function parsePatterns(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('#')) continue;
    const i = line.indexOf('|');
    if (i < 1) throw new Error('secret-patterns: each line needs name|pattern');
    out.push({ name: line.slice(0, i), src: line.slice(i + 1) });
  }
  return out;
}

const PATTERNS = parsePatterns(fs.readFileSync(PATTERNS_FILE, 'utf8')).map(({ name, src }) => ({ name, re: new RegExp(src, 'g') }));

// The exact test fakes that may carry a key shape: one per line.
function loadAllowedFakes(file = ALLOWED_FILE) {
  return new Set(fs.readFileSync(file, 'utf8').split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s.length > 0));
}

// The matched token, without the one leading boundary character a pattern may consume.
function tokenOf(match) {
  return /^[^A-Za-z0-9_]/.test(match) ? match.slice(1) : match;
}

// [{ name, line }] for each line with a match whose token is not in allowed (a Set of exact values). Never the text.
function findSecrets(text, allowed = new Set()) {
  const hits = [];
  const seen = new Set();
  text.split('\n').forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      for (const m of line.matchAll(re)) {
        if (allowed.has(tokenOf(m[0]))) continue;
        const key = `${name}\u0000${i + 1}`;
        if (!seen.has(key)) {
          seen.add(key);
          hits.push({ name, line: i + 1 });
        }
      }
    }
  });
  return hits;
}

module.exports = { PATTERNS, parsePatterns, findSecrets, loadAllowedFakes, tokenOf };
