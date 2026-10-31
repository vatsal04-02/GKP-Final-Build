// ---------------------------------------------------------------- Slice 4C: W13 books, cancels and moves appointments ONLY through the FLOW HQ booking API
// (docs/booking-api.md). Added by n8n/final/tools/patch-4c-w13-booking.js; the same text is in n8n/snippets/ai-receptionist-central.js (generated).
//   * No Grist writes to Appointments from W13 any more (booking_mode = direct is ignored), and no Cal.com link is ever built or sent.
//   * Free times come from GET /availability (one call per day), never from W13's own arithmetic.
//   * Nothing is booked, cancelled or moved until the patient has said YES to a question that named that exact day and time (aiConfirmed).
//   * The patient is told it is done only after the API answered 200/201 (aiApplyCentral). Anything else is a hand-off, never a claim.
const AI_CONFIRM_MARK = 'Reply YES to confirm.';
const AI_CONFIRM_MAX_AGE_SEC = 3 * 3600;    // a confirmation question older than this is asked again
// The patient's answer must START with an affirmative (English, Hinglish, Hindi); "yes but make it 6" is judged by the day and time the AI then reads.
const AI_YES = /^\s*(?:yes|yep|yeah|yup|y|ok|okay|sure|confirm(?:ed)?|please do|go ahead|haan|han|haa|ha|ji|ji haan|theek hai|thik hai|bilkul|हाँ|हां|जी|ठीक है|बिल्कुल|कन्फर्म|👍)(?=$|[\s.,!?])/i;
const AI_CAL_HOST = /(^|\.)cal\.(com|eu)$|(^|\.)cal-staging\.com$/i;

