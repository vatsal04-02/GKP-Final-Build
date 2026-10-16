// W14 (send-ledger reconcile) and multi-clinic isolation of the PRODUCTION export. Run: node n8n/production/tests/w14.test.js
const assert = require('assert');
const H = require('./harness');
const { loadWf, run, fakeMeta, ledger, rows, test, finish, DAY, P, F, REG, DOC, sendItem } = H;
const wf = loadWf();
const S = Math.floor(DAY / 1000);
const row = (id, status, ageMin, key = `K${id}`) => ({ id, fields: { Idem_Key: key, Status: status, Source: 'W5', Audience: 'patient', Template: 'reminder_24h', Created_At: S - ageMin * 60, Updated_At: S - ageMin * 60 } });

test('stale "sending" -> uncertain, old "uncertain" -> unconfirmed, everything else untouched; each change is a failed Run_Log row; Meta is never called', () => {
  const g = H.freshGrist({ Send_Ledger: [row(1, 'sending', 30), row(2, 'sending', 3), row(3, 'uncertain', 25 * 60), row(4, 'uncertain', 60), row(5, 'accepted', 5000), row(6, 'delivered', 5000)] });
  const meta = fakeMeta();
  const { r } = run(wf, 'W14 – Every 15 minutes', [{}], { grist: g, meta });
  assert.strictEqual(r.error, null, r.error && `${r.error.node}: ${r.error.message}`);
  assert.deepStrictEqual(ledger(g).map((l) => [l.id, l.Status]), [[1, 'uncertain'], [2, 'sending'], [3, 'unconfirmed'], [4, 'uncertain'], [5, 'accepted'], [6, 'delivered']]);
  const logs = rows(g, 'Run_Log').filter((l) => l.Workflow === 'W14-send-ledger');
  assert.deepStrictEqual(logs.map((l) => [l.Record, l.Outcome]), [['K1 (sending -> uncertain)', 'failed'], ['K3 (uncertain -> unconfirmed)', 'failed']]);
  assert.strictEqual(meta.calls.length, 0, 'reconcile never sends');
  // second run: nothing new
  const again = run(wf, 'W14 – Every 15 minutes', [{}], { grist: g, meta });
  assert.strictEqual(again.r.error, null);
  assert.strictEqual(rows(g, 'Run_Log').filter((l) => l.Workflow === 'W14-send-ledger').length, 2);
});

test('nothing to settle: no write at all', () => {
  const g = H.freshGrist({ Send_Ledger: [row(1, 'accepted', 100), row(2, 'rejected', 100)] });
  const { r } = run(wf, 'W14 – Every 15 minutes', [{}], { grist: g });
  assert.strictEqual(r.error, null);
  assert.strictEqual(g.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('two clinics: each clinic document is settled on its own; an inactive clinic is not touched', () => {
  const g = H.freshGrist({ Send_Ledger: [row(1, 'sending', 30, 'A1')] });
  g.docs[REG].Clinics.push({ id: 2, fields: { Clinic_Slug: 'second', Clinic_Name: 'Second', Grist_Doc_ID: 'DOCB', WA_Phone_Number_ID: '222222222222222', Active: true } });
  g.docs[REG].Clinics.push({ id: 3, fields: { Clinic_Slug: 'off', Clinic_Name: 'Off', Grist_Doc_ID: 'DOCC', WA_Phone_Number_ID: '333333333333333', Active: false } });
  g.docs.DOCB = { Send_Ledger: [row(1, 'sending', 40, 'B1'), row(2, 'uncertain', 30 * 60, 'B2')], Run_Log: [] };
  g.docs.DOCC = { Send_Ledger: [row(1, 'sending', 40, 'C1')], Run_Log: [] };
  const { r } = run(wf, 'W14 – Every 15 minutes', [{}], { grist: g });
  assert.strictEqual(r.error, null, r.error && `${r.error.node}: ${r.error.message}`);
  assert.deepStrictEqual(g.docs[DOC].Send_Ledger.map((x) => x.fields.Status), ['uncertain']);
  assert.deepStrictEqual(g.docs.DOCB.Send_Ledger.map((x) => x.fields.Status), ['uncertain', 'unconfirmed']);
  assert.deepStrictEqual(g.docs.DOCC.Send_Ledger.map((x) => x.fields.Status), ['sending'], 'inactive clinic untouched');
  assert.deepStrictEqual(g.docs[DOC].Run_Log.map((x) => x.fields.Record), ['A1 (sending -> uncertain)']);
  assert.deepStrictEqual(g.docs.DOCB.Run_Log.length, 2);
});

test('multi-clinic isolation in W12: the ledger and the consent check use the clinic\'s own document, never another clinic\'s', () => {
  const g = H.freshGrist({ LEADS: [H.ashaLead()] });
  g.docs.DOCB = { LEADS: [H.ashaLead({ Consent_WhatsApp: false })], Send_Ledger: [], Conversations: [], Messages: [], Run_Log: [], Settings: [] };
  const meta = fakeMeta();
  const a = run(wf, 'W12 – When called by another workflow', [sendItem()], { grist: g, meta });                              // clinic A: consent true
  const b = run(wf, 'W12 – When called by another workflow', [sendItem({ doc_id: 'DOCB', idem_key: 'W5:reminder_24h:uid-B' })], { grist: g, meta });   // clinic B: consent false
  assert.strictEqual(a.r.runData['W12 – Return result'][0].json.sent, true);
  assert.strictEqual(b.r.runData['W12 – Return result'][0].json.send_status, 'blocked');
  assert.deepStrictEqual([ledger(g).length, g.docs.DOCB.Send_Ledger.length], [1, 0]);
  assert.strictEqual(meta.calls.length, 1);
  // the same key in two clinics is two different messages
  g.docs.DOCB.LEADS[0].fields.Consent_WhatsApp = true;
  const c = run(wf, 'W12 – When called by another workflow', [sendItem({ doc_id: 'DOCB' })], { grist: g, meta });
  assert.strictEqual(c.r.runData['W12 – Return result'][0].json.sent, true);
  assert.deepStrictEqual([ledger(g).length, g.docs.DOCB.Send_Ledger.length], [1, 1]);
});

finish('W14 + isolation');
