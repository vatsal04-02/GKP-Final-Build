#!/usr/bin/env node
// Creates the n8n credentials the production workflow expects (stable ids and names) from environment variables - without ever printing a value.
//   node scripts/create-credentials.js --dry-run                         list the credentials and which variables are missing (values are never shown)
//   node scripts/create-credentials.js --only FhqCredW1Hook001 ...       only the named credential(s) (by id or name); needed for an existing instance: see docs/OPENROUTER.md
//   node scripts/create-credentials.js --out credentials.import.local.json   write the import file (mode 600) and print the import command
//   node scripts/create-credentials.js --import "<command that runs n8n import:credentials --input=%FILE%>"   write, import, then overwrite + delete the file
// Variables: FLOWHQ_GRIST_API_KEY, FLOWHQ_W1_WEBHOOK_SECRET, FLOWHQ_WA_ACCESS_TOKEN, FLOWHQ_AI_API_KEY (optional), FLOWHQ_TELEGRAM_BOT_TOKEN, FLOWHQ_SMTP_*.
// Read them from a file with --env-file .env (the file is parsed here, not sourced by a shell).
const fs = require('fs');
const cp = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const envFile = arg('--env-file');
const env = { ...process.env };
if (envFile) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !/^\s*#/.test(line)) env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^"(.*)"$/, '$1');
  }
}
const blank = (v) => v === undefined || v === null || String(v).trim() === '' || /^(CHANGE_ME|PASTE_|REPLACE_)/i.test(String(v).trim());

// [id, name, type, required env, build(data), optional?]
const SPEC = [
  { id: 'FhqCredGrist0001', name: 'FlowHQ Grist API', type: 'httpHeaderAuth', need: ['FLOWHQ_GRIST_API_KEY'], data: (e) => ({ name: 'Authorization', value: `Bearer ${e.FLOWHQ_GRIST_API_KEY}` }) },
  { id: 'FhqCredW1Hook001', name: 'FlowHQ W1 Webhook Auth', type: 'httpHeaderAuth', need: ['FLOWHQ_W1_WEBHOOK_SECRET'], min: { FLOWHQ_W1_WEBHOOK_SECRET: 20 }, data: (e) => ({ name: 'X-Lead-Secret', value: e.FLOWHQ_W1_WEBHOOK_SECRET }) },
  { id: 'FhqCredWhatsApp1', name: 'FlowHQ WhatsApp Cloud API', type: 'httpHeaderAuth', need: ['FLOWHQ_WA_ACCESS_TOKEN'], data: (e) => ({ name: 'Authorization', value: `Bearer ${e.FLOWHQ_WA_ACCESS_TOKEN}` }) },
  { id: 'FhqCredAiProv001', name: 'FlowHQ AI Provider', type: 'httpHeaderAuth', need: ['FLOWHQ_AI_API_KEY'], optional: true, note: 'only needed when FLOWHQ_AI_EXTERNAL_ENABLED=true', data: (e) => ({ name: 'Authorization', value: `Bearer ${e.FLOWHQ_AI_API_KEY}` }) },
  { id: 'FhqCredBooking01', name: 'FlowHQ Booking API', type: 'httpHeaderAuth', need: ['FLOWHQ_BOOKING_API_TOKEN'], min: { FLOWHQ_BOOKING_API_TOKEN: 30 }, optional: true, note: 'only needed for W13 AI booking (Slice 4C): the token from `npm run booking-token` in FLOW HQ', data: (e) => ({ name: 'Authorization', value: `Bearer ${e.FLOWHQ_BOOKING_API_TOKEN}` }) },
  { id: 'FhqCredTelegram1', name: 'FlowHQ Telegram Alerts', type: 'telegramApi', need: ['FLOWHQ_TELEGRAM_BOT_TOKEN'], data: (e) => ({ accessToken: e.FLOWHQ_TELEGRAM_BOT_TOKEN, baseUrl: 'https://api.telegram.org' }) },
  { id: 'FhqCredSmtp00001', name: 'FlowHQ SMTP', type: 'smtp', need: ['FLOWHQ_SMTP_HOST', 'FLOWHQ_SMTP_PORT'], optional: true, note: 'only needed for e-mail alerts (staging: Mailpit)', data: (e) => ({ user: e.FLOWHQ_SMTP_USER || '', password: e.FLOWHQ_SMTP_PASSWORD || '', host: e.FLOWHQ_SMTP_HOST, port: Number(e.FLOWHQ_SMTP_PORT), secure: String(e.FLOWHQ_SMTP_SECURE).toLowerCase() === 'true', disableStarttls: String(e.FLOWHQ_SMTP_DISABLE_STARTTLS).toLowerCase() === 'true', hostName: '' }) },
];

