#!/usr/bin/env node
// 4D safety fix (n8n/final/tools/patch-4d-allowlist-gate.js): while FLOWHQ_WA_SEND_MODE=allowlist, a message from a number that is NOT on the allowlist is not sent to
// the AI provider. Mock provider and Meta only; nothing leaves this computer.
'use strict';
const path = require('path');
const assert = require('assert');
process.env.PROD_FILE = process.env.FOURD_FILE || path.join(__dirname, '..', 'workflows', 'FlowHQ_Clinic_Automation_production_candidate4d.json');
process.env.SIM_CRED = process.env.SIM_CRED || JSON.stringify({ meta: 'WhatsApp Cloud API', openrouter: 'OpenRouter API' });
const H = require('../../production/tests/harness');
const { loadWf, runItem, inboundRequest, messageBody, fakeMeta, rows, freshGrist, test, finish, P, F, ENV } = H;

const wf = loadWf();
const T = F.sec(F.NOW);
const crm = () => freshGrist({
  Settings: F.settingsRows({ TEST_MODE: 'false', ai_mode: 'auto', owner_phone: P.OWNER }),
  LEADS: F.leadRows().map((l) => ({ ...l, fields: { ...l.fields, Consent_WhatsApp: true } })), Conversations: [], Messages: [],
});
const inbound = (env, from = P.ASHA) => {
  const cl = F.fakeClaude(); const or = F.fakeOpenRouter(cl); const meta = fakeMeta(); const g = crm();
  const res = runItem(wf, 'W2 – Webhook Inbound', inboundRequest(messageBody('What are your timings?', { id: `wamid.IN.${Math.random().toString(36).slice(2, 8)}`, from, name: 'Asha Patel', ts: T })), {
    grist: g, now: F.NOW, openrouter: or, meta, env: { ...ENV, FLOWHQ_AI_EXTERNAL_ENABLED: 'true', ...env },
  });
  const errs = [res.r, ...(res.r.subRuns || [])].filter((x) => x.error).map((x) => `${x.error.node}: ${x.error.message}`);
  assert.deepStrictEqual(errs, [], errs.join(' | '));
  return { g, or, meta, msg: rows(g, 'Messages').find((m) => m.Direction === 'In') };
};
const toPatient = (meta) => meta.calls.filter((c) => c.body && String(c.body.to || '').replace(/\D/g, '') === String(P.ASHA).replace(/\D/g, ''));

test('allowlist mode, number ON the list: the AI is asked exactly once, as before', () => {
  const x = inbound({ FLOWHQ_WA_SEND_MODE: 'allowlist', FLOWHQ_WA_ALLOWLIST: `${P.ASHA},${P.OWNER}` });
  assert.strictEqual(x.or.calls.length, 1); assert.notStrictEqual(x.msg.AI_Status, 'skipped');
});
test('allowlist mode, number NOT on the list: NO provider call, a visible skip with the reason, nothing sent to the patient, the message is kept for staff', () => {
  const x = inbound({ FLOWHQ_WA_SEND_MODE: 'allowlist', FLOWHQ_WA_ALLOWLIST: P.OWNER });
  assert.strictEqual(x.or.calls.length, 0, 'the message text must not reach the provider');
  assert.deepStrictEqual([x.msg.AI_Status, x.msg.AI_Action], ['skipped', 'skip']);
  assert.match(x.msg.AI_Reason, /allowlist/i);
  assert.strictEqual(toPatient(x.meta).length, 0, 'nothing is sent to that patient');
  assert.strictEqual(rows(x.g, 'Messages').filter((m) => m.Direction === 'In').length, 1, 'the inbound message is stored');
});
test('the allowlist is matched on the normalised number: 91XXXXXXXXXX without a plus (the production format) matches +91XXXXXXXXXX', () => {
  const x = inbound({ FLOWHQ_WA_SEND_MODE: 'allowlist', FLOWHQ_WA_ALLOWLIST: String(P.ASHA).replace(/\D/g, '') });
  assert.strictEqual(x.or.calls.length, 1);
});
test('fails closed: allowlist mode with an EMPTY allowlist sends nothing to the provider', () => {
  const x = inbound({ FLOWHQ_WA_SEND_MODE: 'allowlist', FLOWHQ_WA_ALLOWLIST: '' });
  assert.strictEqual(x.or.calls.length, 0); assert.strictEqual(x.msg.AI_Status, 'skipped');
});
test('live mode: unchanged (the allowlist does not apply, the AI is asked)', () => {
  const x = inbound({ FLOWHQ_WA_SEND_MODE: 'live', FLOWHQ_WA_ALLOWLIST: P.OWNER });
  assert.strictEqual(x.or.calls.length, 1);
});
test('the existing external-AI switch still wins: switched off = no provider call even for an allowlisted number', () => {
  const x = inbound({ FLOWHQ_AI_EXTERNAL_ENABLED: 'false', FLOWHQ_WA_SEND_MODE: 'allowlist', FLOWHQ_WA_ALLOWLIST: P.ASHA });
  assert.strictEqual(x.or.calls.length, 0); assert.match(x.msg.AI_Reason, /FLOWHQ_AI_EXTERNAL_ENABLED/);
});

finish('4d-allowlist-gate');
