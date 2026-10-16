// What W12 answered -> the staff row (Status, WA_Message_ID, AI_Reason), the conversation (Unread 0 once answered) and Run_Log.
// Needs_Human, Assigned_To and Automation_Paused are left exactly as staff set them.
const now = Math.floor(Date.now() / 1000);
const out = [];
$input.all().forEach((it, i) => {
  const j = it.json;
  const r = cmStaffReplyResult(j.w10.row_id, j, now);
  const at = { grist_base_url: j.grist_base_url, doc_id: j.doc_id };
  out.push({ json: { ...at, method: 'PATCH', table: 'Messages', body: { records: [{ id: j.w10.row_id, fields: r.message_patch }] } }, pairedItem: { item: i } });
  if (r.conversation_patch && j.w10.conversation_id) out.push({ json: { ...at, method: 'PATCH', table: 'Conversations', body: { records: [{ id: j.w10.conversation_id, fields: r.conversation_patch }] } }, pairedItem: { item: i } });
  out.push({ json: { ...at, method: 'POST', table: 'Run_Log', body: { records: [{ fields: r.log }] } }, pairedItem: { item: i } });
});
return out;
