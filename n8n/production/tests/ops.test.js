// Operations files of the production package: compose files, Caddyfile, scripts (credentials, Grist migration, preflight, backup / restore, health check, init).
// Run: node n8n/production/tests/ops.test.js     (no Docker daemon needed: `docker compose config` only reads the files; scripts that call docker are run with --no-docker)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const H = require('./harness');
const S = require('./real/fake-services');
const { test, finish } = H;
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowhq-ops-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const run = (cmd, args, o = {}) => cp.spawnSync(cmd, args, { encoding: 'utf8', ...o });
const node = (script, args, o = {}) => run(process.execPath, [path.join(ROOT, script), ...args], o);
// async variants: the fake Grist lives in THIS process, so a synchronous child process would block it
const spawnA = (cmd, args, o = {}) => new Promise((resolve) => { const c = cp.spawn(cmd, args, o); let stdout = ''; let stderr = ''; c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; }); c.on('close', (status) => resolve({ status, stdout, stderr })); });
const nodeA = (script, args, o = {}) => spawnA(process.execPath, [path.join(ROOT, script), ...args], o);
const hasDocker = run('docker', ['compose', 'version']).status === 0;

// a complete, fictional environment file
const GOOD_ENV = {
  N8N_DOMAIN: 'n8n.clinic.example', N8N_ADMIN_DOMAIN: 'n8n-admin.clinic.example', ADMIN_ALLOW_CIDR: '203.0.113.10/32', GRIST_DOMAIN: 'crm.clinic.example', ACME_EMAIL: 'ops@clinic.example', N8N_VERSION: '2.43.5', GRIST_VERSION: '1.7.3',
  GRIST_SESSION_SECRET: 'a'.repeat(40), GRIST_ADMIN_EMAIL: 'owner@clinic.example', GRIST_TEAM_NAME: 'agency', GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret',
  FLOWHQ_GRIST_URL: 'http://grist:8484', FLOWHQ_REGISTRY_DOC_ID: 'REGDOC123', FLOWHQ_WA_SEND_MODE: 'allowlist', FLOWHQ_WA_ALLOWLIST: '+919000000019', FLOWHQ_WA_GRAPH_VERSION: 'v23.0',
  FLOWHQ_META_APP_SECRET: 'm'.repeat(32), FLOWHQ_META_VERIFY_TOKEN: 'v'.repeat(32), FLOWHQ_CAL_WEBHOOK_SECRET: 'c'.repeat(32), FLOWHQ_TELEGRAM_CHAT_ID: '-1000001', BACKUP_PASSPHRASE: 'backup-passphrase-for-tests',
  FLOWHQ_ALERT_EMAIL_TO: 'frontdesk@clinic.example', FLOWHQ_EMAIL_FROM: 'noreply@clinic.example',
  FLOWHQ_GRIST_API_KEY: 'grist-key-for-tests-0123456789', FLOWHQ_W1_WEBHOOK_SECRET: 'w1-secret-for-tests-0123456789abcdef', FLOWHQ_WA_ACCESS_TOKEN: 'wa-token-for-tests-0123456789', FLOWHQ_TELEGRAM_BOT_TOKEN: '123456789:test-token-abcdefghijklmnopqrstuvwxyz012', FLOWHQ_SMTP_HOST: '127.0.0.1', FLOWHQ_SMTP_PORT: '1025',
};
const envText = (o) => `${Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
// a private copy of the package, as an operator would have it
const copyPackage = (name) => {
  const dir = path.join(TMP, name); fs.mkdirSync(dir, { recursive: true });
  for (const d of ['scripts', 'ops', 'schema']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'clinic-autopilot-production.json'), path.join(dir, 'clinic-autopilot-production.json'));
  return dir;
};
const composeJson = (file, env) => {
  const envFile = path.join(TMP, `compose-${path.basename(file)}.env`); fs.writeFileSync(envFile, envText(env));
  const r = run('docker', ['compose', '-f', path.join(ROOT, 'ops', file), '--env-file', envFile, '--project-directory', ROOT, 'config', '--format', 'json']);
  return { status: r.status, stderr: r.stderr, json: r.status === 0 ? JSON.parse(r.stdout) : null };
};

test('compose (production): valid; only Caddy publishes ports (80, 443); n8n and Grist are private; images are pinned', () => {
  if (!hasDocker) { console.log('       (docker CLI not available: not run)'); return; }
  const c = composeJson('docker-compose.production.yml', GOOD_ENV);
  assert.strictEqual(c.status, 0, c.stderr);
  const sv = c.json.services;
  assert.deepStrictEqual(Object.keys(sv).sort(), ['caddy', 'grist', 'n8n']);
  assert.deepStrictEqual(sv.caddy.ports.map((p) => p.published).sort(), ['443', '80']);
  assert(!sv.n8n.ports && !sv.grist.ports, 'n8n and Grist publish no port');
  assert.match(sv.n8n.image, /:2\.43\.5$/); assert.match(sv.grist.image, /:1\.7\.3$/);
  for (const s of Object.values(sv)) assert.strictEqual(s.restart, 'unless-stopped');
});

test('compose (production): n8n is configured for env-based settings, tiny retention, health checks, log limits and a key FILE; credential-only secrets never reach the container', () => {
  if (!hasDocker) return;
  const e = composeJson('docker-compose.production.yml', GOOD_ENV).json.services.n8n.environment;
  assert.strictEqual(e.N8N_BLOCK_ENV_ACCESS_IN_NODE, 'false');
  assert.deepStrictEqual([e.EXECUTIONS_DATA_SAVE_ON_SUCCESS, e.EXECUTIONS_DATA_SAVE_ON_ERROR, e.EXECUTIONS_DATA_PRUNE, e.EXECUTIONS_DATA_MAX_AGE, e.N8N_SECURE_COOKIE, e.N8N_PROXY_HOPS, e.TZ], ['none', 'all', 'true', '168', 'true', '1', 'Asia/Kolkata']);
  assert.strictEqual(e.N8N_ENCRYPTION_KEY_FILE, '/run/secrets/n8n_encryption_key');
  assert(!('N8N_ENCRYPTION_KEY' in e), 'the key is a file, not an environment variable');
  assert.match(e.NODES_EXCLUDE, /executeCommand/);
  for (const k of ['FLOWHQ_GRIST_API_KEY', 'FLOWHQ_W1_WEBHOOK_SECRET', 'FLOWHQ_WA_ACCESS_TOKEN', 'FLOWHQ_AI_API_KEY', 'FLOWHQ_TELEGRAM_BOT_TOKEN', 'FLOWHQ_SMTP_PASSWORD', 'BACKUP_PASSPHRASE', 'GOOGLE_CLIENT_SECRET', 'GRIST_SESSION_SECRET']) assert(!(k in e), `${k} must not be in the n8n container`);
  const sv = composeJson('docker-compose.production.yml', GOOD_ENV).json.services;
  for (const n of ['n8n', 'grist']) { assert(sv[n].healthcheck && sv[n].healthcheck.test, `${n} has a health check`); assert.strictEqual(sv[n].logging.options['max-size'], '10m'); }
  assert.strictEqual(sv.caddy.depends_on.n8n.condition, 'service_healthy');
  // every FLOWHQ_* variable the workflow reads is passed through (or is a documented credential-script-only variable)
  const wf = fs.readFileSync(path.join(ROOT, 'clinic-autopilot-production.json'), 'utf8');
  const used = [...new Set(wf.match(/FLOWHQ_[A-Z0-9_]+/g))];
  const optional = new Set(['FLOWHQ_WA_GRAPH_BASE_URL', 'FLOWHQ_AI_BASE_URL', 'FLOWHQ_W1_REQUIRE_CONSENT_X']);
  for (const k of used) assert(k in e || optional.has(k), `the workflow reads ${k} but the compose file does not pass it`);
});

test('compose: a missing required value stops `docker compose` (no half-configured start); unpinned versions are refused', () => {
  if (!hasDocker) return;
  const { FLOWHQ_META_APP_SECRET, ...rest } = GOOD_ENV;
  const a = composeJson('docker-compose.production.yml', rest);
  assert.notStrictEqual(a.status, 0);
  assert.match(a.stderr, /FLOWHQ_META_APP_SECRET/);
  const { N8N_VERSION, ...rest2 } = GOOD_ENV;
  assert.match(composeJson('docker-compose.production.yml', rest2).stderr, /N8N_VERSION/);
});

test('compose (staging): everything bound to 127.0.0.1, Mailpit included, WhatsApp forced to allowlist, external AI off', () => {
  if (!hasDocker) return;
  const c = composeJson('docker-compose.staging.yml', GOOD_ENV);
  assert.strictEqual(c.status, 0, c.stderr);
  for (const s of Object.values(c.json.services)) for (const p of s.ports || []) assert.strictEqual(p.host_ip, '127.0.0.1');
  assert(c.json.services.mailpit);
  assert.deepStrictEqual([c.json.services.n8n.environment.FLOWHQ_WA_SEND_MODE, c.json.services.n8n.environment.FLOWHQ_AI_EXTERNAL_ENABLED], ['allowlist', 'false']);
});

test('Caddyfile: only /webhook/* of n8n is public; the editor host is IP-restricted; Grist is behind its own sign-in; security headers set', () => {
  const t = fs.readFileSync(path.join(ROOT, 'ops', 'Caddyfile.production'), 'utf8');
  const site = (host) => { const i = t.indexOf(`{$${host}} {`); assert(i >= 0, host); let depth = 0, j = t.indexOf('} {', i) + 2; const start = j; for (; j < t.length; j++) { if (t[j] === '{') depth++; if (t[j] === '}') { depth--; if (depth === 0) break; } } return t.slice(start, j + 1); };
  const pub = site('N8N_DOMAIN');
  assert(/@webhooks path \/webhook\/\*/.test(pub) && /handle @webhooks \{\s*reverse_proxy n8n:5678/.test(pub));
  assert.strictEqual((pub.match(/reverse_proxy/g) || []).length, 1, 'exactly one proxied route on the public host');
  assert(/handle \{\s*respond "Not found" 404/.test(pub), 'everything else is 404');
  assert(/max_size/.test(pub));
  const admin = site('N8N_ADMIN_DOMAIN');
  assert(/@allowed remote_ip \{\$ADMIN_ALLOW_CIDR\}/.test(admin) && /handle \{\s*respond "Forbidden" 403/.test(admin));
  assert(/Strict-Transport-Security/.test(t) && /nosniff/.test(t));
  assert(!/webhook-test/.test(pub));
  // if a caddy binary is around, let Caddy itself validate the file
  const caddy = process.env.CADDY_BIN || '';
  if (caddy && fs.existsSync(caddy)) {
    const r = run(caddy, ['validate', '--config', path.join(ROOT, 'ops', 'Caddyfile.production'), '--adapter', 'caddyfile'], { env: { ...process.env, N8N_DOMAIN: 'n8n.example.com', N8N_ADMIN_DOMAIN: 'admin.example.com', ADMIN_ALLOW_CIDR: '203.0.113.10/32', GRIST_DOMAIN: 'crm.example.com', ACME_EMAIL: 'a@example.com' } });
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`.slice(-400));
    console.log('       (validated by the real Caddy binary)');
  } else console.log('       (no CADDY_BIN: syntax not validated by Caddy itself)');
});

