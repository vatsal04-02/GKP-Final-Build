// Production test of the central booking API EXACTLY as n8n (W13) uses it, with ONE synthetic patient. Run by 97-ai-booking-api-test.sh inside the FLOW HQ container:
// the first line of stdin is the service token (never on a command line), the rest is this script. It creates ONE appointment for "ZZ AI Booking Test", moves it, cancels it,
// and leaves the cancelled record in place (records are never deleted; staff may remove it). It contacts nobody: the booking API sends no message.
// Preconditions it checks itself: the AI booking switch is ON (otherwise it stops without writing anything).
const base = `${process.env.BOOKING_BASE || 'http://127.0.0.1:8787'}/api/booking`; const SLUG = process.env.CLINIC_SLUG || 'demo-clinic'; const PH = '+919000050001'; const NAME = 'ZZ AI Booking Test'; const key = `zz-prod-test-${Date.now().toString(36)}`;
let bad = 0; const say = (ok, m) => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${m}`); if (!ok) bad++; return ok; };
const call = async (method, path, body, headers = {}) => { const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ } return { status: r.status, json, text }; };
const ymd = (d) => d.toISOString().slice(0, 10);
(async () => {
  const cfg = await call('GET', '/config');
  if (cfg.status !== 200) { console.log(`STOP: config answered ${cfg.status}`); process.exit(2); }
  if (cfg.json.ai_booking.enabled !== true) { console.log('STOP: the AI booking switch is OFF. An admin must switch it on in FLOW HQ > Schedule first. Nothing was written.'); process.exit(3); }
  say(cfg.json.ai_booking.enabled === true && cfg.json.config_problems.length === 0, 'AI booking is ON and FLOW HQ reports no configuration problems');
  // 1. live availability: first day in the next 10 with at least two free slots with the same doctor
  let pick = null;
  for (let i = 1; i <= 10 && !pick; i++) {
    const day = ymd(new Date(Date.now() + 19800000 + i * 86400000)); const av = await call('GET', `/availability?date=${day}`);
    if (av.status !== 200) continue;
    const by = {}; for (const s of av.json.slots) (by[s.doctor_id] ||= []).push(s);
    const doc = Object.values(by).find((l) => l.length >= 2); if (doc) pick = { day, a: doc[0], b: doc[1], total: av.json.slots.length };
  }
  if (!say(!!pick, 'live availability returned bookable slots (FLOW HQ is the only source)')) process.exit(1);
  console.log(`      using ${pick.day}: ${pick.a.doctor_name} ${pick.a.shift} ${pick.a.start_time} (then ${pick.b.start_time}); ${pick.total} free slots that day`);
  // 2. create (the 4D request shape: slot_id + patient + Idempotency-Key header; no date/start/doctor fields)
  const mk = await call('POST', '/appointments', { slot_id: pick.a.slot_id, patient: { name: NAME, phone: PH }, reason: 'synthetic production test', service: 'Physiotherapy' }, { 'idempotency-key': key });
  if (!say(mk.status === 201 && !!mk.json.appointment, `create -> 201 (got ${mk.status})`)) { console.log(mk.text.slice(0, 300)); process.exit(1); }
  const ref = mk.json.appointment.booking_reference; const ap = mk.json.appointment;
  say(ap.doctor_id === pick.a.doctor_id && ap.shift === pick.a.shift && ap.date === pick.day && ap.start_time === pick.a.start_time, `doctor, shift, date and time are the ones offered: ${ap.doctor_name} / ${ap.shift} / ${ap.date} ${ap.start_time} (ref ${ref})`);
  // 3. duplicate protection
  const rp = await call('POST', '/appointments', { slot_id: pick.a.slot_id, patient: { name: NAME, phone: PH }, reason: 'synthetic production test', service: 'Physiotherapy' }, { 'idempotency-key': key });
  say(rp.status === 200 && rp.json.appointment.booking_reference === ref, 'the same request again replays the SAME appointment (no second booking)');
  const other = await call('POST', '/appointments', { slot_id: pick.a.slot_id, patient: { name: 'ZZ Someone Else', phone: '+919000050002' } }, { 'idempotency-key': `${key}-b` });
  say(other.status === 409, `another patient cannot take the full slot (got ${other.status} ${other.json && other.json.error && other.json.error.code})`);
  // 4. read-back and phone ownership
  const gt = await call('GET', `/appointments/${ref}?patient_phone=${encodeURIComponent(PH)}`);
  say(gt.status === 200 && gt.json.appointment.booking_reference === ref && /confirm/i.test(gt.json.appointment.status), `read-back with the patient's phone: ${gt.status} ${gt.json && gt.json.appointment && gt.json.appointment.status}`);
  say((await call('GET', `/appointments/${ref}?patient_phone=%2B919000059999`)).status === 404, 'a wrong phone cannot read it (404)');
  say((await call('GET', `/appointments/${ref}`)).status === 400, 'a read without a phone is refused (400)');
  // 5. reschedule keeps the reference
  const mv = await call('PATCH', `/appointments/${ref}`, { patient_phone: PH, slot_id: pick.b.slot_id });
  say(mv.status === 200 && mv.json.appointment.booking_reference === ref && mv.json.appointment.start_time === pick.b.start_time, `reschedule -> same reference, new time ${mv.json && mv.json.appointment && mv.json.appointment.start_time}`);
  // 6. cancel, idempotent
  const c1 = await call('POST', `/appointments/${ref}/cancel`, { patient_phone: PH, reason: 'synthetic production test' });
  say(c1.status === 200 && c1.json.already_cancelled === false && /cancel/i.test(c1.json.appointment.status), 'cancel -> Cancelled');
  const c2 = await call('POST', `/appointments/${ref}/cancel`, { patient_phone: PH }); say(c2.status === 200 && c2.json.already_cancelled === true, 'cancelling again is harmless (already cancelled)');
  const av2 = await call('GET', `/availability?date=${pick.day}`); const free = new Set(av2.json.slots.map((s) => s.slot_id)); say(free.has(pick.a.slot_id) && free.has(pick.b.slot_id), 'both slots are free again');
  // 7. written only through FLOW HQ, with an audit trail (read-only check in Grist)
  const h = { Authorization: 'Bearer ' + process.env.GRIST_API_KEY }, b = process.env.GRIST_BASE_URL;
  const reg = await (await fetch(`${b}/api/docs/${process.env.GRIST_REGISTRY_DOC_ID}/tables/Clinics/records`, { headers: h })).json(); const id = reg.records.find((r) => r.fields.Clinic_Slug === SLUG).fields.Grist_Doc_ID;
  const g = async (t) => (await (await fetch(`${b}/api/docs/${id}/tables/${t}/records`, { headers: h })).json()).records || [];
  const row = (await g('Appointments')).filter((r) => r.fields.Booking_UID === ref);
  say(row.length === 1 && !!row[0].fields.Audit_ID && /WhatsApp AI|API/i.test(String(row[0].fields.Booking_Source)), `exactly one Appointments row, with an audit id, source "${row[0] && row[0].fields.Booking_Source}"`);
  let audit = []; for (let i = 0; i < 40 && audit.length < 4; i++) { audit = (await g('Booking_Audit')).filter((r) => JSON.stringify(r.fields).includes(ref)); if (audit.length < 4) await new Promise((r) => setTimeout(r, 1000)); }
  say(audit.length >= 4 && audit.some((r) => r.fields.Outcome === 'ok'), `the audit log holds ${audit.length} entries for this appointment (${[...new Set(audit.map((r) => r.fields.Action))].join(', ')})`);
  console.log(bad ? `AI BOOKING API TEST: ${bad} FAILURE(S)` : `AI BOOKING API TEST: ALL PASSED (synthetic appointment ${ref} was created, moved and cancelled; the cancelled record remains)`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('ERR ' + e.message); process.exit(1); });
