// Deferred messages (they came in at night) to answer now: per conversation only the NEWEST one (it sees the others in its
// history), and only from the last 20 hours (inside WhatsApp's 24-hour reply window). Each goes through the normal W13 run.
const clinics = $('W13 – Active Clinics').all();
const nowSec = Math.floor(Date.now() / 1000);
const out = [];
$input.all().forEach((it, i) => {
  const c = clinics[i] && clinics[i].json;
  if (!c || it.json.error) return;                     // that clinic's Messages could not be read: try again tomorrow
  const newest = {};
  for (const r of it.json.records || []) {
    const f = r.fields || {};
    if (f.Direction === 'Out' || !(Number(f.Created_At) >= nowSec - 20 * 3600)) continue;
    const k = String(f.Conversation || `row-${r.id}`);
    if (!newest[k] || f.Created_At > newest[k].fields.Created_At || (f.Created_At === newest[k].fields.Created_At && r.id > newest[k].id)) newest[k] = r;
  }
  for (const r of Object.values(newest)) {
    out.push({ json: { wa_phone_number_id: c.wa_phone_number_id, message_row_id: r.id, wa_message_id: String(r.fields.WA_Message_ID || ''), w13_retry: true } });
  }
});
return out.slice(0, 200);