test('create-credentials: lists what is missing without values; writes a private file; never prints a secret', () => {
  const dry = node('scripts/create-credentials.js', ['--dry-run'], { env: { PATH: process.env.PATH } });
  assert.strictEqual(dry.status, 1);
  assert.match(dry.stdout, /MISSING +FlowHQ Grist API.*FLOWHQ_GRIST_API_KEY/);
  const envFile = path.join(TMP, 'cred.env'); fs.writeFileSync(envFile, envText(GOOD_ENV));
  const dry2 = node('scripts/create-credentials.js', ['--dry-run', '--env-file', envFile], { env: { PATH: process.env.PATH } });
  assert.strictEqual(dry2.status, 0, dry2.stdout);
  assert.match(dry2.stdout, /skipped +FlowHQ AI Provider.*optional/);
  const out = path.join(TMP, 'cred-out.json');
  const w = node('scripts/create-credentials.js', ['--env-file', envFile, '--out', out], { env: { PATH: process.env.PATH } });
  assert.strictEqual(w.status, 0, w.stdout + w.stderr);
  assert.strictEqual((fs.statSync(out).mode & 0o777).toString(8), '600');
  for (const v of ['grist-key-for-tests-0123456789', 'w1-secret-for-tests-0123456789abcdef', 'wa-token-for-tests-0123456789']) assert(!w.stdout.includes(v) && !w.stderr.includes(v), 'a secret was printed');
  const list = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepStrictEqual(list.map((c) => [c.id, c.type]), [['FhqCredGrist0001', 'httpHeaderAuth'], ['FhqCredW1Hook001', 'httpHeaderAuth'], ['FhqCredWhatsApp1', 'httpHeaderAuth'], ['FhqCredTelegram1', 'telegramApi'], ['FhqCredSmtp00001', 'smtp']]);
  assert.deepStrictEqual(list[0].data, { name: 'Authorization', value: 'Bearer grist-key-for-tests-0123456789' });
  assert.deepStrictEqual(list[1].data.name, 'X-Lead-Secret');
  // the ids/names are the ones the workflow uses
  const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'clinic-autopilot-production.json'), 'utf8'));
  const used = new Set(); for (const n of wf.nodes) for (const c of Object.values(n.credentials || {})) used.add(`${c.id}|${c.name}`);
  const names = { FhqCredGrist0001: 'FlowHQ Grist API', FhqCredW1Hook001: 'FlowHQ W1 Webhook Auth', FhqCredWhatsApp1: 'FlowHQ WhatsApp Cloud API', FhqCredTelegram1: 'FlowHQ Telegram Alerts', FhqCredSmtp00001: 'FlowHQ SMTP' };
  for (const c of list) assert(used.has(`${c.id}|${names[c.id]}`), c.id);
  // a too-short webhook secret is refused
  fs.writeFileSync(envFile, envText({ ...GOOD_ENV, FLOWHQ_W1_WEBHOOK_SECRET: 'short' }));
  const short = node('scripts/create-credentials.js', ['--dry-run', '--env-file', envFile], { env: { PATH: process.env.PATH } });
  assert.strictEqual(short.status, 1); assert.match(short.stdout, /FLOWHQ_W1_WEBHOOK_SECRET is too short/);
  // --import deletes the file even when the import command fails
  fs.writeFileSync(envFile, envText(GOOD_ENV));
  const out2 = path.join(TMP, 'cred-out2.json');
  const bad = node('scripts/create-credentials.js', ['--env-file', envFile, '--out', out2, '--import', 'exit 7'], { env: { PATH: process.env.PATH } });
  assert.strictEqual(bad.status, 1); assert(!fs.existsSync(out2), 'the secrets file must be gone'); assert.match(bad.stdout, /import FAILED/);
});

