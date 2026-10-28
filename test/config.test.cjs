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

test('transport defaults to node when the key is absent', () => {
  const c = loadConfig({ argv: ['--config', write('no-transport.json', good)], env: {} });
  assert.equal(c.transport, 'node');
});

test('transport accepts node and webchannel', () => {
  const n = loadConfig({ argv: ['--config', write('t-node.json', { ...good, transport: 'node' })], env: {} });
  assert.equal(n.transport, 'node');
  const w = loadConfig({ argv: ['--config', write('t-web.json', { ...good, transport: 'webchannel' })], env: {} });
  assert.equal(w.transport, 'webchannel');
});

test('any other transport value is refused with one line', () => {
  for (const bad of ['grpc', 'Node', '', null, 3]) {
    const p = write(`t-bad-${String(bad)}.json`, { ...good, transport: bad });
    assert.throws(() => loadConfig({ argv: ['--config', p], env: {} }), (e) => e instanceof ConfigError && e.message === 'transport must be "node" or "webchannel"', `value ${JSON.stringify(bad)}`);
  }
});

// ---- app_id: the public SPM app id, optional in the settings file ----
const APP_ID = 'example-app-id-0000000000000000';

test('a settings file with a valid app_id loads and returns appId', () => {
  const c = loadConfig({ argv: ['--config', write('app.json', { ...good, app_id: APP_ID })], env: {} });
  assert.equal(c.appId, APP_ID);
});

test('without app_id, appId is null and the load still succeeds', () => {
  const c = loadConfig({ argv: ['--config', write('noapp.json', good)], env: {} });
  assert.equal(c.appId, null);
});

test('an app_id outside ^[A-Za-z0-9_-]{20,60}$ is a ConfigError', () => {
  for (const bad of ['short', 'has space in it 000000000000', 'a'.repeat(61), 42]) {
    assert.throws(
      () => loadConfig({ argv: ['--config', write('badapp.json', { ...good, app_id: bad })], env: {} }),
      ConfigError,
      `app_id ${JSON.stringify(bad)} should be refused`,
    );
  }
});

// ---- the web key: env wins, then the settings file's app_id, else no key (today's failure) ----
const { loadWebKeyFrom } = require('../agent-listen.cjs');

test('env FIREBASE_API_KEY wins over the settings file app_id', () => {
  assert.equal(loadWebKeyFrom({ FIREBASE_API_KEY: 'example-env-app-id-00000000000' }, APP_ID), 'example-env-app-id-00000000000');
});

test('an empty env value does not win: the settings file app_id is used', () => {
  assert.equal(loadWebKeyFrom({ FIREBASE_API_KEY: '' }, APP_ID), APP_ID);
});

test('with no env value, the settings file app_id is used', () => {
  assert.equal(loadWebKeyFrom({}, APP_ID), APP_ID);
});

test('with neither env nor app_id, loadWebKeyFrom still throws (today\'s failure)', () => {
  assert.throws(() => loadWebKeyFrom({}, null), /no firebase web api key found/);
  assert.throws(() => loadWebKeyFrom({}), /no firebase web api key found/);
});
