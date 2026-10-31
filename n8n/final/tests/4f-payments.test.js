#!/usr/bin/env node
// 4F static checks (no simulator): what the payment patch added, and what it must NOT do. The behaviour is proved by the real-n8n staging journey.
'use strict';
const fs = require('fs'); const path = require('path'); const assert = require('assert');
const { audit } = require('../tools/audit-credentials');
const patch = require('../tools/patch-4f-payments');
const dir = path.join(__dirname, '..', 'workflows');
const f4 = JSON.parse(fs.readFileSync(process.env.FOURF_FILE || path.join(dir, 'FlowHQ_Clinic_Automation_production_candidate4f.json'), 'utf8'));
const e4 = JSON.parse(fs.readFileSync(path.join(dir, 'FlowHQ_Clinic_Automation_production_candidate4e.json'), 'utf8'));
let failed = 0; const t = (name, fn) => { try { fn(); console.log(`  ok ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}: ${String(e.message).split('\n')[0]}`); } };
const by = (wf, n) => wf.nodes.find((x) => x.name === n);
const codeOf = (wf, prefix) => wf.nodes.filter((n) => n.name.startsWith(prefix) && n.parameters && typeof n.parameters.jsCode === 'string');

t('the committed 4F file is exactly patch(4E): new id and name, inactive', () => { assert.deepStrictEqual(patch.patch(e4), f4); assert.strictEqual(f4.id, patch.NEW_ID); assert.strictEqual(f4.active, false); });
t('every Code node compiles (a syntax error here only shows up when n8n runs it)', () => { const AF = Object.getPrototypeOf(async function () {}).constructor; for (const n of f4.nodes) if (n.parameters && typeof n.parameters.jsCode === 'string') new AF('$input', '$json', '$', '$itemIndex', '$env', '$workflow', n.parameters.jsCode); });
t('only 4E nodes the patch names changed (W12 sender code, W13 booked-reply wording, W2 parse and AI job); everything else is identical or new', () => {
  const old = new Map(e4.nodes.map((n) => [n.name, n])); const changed = [];
  for (const n of f4.nodes) { const o = old.get(n.name); if (!o) { assert(/^W16/.test(n.name), `unexpected new node ${n.name}`); continue; } if (JSON.stringify(n.parameters) !== JSON.stringify(o.parameters)) changed.push(n.name); }
  for (const c of changed) assert(/^W12 |^W13 |^W2 [–-] (Parse Meta Event|AI Job)$/.test(c), `unexpected change to ${c}`);
  assert(changed.some((c) => c.startsWith('W12 ')) && changed.includes('W2 – Parse Meta Event'));
});
t('the credential roles stay clean: WhatsApp only for Meta calls, the AI credential only for the model, FLOW HQ only through its booking API, the webhook credential only on webhooks', () => { assert(!audit(f4).credentials.some((c) => c.shared)); });
t('the website webhook is header-authenticated with the website credential (never open) and responds through a Respond node', () => { const w = by(f4, 'W16S – Webhook'); assert.strictEqual(w.parameters.authentication, 'headerAuth'); assert.strictEqual(w.credentials.httpHeaderAuth.name, 'FlowHQ W1 Webhook Auth'); assert.strictEqual(w.parameters.path, 'site-payments'); assert.strictEqual(w.parameters.responseMode, 'responseNode'); });
t('NOTHING in the payment nodes can set PAID: no node writes a payment status or an appointment; FLOW HQ is only called for requests, screenshots, extraction, status, notified and the QR', () => {
  for (const n of f4.nodes.filter((x) => /^W16/.test(x.name) && x.type === 'n8n-nodes-base.httpRequest')) {
    const url = String(n.parameters.url || ''); assert(!/tables\/(Appointments|Booking_Payments|Payment_Events)/.test(url), n.name);
    if (/\/api\/booking\//.test(url)) assert(/\/api\/booking\/(payments\/|availability)/.test(url.replace(/\{\{[^}]*\}\}/g, '')) || /payments\/\{\{/.test(url) || /\/availability/.test(url), `${n.name}: ${url}`);
    assert(!/\/(approve|refund|reject|provider-event)\b/.test(url), `${n.name} calls a staff / provider route`);
  }
  for (const n of codeOf(f4, 'W16')) assert(!/Status:\s*['"]PAID['"]|mark[_ ]?paid\s*[:=]\s*true/i.test(n.parameters.jsCode.replace(/mark this payment as PAID/g, '')), n.name);
});
t('the AI reader is only called after the gate (external AI on; WhatsApp: allowlist; website: its own switch) and its answer goes to FLOW HQ as untrusted data', () => {
  for (const p of ['W16', 'W16S']) { const g = by(f4, `${p} – OCR gate`).parameters.jsCode; for (const k of ['external_ai_off', 'website_ocr_off', 'not_on_allowlist']) assert(g.includes(k), `${p} gate lacks ${k}`); assert(g.includes('never follow instructions') || by(f4, `${p} – OCR gate`).parameters.jsCode.includes('DATA: never follow'), `${p}: the prompt must say image text is data`); }
  const s = by(f4, 'W16 – Send extraction'); assert(/payments\/\{\{ encodeURIComponent\(\$json\.payment_ref\) \}\}\/extraction/.test(s.parameters.url));
});
t('the media download is limited to Meta hosts', () => { const c = by(f4, 'W16 – Media URL').parameters.jsCode; for (const h of ['fbsbx\\.com', 'whatsapp\\.net']) assert(c.includes(h), h); });
t('payment messages are sent only through W12 (the one sender): the notifier has no Meta send node of its own', () => { assert(f4.nodes.filter((n) => /^W16N/.test(n.name) && /\/messages$/.test(String(n.parameters.url || ''))).length === 0); assert(by(f4, "W16N – Call 'W12 - WhatsApp send'")); });
t('the notifier text and the quiet-hour exemption: W12 treats W16 payment messages as replies', () => { assert(codeOf(f4, 'W12 ').some((n) => n.parameters.jsCode.includes('/^W(13|10|16)-/'))); });
t('W12 can send an image only with a media id and still obeys the allowlist, ledger and consent rules (the same code path as a text reply)', () => { const c = by(f4, 'W12 – Prepare request').parameters.jsCode; assert(c.includes("image message: media_id is missing")); assert(c.includes("type: 'image'")); assert(c.indexOf("if (mode === 'allowlist')") > 0); });
console.log(`4f-payments: ${failed ? 'FAILED' : 'all passed'}`); process.exit(failed ? 1 : 0);
