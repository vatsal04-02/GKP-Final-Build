#!/usr/bin/env node
// TEST ONLY. Writes a copy of a workflow whose credential references are re-pointed BY ROLE (not by name) to the stable ids that
// n8n/production/scripts/create-credentials.js creates, so the workflow can be imported into a scratch n8n and run in the real-n8n tests:
//   grist -> FlowHQ Grist API · ai-provider -> FlowHQ AI Provider · webhook -> FlowHQ W1 Webhook Auth · whatsapp -> FlowHQ WhatsApp Cloud API · smtp · telegram
//   node n8n/final/tools/remap-credentials-for-scratch.js <workflow.json> <out.json>
// The workflow id is also set to the harness's id (FhqClinicProd001).
// Never import the output into the clinic's n8n: the clinic's own credential ids are the ones in the selected workflow.
'use strict';
const fs = require('fs');
const path = require('path');
const { roleOf } = require('./audit-credentials');

const BY_ROLE = {
  grist: { httpHeaderAuth: { id: 'FhqCredGrist0001', name: 'FlowHQ Grist API' } },
  'ai-provider': { httpHeaderAuth: { id: 'FhqCredAiProv001', name: 'FlowHQ AI Provider' } },
  'webhook-auth (website enquiries / Cal.com)': { httpHeaderAuth: { id: 'FhqCredW1Hook001', name: 'FlowHQ W1 Webhook Auth' } },
  'whatsapp-meta': { httpHeaderAuth: { id: 'FhqCredWhatsApp1', name: 'FlowHQ WhatsApp Cloud API' } },
  'booking-api': { httpHeaderAuth: { id: 'FhqCredBooking01', name: 'FlowHQ Booking API' } },   // Slice 4C
  smtp: { smtp: { id: 'FhqCredSmtp00001', name: 'FlowHQ SMTP' } },
  telegram: { telegramApi: { id: 'FhqCredTelegram1', name: 'FlowHQ Telegram Alerts' } },
};

function remap(wf) {
  const out = JSON.parse(JSON.stringify(wf));
  out.id = 'FhqClinicProd001';   // the real-n8n harness imports and publishes by this id
  let n = 0;
  for (const node of out.nodes) {
    if (!node.credentials) continue;
    const target = BY_ROLE[roleOf(node)];
    if (!target) throw new Error(`no role mapping for ${node.name}`);
    node.credentials = JSON.parse(JSON.stringify(target)); n++;
  }
  return { wf: out, n };
}
module.exports = { remap, BY_ROLE };

if (require.main === module) {
  const [inFile, outFile] = process.argv.slice(2);
  if (!inFile || !outFile) { console.error('usage: node remap-credentials-for-scratch.js <workflow.json> <out.json>'); process.exit(2); }
  if (path.resolve(inFile) === path.resolve(outFile)) { console.error('refusing to overwrite the input'); process.exit(2); }
  const { wf, n } = remap(JSON.parse(fs.readFileSync(inFile, 'utf8')));
  fs.writeFileSync(outFile, `${JSON.stringify(wf, null, 2)}\n`);
  console.log(`${n} credential references re-pointed by role; written ${outFile}`);
}
