// Not sendable as written: the reason goes on the row (AI_Reason, Status) and Send is unticked, so it is never retried by itself;
// staff fix it and tick Send again. Quiet hours: only a note, the row stays ticked and goes out at 08:00.
const now = Math.floor(Date.now() / 1000);
const out = [];
$input.all().forEach((it, i) => {
  const j = it.json;
  const c = j.check || {};
  const at = { grist_base_url: j.grist_base_url, doc_id: j.doc_id };
  if (c.patch) out.push({ json: { ...at, method: 'PATCH', table: 'Messages', body: { records: [{ id: j.row_id, fields: c.patch }] } }, pairedItem: { item: i } });
  if (c.action === 'reject' && !/^already sent/.test(c.reason || '')) {
    out.push({ json: { ...at, method: 'POST', table: 'Run_Log', body: { records: [{ fields: { Workflow: 'W10-staff-reply', Record: `message ${j.row_id} (staff reply not sent)`, Outcome: 'failed', Error: String(c.reason || '').slice(0, 500), At: now } }] } }, pairedItem: { item: i } });
  }
});
return out;