// ---------------------------------------------------------------- migration against a fake Grist over HTTP
const gristDocs = () => ({
  REG: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'demo-physio', Clinic_Name: 'Demo', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: '123456789012345', Active: true } }, { id: 2, fields: { Clinic_Slug: 'off', Clinic_Name: 'Off', Grist_Doc_ID: 'DOCZ', WA_Phone_Number_ID: '9', Active: false } }] },
  DOCA: { LEADS: [{ id: 1, fields: { Lead_id: 'L1', Name: 'Old patient', Phone: '+919000000011', Opted_Out: false } }, { id: 2, fields: { Lead_id: 'L2', Name: 'Cold', Phone: '+919000000012', Opted_Out: false } }, { id: 3, fields: { Lead_id: 'L3', Name: 'Stopped', Phone: '+919000000013', Opted_Out: true } }], Conversations: [{ id: 1, fields: { Lead: 1, Phone: '+919000000011' } }], Appointments: [{ id: 1, fields: { Lead: 3, Booking_UID: 'u' } }], Messages: [], Run_Log: [], Settings: [], Knowledge: [] },
  DOCZ: { LEADS: [] },
});
const KEY = 'migration-test-key-0123456789';
// the fake Grist derives its schema from the simulator's COLUMNS, which already contains the production additions: take them away = a clinic document before the migration
const NEW_LEAD_COLS = ['Email', 'Email_Opted_Out', 'Consent_WhatsApp', 'Consent_Email', 'Consent_Source', 'Consent_At', 'Consent_Version'];
const legacySchema = () => { delete S.sim.COLUMNS.Send_Ledger; S.sim.COLUMNS.LEADS = S.sim.COLUMNS.LEADS.filter((c) => !NEW_LEAD_COLS.includes(c)); };
const migratedSchema = () => { S.sim.COLUMNS.Send_Ledger = S.sim.COLUMNS.Send_Ledger || ['Idem_Key', 'Status', 'Source', 'Audience', 'Template', 'WA_Message_ID', 'Error', 'Error_Code', 'Created_At', 'Updated_At']; for (const c of NEW_LEAD_COLS) if (!S.sim.COLUMNS.LEADS.includes(c)) S.sim.COLUMNS.LEADS.push(c); };
const migrate = (url, args, key = KEY) => nodeA('scripts/migrate-grist.js', args, { env: { PATH: process.env.PATH, FLOWHQ_GRIST_URL: url, FLOWHQ_GRIST_API_KEY: key, FLOWHQ_REGISTRY_DOC_ID: 'REG' } });

