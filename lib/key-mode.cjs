'use strict';
// Key modes (K-A3 item 1). A settings file with key_file reads the key from that file, as before.
// A settings file with no key_file is network-secret mode: the Claude cloud environment adds the real
// key to SPM calls as a network secret, so the scripts send the fixed placeholder below as X-SPM-API-Key
// and never read a key file. Every SPM call in this mode must go through the cloud proxy (HTTPS_PROXY),
// so without a proxy the script refuses before any call.
const NETWORK_SECRET_VALUE = 'network-secret';
const NO_PROXY_REFUSAL = 'network-secret mode needs the Claude cloud proxy; set key_file to run elsewhere';

/** The proxy URL the transports use (the same variables, in the same order, as the scripts' proxy agents). */
function proxyUrl(env = process.env) {
  return env.HTTPS_PROXY || env.https_proxy || null;
}

/**
 * { mode: 'file' } when the settings file names a key_file; { mode: 'secret', key } when it does not and the
 * proxy is set; { mode: 'refused', message } when it does not and no proxy is set.
 */
function keyMode(config, env = process.env) {
  if (config.keyFile) return { mode: 'file' };
  if (!proxyUrl(env)) return { mode: 'refused', message: NO_PROXY_REFUSAL };
  return { mode: 'secret', key: NETWORK_SECRET_VALUE };
}

module.exports = { NETWORK_SECRET_VALUE, NO_PROXY_REFUSAL, proxyUrl, keyMode };
