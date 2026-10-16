// Shared test data for W13 (AI receptionist): a demo clinic (Settings, Knowledge, Appointments, one returning patient) and a
// FAKE Claude. No real API is called anywhere in the tests. The fake reads the facts W13 put in the prompt (CALENDAR,
// AVAILABILITY, KNOWLEDGE BASE, APPOINTMENTS) and answers like a careful receptionist would, so a test fails when W13 gives
// Claude wrong or missing facts. Made-up phone numbers only (91900000001x).
const NOW = Date.parse('2026-10-06T11:00:00+05:30');   // Tuesday 06 Oct 2026, 11:00 IST
const sec = (ms) => Math.floor(ms / 1000);
const at = (date, hhmm) => sec(Date.parse(`${date}T${hhmm}:00+05:30`));
const DAY = 86400;

const SETTINGS = {
  clinic_name: 'Demo Physio', ai_mode: 'auto', open_time: '09:00', close_time: '19:00', working_days: 'Mon-Sat',
  booking_link: 'https://cal.com/demo-physio/assessment', owner_phone: '+919000000018', TEST_MODE: 'true', TEST_PHONE: '+919000000019',
  slot_minutes: '30', booking_notice_minutes: '120',
};
const settingsRows = (over = {}) => Object.entries({ ...SETTINGS, ...over }).filter(([, v]) => v !== undefined).map(([Key, Value], i) => ({ id: i + 1, fields: { Key, Value } }));

const KNOWLEDGE = [
  { id: 1, fields: { Title: 'Knee pain physiotherapy', Category: 'services', Content: 'One-to-one knee rehab: assessment, manual therapy and exercises. ₹800 per session.', Active: true } },
  { id: 2, fields: { Title: 'Back pain physiotherapy', Category: 'services', Content: 'Treatment for lower back and neck pain. ₹800 per session.', Active: true } },
  { id: 3, fields: { Title: 'First assessment', Category: 'pricing', Content: 'The first assessment costs ₹500 and takes 45 minutes.', Active: true } },
  { id: 4, fields: { Title: 'Opening hours', Category: 'hours', Content: 'Monday to Saturday, 9 AM to 7 PM. Closed on Sunday.', Active: true } },
  { id: 5, fields: { Title: 'Address', Category: 'location', Content: 'Demo Physio, 12 MG Road, Pune. Parking available.', Active: true } },
  { id: 6, fields: { Title: 'Cancellation policy', Category: 'policy', Content: 'Cancel or reschedule up to 2 hours before your appointment, free of charge.', Active: true } },
  { id: 7, fields: { Title: 'Old Diwali offer', Category: 'pricing', Content: 'Assessment for ₹199 only.', Active: false } },
];

