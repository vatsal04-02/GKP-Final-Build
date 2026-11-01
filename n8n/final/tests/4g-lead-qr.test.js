#!/usr/bin/env node
// 4G static checks: what the per-doctor-QR / enquiry-payment patch added, and what it must NOT do. Behaviour is proved by the real-n8n staging journey (flowhq/tests/real-grist/staging-payments.real.test.ts).
'use strict';
const fs = require('fs'); const path = require('path'); const assert = require('assert');
const { audit } = require('../tools/audit-credentials');
const patch = require('../tools/patch-4g-lead-qr');
const dir = path.join(__dirname, '..', 'workflows');
const f4g = JSON.parse(fs.readFileSync(process.env.FOURG_FILE || path.join(dir, 'FlowHQ_Clinic_Automation_production_candidate4g.json'), 'utf8'));
const f4f = JSON.parse(fs.readFileSync(path.join(dir, 'FlowHQ_Clinic_Automation_production_candidate4f.json'), 'utf8'));
let failed = 0; const t = (name, fn) => { try { fn(); console.log(`  ok ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}: ${String(e.message).split('\n')[0]}`); } };
const by = (wf, n) => wf.nodes.find((x) => x.name === n);

t('the committed 4G file is exactly patch(4F): new id and name, inactive', () => { assert.deepStrictEqual(patch.patch(f4f), f4g); assert.strictEqual(f4g.id, patch.NEW_ID); assert.strictEqual(f4g.active, false); assert.notStrictEqual(f4g.id, f4f.id); });
t('every Code node compiles', () => { const AF = Object.getPrototypeOf(async function () {}).constructor; for (const n of f4g.nodes) if (n.parameters && typeof n.parameters.jsCode === 'string') new AF('$input', '$json', '$', '$itemIndex', '$env', '$workflow', n.parameters.jsCode); });
t('only W12 sender code, W16N Plan / Image item / Get QR and W16S QR / Shape changed; no node, connection or credential added or removed', () => {
  assert.deepStrictEqual(f4g.connections, f4f.connections); assert.strictEqual(f4g.nodes.length, f4f.nodes.length);
  const old = new Map(f4f.nodes.map((n) => [n.name, n])); const changed = [];
  for (const n of f4g.nodes) { const o = old.get(n.name); assert(o, `new node ${n.name}`); assert.deepStrictEqual(n.credentials, o.credentials); if (JSON.stringify(n.parameters) !== JSON.stringify(o.parameters)) changed.push(n.name); }
  for (const c of changed) assert(/^W12 |^W16N [–-] (Plan|Image item|Get QR)$|^W16S [–-] (FLOW HQ QR image|Shape)$/.test(c), `unexpected change to ${c}`);
  assert(changed.includes('W16N – Plan') && changed.includes('W16S – Shape'));
});
t('credential roles stay clean', () => { assert(!audit(f4g).credentials.some((c) => c.shared)); });
t('the QR is always the one of THAT payment (payment_ref), never a fixed image: notifier and website', () => {
  for (const n of ['W16N – Get QR', 'W16S – FLOW HQ QR image']) assert(/payments\/qr\?payment_ref=\{\{ encodeURIComponent\(/.test(by(f4g, n).parameters.url), n);
});
t('an enquiry-made request is sent as the TEMPLATE with the QR as its image header; a chat-made one is still an image + text inside the window', () => {
  const plan = by(f4g, 'W16N – Plan').parameters.jsCode; assert(plan.includes("template: 'booking_payment_pending'") && plan.includes("message_type: 'text', text_body: it.text"));
  const img = by(f4g, 'W16N – Image item').parameters.jsCode; assert(img.includes('header_media_id: id') && img.includes("message_type: 'image', media_id: id"));
  for (const n of f4g.nodes.filter((x) => /^W12 /.test(x.name) && x.parameters.jsCode && x.parameters.jsCode.includes('const WA_TEMPLATES'))) { const c = n.parameters.jsCode; assert(c.includes("booking_payment_pending: { params: ['name', 'clinic_name', 'date', 'time', 'doctor', 'amount', 'ref', 'minutes'] }"), n.name); assert(c.includes("type: 'header', parameters: [{ type: 'image'"), n.name); }
  assert(f4g.nodes.filter((x) => /^W12 /.test(x.name) && x.parameters.jsCode && x.parameters.jsCode.includes("booking_confirmation: 'booking_transaction'")).every((x) => x.parameters.jsCode.includes("booking_payment_pending: 'booking_transaction'")));
});
t('the website page is told who the QR pays', () => { assert(by(f4g, 'W16S – Shape').parameters.jsCode.includes('payee_name: p.payee_name, payee_doctor: p.payee_doctor')); });
t('nothing in 4G can set PAID or call a staff route (unchanged from 4F)', () => { for (const n of f4g.nodes.filter((x) => /^W16/.test(x.name) && x.type === 'n8n-nodes-base.httpRequest')) { const u = String(n.parameters.url || ''); assert(!/\/(approve|refund|reject|provider-event)\b/.test(u), n.name); assert(!/tables\/(Appointments|Booking_Payments|Payment_Events)/.test(u), n.name); } });
console.log(`4g-lead-qr: ${failed ? 'FAILED' : 'all passed'}`); process.exit(failed ? 1 : 0);