test('migrate-grist: dry run changes nothing; --apply creates Send_Ledger + the consent columns; a second run is a no-op; inactive clinics are skipped', async () => {
  legacySchema();
  const g = await S.startGrist({ docs: gristDocs(), apiKey: KEY });
  try {
    const dry = await migrate(g.url, []);
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /DRY RUN/); assert.match(dry.stdout, /create table Send_Ledger/); assert.match(dry.stdout, /add to LEADS: Email, Email_Opted_Out, Consent_WhatsApp/);
    assert(!g.log.some((l) => l.method === 'POST'), 'a dry run writes nothing');
    assert(!/DOCZ|off/.test(dry.stdout), 'inactive clinic skipped');
    const applied = await migrate(g.url, ['--apply']);
    assert.strictEqual(applied.status, 0, applied.stdout + applied.stderr);
    assert.match(applied.stdout, /APPLYING/);
    const posts = g.log.filter((l) => l.method === 'POST');
    assert(posts.some((l) => l.tables && l.tables.includes('Send_Ledger')) && posts.some((l) => l.columns && l.columns.includes('Consent_WhatsApp')), JSON.stringify(posts));
    const again = await migrate(g.url, ['--apply']);
    assert.match(again.stdout, /nothing to do/);
    assert.strictEqual(g.log.filter((l) => l.method === 'POST').length, posts.length, 'idempotent');
    assert(!(applied.stdout + applied.stderr).includes(KEY), 'the API key is never printed');
  } finally { g.close(); }
});