// Lead 1 = Asha, a returning patient (first chat 5 days ago) with an online (Cal.com) appointment tomorrow 10:00.
// Lead 2 = someone else, booked tomorrow 17:00 (that slot is taken). Lead 3 = booked on WhatsApp (wa-...) on Thursday 12:00.
const ASHA = '+919000000011';
const leadRows = () => [
  { id: 1, fields: { Lead_id: 'L-20261001-0001', Created_At: sec(NOW) - 5 * DAY, Name: 'Asha Patel', Phone: ASHA, Source: 'WhatsApp', Status: 'Contacted', Enquiry: 'Do you treat knee pain?', AI_Summary: 'Asked about knee pain treatment; wanted to think about it.', Lead_Stage: 'warm' } },
  { id: 2, fields: { Lead_id: 'L-20261002-0001', Created_At: sec(NOW) - 4 * DAY, Name: 'Other Patient', Phone: '+919000000014', Source: 'Website', Status: 'Booked' } },
  { id: 3, fields: { Lead_id: 'L-20261003-0001', Created_At: sec(NOW) - 3 * DAY, Name: 'Ravi Kumar', Phone: '+919000000015', Source: 'WhatsApp', Status: 'Booked' } },
];
const appointmentRows = () => [
  { id: 1, fields: { Booking_UID: 'cal-uid-asha-1', Lead: 1, Service: 'Knee pain physiotherapy', Physio: 'Dr. Mehta', Start: at('2026-10-07', '10:00'), End: at('2026-10-07', '10:30'), Status: 'Booked' } },
  { id: 2, fields: { Booking_UID: 'cal-uid-other-1', Lead: 2, Service: 'First assessment', Start: at('2026-10-07', '17:00'), End: at('2026-10-07', '17:30'), Status: 'Booked' } },
  { id: 3, fields: { Booking_UID: 'wa-wamid.OLD.ravi', Lead: 3, Service: 'Back pain physiotherapy', Start: at('2026-10-08', '12:00'), End: at('2026-10-08', '12:30'), Status: 'Booked' } },
  { id: 4, fields: { Booking_UID: 'cal-uid-asha-old', Lead: 1, Service: 'First assessment', Start: at('2026-09-20', '10:00'), Status: 'Completed' } },
];
const conversationRows = () => [{ id: 1, fields: { Lead: 1, Phone: ASHA, Last_Inbound_At: sec(NOW) - 5 * DAY, Unread: 0, Automation_Paused: false } }];
const messageRows = () => [
  { id: 1, fields: { Conversation: 1, Direction: 'In', Body: 'Do you treat knee pain?', Sent_By: 'Patient', WA_Message_ID: 'wamid.OLD.1', Status: 'Received', Created_At: sec(NOW) - 5 * DAY } },
  { id: 2, fields: { Conversation: 1, Direction: 'Out', Body: 'Yes, we treat knee pain. Knee pain physiotherapy is ₹800 per session.', Sent_By: 'W13-ai-receptionist', WA_Message_ID: 'wamid.OUT.1', Status: 'queued', Created_At: sec(NOW) - 5 * DAY + 20 } },
  { id: 3, fields: { Conversation: 1, Direction: 'In', Body: 'Ok, I will think about it', Sent_By: 'Patient', WA_Message_ID: 'wamid.OLD.2', Status: 'Received', Created_At: sec(NOW) - 5 * DAY + 60 } },
];

// ---------------------------------------------------------------- the fake Claude
const BASE_DECISION = {
  intent: 'other', action: 'reply', needs_human: false, handoff_reason: '', confidence: 0.92, sentiment: 'neutral', language: 'en',
  lead_stage: 'warm', reply: '', booking: { date: null, time: null, time_window: null }, appointment_ref: null, follow_up_days: null,
  kb_refs: [], likely_service: null, lead_summary: '', priority: 'normal', staff_note: '', risk_flags: [],
};
const twelve = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };

