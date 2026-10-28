#!/usr/bin/env node
'use strict';
// Prints the test/banned-hashes.json entry for ONE term read from stdin.
//   printf '%s' '<term>' | node scripts/hash-term.cjs [--case-sensitive]
// Output: {"h":"<sha-256 hex>","cs":true|false}. The term is never printed or echoed.
// Rule: the tokens of the term (/[A-Za-z0-9]+/g, lower-cased unless --case-sensitive), joined by one space, SHA-256 (UTF-8).
// A term has 1 to 4 tokens.
const crypto = require('node:crypto');

const cs = process.argv.slice(2).includes('--case-sensitive');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const term = input.replace(/\r?\n$/, '');
  if (term.includes('\n') || term.length === 0) {
    process.stderr.write('hash-term: stdin must hold exactly one non-empty line\n');
    process.exitCode = 2;
    return;
  }
  const toks = (cs ? term : term.toLowerCase()).match(/[A-Za-z0-9]+/g) || [];
  if (toks.length < 1 || toks.length > 4) {
    process.stderr.write('hash-term: a term must have 1 to 4 tokens\n');
    process.exitCode = 2;
    return;
  }
  const h = crypto.createHash('sha256').update(toks.join(' '), 'utf8').digest('hex');
  process.stdout.write(JSON.stringify({ h, cs }) + '\n');
});