test('migrate-grist: --check reports missing existing columns; legacy consent backfill is opt-in, dry by default, skips opted-out leads, only touches leads with a conversation or appointment', async () => {
  migratedSchema();
  const docs = gristDocs();
  const g = await S.startGrist({ docs, apiKey: KEY });
  try {
    const okChk = await migrate(g.url, ['--check', '--doc', 'DOCA']);
    assert.strictEqual(okChk.status, 0, okChk.stdout);
    assert(!/MISSING|missing/.test(okChk.stdout.replace('migrated', '')), 'a complete schema reports nothing missing');
    const saved = S.sim.COLUMNS.Appointments; S.sim.COLUMNS.Appointments = saved.filter((c) => c !== 'Confirm_Sent');
    const chk = await migrate(g.url, ['--check', '--doc', 'DOCA']);
    S.sim.COLUMNS.Appointments = saved;
    assert.match(chk.stdout, /! Appointments: missing Confirm_Sent \(grist\/schema\.md\)/);
    const dry = await migrate(g.url, ['--doc', 'DOCA', '--backfill-legacy-consent', 'clinic owner confirmed on 2026-10-14']);
    assert.match(dry.stdout, /would be marked/); assert.match(dry.stdout, /1 existing lead/);
    assert(docs.DOCA.LEADS.every((l) => l.fields.Consent_WhatsApp === undefined), 'dry run changed nothing');
    await migrate(g.url, ['--doc', 'DOCA', '--apply', '--backfill-legacy-consent', 'clinic owner confirmed on 2026-10-14']);
    const byId = Object.fromEntries(docs.DOCA.LEADS.map((l) => [l.id, l.fields]));
    assert.deepStrictEqual([byId[1].Consent_WhatsApp, byId[1].Consent_Source], [true, 'legacy']);
    assert.strictEqual(byId[2].Consent_WhatsApp, undefined, 'a lead with no conversation or appointment is not touched');
    assert.strictEqual(byId[3].Consent_WhatsApp, undefined, 'an opted-out lead is never marked');
  } finally { g.close(); }
});