// Reads the request the way Claude would: from the prompt text only.
function fakeDecide(req) {
  const facts = req.system.map((b) => b.text).join('\n');
  const text = req.messages[0].content.replace(/<\/?patient_message>/g, '').trim();
  const d = JSON.parse(JSON.stringify(BASE_DECISION));
  const kb = (ref) => (facts.match(new RegExp(`^\\[${ref}\\][^\\n]*`, 'm')) || [''])[0];
  const price = (ref) => (kb(ref).match(/₹\d+/) || [''])[0];
  const dateOf = (word) => { const m = facts.match(new RegExp(`^- (\\d{4}-\\d{2}-\\d{2}) = [^\\n]*${word}`, 'mi')); return m ? m[1] : null; };
  const freeOn = (date) => { const m = facts.match(new RegExp(`^- ${date} \\([^)]*\\): ([^\\n]*)`, 'm')); return m ? m[1].split(', ') : []; };

  const outcomeAsked = /How are you feeling/i.test((facts.match(/RECENT CONVERSATION[\s\S]*/) || [''])[0]);   // W7's check-in is in the history
  if (outcomeAsked && /\b(worse|more pain|pain has increased)\b/i.test(text)) {
    Object.assign(d, { intent: 'outcome_worse', action: 'handoff', needs_human: true, sentiment: 'negative', handoff_reason: 'feels worse after the session', reply: '' });
  } else if (outcomeAsked && /\b(same as before|no change|still the same)\b/i.test(text)) {
    Object.assign(d, { intent: 'outcome_same', action: 'handoff', needs_human: true, handoff_reason: 'no change yet', reply: '' });
  } else if (outcomeAsked && /\b(better|much better|feeling good)\b/i.test(text) && !/book|appointment/i.test(text)) {
    Object.assign(d, { intent: 'outcome_better', action: 'reply', sentiment: 'positive', reply: 'So glad to hear you are feeling better! Thank you for letting us know.', lead_summary: 'Feeling better after the visit.' });
  } else if (/services|what do you (do|offer)/i.test(text)) {
    const services = [...facts.matchAll(/^\[K\d+\] \(services\) ([^:]+):/gm)].map((m) => m[1]);
    Object.assign(d, { intent: 'services_info', reply: `Hi! We offer ${services.join(' and ')}. Would you like to book a first assessment?`, kb_refs: ['K1', 'K2'], lead_summary: 'New enquiry about services.' });
  } else if (/how much|cost|charges|kitne|price/i.test(text) && /knee/i.test(facts.match(/RECENT CONVERSATION[\s\S]*/)[0]) && /again|still/i.test(text)) {
    Object.assign(d, { intent: 'pricing', reply: `Welcome back Asha! Yes, knee physiotherapy is still ${price('K1')} per session, and you can book here: {{BOOKING_LINK}}`, kb_refs: ['K1'], likely_service: 'Knee pain physiotherapy', lead_stage: 'hot', lead_summary: 'Returning patient with knee pain, ready to start treatment.' });
  } else if (/how much|cost|charges|kitne|price/i.test(text)) {
    Object.assign(d, { intent: 'pricing', reply: `The first assessment costs ${price('K3')} (45 minutes). Treatment sessions are ${price('K1')} each.`, kb_refs: ['K1', 'K3'], lead_summary: 'Asked about prices.' });
  } else if (/tomorrow evening|kal evening/i.test(text) && /AVAILABILITY[^\n]*\n- not known/.test(facts)) {
    if (/booking link: available/.test(facts)) Object.assign(d, { intent: 'availability_check', action: 'offer_slots', lead_stage: 'hot', reply: 'Please pick a time that suits you here: {{BOOKING_LINK}}' });
    else Object.assign(d, { intent: 'availability_check', action: 'handoff', needs_human: true, handoff_reason: 'free times are not known' });
  } else if (/tomorrow evening|kal evening/i.test(text)) {
    const date = dateOf('\\(tomorrow\\)');
    const evening = freeOn(date).filter((t) => t >= '16:00').slice(0, 3);
    Object.assign(d, { intent: 'availability_check', action: 'offer_slots', lead_stage: 'hot', booking: { date, time: null, time_window: 'evening' }, reply: `Yes! Tomorrow evening we have ${evening.map(twelve).join(', ')} free. Which one suits you?`, lead_summary: 'Wants to come tomorrow evening.' });
  } else if (/book me for (\w+) at (\d+)/i.test(text)) {
    const [, day, hour] = text.match(/book me for (\w+) at (\d+)/i);
    const date = dateOf(day.toLowerCase());
    const time = `${String(Number(hour) + (Number(hour) < 9 ? 12 : 0)).padStart(2, '0')}:00`;
    Object.assign(d, { intent: 'book_appointment', action: 'book_slot', lead_stage: 'hot', booking: { date, time, time_window: null }, reply: `${day} at ${twelve(time)} is free. Please confirm your booking here: {{BOOKING_LINK}}`, lead_summary: `Wants to book ${day} ${time}.` });
  } else if (/cancel/i.test(text)) {
    const a = facts.match(/^- \[(A\d)\] ([^,(]+)[^\n]*\((booked [a-zA-Z]+)/m);
    const reply = a && a[3] === 'booked online' ? `No problem. You can cancel your appointment on ${a[2].trim()} with this link: {{CANCEL_LINK}}` : a && `Done, your appointment on ${a[2].trim()} is cancelled.`;
    if (a) Object.assign(d, { intent: 'cancel_appointment', action: 'cancel_appointment', appointment_ref: a[1], lead_stage: 'cold', reply, lead_summary: 'Wants to cancel the appointment.' });
    else Object.assign(d, { intent: 'cancel_appointment', action: 'handoff', needs_human: true, handoff_reason: 'no appointment found to cancel' });
  } else if (/think about it|baad mein/i.test(text)) {
    Object.assign(d, { intent: 'follow_up_later', action: 'schedule_follow_up', follow_up_days: 3, lead_stage: 'warm', reply: 'Sure, take your time. We are here when you are ready.', lead_summary: 'Will decide later.' });
  } else if (/^(ok|thanks|thank you)[.!]*$/i.test(text)) {
    Object.assign(d, { intent: 'thanks_ack', action: 'no_reply', reply: '' });
  } else {
    Object.assign(d, { intent: 'other', action: 'handoff', needs_human: true, confidence: 0.4, handoff_reason: 'question not covered by the knowledge base', reply: '' });
  }
  return d;
}

// The Anthropic Messages API answer for a decision (what n8n's HTTP node returns as $json).
const claudeResponse = (decision) => ({
  id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn',
  content: [{ type: 'text', text: typeof decision === 'string' ? decision : JSON.stringify(decision) }],
  usage: { input_tokens: 1000, output_tokens: 200 },
});

// fakeClaude(): records every request; `override(req)` may return a decision object, a raw string, or { http: {...} }.
function fakeClaude(override) {
  const calls = [];
  const fn = (method, url, headers, body) => {
    calls.push({ method, url, headers, body });
    const o = override ? override(body, calls.length) : undefined;
    if (o && o.throw) throw new Error(o.throw);
    if (o && o.http) return o.http;
    return { status: 200, body: claudeResponse(o === undefined ? fakeDecide(body) : o) };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------- the same fake behind OpenRouter (W13 DEMO workflow)
// The OpenRouter request is turned back into the Anthropic shape the fake reads (its one system message split at the CLINIC and
// NOW sections, so a fact lost in translation makes the prompt checks fail), and the fake's answers (normal, refusal, cut off,
// HTTP errors, thrown timeouts) are turned into OpenRouter Chat Completions answers. `fn.claude.calls` = what the model saw.
function toOpenRouterBody(status, b) {
  if (!b || typeof b !== 'object') return b;
  if (status >= 400 || b.type === 'error') return { error: { code: status, message: (b.error && (b.error.message || b.error.type)) || 'error' } };
  const text = (b.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('');
  const refused = b.stop_reason === 'refusal';
  const finish = { end_turn: 'stop', max_tokens: 'length' }[b.stop_reason] || 'stop';
  return {
    id: 'gen-fake', object: 'chat.completion', model: 'openai/gpt-4o-mini', provider: 'OpenAI',
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: refused ? null : text, refusal: refused ? 'I cannot help with that.' : null } }],
    usage: { prompt_tokens: (b.usage && b.usage.input_tokens) || 0, completion_tokens: (b.usage && b.usage.output_tokens) || 0 },
  };
}
function fakeOpenRouter(claude) {
  const calls = [];
  const fn = (method, url, headers, body) => {
    calls.push({ method, url, headers, body });
    const sys = body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const i = sys.indexOf('\n\nCLINIC\n');
    const j = sys.indexOf('\n\nNOW: ');
    const system = i > 0 && j > i ? [sys.slice(0, i), sys.slice(i + 2, j), sys.slice(j + 2)].map((text) => ({ type: 'text', text })) : [{ type: 'text', text: sys }];
    const req = {
      model: body.model, max_tokens: body.max_tokens, system,
      messages: body.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      output_config: body.response_format ? { format: { type: body.response_format.type, schema: body.response_format.json_schema.schema } } : undefined,
    };
    const r = claude(method, url, headers, req);   // may throw (timeout): the HTTP node then fails like a real timeout
    return { status: r.status, body: toOpenRouterBody(r.status, r.body) };
  };
  fn.calls = calls;
  fn.claude = claude;
  return fn;
}

module.exports = { NOW, sec, at, DAY, SETTINGS, settingsRows, KNOWLEDGE, ASHA, leadRows, appointmentRows, conversationRows, messageRows, BASE_DECISION, fakeDecide, fakeClaude, claudeResponse, fakeOpenRouter };
