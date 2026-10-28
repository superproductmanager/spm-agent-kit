'use strict';
// Tests for lib/config.cjs: where the settings file comes from and what it must contain.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, ConfigError } = require('../lib/config.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-kit-config-'));
const good = { agent: { name: 'Example agent', email: 'spm-example-agent@agents.invalid' }, key_file: path.join(dir, 'example.key') };

function write(name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
}

test('--config wins over SPM_AGENT_CONFIG', () => {
  const flagFile = write('flag.json', good);
  const envFile = write('env.json', { ...good, agent: { name: 'Other agent', email: 'other-agent@agents.invalid' } });
  const c = loadConfig({ argv: ['--config', flagFile], env: { SPM_AGENT_CONFIG: envFile } });
  assert.equal(c.name, 'Example agent');
  assert.equal(c.configPath, flagFile);
});

test('SPM_AGENT_CONFIG is used when no --config flag is given', () => {
  const envFile = write('env-only.json', good);
  const c = loadConfig({ argv: [], env: { SPM_AGENT_CONFIG: envFile } });
  assert.equal(c.email, 'spm-example-agent@agents.invalid');
  assert.equal(c.keyFile, good.key_file);
  assert.equal(c.configPath, envFile);
});

test('no flag and no env var is refused with a plain message', () => {
  assert.throws(() => loadConfig({ argv: [], env: {} }), (e) => e instanceof ConfigError && /no settings file/.test(e.message));
});

test('--config with no value is refused', () => {
  assert.throws(() => loadConfig({ argv: ['--config'], env: {} }), (e) => e instanceof ConfigError && /needs a value/.test(e.message));
  assert.throws(() => loadConfig({ argv: ['--config', '--other'], env: {} }), ConfigError);
});

test('a relative settings path is refused, from the flag or the env var', () => {
  assert.throws(() => loadConfig({ argv: ['--config', 'relative/agent.json'], env: {} }), (e) => e instanceof ConfigError && /must be absolute/.test(e.message));
  assert.throws(() => loadConfig({ argv: [], env: { SPM_AGENT_CONFIG: 'agent.json' } }), (e) => e instanceof ConfigError && /must be absolute/.test(e.message));
});

test('a missing settings file is refused', () => {
  const missing = path.join(dir, 'does-not-exist.json');
  assert.throws(() => loadConfig({ argv: ['--config', missing], env: {} }), (e) => e instanceof ConfigError && /cannot read the settings file/.test(e.message));
});

test('a settings file that is not JSON is refused', () => {
  const p = write('bad.json', '{ not json');
  assert.throws(() => loadConfig({ argv: ['--config', p], env: {} }), (e) => e instanceof ConfigError && /not valid JSON/.test(e.message));
});

test('a settings file with no agent name is refused', () => {
  const p = write('noname.json', { agent: { email: 'spm-example-agent@agents.invalid' } });
  assert.throws(() => loadConfig({ argv: ['--config', p], env: {} }), (e) => e instanceof ConfigError && /agent\.name is missing/.test(e.message));
  const blank = write('blankname.json', { agent: { name: '   ', email: 'spm-example-agent@agents.invalid' } });
  assert.throws(() => loadConfig({ argv: ['--config', blank], env: {} }), ConfigError);
});

test('an upper-case address is refused', () => {
  const p = write('upper.json', { agent: { name: 'Example agent', email: 'SPM-Example-Agent@agents.invalid' } });
  assert.throws(() => loadConfig({ argv: ['--config', p], env: {} }), (e) => e instanceof ConfigError && /lower-case address ending in @agents\.invalid/.test(e.message));
});

test('an address outside the agents.invalid domain is refused', () => {
  const p = write('domain.json', { agent: { name: 'Example agent', email: 'spm-example-agent@example.com' } });
  assert.throws(() => loadConfig({ argv: ['--config', p], env: {} }), ConfigError);
});

test('a relative key_file is refused', () => {
  const p = write('relkey.json', { ...good, key_file: 'example.key' });
  assert.throws(() => loadConfig({ argv: ['--config', p], env: {} }), (e) => e instanceof ConfigError && /key_file must be an absolute path/.test(e.message));
});

test('key_file is optional and ignore_agents keeps only non-empty names', () => {
  const p = write('nokey.json', { agent: { name: 'Example agent', email: 'spm-example-agent@agents.invalid' }, ignore_agents: ['Other agent', '', 7, '  '] });
  const c = loadConfig({ argv: ['--config', p], env: {} });
  assert.equal(c.keyFile, null);
  assert.deepEqual(c.ignoreAgents, ['Other agent']);
});

test('ignore_agents is empty when absent', () => {
  const c = loadConfig({ argv: ['--config', write('plain.json', good)], env: {} });
  assert.deepEqual(c.ignoreAgents, []);
});
