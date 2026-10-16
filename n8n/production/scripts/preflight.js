#!/usr/bin/env node
// Read-only checks before go-live. Prints PASS / WARN / FAIL and never a secret value. Exit 1 when anything FAILs.
//   node scripts/preflight.js                         .env + secrets + workflow file + compose syntax
//   node scripts/preflight.js --env .env.staging      another environment file
//   node scripts/preflight.js --workflow-only <file>  only the workflow export (used by import-workflow.sh)
//   node scripts/preflight.js --online                also: Grist reachable, every clinic document has the tables / columns, Meta phone numbers answer
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(k);
let bad = 0;
const out = (level, msg) => { if (level === 'FAIL') bad++; console.log(`${level.padEnd(4)}  ${msg}`); };
const pass = (m) => out('PASS', m); const warn = (m) => out('WARN', m); const fail = (m) => out('FAIL', m);

// ---------------------------------------------------------------- workflow file
function checkWorkflow(file) {
  let wf;
  try { wf = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fail(`${file} is not valid JSON`); }
  const nodes = wf.nodes || [];
  nodes.length > 300 ? pass(`workflow ${path.basename(file)}: ${nodes.length} nodes`) : fail(`workflow has only ${nodes.length} nodes: wrong file?`);
  wf.active === false ? pass('the export is inactive (nothing runs until you activate it)') : fail('the export is ACTIVE: importing it would start listening / sending before configuration is tested');
  wf.id === 'FhqClinicProd001' ? pass('workflow id FhqClinicProd001 (cannot overwrite another workflow)') : fail(`unexpected workflow id ${wf.id}`);
  const text = JSON.stringify(wf);
  const secrets = [['bearer token', /Bearer\s+[A-Za-z0-9._-]{10,}/], ['Meta access token', /EAA[A-Za-z0-9]{20,}/], ['API key', /sk-(or-)?[A-Za-z0-9-]{20,}/], ['Telegram bot token', /\d{8,10}:[A-Za-z0-9_-]{30,}/], ['long hex secret', /\b[0-9a-f]{32,}\b/i]].filter(([, re]) => re.test(text)).map(([n]) => n);
  secrets.length ? fail(`the workflow file looks like it contains: ${secrets.join(', ')}`) : pass('no secret-like value in the workflow file');
  /allowUnauthorizedCerts/.test(text) ? fail('a node has allowUnauthorizedCerts (TLS verification off)') : pass('TLS verification is on in every node');
  /DISABLE_QUIET_HOURS_FOR_TEST = true/.test(text) ? fail('the quiet-hours test switch is ON') : pass('quiet-hours test switch is off');
  const hooks = nodes.filter((n) => n.type === 'n8n-nodes-base.webhook');
  hooks.every((h) => h.parameters.responseMode === 'responseNode') ? pass(`${hooks.length} webhooks, all answer after processing (Respond to Webhook)`) : fail('a webhook answers before processing (responseMode not responseNode)');
  let badCode = 0;
  for (const n of nodes.filter((x) => x.type === 'n8n-nodes-base.code')) { try { new Function('$', '$input', '$json', '$getWorkflowStaticData', '$env', '$binary', `return (async () => { ${n.parameters.jsCode}\n})`); } catch (e) { badCode++; } }
  badCode ? fail(`${badCode} Code node(s) do not parse`) : pass('every Code node parses');
  return wf;
}

if (flag('--workflow-only')) { checkWorkflow(args[args.indexOf('--workflow-only') + 1] || path.join(ROOT, 'clinic-autopilot-production.json')); process.exit(bad ? 1 : 0); }

