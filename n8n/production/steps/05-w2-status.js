// STEP 05 - W2: delivery receipts. Meta posts statuses (sent / delivered / read / failed) to the same webhook as patient messages. They were
// counted (statuses_seen) and thrown away, so "accepted by Meta" was never upgraded to delivered / read / failed. Now:
//  * W2 – Parse Meta Event also returns status_events[] (validated, capped at 100)
//  * a second branch (after the message branch) finds the clinic by phone_number_id, then the Send_Ledger row (by the callback data "fhq:<idem_key>",
//    else by WA_Message_ID) and the Messages row (by WA_Message_ID) and upgrades their Status. Statuses only move forward; duplicates are no-ops;
//    a delivery failure is written to Run_Log. An uncertain send is settled the moment its receipt arrives.
const STATUS_URL = (table) => `={{ $json.grist_base_url }}/api/docs/{{ $json.doc_id }}/tables/${table}/records`;

module.exports = {
  id: '05-w2-status',
  title: 'W2: delivery receipts update the send ledger and the Messages status',
  run(ctx) {
    ctx.editCode('W2 – Parse Meta Event', [
      { find: 'let statuses = 0;\n', replace: 'let statuses = 0;\nconst status_events = [];\n' },
      {
        find: '    if (Array.isArray(v.statuses)) statuses += v.statuses.length;\n',
        replace: `    if (Array.isArray(v.statuses)) {
      statuses += v.statuses.length;
      const spid = isObj(v.metadata) ? line(v.metadata.phone_number_id, 40) : '';
      for (const s of v.statuses) {                                          // delivery receipts for messages WE sent
        if (!isObj(s) || status_events.length >= MAX_EVENTS) continue;
        const st = line(s.status, 20).toLowerCase();
        const wid = line(s.id, 200);
        if (!['sent', 'delivered', 'read', 'failed'].includes(st) || !wid || !spid) continue;
        const err = Array.isArray(s.errors) && isObj(s.errors[0]) ? s.errors[0] : {};
        status_events.push({ phone_number_id: spid, wa_message_id: wid, status: st, status_timestamp: Number(s.timestamp) > 0 ? Math.floor(Number(s.timestamp)) : nowSec, callback: line(s.biz_opaque_callback_data, 300), error_code: Number.isFinite(Number(err.code)) ? Number(err.code) : 0, error_text: line(err.title || err.message || '', 200) });
      }
    }
`,
      },
      { find: '...cfg, source, kind, events, rejected, statuses_seen: statuses,', replace: '...cfg, source, kind, events, rejected, statuses_seen: statuses, status_events,' },
    ]);
    ctx.editCode('W2 – Split Messages', [{ find: 'const { events, rejected, statuses_seen, http_status, response_body, reject_reason, kind, ...ctx } = item.json;', replace: 'const { events, rejected, statuses_seen, http_status, response_body, reject_reason, kind, status_events, ...ctx } = item.json;' }]);

    const base = ctx.node('W2 – Parse Meta Event').position;
    const at = (i, row = 0) => [base[0] + 224 * i, base[1] - 700 - 200 * row];
    ctx.ifNode('W2 – Has Statuses?', "={{ $json.source === 'webhook' && Array.isArray($json.status_events) && $json.status_events.length > 0 }}", at(0));
    ctx.codeNode('W2 – Split Statuses', `// One item per delivery receipt (the message branch drops them: it only reads events[]).
const out = [];
$input.all().forEach((item, i) => {
  const { events, rejected, statuses_seen, http_status, response_body, reject_reason, kind, status_events, ...c } = item.json;
  for (const ev of status_events || []) out.push({ json: { ...c, ...ev }, pairedItem: { item: i } });
});
return out;
`, at(1));
    ctx.httpGrist('W2 – Status Clinics', 'GET', '={{ $json.grist_base_url }}/api/docs/{{ $json.registry_doc_id }}/tables/Clinics/records', at(2));
    ctx.codeNode('W2 – Status Resolve Clinic', `// phone_number_id -> clinic (same rule as W2 – Resolve Clinic)
const rows = (i) => (Array.isArray($input.all()[i].json.records) ? $input.all()[i].json.records : []);
return $input.all().map((it, i) => {
  const ctx = $('W2 – Split Statuses').all()[i].json;
  const want = String(ctx.phone_number_id || '').trim();
  const rec = rows(i).find((r) => r && r.fields && String(r.fields.WA_Phone_Number_ID === undefined || r.fields.WA_Phone_Number_ID === null ? '' : r.fields.WA_Phone_Number_ID).trim() === want);
  const f = rec ? rec.fields : {};
  const ok = !!want && !!rec && String(f.Active).toUpperCase() === 'TRUE' && !!String(f.Grist_Doc_ID || '').trim();
  return { json: { ...ctx, clinic_found: ok, doc_id: ok ? String(f.Grist_Doc_ID).trim() : '' }, pairedItem: { item: i } };
});
`, at(3));
    ctx.ifNode('W2 – Status Clinic Found?', '={{ $json.clinic_found === true }}', at(4));
    ctx.httpGrist('W2 – Status Ledger', 'GET', STATUS_URL('Send_Ledger'), at(5), { sendQuery: true, queryParameters: { parameters: [{ name: 'filter', value: "={{ JSON.stringify(String($json.callback || '').startsWith('fhq:') ? { Idem_Key: [String($json.callback).slice(4)] } : { WA_Message_ID: [$json.wa_message_id] }) }}" }, { name: 'limit', value: '20' }] } });
    ctx.httpGrist('W2 – Status Message', 'GET', "={{ $('W2 – Status Resolve Clinic').item.json.grist_base_url }}/api/docs/{{ $('W2 – Status Resolve Clinic').item.json.doc_id }}/tables/Messages/records", at(6), { sendQuery: true, queryParameters: { parameters: [{ name: 'filter', value: "={{ JSON.stringify({ WA_Message_ID: [$('W2 – Status Resolve Clinic').item.json.wa_message_id] }) }}" }, { name: 'limit', value: '5' }] } });
    ctx.codeNode('W2 – Status Plan', `// Delivery receipt -> what to change. Statuses only move FORWARD (queued < sent < delivered < read); "failed" can only follow a message that was not
// delivered yet; the same receipt twice changes nothing. Unreadable Grist answers change nothing (Meta repeats receipts).
const rank = { sending: 0, uncertain: 0, unconfirmed: 0, accepted: 1, sent: 1, delivered: 2, read: 3 };
const mrank = { queued: 0, sent: 1, delivered: 2, read: 3 };
return $input.all().map((it, i) => {
  const ev = $('W2 – Status Resolve Clinic').all()[i].json;
  const led = $('W2 – Status Ledger').all()[i].json;
  const msg = it.json;
  const now = Math.floor(Date.now() / 1000);
  let ledger_patch = null, message_patch = null, log_failed = null, outcome = 'ignored';
  const lrows = Array.isArray(led.records) ? led.records.filter((r) => !['rejected', 'duplicate'].includes(String((r.fields || {}).Status || ''))) : [];
  const lr = lrows[0];
  if (lr) {
    const cur = String(lr.fields.Status || '');
    const want = ev.status === 'sent' ? 'accepted' : ev.status;          // Meta "sent" = accepted by WhatsApp: the ledger already says accepted
    const fields = {};
    if (ev.status === 'failed') { if (rank[cur] !== undefined && rank[cur] <= 1) { fields.Status = 'failed'; fields.Error = \`\${ev.error_code || ''} \${ev.error_text || 'delivery failed'}\`.trim().slice(0, 300); fields.Error_Code = ev.error_code || 0; } }
    else if ((rank[want] || 0) > (rank[cur] === undefined ? -1 : rank[cur])) fields.Status = want;
    if (!String(lr.fields.WA_Message_ID || '') && ev.wa_message_id) fields.WA_Message_ID = ev.wa_message_id;
    if (fields.Status || fields.WA_Message_ID) { fields.Updated_At = now; ledger_patch = { records: [{ id: lr.id, fields }] }; outcome = fields.Status || 'linked'; }
  }
  const mr = Array.isArray(msg.records) ? msg.records.find((r) => (r.fields || {}).Direction === 'Out') : null;
  if (mr) {
    const cur = String(mr.fields.Status || 'queued');
    if (ev.status === 'failed') { if (mrank[cur] !== undefined && mrank[cur] <= 1) { message_patch = { records: [{ id: mr.id, fields: { Status: 'failed' } }] }; outcome = 'failed'; } }
    else if ((mrank[ev.status] || 0) > (mrank[cur] === undefined ? -1 : mrank[cur])) { message_patch = { records: [{ id: mr.id, fields: { Status: ev.status } }] }; if (outcome === 'ignored') outcome = ev.status; }
  }
  if (ev.status === 'failed' && (ledger_patch || message_patch)) log_failed = { Workflow: 'W2-delivery-status', Record: \`\${(lr && lr.fields.Idem_Key) || ev.wa_message_id} (delivery failed)\`.slice(0, 200), Outcome: 'failed', Error: \`\${ev.error_code || ''} \${ev.error_text || 'delivery failed'}\`.trim().slice(0, 500), At: now };
  return { json: { ...ev, ledger_patch, message_patch, log_failed, status_outcome: outcome }, pairedItem: { item: i } };
});
`, at(7));
    ctx.ifNode('W2 – Status Ledger patch?', '={{ !!$json.ledger_patch }}', at(8));
    ctx.httpGrist('W2 – Status Write Ledger', 'PATCH', STATUS_URL('Send_Ledger'), at(9), { sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.ledger_patch) }}' });
    ctx.ifNode('W2 – Status Message patch?', "={{ !!$('W2 – Status Plan').item.json.message_patch }}", at(10));
    ctx.httpGrist('W2 – Status Write Message', 'PATCH', "={{ $('W2 – Status Plan').item.json.grist_base_url }}/api/docs/{{ $('W2 – Status Plan').item.json.doc_id }}/tables/Messages/records", at(11), { sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify($('W2 – Status Plan').item.json.message_patch) }}" });
    ctx.ifNode('W2 – Status Failed to log?', "={{ !!$('W2 – Status Plan').item.json.log_failed }}", at(12));
    ctx.httpGrist('W2 – Status Write Log', 'POST', "={{ $('W2 – Status Plan').item.json.grist_base_url }}/api/docs/{{ $('W2 – Status Plan').item.json.doc_id }}/tables/Run_Log/records", at(13), { sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify({ records: [{ fields: $('W2 – Status Plan').item.json.log_failed }] }) }}" });

    // wiring: Parse -> [Webhook Source? (message branch, first), Has Statuses? (second)]
    ctx.addOutput('W2 – Parse Meta Event', 0, 'W2 – Has Statuses?');
    ctx.setOutputs('W2 – Has Statuses?', [['W2 – Split Statuses']]);
    ctx.setOutputs('W2 – Split Statuses', [['W2 – Status Clinics']]);
    ctx.setOutputs('W2 – Status Clinics', [['W2 – Status Resolve Clinic']]);
    ctx.setOutputs('W2 – Status Resolve Clinic', [['W2 – Status Clinic Found?']]);
    ctx.setOutputs('W2 – Status Clinic Found?', [['W2 – Status Ledger']]);
    ctx.setOutputs('W2 – Status Ledger', [['W2 – Status Message']]);
    ctx.setOutputs('W2 – Status Message', [['W2 – Status Plan']]);
    ctx.setOutputs('W2 – Status Plan', [['W2 – Status Ledger patch?']]);
    ctx.setOutputs('W2 – Status Ledger patch?', [['W2 – Status Write Ledger'], ['W2 – Status Message patch?']]);
    ctx.setOutputs('W2 – Status Write Ledger', [['W2 – Status Message patch?']]);
    ctx.setOutputs('W2 – Status Message patch?', [['W2 – Status Write Message'], ['W2 – Status Failed to log?']]);
    ctx.setOutputs('W2 – Status Write Message', [['W2 – Status Failed to log?']]);
    ctx.setOutputs('W2 – Status Failed to log?', [['W2 – Status Write Log']]);
    ctx.log('05', 'W2: delivery receipts (sent/delivered/read/failed) are parsed into status_events and update Send_Ledger (by callback data fhq:<key>, else WA_Message_ID) and Messages.Status; statuses only move forward; a failed delivery is logged in Run_Log (13 new nodes, second branch after the message branch)');
  },
};