test('migrate-grist: wrong API key / unknown document / no key: clear failure, exit code, no secret printed', async () => {
  migratedSchema();
  const g = await S.startGrist({ docs: gristDocs(), apiKey: KEY });
  try {
    const wrong = await migrate(g.url, ['--doc', 'DOCA'], 'wrong-key-0123456789');
    assert.notStrictEqual(wrong.status, 0); assert.match(wrong.stdout + wrong.stderr, /HTTP 401/); assert(!(wrong.stdout + wrong.stderr).includes('wrong-key-0123456789'));
    const nodoc = await migrate(g.url, ['--doc', 'NOPE']);
    assert.notStrictEqual(nodoc.status, 0); assert.match(nodoc.stdout, /FAILED/);
    const nokey = await nodeA('scripts/migrate-grist.js', [], { env: { PATH: process.env.PATH, FLOWHQ_GRIST_URL: g.url } });
    assert.strictEqual(nokey.status, 2); assert.match(nokey.stderr, /FLOWHQ_GRIST_API_KEY is not set/);
  } finally { g.close(); }
});

test('preflight: the example environment FAILS (placeholders), a complete one PASSES, and the workflow file is checked', () => {
  const ex = node('scripts/preflight.js', ['--env', '.env.example'], { env: { PATH: process.env.PATH } });
  assert.strictEqual(ex.status, 1); assert.match(ex.stdout, /FAIL .*not set/);
  const dir = copyPackage('pkg-preflight');
  fs.writeFileSync(path.join(dir, '.env'), envText(GOOD_ENV), { mode: 0o600 });
  fs.mkdirSync(path.join(dir, 'secrets')); fs.writeFileSync(path.join(dir, 'secrets', 'n8n_encryption_key'), 'k'.repeat(64));
  const ok = run(process.execPath, [path.join(dir, 'scripts', 'preflight.js')], { env: { PATH: process.env.PATH }, cwd: dir });
  assert.strictEqual(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /PASS +every Code node parses/); assert.match(ok.stdout, /PASS +the export is inactive/);
  // a live-mode / secret-in-workflow / active export is caught
  fs.writeFileSync(path.join(dir, '.env'), envText({ ...GOOD_ENV, FLOWHQ_WA_SEND_MODE: 'live', FLOWHQ_AI_EXTERNAL_ENABLED: 'true' }), { mode: 0o600 });
  const live = run(process.execPath, [path.join(dir, 'scripts', 'preflight.js')], { env: { PATH: process.env.PATH }, cwd: dir });
  assert.match(live.stdout, /WARN +FLOWHQ_WA_SEND_MODE=live/); assert.match(live.stdout, /WARN +external AI is ENABLED/);
  const wfp = path.join(dir, 'clinic-autopilot-production.json'); const wf = JSON.parse(fs.readFileSync(wfp, 'utf8')); wf.active = true; wf.nodes[0].parameters.leak = 'Bearer abcdefghijklmnop12345'; fs.writeFileSync(wfp, JSON.stringify(wf));
  const bad = run(process.execPath, [path.join(dir, 'scripts', 'preflight.js'), '--workflow-only', wfp], { env: { PATH: process.env.PATH }, cwd: dir });
  assert.strictEqual(bad.status, 1); assert.match(bad.stdout, /FAIL +the export is ACTIVE/); assert.match(bad.stdout, /FAIL +the workflow file looks like it contains: bearer token/);
});

test('preflight --online: finds a clinic document that is not migrated, and passes after the migration', async () => {
  legacySchema();
  const g = await S.startGrist({ docs: gristDocs(), apiKey: KEY });
  try {
    const dir = copyPackage('pkg-online');
    fs.writeFileSync(path.join(dir, '.env'), envText({ ...GOOD_ENV, FLOWHQ_REGISTRY_DOC_ID: 'REG', FLOWHQ_GRIST_API_KEY: KEY, FLOWHQ_GRIST_URL_ADMIN: g.url }), { mode: 0o600 });
    fs.mkdirSync(path.join(dir, 'secrets')); fs.writeFileSync(path.join(dir, 'secrets', 'n8n_encryption_key'), 'k'.repeat(64));
    const before = await spawnA(process.execPath, [path.join(dir, 'scripts', 'preflight.js'), '--online'], { env: { PATH: process.env.PATH }, cwd: dir });
    assert.strictEqual(before.status, 1);
    assert.match(before.stdout, /FAIL +clinic demo-physio: missing .*Send_Ledger.*migrate-grist/);
    assert(!before.stdout.includes(KEY));
    await migrate(g.url, ['--apply']);
    const after = await spawnA(process.execPath, [path.join(dir, 'scripts', 'preflight.js'), '--online'], { env: { PATH: process.env.PATH }, cwd: dir });
    assert.match(after.stdout, /PASS +clinic demo-physio: all tables and columns present/);
    assert.match(after.stdout, /PASS +clinic demo-physio: TEST_MODE is on|WARN +clinic demo-physio: TEST_MODE=false/);
  } finally { g.close(); }
});

