#!/usr/bin/env node
// Grist migration for the production workflow: creates the Send_Ledger table and the new LEADS columns (schema/production-schema.json) in every clinic document.
// DRY RUN by default (prints what it would do). Idempotent: running it again changes nothing.
//   node scripts/migrate-grist.js --env-file .env                          dry run for every active clinic of the Agency Registry
//   node scripts/migrate-grist.js --env-file .env --apply                  do it
//   node scripts/migrate-grist.js --doc <docId> --apply                    one document only
//   node scripts/migrate-grist.js --check                                  also report missing columns of the existing schema (grist/schema.md essentials)
//   node scripts/migrate-grist.js --backfill-legacy-consent "<why>" --apply  OPTIONAL and a LEGAL decision of the clinic: marks existing leads that have a conversation or an
//       appointment as Consent_WhatsApp = true, Consent_Source = legacy. Without this, W12 sends no business-initiated template to a lead without consent.
// Needs FLOWHQ_GRIST_URL (default http://127.0.0.1:8484 outside Docker), FLOWHQ_GRIST_API_KEY, FLOWHQ_REGISTRY_DOC_ID. Nothing is ever deleted or overwritten.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const env = { ...process.env };
if (arg('--env-file')) for (const line of fs.readFileSync(arg('--env-file'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && !/^\s*#/.test(line)) env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^"(.*)"$/, '$1'); }
const BASE = String(arg('--grist-url', env.FLOWHQ_GRIST_URL_ADMIN || env.FLOWHQ_GRIST_URL || 'http://127.0.0.1:8484')).replace(/\/+$/, '');
const KEY = env.FLOWHQ_GRIST_API_KEY;
const APPLY = flag('--apply');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schema', 'production-schema.json'), 'utf8'));
const BASE_COLUMNS = Object.fromEntries(Object.entries(SCHEMA.existing).filter(([k]) => k !== 'note'));   // grist/schema.md essentials; --check reports what is missing

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (e) { json = null; }
        if (res.statusCode >= 400) return reject(new Error(`${method} ${u.pathname} -> HTTP ${res.statusCode}${json && json.error ? `: ${String(json.error).slice(0, 150)}` : ''}`));
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const colSpec = (c) => ({ id: c.id, fields: { type: c.type === 'DateTime' ? 'DateTime:Asia/Kolkata' : c.type, label: c.id, ...(c.choices ? { widgetOptions: JSON.stringify({ choices: c.choices }) } : {}) } });

async function migrateDoc(doc, label) {
  const lines = [];
  const tables = ((await request('GET', `${BASE}/api/docs/${doc}/tables`)) || {}).tables || [];
  const have = new Set(tables.map((t) => t.id));
  const todo = [];
  for (const [t, def] of Object.entries(SCHEMA.newTables)) {
    if (!have.has(t)) todo.push({ kind: 'table', t, def });
    else {
      const cols = new Set((((await request('GET', `${BASE}/api/docs/${doc}/tables/${t}/columns`)) || {}).columns || []).map((c) => c.id));
      const missing = def.columns.filter((c) => !cols.has(c.id));
      if (missing.length) todo.push({ kind: 'columns', t, cols: missing });
    }
  }
  for (const [t, list] of Object.entries(SCHEMA.newColumns)) {
    if (!have.has(t)) { lines.push(`  ! table ${t} does not exist in ${label}: nothing to add`); continue; }
    const cols = new Set((((await request('GET', `${BASE}/api/docs/${doc}/tables/${t}/columns`)) || {}).columns || []).map((c) => c.id));
    const missing = list.filter((c) => !cols.has(c.id));
    if (missing.length) todo.push({ kind: 'columns', t, cols: missing });
  }
  for (const a of todo) {
    if (a.kind === 'table') {
      lines.push(`  + create table ${a.t} (${a.def.columns.map((c) => c.id).join(', ')})`);
      if (APPLY) await request('POST', `${BASE}/api/docs/${doc}/tables`, { tables: [{ id: a.t, columns: a.def.columns.map(colSpec) }] });
    } else {
      lines.push(`  + add to ${a.t}: ${a.cols.map((c) => c.id).join(', ')}`);
      if (APPLY) await request('POST', `${BASE}/api/docs/${doc}/tables/${a.t}/columns`, { columns: a.cols.map(colSpec) });
    }
  }
  if (!todo.length) lines.push('  = nothing to do (already migrated)');
  if (flag('--check')) {
    for (const [t, cols] of Object.entries(BASE_COLUMNS)) {
      if (!have.has(t)) { lines.push(`  ! MISSING TABLE ${t} (grist/schema.md)`); continue; }
      const present = new Set((((await request('GET', `${BASE}/api/docs/${doc}/tables/${t}/columns`)) || {}).columns || []).map((c) => c.id));
      const missing = cols.filter((c) => !present.has(c));
      if (missing.length) lines.push(`  ! ${t}: missing ${missing.join(', ')} (grist/schema.md)`);
    }
  }
  const why = arg('--backfill-legacy-consent');
  if (why) {
    const leads = ((await request('GET', `${BASE}/api/docs/${doc}/tables/LEADS/records`)) || {}).records || [];
    const convs = new Set((((await request('GET', `${BASE}/api/docs/${doc}/tables/Conversations/records`)) || {}).records || []).map((r) => Number(r.fields.Lead)));
    const appts = new Set((((await request('GET', `${BASE}/api/docs/${doc}/tables/Appointments/records`)) || {}).records || []).map((r) => Number(r.fields.Lead)));
    const now = Math.floor(Date.now() / 1000);
    const ids = leads.filter((r) => r.fields.Consent_WhatsApp !== true && r.fields.Opted_Out !== true && (convs.has(r.id) || appts.has(r.id))).map((r) => r.id);
    lines.push(`  ~ legacy consent: ${ids.length} existing lead(s) with a conversation or appointment ${APPLY ? 'marked' : 'would be marked'} Consent_WhatsApp=true, source legacy (${why.slice(0, 80)})`);
    if (APPLY) for (let i = 0; i < ids.length; i += 100) await request('PATCH', `${BASE}/api/docs/${doc}/tables/LEADS/records`, { records: ids.slice(i, i + 100).map((id) => ({ id, fields: { Consent_WhatsApp: true, Consent_Source: 'legacy', Consent_At: now, Consent_Version: why.slice(0, 40) } })) });
  }
  return lines;
}

(async () => {
  if (!KEY || /^(CHANGE_ME|PASTE_)/.test(KEY)) { console.error('FLOWHQ_GRIST_API_KEY is not set (never printed).'); process.exit(2); }
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN (add --apply to change anything)'} against ${BASE}`);
  let docs = [];
  if (arg('--doc')) docs = [{ doc: arg('--doc'), label: arg('--doc') }];
  else {
    const reg = env.FLOWHQ_REGISTRY_DOC_ID;
    if (!reg || /^(CHANGE_ME|PASTE_)/.test(reg)) { console.error('FLOWHQ_REGISTRY_DOC_ID is not set (or pass --doc).'); process.exit(2); }
    const clinics = ((await request('GET', `${BASE}/api/docs/${reg}/tables/Clinics/records`)) || {}).records || [];
    docs = clinics.filter((r) => String(r.fields.Active).toUpperCase() === 'TRUE' && String(r.fields.Grist_Doc_ID || '').trim()).map((r) => ({ doc: String(r.fields.Grist_Doc_ID).trim(), label: `${r.fields.Clinic_Slug} (${String(r.fields.Grist_Doc_ID).trim().slice(0, 4)}...)` }));
    if (!docs.length) { console.error('No active clinic in the registry.'); process.exit(2); }
  }
  let failed = 0;
  for (const d of docs) {
    console.log(`clinic ${d.label}`);
    try { for (const l of await migrateDoc(d.doc, d.label)) console.log(l); } catch (e) { failed++; console.log(`  ! FAILED: ${e.message}`); }
  }
  process.exit(failed ? 1 : 0);
})();
