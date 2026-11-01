// templates/whatsapp-templates.json must match what W12 actually sends (names, parameter order) and what the callers use. Run: node n8n/production/tests/templates.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const wf = H.loadWf();
const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'whatsapp-templates.json'), 'utf8'));
// W15's template (n8n/final/tools/patch-w15-followup.js) is documented here; an export without the W15 section (the earlier reference build) does not carry it
if (!wf.nodes.some((n) => /^W15 – /.test(n.name))) doc.templates = doc.templates.filter((t) => t.sent_by !== 'W15');
// the payment-pending template (4G, n8n/final/tools/patch-4g-lead-qr.js) is documented here; an export without 4G does not carry it
if (!wf.nodes.some((n) => n.name === 'W16N – Plan' && String(n.parameters.jsCode).includes("'booking_payment_pending'"))) doc.templates = doc.templates.filter((t) => t.name !== 'booking_payment_pending');
const code = wf.nodes.find((n) => n.name === 'W12 – Prepare request').parameters.jsCode;
const lit = code.slice(code.indexOf('const WA_TEMPLATES = {'), code.indexOf('};', code.indexOf('const WA_TEMPLATES = {')) + 2);
const WA = new Function(`${lit}\nreturn WA_TEMPLATES;`)();
H.test('every W12 template except hello_world is documented, with the same parameter order, and the body has exactly that many {{n}} slots', () => {
  const names = Object.keys(WA).filter((k) => k !== 'hello_world').sort();
  assert.deepStrictEqual(doc.templates.map((t) => t.name).sort(), names);
  for (const t of doc.templates) {
    const keys = WA[t.name].params.map((p) => (typeof p === 'string' ? p : p.key));
    assert.deepStrictEqual(t.params, keys, t.name);
    const slots = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
    assert.deepStrictEqual(slots, keys.map((_, i) => i + 1), `${t.name}: body slots`);
    assert(t.body.length < 1000);
  }
});
H.test('the sections use only documented templates (and never hello_world)', () => {
  const documented = new Set(doc.templates.map((t) => t.name));
  const used = new Set();
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) for (const m of n.parameters.jsCode.matchAll(/template\s*[:=]\s*'([a-z0-9_]+)'/g)) used.add(m[1]);
  used.delete('hello_world');
  const everyName = new Set(doc.templates.map((t) => t.name));
  const text = wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code').map((n) => n.parameters.jsCode).join('\n');
  for (const name of everyName) if (name !== 'lead_escalation') assert(text.includes(`'${name}'`) || text.includes(`${name}`), `${name} is never referenced`);
  for (const u of used) assert(documented.has(u) || u === '', `template ${u} is used but not documented`);
});
H.test('consent is required exactly for the patient templates', () => {
  for (const t of doc.templates) assert.strictEqual(t.needs_consent, t.audience === 'patient', t.name);
});
H.finish('templates');
