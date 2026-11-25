'use strict';
// The SPM server the kit talks to (0.3.0). One place for the host, the Firebase project and the web key.
// settings file: optional "backend": { "api_base": "https://<functions host>", "firebase_project": "<id>", "firebase_web_key": "<key>" }
// Every field is optional. An absent field takes today's litethink value, so an install without a backend block behaves
// exactly as in 0.2.x. api_base is the origin of the functions host only (https, no path, port, query or credentials);
// the scripts add their own service paths (/accountApi, /documentsApi, /boardsApi, /mapsApi, /getRealtimeToken).
// firebase_web_key: when absent the kit reads the web key from its usual key sources (null here).

class BackendError extends Error {}

const DEFAULT_BACKEND = Object.freeze({
  api_base: 'https://asia-south1-litethink.cloudfunctions.net',
  api_host: 'asia-south1-litethink.cloudfunctions.net',
  firebase_project: 'litethink',
  firebase_web_key: null,
});

const PROJECT_RE = /^[a-z][a-z0-9-]{3,29}$/;
const WEB_KEY_RE = /^[A-Za-z0-9_-]{20,80}$/;

/** Returns { api_base, api_host, firebase_project, firebase_web_key } for a parsed settings object. Throws BackendError. */
function resolveBackend(settings) {
  const raw = settings && typeof settings === 'object' ? settings.backend : undefined;
  if (raw === undefined || raw === null) return { ...DEFAULT_BACKEND };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BackendError('backend must be an object');
  const out = { ...DEFAULT_BACKEND };
  if (raw.api_base !== undefined) {
    if (typeof raw.api_base !== 'string') throw new BackendError('backend.api_base must be a string');
    let u = null;
    try { u = new URL(raw.api_base); } catch (_) { u = null; }
    if (!u || u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '' || (u.pathname !== '/' && u.pathname !== '')) {
      throw new BackendError('backend.api_base must be an https origin with no path, port, query or credentials');
    }
    out.api_base = u.origin;
    out.api_host = u.hostname;
  }
  if (raw.firebase_project !== undefined) {
    if (typeof raw.firebase_project !== 'string' || !PROJECT_RE.test(raw.firebase_project)) throw new BackendError('backend.firebase_project must be 4 to 30 lower-case letters, digits or hyphens');
    out.firebase_project = raw.firebase_project;
  }
  if (raw.firebase_web_key !== undefined) {
    if (typeof raw.firebase_web_key !== 'string' || !WEB_KEY_RE.test(raw.firebase_web_key)) throw new BackendError('backend.firebase_web_key must be 20 to 80 letters, digits, hyphens or underscores');
    out.firebase_web_key = raw.firebase_web_key;
  }
  return out;
}

module.exports = { resolveBackend, DEFAULT_BACKEND, BackendError };