// ---------------------------------------------------------------- environment
const envFile = path.resolve(ROOT, arg('--env', '.env'));
const env = {};
if (!fs.existsSync(envFile)) fail(`${path.basename(envFile)} does not exist (copy .env.example)`);
else {
  const st = fs.statSync(envFile);
  (st.mode & 0o077) === 0 ? pass(`${path.basename(envFile)} is private (mode ${(st.mode & 0o777).toString(8)})`) : warn(`${path.basename(envFile)} is readable by others (mode ${(st.mode & 0o777).toString(8)}): chmod 600`);
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && !/^\s*#/.test(line)) env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^"(.*)"$/, '$1'); }
  const blank = (k) => !env[k] || /^(CHANGE_ME|PASTE_|REPLACE_)/i.test(env[k]);
  const REQUIRED = ['N8N_DOMAIN', 'N8N_ADMIN_DOMAIN', 'ADMIN_ALLOW_CIDR', 'GRIST_DOMAIN', 'ACME_EMAIL', 'N8N_VERSION', 'GRIST_VERSION', 'GRIST_SESSION_SECRET', 'GRIST_ADMIN_EMAIL', 'FLOWHQ_REGISTRY_DOC_ID', 'FLOWHQ_META_APP_SECRET', 'FLOWHQ_META_VERIFY_TOKEN', 'FLOWHQ_CAL_WEBHOOK_SECRET', 'FLOWHQ_WA_ALLOWLIST', 'FLOWHQ_WA_GRAPH_VERSION'];
  const missing = REQUIRED.filter(blank);
  missing.length ? fail(`not set (still a placeholder): ${missing.join(', ')}`) : pass('all required variables are set');
  for (const [k, n] of [['FLOWHQ_META_APP_SECRET', 16], ['FLOWHQ_META_VERIFY_TOKEN', 16], ['FLOWHQ_CAL_WEBHOOK_SECRET', 16], ['GRIST_SESSION_SECRET', 24]]) if (!blank(k) && env[k].length < n) fail(`${k} is shorter than ${n} characters`);
  if (env.N8N_VERSION === 'latest') fail('N8N_VERSION=latest: pin an exact version'); else if (env.N8N_VERSION && env.N8N_VERSION !== '2.43.5') warn(`N8N_VERSION=${env.N8N_VERSION}: the tests ran against 2.43.5; re-run the tests before using another version`);
  if (env.GRIST_VERSION === 'latest') fail('GRIST_VERSION=latest: pin an exact version');
  if (!/^v\d+\.\d+$/.test(env.FLOWHQ_WA_GRAPH_VERSION || '')) fail('FLOWHQ_WA_GRAPH_VERSION must look like v23.0');
  const mode = (env.FLOWHQ_WA_SEND_MODE || 'allowlist').toLowerCase();
  if (!['allowlist', 'live', 'off'].includes(mode)) fail('FLOWHQ_WA_SEND_MODE must be allowlist, live or off');
  else if (mode === 'live') warn('FLOWHQ_WA_SEND_MODE=live: real patients receive messages. Only after the go-live checklist in DEPLOYMENT.md.');
  else pass(`WhatsApp send mode: ${mode}`);
  env.FLOWHQ_AI_EXTERNAL_ENABLED === 'true' ? warn('external AI is ENABLED: masked patient messages go to the AI provider (PRIVACY.md)') : pass('external AI is off');
  env.FLOWHQ_WA_ALLOW_HELLO_WORLD === 'true' ? warn("FLOWHQ_WA_ALLOW_HELLO_WORLD=true: Meta's sample template may be sent (smoke tests only)") : pass('hello_world is refused');
  env.FLOWHQ_WA_GRAPH_BASE_URL || env.FLOWHQ_AI_BASE_URL ? warn('a base URL override is set: it must be unset in production') : pass('provider endpoints are the defaults');
  if (env.FLOWHQ_ALERT_EMAIL_TO) (env.FLOWHQ_EMAIL_FROM ? pass('e-mail alerts are configured') : fail('FLOWHQ_ALERT_EMAIL_TO is set without FLOWHQ_EMAIL_FROM'));
  else warn('no FLOWHQ_ALERT_EMAIL_TO: staff get no e-mail for website enquiries');
  blank('FLOWHQ_TELEGRAM_CHAT_ID') ? warn('no Telegram chat id: workflow failures raise no alert (they are still in the n8n execution list)') : pass('error alerts: Telegram chat id set');
  blank('BACKUP_PASSPHRASE') ? warn('BACKUP_PASSPHRASE is not set: scripts/backup.sh will refuse to run') : pass('backup passphrase set');
}
const keyFile = path.join(ROOT, 'secrets', path.basename(envFile).includes('staging') ? 'n8n_encryption_key.staging' : 'n8n_encryption_key');
if (fs.existsSync(keyFile)) { const k = fs.readFileSync(keyFile, 'utf8').trim(); k.length >= 32 ? pass('n8n encryption key file present (back it up separately)') : fail('the n8n encryption key file is too short'); } else fail(`${path.relative(ROOT, keyFile)} is missing: run scripts/init-secrets.sh`);

// ---------------------------------------------------------------- workflow + compose
const wfFile = path.join(ROOT, arg('--workflow', 'clinic-autopilot-production.json'));
fs.existsSync(wfFile) ? checkWorkflow(wfFile) : fail(`${path.basename(wfFile)} not found`);
const composeFile = path.join(ROOT, 'ops', envFile.includes('staging') ? 'docker-compose.staging.yml' : 'docker-compose.production.yml');
const dc = cp.spawnSync('docker', ['compose', '-f', composeFile, '--env-file', envFile, '--project-directory', ROOT, 'config', '-q'], { encoding: 'utf8' });
if (dc.error) warn('docker is not installed here: compose file not checked');
else dc.status === 0 ? pass(`${path.basename(composeFile)} is valid with this environment`) : fail(`${path.basename(composeFile)}: ${String(dc.stderr).split('\n')[0].slice(0, 160)}`);

