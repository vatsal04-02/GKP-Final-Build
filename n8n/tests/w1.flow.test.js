const assert = require('assert');
const { simulate } = require('./n8n-sim');
const { load, withConfig, freshGrist } = require('./helpers');

const wf = withConfig(load('W1-website-lead.json'), { registry_doc_id: 'REG' });
const NOW = Date.parse('2026-10-05T10:00:00+05:30');
const hook = (body, query = {}) => [{ json: { headers: { 'x-lead-secret': 'x' }, params: {}, query, body } }];
const run = (grist, body) => simulate(wf, { start: 'Webhook', items: hook(body), grist, now: NOW });
const leads = (g) => g.docs.DOCA.Leads.map((r) => r.fields);
const logs = (g) => g.docs.DOCA.Run_Log.map((r) => r.fields);
let n = 0; const ok = (m) => { n++; console.log(`  ok  ${m}`); };

const g = freshGrist();
const form = { clinic: 'demo-physio', name: 'Asha Rao', phone: '98765 43210', enquiry: 'Back pain', page_url: 'https://x.in/c', utm_campaign: 'gads', website: '' };

let r = run(g, form);
assert.strictEqual(r.error, null, JSON.stringify(r.error));
assert.deepStrictEqual(leads(g).map((l) => [l.Lead_ID, l.Name, l.Phone, l.Source, l.Status, l.Enquiry]), [['L-20261005-0001', 'Asha Rao', '+919876543210', 'Website', 'New', 'Back pain']]);
assert.deepStrictEqual(logs(g).map((l) => [l.Workflow, l.Record, l.Outcome]), [['W1-website-lead', 'L-20261005-0001 (created)', 'ok']]);
assert(r.visited.includes('Staff alert (stub)') && r.runData['Staff alert (stub)'][0].json.staff_alert_sent === false);
ok('new lead: created in Grist with the right columns, Run_Log row written, staff alert stubbed (nothing sent)');

r = run(g, { ...form, enquiry: 'Also knee pain', utm_campaign: 'fb' });
assert.strictEqual(r.error, null, JSON.stringify(r.error));
assert.strictEqual(leads(g).length, 1);
assert.strictEqual(leads(g)[0].Enquiry, 'Back pain\n---\n2026-10-05: Also knee pain');
assert.strictEqual(leads(g)[0].UTM_Campaign, 'fb');
assert.strictEqual(leads(g)[0].Status, 'New');
assert.strictEqual(logs(g)[1].Record, 'L-20261005-0001 (updated)');
ok('same phone again: no second lead; enquiry appended; Status untouched');

r = run(g, { ...form, enquiry: 'Also knee pain', utm_campaign: 'fb' });
assert.strictEqual(r.error, null);
assert.strictEqual(leads(g).length, 1);
assert.deepStrictEqual([logs(g)[2].Outcome, logs(g)[2].Error], ['skipped', 'duplicate submission']);
assert(!r.visited.includes('Update lead') && !r.visited.includes('Staff alert (stub)'));
ok('identical resubmission: skipped as duplicate, no write, no alert');

r = run(g, { ...form, phone: '9811111111', name: 'Ravi' });
assert.deepStrictEqual(leads(g).map((l) => l.Lead_ID), ['L-20261005-0001', 'L-20261005-0002']);
ok('second patient the same day: Lead_ID continues at 0002');

r = run(g, { ...form, phone: '12345' });
assert.strictEqual(leads(g).length, 2);
assert.deepStrictEqual([logs(g).at(-1).Outcome, logs(g).at(-1).Error], ['skipped', 'invalid phone']);
r = run(g, { ...form, website: 'http://spam' });
assert.strictEqual(logs(g).at(-1).Error, 'honeypot filled');
assert.strictEqual(leads(g).length, 2);
ok('invalid phone and honeypot: logged as skipped, nothing created');

r = run(g, { ...form, clinic: 'no-such-clinic' });
assert.deepStrictEqual([r.error.node, r.error.stopAndError], ['Unknown clinic', true]);
assert.match(r.error.message, /unknown or inactive clinic slug "no-such-clinic"/);
r = run(g, { ...form, clinic: 'old-clinic' });
assert.strictEqual(r.error.node, 'Unknown clinic');
r = run(g, { ...form, clinic: '' });
assert.strictEqual(r.error.node, 'Unknown clinic');
ok('unknown / inactive / missing clinic: the run FAILS on purpose (so W11 alerts you)');

// the failure message is a clean input for W11
const w11 = load('W11-error-alert.json');
const cfg11 = withConfig(w11, { telegram_chat_id: '-1001' });
r = run(g, { ...form, clinic: 'no-such-clinic' });
const t = simulate(cfg11, { start: 'Error Trigger', grist: g, now: NOW, staticData: {}, items: [{ json: { workflow: { id: '1', name: 'W1 - Website lead intake' }, execution: { id: '9', url: 'https://h/workflow/1/executions/9', lastNodeExecuted: r.error.node, error: { message: r.error.message } } } }] });
assert.strictEqual(t.error, null, JSON.stringify(t.error));
assert.strictEqual(t.telegram.length, 1);
assert.match(t.telegram[0].text, /Workflow: W1 - Website lead intake\nStep: Unknown clinic\nError: W1: unknown or inactive clinic slug &quot;?|Error: W1: unknown or inactive clinic slug "no-such-clinic"/);
assert.strictEqual(t.telegram[0].chatId, '-1001');
ok('W1 failure -> W11 -> one Telegram message with workflow, step and error');

console.log(`W1 simulation: ${n} scenarios pass`);
