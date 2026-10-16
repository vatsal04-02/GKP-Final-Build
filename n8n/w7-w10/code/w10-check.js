// cmStaffReplyCheck: send / reject (written back on the row, Send unticked) / hold (quiet hours: it goes at 08:00) / none.
// Opted_Out, a valid phone, the 24 h WhatsApp window, quiet hours and TEST_MODE apply. Automation_Paused, Needs_Human and Assigned_To
// do not stop a person's reply (they stop automated messages).
const x = $('W10 – Collect').item.json;
const settings = {};
for (const r of $('W10 – Settings').item.json.records || []) {
  const f = r.fields || {};
  if (f.Key) settings[String(f.Key).trim()] = f.Value;
}
const conv = ($('W10 – Conversation').item.json.records || [])[0] || null;
const lead = ($json.records || [])[0] || null;
const check = cmStaffReplyCheck(x.row, conv, lead, settings, Date.now(), { normalizeIndianPhone, decideSend });
const base = { grist_base_url: x.grist_base_url, doc_id: x.doc_id, row_id: x.row.id, conversation_id: x.conversation_id, check, send: check.action === 'send' };
if (!base.send) return { json: base };
return {
  json: {
    ...base,
    message: {
      ...check.message, decision: check.decision, audience: 'patient', source_workflow: 'W10-staff-reply',
      wa_phone_number_id: x.wa_phone_number_id, grist_base_url: x.grist_base_url, doc_id: x.doc_id,
      w10: { row_id: x.row.id, conversation_id: x.conversation_id },
    },
  },
};
