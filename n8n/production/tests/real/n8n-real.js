// Runs the REAL n8n (the version that is installed) with the production export imported through n8n's own CLI, in a throw-away user folder,
// on 127.0.0.1, against the local stand-ins. Needs: N8N_RUNTIME_DIR (a folder with node_modules/.bin/n8n), N8N_NODE_DIR (a node new enough for it, e.g. 24).
// Optional: FAKETIME_LIB (libfaketime: the clock is shifted to 11:00 India time so the run is always in clinic hours; without it the real clock is used).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const cp = require('child_process');

const RUNTIME = process.env.N8N_RUNTIME_DIR;
const NODE_DIR = process.env.N8N_NODE_DIR;
const FAKETIME_LIB = process.env.FAKETIME_LIB || (fs.existsSync('/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1') ? '/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1' : '');
const N8N_BIN = RUNTIME ? path.join(RUNTIME, 'node_modules', '.bin', 'n8n') : '';
const available = () => !!(RUNTIME && NODE_DIR && fs.existsSync(N8N_BIN) && fs.existsSync(path.join(NODE_DIR, 'node')));

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// seconds to shift the clock so that it is 11:00 IST today (the offset a wrapper `node` gives to n8n AND to its task runner)
function dayShiftSeconds(nowMs = Date.now()) {
  const ist = new Date(nowMs + 5.5 * 3600 * 1000);
  const target = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 11, 0, 0);
  return Math.round((target - (nowMs + 5.5 * 3600 * 1000)) / 1000);
}

class RealN8n {
  constructor({ workflowFile, env = {}, workdir }) {
    this.workflowFile = workflowFile;
    this.dir = workdir || fs.mkdtempSync(path.join(os.tmpdir(), 'flowhq-n8n-'));
    this.userFolder = path.join(this.dir, 'user');
    fs.mkdirSync(this.userFolder, { recursive: true });
    this.keyFile = path.join(this.dir, 'n8n_encryption_key');
    fs.writeFileSync(this.keyFile, 'e'.repeat(64), { mode: 0o600 });
    this.wrapDir = path.join(this.dir, 'bin');
    fs.mkdirSync(this.wrapDir, { recursive: true });
    this.logFile = path.join(this.dir, 'n8n.log');
    this.extraEnv = env;
    this.proc = null;
    this.shifted = false;
  }

  async init() {
    this.port = await freePort();
    this.broker = await freePort();
    const real = path.join(NODE_DIR, 'node');
    let wrapper;
    if (FAKETIME_LIB) {
      this.shifted = true;
      wrapper = `#!/bin/sh\nexec env LD_PRELOAD=${FAKETIME_LIB} FAKETIME_DONT_FAKE_MONOTONIC=1 FAKETIME="${dayShiftSeconds() >= 0 ? '+' : ''}${dayShiftSeconds()}s" ${real} "$@"\n`;
    } else wrapper = `#!/bin/sh\nexec ${real} "$@"\n`;
    fs.writeFileSync(path.join(this.wrapDir, 'node'), wrapper, { mode: 0o755 });
    this.env = {
      PATH: `${this.wrapDir}:${process.env.PATH}`, HOME: this.dir, TZ: 'Asia/Kolkata',
      N8N_USER_FOLDER: this.userFolder, N8N_PORT: String(this.port), N8N_RUNNERS_BROKER_PORT: String(this.broker), N8N_LISTEN_ADDRESS: '127.0.0.1',
      N8N_DIAGNOSTICS_ENABLED: 'false', N8N_VERSION_NOTIFICATIONS_ENABLED: 'false', N8N_TEMPLATES_ENABLED: 'false', N8N_PERSONALIZATION_ENABLED: 'false', N8N_HIRING_BANNER_ENABLED: 'false',
      N8N_SECURE_COOKIE: 'false', N8N_ENCRYPTION_KEY_FILE: this.keyFile, N8N_BLOCK_ENV_ACCESS_IN_NODE: 'false', N8N_PAYLOAD_SIZE_MAX: '4',
      GENERIC_TIMEZONE: 'Asia/Kolkata', NODE_ENV: 'production', N8N_LOG_LEVEL: 'info', N8N_PROXY_HOPS: '0',
      EXECUTIONS_DATA_SAVE_ON_SUCCESS: 'none', EXECUTIONS_DATA_SAVE_ON_ERROR: 'all',
      WEBHOOK_URL: `http://127.0.0.1:${this.port}/`,
      ...this.extraEnv,
    };
    for (const k of this.removeEnv || []) delete this.env[k];
    this.base = `http://127.0.0.1:${this.port}`;
    return this;
  }

  cli(args, { input } = {}) {
    const r = cp.spawnSync(N8N_BIN, args, { env: this.env, encoding: 'utf8', timeout: 240000, input });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status !== 0) throw new Error(`n8n ${args.join(' ')} failed (${r.status}):\n${out.slice(-1500)}`);
    return out;
  }
  importCommand() { return `PATH='${this.wrapDir}':"$PATH" N8N_USER_FOLDER='${this.userFolder}' N8N_ENCRYPTION_KEY_FILE='${this.keyFile}' '${N8N_BIN}' import:credentials --input=%FILE%`; }
  importWorkflow() {
    const out = this.cli(['import:workflow', `--input=${this.workflowFile}`]);
    if (!/Successfully imported 1 workflow/.test(out)) throw new Error(`import:workflow: ${out.slice(-600)}`);
    return out;
  }
  publish(id = 'FhqClinicProd001') { return this.cli(['publish:workflow', `--id=${id}`]); }

  async start(wait = 150000) {
    const log = fs.openSync(this.logFile, 'a');
    this.proc = cp.spawn(N8N_BIN, ['start'], { env: this.env, stdio: ['ignore', log, log], detached: true });
    const t0 = Date.now();
    while (Date.now() - t0 < wait) {
      if (this.proc.exitCode !== null) throw new Error(`n8n exited during start-up:\n${this.logTail()}`);
      if (await this.ready()) return this;
      await sleep(500);
    }
    this.kill();
    throw new Error(`n8n did not register its webhooks in time:\n${this.logTail()}`);
  }
  async ready() {
    try {
      const a = await this.request('GET', '/webhook/whatsapp-inbound?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1');
      const b = await this.request('POST', '/webhook/cal?clinic=x', { body: '{}', headers: { 'content-type': 'application/json' } });
      const c = await this.request('POST', '/webhook/website-lead', { body: '{}', headers: { 'content-type': 'application/json' } });
      return [a, b, c].every((r) => r.status !== 404 && r.status !== 0);
    } catch (e) { return false; }
  }
  logTail(n = 1800) { try { return fs.readFileSync(this.logFile, 'utf8').slice(-n); } catch (e) { return ''; } }
  kill() { try { process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    try { process.kill(-this.proc.pid, 'SIGTERM'); } catch (e) { /* gone */ }
    for (let i = 0; i < 60 && this.proc.exitCode === null; i++) await sleep(250);
    if (this.proc.exitCode === null) this.kill();
  }
  request(method, p, { body, headers = {}, timeout = 60000 } = {}) {
    return new Promise((resolve) => {
      const req = http.request(`${this.base}${p}`, { method, headers: { ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers }, timeout }, (res) => {
        const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { const text = Buffer.concat(c).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ } resolve({ status: res.statusCode, text, json }); });
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: 'timeout', json: null }); });
      req.on('error', () => resolve({ status: 0, text: 'error', json: null }));
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}

module.exports = { RealN8n, available, dayShiftSeconds, sleep, FAKETIME_LIB, RUNTIME, NODE_DIR };
