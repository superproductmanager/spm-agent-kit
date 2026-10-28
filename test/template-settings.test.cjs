'use strict';
// Tests for templates/org-repo/.claude/settings.json: one SessionStart command that installs the kit and the
// Firebase SDK, and the exact allow rules. Parses the real JSON file; nothing is run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SETTINGS = path.join(__dirname, '..', 'templates', 'org-repo', '.claude', 'settings.json');
const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));

test('SessionStart has exactly one hook, and it installs the kit and the Firebase SDK joined by &&', () => {
  const hooks = settings.hooks.SessionStart.flatMap((entry) => entry.hooks);
  assert.equal(hooks.length, 1, 'hooks in one entry run in parallel, so there must be exactly one command');
  const cmd = hooks[0].command;
  assert.equal(hooks[0].type, 'command');
  assert.equal(
    cmd,
    'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/install-kit.sh" 0.1.0 REPLACE_WITH_SHA256_FROM_SHA256SUMS && bash "${SPM_AGENT_KIT_DIR:-$HOME/spm-agent-kit}/cloud-agent-setup.sh" --apply',
  );
  const parts = cmd.split(' && ');
  assert.equal(parts.length, 2);
  assert.match(parts[0], /install-kit\.sh" 0\.1\.0 /);
  assert.match(parts[1], /cloud-agent-setup\.sh" --apply$/);
});

test('permissions.allow holds exactly the reply, ack, resolve, relay and start rules', () => {
  assert.deepEqual([...settings.permissions.allow].sort(), [
    'Bash(bash */spm-agent-kit/start.sh *)',
    'Bash(node */spm-agent-kit/agent-ack.cjs *)',
    'Bash(node */spm-agent-kit/agent-relay.cjs *)',
    'Bash(node */spm-agent-kit/agent-reply.cjs *)',
    'Bash(node */spm-agent-kit/agent-resolve.cjs *)',
  ]);
});