test('init-secrets: creates the key once (64 hex, mode 600) and never overwrites it', () => {
  const dir = copyPackage('pkg-init');
  const a = run('bash', [path.join(dir, 'scripts', 'init-secrets.sh')], { cwd: dir });
  assert.strictEqual(a.status, 0, a.stderr);
  const key = fs.readFileSync(path.join(dir, 'secrets', 'n8n_encryption_key'), 'utf8');
  assert.match(key, /^[0-9a-f]{64}$/); assert.strictEqual((fs.statSync(path.join(dir, 'secrets', 'n8n_encryption_key')).mode & 0o777).toString(8), '600');
  assert(!a.stdout.includes(key));
  const b = run('bash', [path.join(dir, 'scripts', 'init-secrets.sh')], { cwd: dir });
  assert.match(b.stdout, /kept the existing/); assert.strictEqual(fs.readFileSync(path.join(dir, 'secrets', 'n8n_encryption_key'), 'utf8'), key);
  assert(fs.existsSync(path.join(dir, 'data', 'n8n')) && fs.existsSync(path.join(dir, 'data', 'grist')));
});

test('backup + restore round trip (encrypted, checksummed): wrong passphrase, tampering and overwriting are refused', () => {
  const dir = copyPackage('pkg-backup');
  fs.mkdirSync(path.join(dir, 'data', 'n8n'), { recursive: true }); fs.mkdirSync(path.join(dir, 'data', 'grist'), { recursive: true }); fs.mkdirSync(path.join(dir, 'secrets'));
  fs.writeFileSync(path.join(dir, 'data', 'n8n', 'database.sqlite'), 'N8N-DB-PLAINTEXT-MARKER');
  fs.writeFileSync(path.join(dir, 'data', 'grist', 'clinic.grist'), 'GRIST-DOC-PLAINTEXT-MARKER');
  fs.writeFileSync(path.join(dir, 'secrets', 'n8n_encryption_key'), 'KEY-PLAINTEXT-MARKER');
  fs.writeFileSync(path.join(dir, '.env'), 'BACKUP_PASSPHRASE=env-file-pass\nBACKUP_DIR=./bk\nFLOWHQ_X=ENV-PLAINTEXT-MARKER\n');
  const env = { PATH: process.env.PATH };
  const none = run('bash', [path.join(dir, 'scripts', 'backup.sh'), '--no-docker'], { cwd: dir, env: { ...env, BACKUP_PASSPHRASE: 'CHANGE_ME' } });
  assert.strictEqual(none.status, 2); assert.match(none.stderr, /refusing to write an unencrypted backup/);
  const b = run('bash', [path.join(dir, 'scripts', 'backup.sh'), '--no-docker'], { cwd: dir, env });
  assert.strictEqual(b.status, 0, b.stdout + b.stderr);
  const files = fs.readdirSync(path.join(dir, 'bk')).filter((f) => f.endsWith('.enc'));
  assert.strictEqual(files.length, 1);
  const archive = path.join(dir, 'bk', files[0]);
  assert.strictEqual((fs.statSync(archive).mode & 0o777).toString(8), '600');
  const bytes = fs.readFileSync(archive);
  for (const m of ['PLAINTEXT-MARKER', 'ENV-PLAINTEXT']) assert(!bytes.includes(m), 'the archive is encrypted');
  assert(fs.existsSync(`${archive}.sha256`));
  // restore into an empty target
  const target = path.join(TMP, 'restore-target');
  const r = run('bash', [path.join(dir, 'scripts', 'restore.sh'), archive, '--target', target, '--no-docker'], { cwd: dir, env: { ...env, BACKUP_PASSPHRASE: 'env-file-pass' } });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(target, 'data', 'n8n', 'database.sqlite'), 'utf8'), 'N8N-DB-PLAINTEXT-MARKER');
  assert.strictEqual(fs.readFileSync(path.join(target, 'data', 'grist', 'clinic.grist'), 'utf8'), 'GRIST-DOC-PLAINTEXT-MARKER');
  assert.strictEqual(fs.readFileSync(path.join(target, 'secrets', 'n8n_encryption_key'), 'utf8'), 'KEY-PLAINTEXT-MARKER');
  // refusals
  const wrong = run('bash', [path.join(dir, 'scripts', 'restore.sh'), archive, '--target', path.join(TMP, 'rt2'), '--no-docker'], { cwd: dir, env: { ...env, BACKUP_PASSPHRASE: 'wrong' } });
  assert.strictEqual(wrong.status, 5); assert.match(wrong.stderr, /wrong passphrase|damaged/); assert(!fs.existsSync(path.join(TMP, 'rt2', 'data')));
  const over = run('bash', [path.join(dir, 'scripts', 'restore.sh'), archive, '--target', target, '--no-docker'], { cwd: dir, env: { ...env, BACKUP_PASSPHRASE: 'env-file-pass' } });
  assert.strictEqual(over.status, 6); assert.match(over.stderr, /already exists/);
  const forced = run('bash', [path.join(dir, 'scripts', 'restore.sh'), archive, '--target', target, '--no-docker', '--force'], { cwd: dir, env: { ...env, BACKUP_PASSPHRASE: 'env-file-pass' } });
  assert.strictEqual(forced.status, 0, forced.stderr);
  assert(fs.readdirSync(target).some((f) => f.startsWith('data.before-restore-')), 'the old data was moved aside, not deleted');
  const tampered = path.join(dir, 'bk', 'tampered.tar.gz.enc'); fs.writeFileSync(tampered, Buffer.concat([bytes.subarray(0, bytes.length - 5), Buffer.from('xxxxx')])); fs.copyFileSync(`${archive}.sha256`, `${tampered}.sha256`);
  fs.writeFileSync(`${tampered}.sha256`, fs.readFileSync(`${archive}.sha256`, 'utf8').replace(path.basename(archive), 'tampered.tar.gz.enc'));
  const t = run('bash', [path.join(dir, 'scripts', 'restore.sh'), tampered, '--target', path.join(TMP, 'rt3'), '--no-docker'], { cwd: dir, env: { ...env, BACKUP_PASSPHRASE: 'env-file-pass' } });
  assert.strictEqual(t.status, 3); assert.match(t.stderr, /checksum does not match/);
});