// A clinic's own booking link is still allowed when Settings has one, but never a Cal.com link: Cal.com is not a booking channel any more.
function aiSafeLink(v) {
  const s = aiLine(v, 300);
  const m = s.match(/^https:\/\/([^/?#\s]+)/i);
  if (!m) return '';
  const host = m[1].toLowerCase().replace(/:\d+$/, '');
  return AI_CAL_HOST.test(host) ? '' : s;
}

// A stable idempotency key for one patient message and one slot: the same inbound WhatsApp message always maps to the same booking.
function aiIdemKey(waMessageId, slotId) {
  const src = `${waMessageId}|${slotId}`;
  let h1 = 0xdeadbeef; let h2 = 0x41c6ce57;
  for (let i = 0; i < src.length; i++) { const c = src.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `w13-${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
}

// raw.central (W13 – Availability collect): { configured, ok, available, ai_reason, reason, days: [{ date, slots: [{ slot_id, start_time, end_time, doctor_name }] }] }
// -> the same shape aiFreeSlots returned (known, days[{date,label,times[min]}], slot_minutes, open, close) plus by_key['YYYY-MM-DD|HH:MM'] = the slot to book.
function aiCentralSlots(c, p, nowMs, days) {
  const none = (reason) => ({ known: false, unreadable: true, days: [], slot_minutes: p.slot_minutes, by_key: {}, reason });
  if (!c || c.configured !== true) return none('the booking system is not set up for W13 (FLOWHQ_BOOKING_API_URL)');
  if (c.ok !== true) return none(aiLine(c.reason || 'the booking system could not be reached', 160));
  if (c.available !== true) return none(`AI booking is switched off in the CRM (${aiLine(c.ai_reason || 'disabled', 40)})`);
  const toMin = (t) => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
  const byDate = {};
  for (const d of Array.isArray(c.days) ? c.days : []) if (d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date))) byDate[d.date] = Array.isArray(d.slots) ? d.slots : [];
  const out = []; const by_key = {};
  let open = Infinity; let close = 0; let minutes = 0;
  for (const day of aiCalendar(nowMs, days)) {
    const times = new Set();
    for (const s of byDate[day.date] || []) {
      if (!s || !/^\d{2}:\d{2}$/.test(String(s.start_time)) || !s.slot_id) continue;
      const m = toMin(s.start_time);
      const key = `${day.date}|${s.start_time}`;
      times.add(m);
      if (!by_key[key]) by_key[key] = { slot_id: String(s.slot_id), doctor_name: aiLine(s.doctor_name, 80), doctor_id: aiLine(s.doctor_id, 20) };   // several doctors at one time: the first one
      if (/^\d{2}:\d{2}$/.test(String(s.end_time))) { open = Math.min(open, m); close = Math.max(close, toMin(s.end_time)); minutes = minutes || toMin(s.end_time) - m; }
    }
    if (times.size) out.push({ date: day.date, label: day.label, times: [...times].sort((a, b) => a - b) });
  }
  return { known: true, days: out, slot_minutes: minutes > 0 ? minutes : p.slot_minutes, open: Number.isFinite(open) ? open : null, close: close || null, by_key, reason: '' };
}

// The question that must be answered YES before anything changes. The label is the exact day and time, so a later "yes" cannot be about anything else.
function aiConfirmAsk(kind, text) {
  if (kind === 'book') return `Shall I book ${text}? ${AI_CONFIRM_MARK}`;
  if (kind === 'cancel') return `Shall I cancel your appointment on ${text}? ${AI_CONFIRM_MARK}`;
  return `Shall I move your appointment ${text}? ${AI_CONFIRM_MARK}`;
}
// Has the patient just said yes to a question about exactly this? The newest clinic message in the conversation must be that question, recent, and the
// patient's own message must start with a yes.
function aiConfirmed(x, kind, text) {
  if (!AI_YES.test(x.text || '')) return false;
  const last = [...(x.history || [])].reverse().find((m) => m.dir === 'clinic');
  if (!last) return false;
  const nowSec = Math.floor(x.now_ms / 1000);
  if (!last.at || nowSec - last.at > AI_CONFIRM_MAX_AGE_SEC) return false;
  return String(last.text || '').includes(aiConfirmAsk(kind, text));
}

// plan.central is what the plan wants from the booking API; result is what the API answered: { status, body } or { error } (network); null = no call was made.
// Returns the plan. The patient is told "done" ONLY for a 200/201; every other answer is a different message or a hand-off.
function aiApplyCentral(plan, x, cfg, result) {
  const c = plan.central;
  if (!c) return plan;
  const handoff = (why) => { plan.central = null; return aiToHandoff(plan, x, cfg, why); };
  const offers = (body, lead) => {
    const slots = body && body.error && body.error.availability && Array.isArray(body.error.availability.slots) ? body.error.availability.slots : [];
    const picks = slots.slice(0, 3).filter((s) => s && /^\d{4}-\d{2}-\d{2}$/.test(String(s.date)) && /^\d{2}:\d{2}$/.test(String(s.start_time))).map((s) => `${aiDayLabel(s.date)} ${ai12h(Number(s.start_time.slice(0, 2)) * 60 + Number(s.start_time.slice(3, 5)))}`);
    return picks.length ? `${lead} Free times: ${picks.join(', ')}. Which one would you like?` : null;
  };
  if (x.dry_run) { plan.reply = `[dry run: nothing was sent to the booking system] ${plan.reply}`; return plan; }
  if (!result) return handoff('the booking system was not called (no answer from the call step)');
  const status = Number(result.status) || 0;
  const body = result.body && typeof result.body === 'object' ? result.body : {};
  const code = body.error && body.error.code ? String(body.error.code) : '';
  const done = status === 200 || status === 201;
  const appt = body.appointment || {};
  const who = appt.doctor_name || c.doctor_name ? ` with ${appt.doctor_name || c.doctor_name}` : '';
  const ref = aiLine(appt.booking_reference, 60);
  plan.notes.push(`booking system: ${c.op} ${status || 'no answer'}${code ? ` ${code}` : ''}`);

  if (c.op === 'create') {
    if (done && appt.booking_reference) {
      plan.reply = `Your appointment is booked: ${c.label}${who}.${ref ? ` Your reference is ${ref}.` : ''} See you then!`;
      plan.lead_patch.Status = 'Booked';
      plan.booking_ref = ref;
      plan.route = 'book_slot';
      return plan;
    }
    if (status === 409 && code === 'slot_unavailable') {
      const t = offers(body, `Sorry, ${c.label} was just taken.`);
      if (!t) return handoff(`${c.label} is no longer free and there are no other times to offer`);
      plan.reply = t; plan.route = 'offer_slots'; plan.central = null; return plan;
    }
    if (status === 409 && code === 'duplicate_booking') { plan.reply = `You already have an appointment at that time${body.error && body.error.booking_reference ? ` (reference ${aiLine(body.error.booking_reference, 60)})` : ''}.`; plan.route = 'reply'; plan.central = null; return plan; }
    if (status === 403 && code === 'ai_booking_disabled') return handoff(`AI booking is switched off in the CRM (${aiLine(body.error && body.error.reason, 40) || 'disabled'}): the team confirms this booking by hand`);
    return handoff(`the booking system did not confirm the booking (${code || status || 'no answer'}): nothing was told to the patient as booked; check for ${c.label} before booking it again`);
  }
  if (c.op === 'cancel') {
    if (done) { plan.reply = `Your appointment on ${c.label} is cancelled.`; plan.route = 'cancelled'; return plan; }
    return handoff(`the booking system did not cancel the appointment (${code || status || 'no answer'})`);
  }
  // reschedule
  if (done) { plan.reply = `Your appointment is moved to ${c.label}${who}.`; plan.route = 'rescheduled'; return plan; }
  if (status === 409 && code === 'slot_unavailable') {
    const t = offers(body, `Sorry, ${c.label} was just taken. Your appointment on ${c.from_label} is unchanged.`);
    if (!t) return handoff(`${c.label} is no longer free and there are no other times to offer`);
    plan.reply = t; plan.route = 'offer_slots'; plan.central = null; return plan;
  }
  return handoff(`the booking system did not move the appointment (${code || status || 'no answer'})`);
}

