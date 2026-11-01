#!/usr/bin/env node
// 4G: per-doctor QR + payment requests for website enquiries.   4G = 4F + this patch.   node n8n/final/tools/patch-4g-lead-qr.js <4f-workflow.json> <output.json>
//
//  * W16N / W16S ask FLOW HQ for the QR OF THAT PAYMENT (`/payments/qr?payment_ref=`): FLOW HQ chose the doctor's account from the real clock when the request was made.
//  * W16S passes the payee (doctor and receiver name) to the website page.
//  * A payment made automatically from a website ENQUIRY (channel `enquiry`) is the first message to a patient who has not written to us, so W16N sends it as an approved TEMPLATE
//    `booking_payment_pending` whose HEADER IS THE QR IMAGE (WhatsApp allows free text and images only inside 24 h of the patient's own message). W12 gets: that template in its list,
//    the header-image component, and the booking_transaction consent purpose for it. Same ledger, allowlist, TEST_MODE, opt-out and consent rules as every other send.
//  The template must be created and approved in Meta (docs/payments-status.md has the exact text). Until then Meta rejects it (132001) and nothing reaches the patient.
'use strict';
const D = '–';
const NEW_ID = 'F4gLeadQr0000001';
const NEW_NAME = 'FlowHQ Clinic Automation 4G candidate (4F + per-doctor QR and enquiry payment requests)';
const clone = (o) => JSON.parse(JSON.stringify(o));
const count = (s, sub) => s.split(sub).length - 1;

const TPL_OLD = "  booking_confirmation: { params: ['name', 'service', 'clinic_name', 'date', 'time'] },\n";
const TPL_NEW = TPL_OLD + "  booking_payment_pending: { params: ['name', 'clinic_name', 'date', 'time', 'doctor', 'amount', 'ref', 'minutes'] },   // 4G: image header = the doctor's payment QR\n";
const COMP_OLD = "  if (params.length) template.components = [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }];\n";
const COMP_NEW = COMP_OLD + "  if (/^\\d{5,30}$/.test(String(input.header_media_id || ''))) (template.components ||= []).unshift({ type: 'header', parameters: [{ type: 'image', image: { id: String(input.header_media_id) } }] });   // 4G\n";
const CONSENT_OLD = "  booking_confirmation: 'booking_transaction',\n";
const CONSENT_NEW = CONSENT_OLD + "  booking_payment_pending: 'booking_transaction',\n";

function patch(wf) {
  const out = clone(wf);
  if (out.nodes.some((n) => (n.parameters || {}).jsCode && n.parameters.jsCode.includes('booking_payment_pending'))) throw new Error('already patched');
  const by = (n) => { const f = out.nodes.filter((x) => x.name === n); if (f.length !== 1) throw new Error(`node "${n}" found ${f.length} times`); return f[0]; };
  const swap = (node, oldS, newS) => { const c = node.parameters.jsCode; if (count(c, oldS) !== 1) throw new Error(`${node.name}: expected one occurrence of ${JSON.stringify(oldS.slice(0, 60))}, found ${count(c, oldS)}`); node.parameters.jsCode = c.replace(oldS, () => newS); };

  // W12: the template, its image header, its consent purpose (every node that carries a copy)
  let w12 = 0;
  for (const n of out.nodes.filter((x) => x.name.startsWith('W12 ') && typeof (x.parameters || {}).jsCode === 'string')) {
    let c = n.parameters.jsCode; const b = c;
    if (c.includes(TPL_OLD)) c = c.replace(TPL_OLD, () => TPL_NEW);
    if (c.includes(COMP_OLD)) c = c.replace(COMP_OLD, () => COMP_NEW);
    if (c.includes(CONSENT_OLD)) c = c.replace(CONSENT_OLD, () => CONSENT_NEW);
    if (c !== b) { n.parameters.jsCode = c; w12++; }
  }
  if (w12 < 3) throw new Error(`W12 changed in ${w12} node(s), expected at least 3`);

  // W16N: the enquiry-made request goes out as the template; the QR is that payment's own
  swap(by(`W16N ${D} Plan`), "message_type: 'text', text_body: it.text, message_text: it.text, last_inbound_at: it.last_inbound_at,",
    "...(it.needs_template ? { message_type: '', template: 'booking_payment_pending', template_params: { clinic_name: clinic.clinic_name || 'the clinic', ...(it.template_params || {}) } } : { message_type: 'text', text_body: it.text }), message_text: it.text, last_inbound_at: it.last_inbound_at,");
  swap(by(`W16N ${D} Image item`), "return { json: { ...ctx, message_type: 'image', media_id: id } };", "return { json: { ...ctx, ...(ctx.template ? { header_media_id: id } : { message_type: 'image', media_id: id }) } };");
  const getQr = by(`W16N ${D} Get QR`); const u1 = getQr.parameters.url;
  if (!u1.endsWith('/api/booking/payments/qr')) throw new Error('W16N Get QR url changed');
  getQr.parameters.url = `${u1}?payment_ref={{ encodeURIComponent($('W16N ${D} Plan').item.json.payment_ref) }}`;

  // W16S (the website): the QR of the booking being viewed, and who it pays
  const siteQr = by(`W16S ${D} FLOW HQ QR image`); const u2 = siteQr.parameters.url;
  if (!u2.endsWith('/api/booking/payments/qr')) throw new Error('W16S QR url changed');
  siteQr.parameters.url = `${u2}?payment_ref={{ encodeURIComponent($('W16S ${D} Route').item.json.payment_ref) }}`;
  swap(by(`W16S ${D} Shape`), "const view = (p) => p && ({ payment_ref: p.payment_ref,", "const view = (p) => p && ({ payee_name: p.payee_name, payee_doctor: p.payee_doctor, payment_ref: p.payment_ref,");

  out.name = NEW_NAME; out.id = NEW_ID; out.active = false;
  return out;
}

module.exports = { patch, NEW_ID, NEW_NAME };

if (require.main === module) {
  const fs = require('fs'); const [inp, outp] = process.argv.slice(2);
  if (!inp || !outp) { console.error('usage: node n8n/final/tools/patch-4g-lead-qr.js <4f-workflow.json> <output.json>'); process.exit(2); }
  const res = patch(JSON.parse(fs.readFileSync(inp, 'utf8')));
  fs.writeFileSync(outp, `${JSON.stringify(res, null, 2)}\n`);
  console.log(`wrote ${outp}: ${res.nodes.length} nodes, id ${res.id}, inactive`);
}