test('healthcheck.sh: passes when /healthz answers and the editor API is not public; fails when the editor is exposed or the host is down', async () => {
  let editorOpen = false;
  const srv = http.createServer((req, res) => { if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); } if (req.url === '/rest/login') { res.writeHead(editorOpen ? 200 : 404); return res.end('x'); } res.writeHead(404); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const hc = () => spawnA('bash', [path.join(ROOT, 'scripts', 'healthcheck.sh'), '--url', url], { cwd: TMP, env: { PATH: process.env.PATH } });
  try {
    const ok = await hc(); assert.strictEqual(ok.status, 0, ok.stdout); assert.match(ok.stdout, /^healthy$/m);
    editorOpen = true;
    const bad = await hc(); assert.strictEqual(bad.status, 1); assert.match(bad.stdout, /FAIL .*editor/);
  } finally { srv.close(); }
  const down = run('bash', [path.join(ROOT, 'scripts', 'healthcheck.sh'), '--url', 'http://127.0.0.1:9'], { cwd: TMP, env: { PATH: process.env.PATH } });
  assert.strictEqual(down.status, 1); assert.match(down.stdout, /NOT healthy/);
});

test('shell scripts parse (bash -n) and are executable', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts')).filter((x) => x.endsWith('.sh'))) { assert.strictEqual(run('bash', ['-n', path.join(ROOT, 'scripts', f)]).status, 0, f); assert(fs.statSync(path.join(ROOT, 'scripts', f)).mode & 0o100, `${f} is not executable`); }
});

finish('ops');
