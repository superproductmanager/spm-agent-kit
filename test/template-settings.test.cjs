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
    'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/install-kit.sh" 0.1.0 REPLACE_WITH_SHA256_FROM_SHA256SUMS && bash "${SPM_AGENT_KIT_DIR:-$HOME/spm-agent-kit}/cloud-agent-setup.sh" --apply && (umask 077 && mkdir -p "$HOME/.spm-agent-state") && cp "$CLAUDE_PROJECT_DIR/spm-agent.config.json" "$HOME/.spm-agent-state/config.json"',
  );
  const parts = cmd.split(' && ');
  assert.match(parts[0], /install-kit\.sh" 0\.1\.0 /);
  assert.match(parts[1], /cloud-agent-setup\.sh" --apply$/);
  // the settings file is copied to a fixed path, because CLAUDE_PROJECT_DIR is set for hooks only, not for Claude's own commands
  assert.match(cmd, /cp "\$CLAUDE_PROJECT_DIR\/spm-agent\.config\.json" "\$HOME\/\.spm-agent-state\/config\.json"$/);
});

test('the hook command copies the settings file to the fixed path, in a shell', () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-hook-'));
  const home = path.join(dir, 'home'); const proj = path.join(dir, 'proj');
  fs.mkdirSync(home); fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'spm-agent.config.json'), '{"agent":{"name":"Example agent","email":"spm-example-agent@agents.invalid"}}\n');
  const tail = settings.hooks.SessionStart[0].hooks[0].command.split(' && ').slice(2).join(' && ');
  execFileSync('bash', ['-c', tail], { env: { PATH: process.env.PATH, HOME: home, CLAUDE_PROJECT_DIR: proj } });
  const copied = path.join(home, '.spm-agent-state', 'config.json');
  assert.equal(fs.readFileSync(copied, 'utf8'), fs.readFileSync(path.join(proj, 'spm-agent.config.json'), 'utf8'));
  assert.equal(fs.statSync(path.join(home, '.spm-agent-state')).mode & 0o777, 0o700);
});

test('permissions.allow holds exactly the reply, ack, resolve, relay, selfcheck and start rules', () => {
  assert.deepEqual([...settings.permissions.allow].sort(), [
    'Bash(bash */spm-agent-kit/start.sh *)',
    'Bash(node */spm-agent-kit/agent-ack.cjs *)',
    'Bash(node */spm-agent-kit/agent-relay.cjs *)',
    'Bash(node */spm-agent-kit/agent-reply.cjs *)',
    'Bash(node */spm-agent-kit/agent-resolve.cjs *)',
    'Bash(node */spm-agent-kit/agent-selfcheck.cjs *)',
  ]);
});
