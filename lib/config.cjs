'use strict';
// Reads the agent settings file. Path: --config <absolute path>, else the SPM_AGENT_CONFIG environment variable.
// File shape: { "agent": { "name": "Example agent", "email": "spm-example-agent@agents.invalid" }, "key_file": "/abs/path/example-agent.key", "ignore_agents": ["Other agent"] }
// agent is optional in 0.2.0: setup-env.sh may write no agent block, and agent-health.cjs start writes it once SPM has answered.
// loadConfig (strict) is for the scripts that need the agent; loadConfigOptionalAgent accepts a missing agent (name and email are null then).
// key_file is optional here; a script that needs a key refuses without it. ignore_agents is optional (names of other agents whose comments are not tags for this one).
// transport is optional: "node" (default) or "webchannel" (how agent-listen.cjs talks to Firestore; see the README).
const fs = require('node:fs');
const path = require('node:path');

class ConfigError extends Error {}
const TRANSPORTS = ['node', 'webchannel'];
const APP_ID_RE = /^[A-Za-z0-9_-]{20,60}$/;
const KIT = path.resolve(__dirname, '..');

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

function readSettings(argv, env) {
  const p = configPath(argv, env);
  if (!path.isAbsolute(p)) throw new ConfigError('the settings file path must be absolute');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { throw new ConfigError(`cannot read the settings file (${e.code || 'error'})`); }
  let c;
  try { c = JSON.parse(raw); } catch { throw new ConfigError('the settings file is not valid JSON'); }
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new ConfigError('the settings file is not a JSON object');
  return { c, p };
}

// The fields every loader reads the same way. agent is checked by the caller.
function restOf(c, p) {
  let keyFile = null;
  if (c.key_file !== undefined) {
    if (typeof c.key_file !== 'string' || !path.isAbsolute(c.key_file)) throw new ConfigError('key_file must be an absolute path');
    keyFile = c.key_file;
  }
  const ignore = Array.isArray(c.ignore_agents) ? c.ignore_agents.filter((x) => typeof x === 'string' && x.trim()) : [];
  let transport = 'node';
  if (c.transport !== undefined) {
    if (typeof c.transport !== 'string' || !TRANSPORTS.includes(c.transport)) throw new ConfigError('transport must be "node" or "webchannel"');
    transport = c.transport;
  }
  let appId = null;
  if (c.app_id !== undefined) {
    if (typeof c.app_id !== 'string' || !APP_ID_RE.test(c.app_id)) throw new ConfigError('app_id must be 20 to 60 letters, digits, hyphens or underscores');
    appId = c.app_id;
  }
  // report (Addendum A4): false opts the agent out of sending health reports; absent means on.
  let report = true;
  if (c.report !== undefined) {
    if (typeof c.report !== 'boolean') throw new ConfigError('report must be true or false');
    report = c.report;
  }
  // autostart (Addendum B1): false turns the agent's automatic start off here; absent means on.
  let autostart = true;
  if (c.autostart !== undefined) {
    if (typeof c.autostart !== 'boolean') throw new ConfigError('autostart must be true or false');
    autostart = c.autostart;
  }
  return { keyFile, ignoreAgents: ignore, transport, appId, report, autostart, configPath: p };
}

/** Strict: the agent must be in the file. Scripts that talk to SPM as the agent use this. */
function loadConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const { c, p } = readSettings(argv, env);
  if (c.agent === undefined || c.agent === null) {
    throw new ConfigError(`the agent is not identified yet: run node ${KIT}/agent-health.cjs start --config ${p}`);
  }
  const a = c.agent;
  if (typeof a !== 'object' || Array.isArray(a) || typeof a.name !== 'string' || !a.name.trim()) throw new ConfigError('agent.name is missing');
  if (typeof a.email !== 'string' || !/^[a-z0-9._-]+@agents\.invalid$/.test(a.email)) throw new ConfigError('agent.email must be a lower-case address ending in @agents.invalid');
  return { name: a.name.trim(), email: a.email, ...restOf(c, p) };
}

/** Optional agent: for setup and identity steps. name and email are null when the file has no agent. A present agent is validated as strictly. */
function loadConfigOptionalAgent({ argv = process.argv.slice(2), env = process.env } = {}) {
  const { c, p } = readSettings(argv, env);
  if (c.agent === undefined || c.agent === null) return { name: null, email: null, ...restOf(c, p) };
  const a = c.agent;
  if (typeof a !== 'object' || Array.isArray(a) || typeof a.name !== 'string' || !a.name.trim()) throw new ConfigError('agent.name is missing');
  if (typeof a.email !== 'string' || !/^[a-z0-9._-]+@agents\.invalid$/.test(a.email)) throw new ConfigError('agent.email must be a lower-case address ending in @agents.invalid');
  return { name: a.name.trim(), email: a.email, ...restOf(c, p) };
}

module.exports = { loadConfig, loadConfigOptionalAgent, ConfigError };