// ---------------------------------------------------------------- online
function get(url, headers) {
  return new Promise((resolve) => {
    const u = new URL(url); const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers, timeout: 15000 }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json: j }); }); });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve({ status: 0, json: null }));
  });
}
(async () => {
  if (flag('--online')) {
    const base = String(arg('--grist-url', env.FLOWHQ_GRIST_URL_ADMIN || 'http://127.0.0.1:8484')).replace(/\/+$/, '');
    const key = env.FLOWHQ_GRIST_API_KEY;
    const H = { Authorization: `Bearer ${key}` };
    const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'production-schema.json'), 'utf8'));
    if (!key || /^CHANGE_ME/.test(key)) fail('--online needs FLOWHQ_GRIST_API_KEY');
    else {
      const reg = await get(`${base}/api/docs/${env.FLOWHQ_REGISTRY_DOC_ID}/tables/Clinics/records`, H);
      if (reg.status !== 200) fail(`Grist registry not readable (HTTP ${reg.status}) at ${base}`);
      else {
        pass('Grist: Agency Registry readable');
        const active = (reg.json.records || []).filter((r) => String(r.fields.Active).toUpperCase() === 'TRUE' && r.fields.Grist_Doc_ID);
        active.length ? pass(`${active.length} active clinic(s) in the registry`) : fail('no active clinic in the registry');
        for (const c of active) {
          const doc = String(c.fields.Grist_Doc_ID).trim(); const label = c.fields.Clinic_Slug;
          const tabs = await get(`${base}/api/docs/${doc}/tables`, H);
          if (tabs.status !== 200) { fail(`clinic ${label}: document not readable (HTTP ${tabs.status})`); continue; }
          const have = new Set((tabs.json.tables || []).map((t) => t.id));
          const need = { ...Object.fromEntries(Object.entries(SCHEMA.existing).filter(([k]) => k !== 'note')), Send_Ledger: SCHEMA.newTables.Send_Ledger.columns.map((x) => x.id) };
          const lack = [];
          for (const [t, cols] of Object.entries(need)) {
            if (!have.has(t)) { lack.push(`table ${t}`); continue; }
            const present = new Set(((await get(`${base}/api/docs/${doc}/tables/${t}/columns`, H)).json || { columns: [] }).columns.map((x) => x.id));
            const m = cols.filter((x) => !present.has(x)); if (m.length) lack.push(`${t}: ${m.join(', ')}`);
          }
          const newCols = SCHEMA.newColumns.LEADS.map((x) => x.id);
          const present = new Set(((await get(`${base}/api/docs/${doc}/tables/LEADS/columns`, H)).json || { columns: [] }).columns.map((x) => x.id));
          const m2 = newCols.filter((x) => !present.has(x)); if (m2.length) lack.push(`LEADS: ${m2.join(', ')}`);
          lack.length ? fail(`clinic ${label}: missing ${lack.join(' | ')} (run scripts/migrate-grist.js --apply)`) : pass(`clinic ${label}: all tables and columns present`);
          if (!/^\d{5,25}$/.test(String(c.fields.WA_Phone_Number_ID || '').trim())) warn(`clinic ${label}: WA_Phone_Number_ID is not a Meta phone-number id`);
          const settings = await get(`${base}/api/docs/${doc}/tables/Settings/records`, H);
          const keys = new Map(((settings.json || {}).records || []).map((r) => [String(r.fields.Key || '').trim(), String(r.fields.Value || '').trim()]));
          keys.get('TEST_MODE') === 'false' ? warn(`clinic ${label}: TEST_MODE=false (patients receive messages)`) : pass(`clinic ${label}: TEST_MODE is on (messages go to TEST_PHONE)`);
          for (const k of ['owner_phone', 'clinic_name']) if (!keys.get(k)) warn(`clinic ${label}: Settings.${k} is empty`);
        }
      }
    }
    const tok = env.FLOWHQ_WA_ACCESS_TOKEN;
    if (tok && !/^CHANGE_ME/.test(tok) && env.FLOWHQ_WA_PHONE_NUMBER_ID_CHECK) {
      const r = await get(`https://graph.facebook.com/${env.FLOWHQ_WA_GRAPH_VERSION}/${env.FLOWHQ_WA_PHONE_NUMBER_ID_CHECK}?fields=display_phone_number`, { Authorization: `Bearer ${tok}` });
      r.status === 200 ? pass('Meta: the token can read the phone number') : fail(`Meta: HTTP ${r.status} for the phone number id (token or id wrong)`);
    } else warn('Meta token / phone number not checked here (set FLOWHQ_WA_PHONE_NUMBER_ID_CHECK to check one)');
  }
  console.log(bad ? `\n${bad} check(s) FAILED: do not go live.` : '\nno FAIL. Read the WARN lines, then the go-live checklist.');
  process.exit(bad ? 1 : 0);
})();
