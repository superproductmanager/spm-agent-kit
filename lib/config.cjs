'use strict';
// Reads the agent settings file. Path: --config <absolute path>, else the SPM_AGENT_CONFIG environment variable.
// File shape: { "agent": { "name": "Example agent", "email": "spm-example-agent@agents.invalid" }, "key_file": "/abs/path/example-agent.key", "ignore_agents": ["Other agent"] }
// key_file is optional here; a script that needs a key refuses without it. ignore_agents is optional (names of other agents whose comments are not tags for this one).
const fs = require('node:fs');
const path = require('node:path');

class ConfigError extends Error {}

function configPath(argv, env) {
  const i = argv.indexOf('--config');
  if (i !== -1) {
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new ConfigError('--config needs a value');
    return v;
  }
  if (env.SPM_AGENT_CONFIG) return env.SPM_AGENT_CONFIG;
  throw new ConfigError('no settings file: pass --config <absolute path> or set SPM_AGENT_CONFIG');
}

function loadConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const p = configPath(argv, env);
  if (!path.isAbsolute(p)) throw new ConfigError('the settings file path must be absolute');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { throw new ConfigError(`cannot read the settings file (${e.code || 'error'})`); }
  let c;
  try { c = JSON.parse(raw); } catch { throw new ConfigError('the settings file is not valid JSON'); }
  const a = c && typeof c === 'object' ? c.agent : null;
  if (!a || typeof a.name !== 'string' || !a.name.trim()) throw new ConfigError('agent.name is missing');
  if (typeof a.email !== 'string' || !/^[a-z0-9._-]+@agents\.invalid$/.test(a.email)) throw new ConfigError('agent.email must be a lower-case address ending in @agents.invalid');
  let keyFile = null;
  if (c.key_file !== undefined) {
    if (typeof c.key_file !== 'string' || !path.isAbsolute(c.key_file)) throw new ConfigError('key_file must be an absolute path');
    keyFile = c.key_file;
  }
  const ignore = Array.isArray(c.ignore_agents) ? c.ignore_agents.filter((x) => typeof x === 'string' && x.trim()) : [];
  return { name: a.name.trim(), email: a.email, keyFile, ignoreAgents: ignore, configPath: p };
}

module.exports = { loadConfig, ConfigError };
