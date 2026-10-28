'use strict';
// LIVE check of the two Firestore transports (node and webchannel). NOT part of `node --test test/*.test.cjs`.
// It runs only with SPM_LIVE=1. It needs FIREBASE_API_KEY (the public web key of the project) and SPM_AGENT_RUNTIME_DIR
// (the folder where cloud-agent-setup.sh installed the Firebase SDK).
// For each transport it starts a child process (the SDK loads once per process) that initialises the app WITHOUT signing
// in and listens to signals/<64 zero hex>. Through the proxy, an unsigned listen must end with permission-denied within 15 s.
// The child is started the way start.sh starts the listener: NODE_USE_ENV_PROXY=1, the proxy variables passed through.
// Prints one line per transport and exits 0 only when both transports end in permission-denied. Never prints the key.
// Run: SPM_LIVE=1 FIREBASE_API_KEY=<key> SPM_AGENT_RUNTIME_DIR=<sdk folder> node test/firestore-transport.live.cjs
const { spawn } = require('node:child_process');
const path = require('node:path');

const LISTENER = path.join(__dirname, '..', 'agent-listen.cjs');
const ZEROS = '0'.repeat(64);
const WAIT_MS = 15000;
const KILL_MS = 25000;

if (process.env.SPM_LIVE !== '1') {
  console.log('SKIP: set SPM_LIVE=1 (with FIREBASE_API_KEY and SPM_AGENT_RUNTIME_DIR) to run the live transport check');
  process.exit(0);
}
const apiKey = process.env.FIREBASE_API_KEY;
const runtimeDir = process.env.SPM_AGENT_RUNTIME_DIR;
if (!apiKey || !runtimeDir) {
  console.error('live check needs FIREBASE_API_KEY and SPM_AGENT_RUNTIME_DIR set');
  process.exit(2);
}

// The child: loads the real listener module, starts the app with no sign-in, listens once, prints one RESULT line and exits.
const CHILD = `
const m = require(process.argv[1]);
const t = process.argv[2];
const started = Date.now();
const out = (s) => process.stdout.write(s + '\\n');
const finish = (code, ms) => { out('RESULT ' + code + ' ' + ms); process.exit(0); };
try {
  const s = m.loadSdk(t);
  s.appInst = s.app.initializeApp({ apiKey: process.env.FIREBASE_API_KEY, projectId: 'litethink' }, 'live-check-' + t);
  s.db = t === 'webchannel'
    ? s.fs.initializeFirestore(s.appInst, { experimentalForceLongPolling: true, useFetchStreams: true })
    : s.fs.getFirestore(s.appInst);
  const timer = setTimeout(() => finish('TIMEOUT', Date.now() - started), ${WAIT_MS});
  s.fs.onSnapshot(s.fs.doc(s.db, 'signals', '${ZEROS}'), () => {}, (err) => {
    clearTimeout(timer);
    const code = err && typeof err.code === 'string' && /^[a-z-]{1,40}$/.test(err.code) ? err.code : 'error';
    finish(code, Date.now() - started);
  });
} catch (e) {
  out('RESULT child-failed 0');
  process.exit(0);
}
`;

function childEnv() {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, SPM_AGENT_RUNTIME_DIR: runtimeDir, FIREBASE_API_KEY: apiKey, NODE_USE_ENV_PROXY: '1' };
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

function runTransport(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD, LISTENER, name], { env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), KILL_MS);
    child.on('close', () => {
      clearTimeout(killer);
      const m = /^RESULT (\S+) (\d+)$/m.exec(stdout);
      resolve(m ? { code: m[1], ms: Number(m[2]) } : { code: 'TIMEOUT', ms: null });
    });
  });
}

(async () => {
  let allOk = true;
  for (const name of ['node', 'webchannel']) {
    const r = await runTransport(name);
    if (r.code === 'permission-denied') {
      console.log(`transport ${name}: permission-denied in ${r.ms} ms`);
    } else if (r.code === 'TIMEOUT') {
      console.log(`transport ${name}: TIMEOUT`);
      allOk = false;
    } else {
      console.log(`transport ${name}: ${r.code} in ${r.ms} ms`);
      allOk = false;
    }
  }
  process.exit(allOk ? 0 : 1);
})();