// --only "FhqCredW1Hook001,FlowHQ W1 Webhook Auth": create just these (by id or name). For an existing instance whose Grist / OpenRouter / WhatsApp credentials already exist, create ONLY the website webhook credential: --only FhqCredW1Hook001
const wanted = arg('--only') ? arg('--only').split(',').map((s) => s.trim()).filter(Boolean) : null;
if (wanted) { const known = SPEC.flatMap((s) => [s.id, s.name]); const bad = wanted.filter((w) => !known.includes(w)); if (bad.length) { console.error(`--only: unknown credential(s): ${bad.join(', ')}`); process.exit(2); } }
const plan = SPEC.filter((s) => !wanted || wanted.includes(s.id) || wanted.includes(s.name)).map((s) => {
  const missing = s.need.filter((k) => blank(env[k]));
  const short = Object.entries(s.min || {}).filter(([k, n]) => !blank(env[k]) && String(env[k]).length < n).map(([k]) => k);
  return { ...s, missing, short, ready: missing.length === 0 && short.length === 0 };
});

console.log('FlowHQ credentials (values are never printed):');
for (const p of plan) console.log(`  ${p.ready ? 'ready  ' : p.optional ? 'skipped' : 'MISSING'}  ${p.name} (${p.type}, id ${p.id})${p.missing.length ? ` - set ${p.missing.join(', ')}` : ''}${p.short.length ? ` - ${p.short.join(', ')} is too short` : ''}${p.optional && !p.ready ? ` (optional: ${p.note})` : ''}`);
const blocking = plan.filter((p) => !p.ready && !p.optional);
if (flag('--dry-run')) process.exit(blocking.length ? 1 : 0);
if (blocking.length) { console.error('\nNothing was written: required credentials are missing.'); process.exit(1); }

const out = path.resolve(arg('--out', 'credentials.import.local.json'));
const list = plan.filter((p) => p.ready).map((p) => ({ id: p.id, name: p.name, type: p.type, data: p.data(env) }));
fs.writeFileSync(out, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(out, 0o600);
console.log(`\nwrote ${out} (${list.length} credentials, mode 600). It contains secrets: do not copy it anywhere, do not commit it.`);

const importCmd = arg('--import');
if (!importCmd) { console.log('Import it, then delete it:\n  n8n import:credentials --input=<file>   (inside the n8n container: docker compose cp <file> n8n:/tmp/c.json && docker compose exec n8n n8n import:credentials --input=/tmp/c.json)'); process.exit(0); }
let status = 1;
try {
  const r = cp.spawnSync('/bin/sh', ['-c', importCmd.replace(/%FILE%/g, out)], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: process.env });
  status = r.status;
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  console.log(text.split('\n').filter((l) => !/data|secret|token|password/i.test(l)).join('\n').trim());
  console.log(status === 0 ? 'import finished' : `import FAILED (exit ${status})`);
} finally {
  try { fs.writeFileSync(out, 'x'.repeat(4096)); fs.unlinkSync(out); console.log('the import file was overwritten and deleted'); } catch (e) { console.error(`COULD NOT delete ${out}: delete it by hand`); }
}
process.exit(status === 0 ? 0 : 1);
