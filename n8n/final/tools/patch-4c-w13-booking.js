#!/usr/bin/env node
// Slice 4C: W13 (the WhatsApp AI receptionist) books, cancels and moves appointments ONLY through the FLOW HQ booking API; no Cal.com link; no direct Grist writes.
//
//   node n8n/final/tools/patch-4c-w13-booking.js <candidate.json> <output.json> [--snippet <path>]
//
// Run it AFTER patch-4c-consent.js (it builds on that output, but touches different nodes). What changes:
//   * "W13 – Availability days / Booking availability / Availability collect": the free times of the next days come from GET /api/booking/availability (bearer credential
//     "FlowHQ Booking API"); W13's own slot arithmetic is no longer used. Unreachable / not configured / AI booking off = no times are offered (the AI hands off).
//   * "W13 – Central calls? / Split central calls / Booking API / Central collect": ONE call per message at most (create, cancel or reschedule), only after the patient said YES to a
//     question naming the exact day and time, with a stable Idempotency-Key. The reply says "booked" only after the API answered 200/201 ("W13 – Plan Ready" applies the answer).
//   * the snippet copies in Build Context / Plan / Plan Ready / Record Sends get the central logic (n8n/final/tools/4c/w13-transform.js): booking_mode = direct is ignored, Cal.com
//     links are never built or accepted, the AI prompt no longer talks about cancel / reschedule links.
// Settings > booking_mode = direct, and every Appointments write from W13, are gone. The old nodes (Write Action etc.) stay; they now receive no writes from W13.
// New environment variable: FLOWHQ_BOOKING_API_URL (for example http://flowhq:8787). New credential: "FlowHQ Booking API" (Header Auth: Authorization = Bearer <token>).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const T = require('./4c/w13-transform');

const N = {
  appts: 'W13 – Appointments', w6settings: 'W6 – Add settings', w15plan: 'W15 – Plan', w15build: 'W15 – Build Message', w15held: 'W15 – Held summary', start: 'W13 – Start', build: 'W13 – Build Context', plan: 'W13 – Plan', ready: 'W13 – Plan Ready', record: 'W13 – Record Sends', cfg: 'W13 – Config', writes: 'W13 – Action Writes?',
  days: 'W13 – Availability days', avail: 'W13 – Booking availability', collectAvail: 'W13 – Availability collect',
  calls: 'W13 – Central calls?', split: 'W13 – Split central calls', api: 'W13 – Booking API', collect: 'W13 – Central collect',
};
const CRED = { id: 'FhqCredBooking01', name: 'FlowHQ Booking API' };
const ADDED = [N.days, N.avail, N.collectAvail, N.calls, N.split, N.api, N.collect];
const CHANGED = [N.build, N.plan, N.ready, N.record, N.cfg, N.start, N.w6settings, N.w15plan, N.w15build, N.w15held];
const CHANGED_CONNECTIONS = [N.appts, N.plan];

