// W5 - Skip digest (Slice 4C). Every reminder that was due but NOT sent, and why, as ONE Run_Log line per clinic.
// W5 runs every 15 minutes, so the line is written in the first run of each hour (08:00-20:59 IST), only when something was held: at most 13 lines a day per clinic,
// none on a quiet day. The line names the booking references and the reason; it never holds a phone number or a patient name.
// Only items with a hold_reason are listed. "quiet hours" and "test mode" decisions of W5 - Decide send are normal and stay silent, as before.
const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
if (ist.getUTCMinutes() >= 15 || ist.getUTCHours() < 8 || ist.getUTCHours() >= 21) return [];
const byDoc = {};
for (const it of $input.all()) {
  const j = it.json;
  if (!j.hold_reason) continue;
  const g = (byDoc[j.doc_id] = byDoc[j.doc_id] || { j, by: {} });
  (g.by[j.hold_reason] = g.by[j.hold_reason] || []).push(String(j.booking_uid || `row ${j.appt_row_id}`));
}
return Object.values(byDoc).map(({ j, by }) => {
  const total = Object.values(by).reduce((s, u) => s + u.length, 0);
  const parts = Object.entries(by).sort((a, b) => b[1].length - a[1].length).map(([why, uids]) => `${why}: ${uids.length} (${uids.slice(0, 5).join(', ')}${uids.length > 5 ? ', ...' : ''})`);
  return { json: { grist_base_url: j.grist_base_url, doc_id: j.doc_id, log: { Workflow: 'W5-reminders', Record: `${total} reminder(s) not sent`, Outcome: 'skipped', Error: parts.join('; ').slice(0, 500), At: Math.floor(Date.now() / 1000) } } };
});