const uuid = (seed) => { const h = crypto.createHash('sha1').update(`4c-w13:${seed}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const clone = (o) => JSON.parse(JSON.stringify(o));

const DAYS_CODE = `// The next days to ask the booking system about (one GET /availability per day). Nothing is configured = one item with an empty address: the call fails and
// "Availability collect" reports "not configured", so no time is ever offered.
const cfg = $('W13 – Start').first().json;
const base = String(cfg.booking_api_url || '').trim().replace(/\\/+$/, '');
const n = Math.min(14, Math.max(2, Number(cfg.slot_days) || 7));
const out = [];
for (let i = 0; i < n; i++) out.push({ json: { date: new Date(Date.now() + 5.5 * 3600 * 1000 + i * 86400000).toISOString().slice(0, 10), booking_api_url: base } });
return out;
`;
const COLLECT_AVAIL_CODE = `// The booking system's free times for the coming days, in the shape the W13 snippet reads (raw.central). Fail closed: ANY problem (not configured, no answer,
// 401/403, a non-200 answer, AI booking off in the CRM) means no time is offered at all and the reason is kept for the staff note.
const cfg = $('W13 – Start').first().json;
const configured = !!String(cfg.booking_api_url || '').trim();
let ok = configured;
let available = configured;
let ai_reason = '';
let reason = configured ? '' : 'FLOWHQ_BOOKING_API_URL is not set';
const days = [];
for (const it of $input.all()) {
  const r = it.json || {};
  if (!configured) break;
  if (r.error || typeof r.statusCode !== 'number') { ok = false; reason = reason || 'the booking system did not answer'; continue; }
  if (r.statusCode === 401 || r.statusCode === 403) { ok = false; reason = reason || \`the booking token was refused (HTTP \${r.statusCode})\`; continue; }
  if (r.statusCode !== 200) { ok = false; reason = reason || \`the booking system answered HTTP \${r.statusCode}\`; continue; }
  let b = r.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  if (!b || typeof b !== 'object' || !Array.isArray(b.slots)) { ok = false; reason = reason || 'the booking system sent an unreadable answer'; continue; }
  if (!b.ai_booking || b.ai_booking.available !== true) { available = false; ai_reason = ai_reason || String((b.ai_booking && b.ai_booking.reason) || 'disabled'); }
  days.push({ date: String(b.date || ''), slots: b.slots.map((s) => ({ slot_id: s.slot_id, start_time: s.start_time, end_time: s.end_time, doctor_id: s.doctor_id, doctor_name: s.doctor_name })) });
}
return [{ json: { central: { configured, ok, available: ok && available, ai_reason, reason, days: ok ? days : [] } } }];
`;
const SPLIT_CODE = `// The ONE booking-system call this message needs. create = POST /appointments with an Idempotency-Key that is the same on every retry of this WhatsApp
// message; cancel = POST .../cancel; reschedule = PATCH. The patient's phone is the proof of ownership (the API never returns it).
const c = $json.plan.central;
const base = String($('W13 – Start').first().json.booking_api_url || '').trim().replace(/\\/+$/, '');
const ref = encodeURIComponent(c.reference || '');
let method = 'POST'; let url = \`\${base}/api/booking/appointments\`; let body;
if (c.op === 'create') body = { slot_id: c.slot_id, patient: { name: c.patient.name, phone: c.patient.phone }, service: c.service, ...(c.reason ? { reason: c.reason } : {}) };
else if (c.op === 'cancel') { url = \`\${base}/api/booking/appointments/\${ref}/cancel\`; body = { patient_phone: c.patient_phone, reason: 'Cancelled by the patient on WhatsApp' }; }
else { method = 'PATCH'; url = \`\${base}/api/booking/appointments/\${ref}\`; body = { patient_phone: c.patient_phone, slot_id: c.slot_id }; }
return [{ json: { op: c.op, method, url, body, idem_key: c.op === 'create' ? c.idem_key : '' } }];
`;
const COLLECT_CODE = `// Passes the plan on (Action Writes? and the rest read $json.plan) together with what the booking system answered. No call this time = no result.
if ($json && $json.plan) return [{ json: { ...$json, central_results: [] } }];
const plan = $('W13 – Plan').first().json;
const results = $input.all().map((it) => {
  const r = it.json || {};
  if (r.error || typeof r.statusCode !== 'number') return { status: 0, error: String((r.error && (r.error.message || r.error)) || 'no answer from the booking system').slice(0, 200) };
  let body = r.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  return { status: r.statusCode, body: body && typeof body === 'object' ? body : {} };
});
return [{ json: { ...plan, central_results: results } }];
`;

function patch(wf, standaloneOut) {
  const out = clone(wf);
  const by = (n) => { const x = out.nodes.find((o) => o.name === n); if (!x) throw new Error(`node "${n}" is missing: this is not the expected candidate`); return x; };
  for (const n of ADDED) if (out.nodes.some((x) => x.name === n)) throw new Error(`"${n}" already exists: the 4C W13 patch was applied already`);
  const link = (from, to, idx = 0) => { const c = out.connections[from] || (out.connections[from] = { main: [] }); while (c.main.length <= idx) c.main.push([]); c.main[idx].push({ node: to, type: 'main', index: 0 }); };
  const reroute = (from, oldTo, newTo) => {
    const c = out.connections[from];
    const hit = c.main.flatMap((o, i) => (o || []).map((x) => [i, x])).filter(([, x]) => x.node === oldTo);
    if (hit.length !== 1) throw new Error(`connection ${from} -> ${oldTo} not found exactly once`);
    hit[0][1].node = newTo;
  };
  const mk = (tpl, name, parameters, x, y, extra = {}) => ({ ...clone(by(tpl)), ...extra, name, id: uuid(name), position: [x, y], parameters });
  const at = (n) => by(n).position;

  // ---- the snippet copies
  for (const n of [N.build, N.plan, N.ready, N.record]) {
    let code = T.transformSnippet(by(n).parameters.jsCode.replace(/\r\n/g, '\n'));
    if (n === N.build) code = T.buildContextNode(code);
    if (n === N.ready) code = T.planReadyNode(code);
    by(n).parameters.jsCode = code;
  }
  // ---- W6 and W15 put Settings > booking_link into their templates. A Cal.com link is not accepted any more (Cal.com is retired as a booking channel): it counts as "no link",
  // which both workflows already handle visibly (W6 logs "booking_link" as failed and sends nothing; W15 holds the patient and counts it in its daily summary).
  const calUrl = "/^https:\\/\\/([^/?#\\s]*\\.)?cal\\.(com|eu)(:\\d+)?([/?#]|$)/i";
  by(N.w6settings).parameters.jsCode = T.replaceOnce(by(N.w6settings).parameters.jsCode, "booking_link: String(s.booking_link || '').trim(),",
    `booking_link: ${calUrl}.test(String(s.booking_link || '').trim()) ? '' : String(s.booking_link || '').trim(),   // Slice 4C: a Cal.com link is no booking link`, N.w6settings);
  for (const n of [N.w15plan, N.w15build, N.w15held]) {
    let code = T.replaceOnce(by(n).parameters.jsCode, 'function frHttps(v) { const s = frText(v, 500); return /^https:\\/\\/[^\\s<>"\']+$/i.test(s) ? s : \'\'; }',
      `function frHttps(v) { const s = frText(v, 500); return /^https:\\/\\/[^\\s<>"']+$/i.test(s) && !${calUrl}.test(s) ? s : ''; }   // Slice 4C: never a Cal.com link`, n);
    code = T.replaceOnce(code, "hold = 'Settings > booking_link is not set (an https link)'", "hold = 'Settings > booking_link is not set (an https link that is not Cal.com)'", n);
    by(n).parameters.jsCode = code;
  }
  // ---- Start passes the booking system's address on (every other W13 node reads its settings from Start; a manual test starts there without Config)
  by(N.start).parameters.jsCode = T.replaceOnce(by(N.start).parameters.jsCode, '    slot_days: Number(j.slot_days),', "    slot_days: Number(j.slot_days),\n    booking_api_url: String(j.booking_api_url || '').trim().replace(/\\/+$/, ''),   // Slice 4C: empty = not configured = the AI books nothing", 'W13 – Start');
  // ---- Config: the booking system's address (empty = not configured = no AI booking)
  const cfgNode = by(N.cfg);
  const assignments = cfgNode.parameters.assignments.assignments;
  assignments.push({ id: uuid('config-booking_api_url'), name: 'booking_api_url', value: "={{ ($env.FLOWHQ_BOOKING_API_URL || '').trim() }}", type: 'string' });

  // ---- availability chain: Appointments -> days -> availability -> collect -> Build Context
  const [ax, ay] = at(N.appts);
  const days = mk('W13 – Pick Retries', N.days, { jsCode: DAYS_CODE }, ax + 224, ay + 224);
  const apiHttp = (name, parameters, x, y) => mk(N.appts, name, parameters, x, y, { credentials: { httpHeaderAuth: { ...CRED } }, onError: 'continueRegularOutput' });
  const avail = apiHttp(N.avail, {
    method: 'GET', url: '={{ $json.booking_api_url }}/api/booking/availability?date={{ $json.date }}',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 10000 },
  }, ax + 448, ay + 224);
  const collectAvail = mk('W13 – Pick Retries', N.collectAvail, { jsCode: COLLECT_AVAIL_CODE }, ax + 672, ay + 224);
  reroute(N.appts, N.build, N.days);
  link(N.days, N.avail); link(N.avail, N.collectAvail); link(N.collectAvail, N.build);

  // ---- central calls: Plan -> calls? -> (split -> API ->) collect -> Action Writes?
  const [px, py] = at(N.plan);
  const calls = mk(N.writes, N.calls, (() => {
    const c = clone(by(N.writes).parameters);
    c.conditions.conditions[0].id = uuid('central-calls-cond');
    c.conditions.conditions[0].leftValue = "={{ !!$json.plan.central && $json.dry_run !== true }}";
    return c;
  })(), px + 112, py + 224);
  const split = mk('W13 – Split Sends', N.split, { jsCode: SPLIT_CODE }, px + 336, py + 336);
  const api = apiHttp(N.api, {
    method: '={{ $json.method }}', url: '={{ $json.url }}', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendHeaders: true, headerParameters: { parameters: [{ name: 'Idempotency-Key', value: '={{ $json.idem_key }}' }] },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}',
    options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 20000 },
  }, px + 560, py + 336);
  const collect = mk('W13 – Split Sends', N.collect, { jsCode: COLLECT_CODE }, px + 784, py + 224);
  reroute(N.plan, N.writes, N.calls);
  link(N.calls, N.split, 0); link(N.calls, N.collect, 1);
  link(N.split, N.api); link(N.api, N.collect); link(N.collect, N.writes);
  out.nodes.push(days, avail, collectAvail, calls, split, api, collect);

  // ---- proof that nothing else moved
  const added = new Set(ADDED);
  const changed = out.nodes.filter((n) => !added.has(n.name) && JSON.stringify(n) !== JSON.stringify(wf.nodes.find((o) => o.name === n.name))).map((n) => n.name).sort();
  if (JSON.stringify(changed) !== JSON.stringify([...CHANGED].sort())) throw new Error(`unexpected existing nodes changed: ${changed.join(', ')}`);
  for (const n of [N.build, N.plan, N.ready, N.record]) {
    const a = by(n); const b = wf.nodes.find((o) => o.name === n);
    if (JSON.stringify({ ...a, parameters: { ...a.parameters, jsCode: 0 } }) !== JSON.stringify({ ...b, parameters: { ...b.parameters, jsCode: 0 } })) throw new Error(`"${n}" changed beyond its code`);
  }
  const connChanged = Object.keys(out.connections).filter((k) => JSON.stringify(out.connections[k]) !== JSON.stringify(wf.connections[k])).sort();
  const expect = [...CHANGED_CONNECTIONS, ...ADDED.filter((n) => out.connections[n])].sort();
  if (JSON.stringify(connChanged) !== JSON.stringify(expect)) throw new Error(`unexpected connection changes: ${connChanged.join(', ')} (expected ${expect.join(', ')})`);
  for (const k of Object.keys(wf)) if (k !== 'nodes' && k !== 'connections' && JSON.stringify(out[k]) !== JSON.stringify(wf[k])) throw new Error(`workflow field "${k}" changed`);
  if (standaloneOut) fs.writeFileSync(standaloneOut.file, T.standalone(fs.readFileSync(standaloneOut.from, 'utf8')));
  return out;
}

module.exports = { patch, N, ADDED, CHANGED, CHANGED_CONNECTIONS, CRED };

if (require.main === module) {
  const args = process.argv.slice(2);
  const [inFile, outFile] = args.filter((a) => !a.startsWith('--'));
  if (!inFile || !outFile) { console.error('usage: node n8n/final/tools/patch-4c-w13-booking.js <candidate.json> <output.json>'); process.exit(2); }
  if (path.resolve(inFile) === path.resolve(outFile)) { console.error('refusing to overwrite the input file'); process.exit(2); }
  const wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const snippets = path.join(__dirname, '..', '..', 'snippets');
  const res = patch(wf, { file: path.join(snippets, 'ai-receptionist-central.js'), from: path.join(snippets, 'ai-receptionist.js') });
  fs.writeFileSync(outFile, `${JSON.stringify(res, null, 2)}\n`);
  console.log(`written ${outFile}: ${ADDED.length} nodes added (${wf.nodes.length} -> ${res.nodes.length}), ${CHANGED.length} existing nodes changed (code / one config value); n8n/snippets/ai-receptionist-central.js regenerated; the input file is untouched`);
}
