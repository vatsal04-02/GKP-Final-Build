// W7 (outcome check-in), W8 (review request), W9 (weekly report) and W10 (staff reply): the pure functions behind their n8n Code
// nodes. Nothing here sends, writes or calls an API; W12 sends, Grist nodes write. Paste from CM_ROLE down to (not including) the
// module.exports line. The shared helpers come in as `h` (normalizeIndianPhone, decideSend), like the other snippets.
//
// Safety, by construction: eligibility, timing, duplicate flags and every number are computed here, deterministically. The only AI
// text (W9's summary / recommendations) is checked line by line: a line that quotes a number not in the computed data is dropped.

const CM_ROLE = { hot: 0, warm: 1, cold: 2 };
const CM_DONE_INTENTS = ['not_interested', 'opt_out'];
const CM_TEXT_WINDOW_SEC = 24 * 3600 - 5 * 60;   // WhatsApp free-text window (as W12), minus a margin
const CM_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CM_IST = 5.5 * 3600;

function cmText(v, max) { return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function cmSec(v) { return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null; }
function cmDate(sec) { const t = new Date((sec + CM_IST) * 1000); return `${String(t.getUTCDate()).padStart(2, '0')} ${CM_MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`; }
function cmHttps(v) { const s = cmText(v, 500); return /^https:\/\/[^\s<>"']+$/i.test(s) ? s : ''; }
function cmFirstName(v) { return cmText(v, 60).split(' ')[0] || 'there'; }
function cmIsAutomation(sentBy) { return /^W\d+(?!\w)/.test(cmText(sentBy, 80)); }   // "W5-reminders", "W13-ai-receptionist", "W12"... else a person
// A per-clinic switch in Settings (outcome_checkin, review_requests, weekly_report_whatsapp): on / true / yes / 1. Missing = OFF,
// like ai_mode: a clinic gets these messages only after it is switched on (its WhatsApp templates are approved per number).
function cmOn(v) { return ['on', 'true', 'yes', '1'].includes(cmText(v, 10).toLowerCase()); }

// Conversations -> { lead id: { needs_human, paused, assigned, last_intent, last_inbound_at } } (newest inbound wins the intent).
function cmConversations(records) {
  const out = {};
  for (const r of Array.isArray(records) ? records : []) {
    const f = (r && r.fields) || {};
    const id = String(f.Lead === null || f.Lead === undefined ? '' : f.Lead);
    if (!/^[1-9]\d*$/.test(id)) continue;
    const c = out[id] || (out[id] = { needs_human: false, paused: false, assigned: '', last_intent: '', last_inbound_at: null, conversation_id: r.id });
    if (f.Needs_Human === true) c.needs_human = true;
    if (f.Automation_Paused === true) c.paused = true;
    if (!c.assigned) c.assigned = cmText(f.Assigned_To, 60);
    const at = cmSec(f.Last_Inbound_At);
    if (at !== null && (c.last_inbound_at === null || at >= c.last_inbound_at)) { c.last_inbound_at = at; c.last_intent = cmText(f.Last_Intent, 40); }
  }
  return out;
}
const cmEnd = (f) => cmSec(f.End) || (cmSec(f.Start) ? f.Start + 45 * 60 : null);   // no End: assume a 45-minute session

// ---------------------------------------------------------------- W7: outcome check-in after a Completed appointment
// cfg: { after_hours, max_hours, min_days_between }. One check-in per patient: the newest Completed visit that ended after_hours to
// max_hours ago, Outcome_Sent empty; none if another check-in went to them in the last min_days_between days, if they already have
// a future Booked visit (staff see them soon), or if a person owns the conversation / they said not interested or stop.
function cmOutcomePlan(appointments, leadRows, convRecords, nowMs, cfg) {
  const now = Math.floor(nowMs / 1000);
  const after = Number(cfg.after_hours) * 3600;
  const max = Number(cfg.max_hours) * 3600;
  const gap = Number(cfg.min_days_between) * 86400;
  const leads = {};
  for (const r of leadRows || []) leads[String(r.id)] = r.fields || {};
  const convs = cmConversations(convRecords);
  const byLead = {};
  for (const a of appointments || []) (byLead[String((a.fields || {}).Lead)] = byLead[String((a.fields || {}).Lead)] || []).push(a);
  const items = [];
  const held = [];
  for (const [lead, list] of Object.entries(byLead)) {
    if (!/^[1-9]\d*$/.test(lead)) continue;
    const due = list.filter((a) => {
      const f = a.fields || {};
      const end = cmEnd(f);
      return f.Status === 'Completed' && !f.Outcome_Sent && end !== null && now - end >= after && now - end <= max;
    }).sort((x, y) => cmEnd(y.fields) - cmEnd(x.fields));
    if (!due.length) continue;
    const a = due[0];
    const hold = (why) => held.push({ appt_row_id: a.id, booking_uid: a.fields.Booking_UID || `row ${a.id}`, reason: why });
    const lf = leads[lead];
    if (!lf) { hold('lead not found'); continue; }
    if (list.some((x) => cmSec(x.fields.Outcome_Sent) && now - x.fields.Outcome_Sent < gap)) { hold('a check-in went to this patient recently'); continue; }
    if (list.some((x) => x.fields.Status === 'Booked' && cmSec(x.fields.Start) && x.fields.Start > now)) { hold('the patient already has a future appointment'); continue; }
    const c = convs[lead];
    if (c && (c.needs_human || c.assigned)) { hold('a person owns this conversation'); continue; }
    if (c && CM_DONE_INTENTS.includes(c.last_intent)) { hold('the patient said not interested / stop'); continue; }
    items.push({
      kind: 'outcome', appt_row_id: a.id, booking_uid: a.fields.Booking_UID || `row ${a.id}`, lead_row_id: Number(lead),
      lead_id: lf.Lead_id || lf.Lead_ID || `row ${lead}`, lead_name: cmText(lf.Name, 60), lead_phone: cmText(lf.Phone, 20),
      opted_out: lf.Opted_Out === true, automation_paused: !!(c && c.paused), flag_value: a.fields.Outcome_Sent || null,
      service: cmText(a.fields.Service, 80), physio: cmText(a.fields.Physio, 60), appt_end: cmEnd(a.fields), last_inbound_at: c ? c.last_inbound_at : null,
    });
  }
  return { items, held };
}

// ---------------------------------------------------------------- W8: review request after a Completed appointment
// cfg: { after_hours, max_days, min_days_between }. The newest Completed visit per patient that ended after_hours to max_days ago,
// Review_Sent empty; none if this patient was asked in the last min_days_between days. Deliberately NO filter on mood, outcome or
// complaints: choosing whom to ask by how happy they are is "review gating", against Google's review policy. Opted out, paused,
// quiet hours and TEST_MODE are applied by W8 – Decide send. Without a review link nothing is planned (reported as waiting).
function cmReviewPlan(appointments, leadRows, convRecords, nowMs, cfg, reviewLink) {
  const now = Math.floor(nowMs / 1000);
  const after = Number(cfg.after_hours) * 3600;
  const max = Number(cfg.max_days) * 86400;
  const gap = Number(cfg.min_days_between) * 86400;
  const link = cmHttps(reviewLink);
  const leads = {};
  for (const r of leadRows || []) leads[String(r.id)] = r.fields || {};
  const convs = cmConversations(convRecords);
  const byLead = {};
  for (const a of appointments || []) (byLead[String((a.fields || {}).Lead)] = byLead[String((a.fields || {}).Lead)] || []).push(a);
  const items = [];
  let waiting = 0;
  for (const [lead, list] of Object.entries(byLead)) {
    if (!/^[1-9]\d*$/.test(lead) || !leads[lead]) continue;
    const due = list.filter((a) => {
      const f = a.fields || {};
      const end = cmEnd(f);
      return f.Status === 'Completed' && !f.Review_Sent && end !== null && now - end >= after && now - end <= max;
    }).sort((x, y) => cmEnd(y.fields) - cmEnd(x.fields));
    if (!due.length) continue;
    if (list.some((x) => cmSec(x.fields.Review_Sent) && now - x.fields.Review_Sent < gap)) continue;
    if (!link) { waiting++; continue; }
    const a = due[0];
    const lf = leads[lead];
    const c = convs[lead];
    items.push({
      kind: 'review', appt_row_id: a.id, booking_uid: a.fields.Booking_UID || `row ${a.id}`, lead_row_id: Number(lead),
      lead_id: lf.Lead_id || lf.Lead_ID || `row ${lead}`, lead_name: cmText(lf.Name, 60), lead_phone: cmText(lf.Phone, 20),
      opted_out: lf.Opted_Out === true, automation_paused: !!(c && c.paused), flag_value: a.fields.Review_Sent || null,
      review_link: link, last_inbound_at: c ? c.last_inbound_at : null,
    });
  }
  return { items, waiting, link_ok: !!link };
}

// W7 / W8: the message for W12. Free text when the patient wrote in the last 24 h (no template needed), else the approved template.
// The text is the template's wording, so the Grist inbox (and W13 reading the history) shows what the patient got.
function cmPatientMessage(item, clinicName, nowSec) {
  const name = cmFirstName(item.lead_name);
  const clinic = cmText(clinicName, 80) || 'the clinic';
  let text;
  let template;
  let params;
  if (item.kind === 'outcome') {
    const service = item.service || 'visit';
    text = `Hi ${name}, thank you for visiting ${clinic} for your ${service}. How are you feeling now? Just reply here: better, the same or worse. If you would like another appointment, tell us and we will help.`;
    template = 'outcome_check';
    params = { name, clinic_name: clinic, service };
  } else {
    text = `Hi ${name}, thank you for choosing ${clinic}. If you have a minute, we would be grateful for your honest review here: ${item.review_link} Thank you!`;
    template = 'review_request';
    params = { name, clinic_name: clinic, review_link: item.review_link };
  }
  const inWindow = cmSec(item.last_inbound_at) !== null && nowSec - item.last_inbound_at < CM_TEXT_WINDOW_SEC;
  return inWindow
    ? { message_type: 'text', text_body: text, message_text: text, template: '', template_params: {} }
    : { message_type: 'template', text_body: '', message_text: text, template, template_params: params };
}

// ---------------------------------------------------------------- W9: weekly report
// The week that ended last Monday 00:00 IST (W9 runs Monday morning): [start, end) in epoch seconds.
function cmWeekWindow(nowMs) {
  const istDay = Math.floor((nowMs / 1000 + CM_IST) / 86400);   // days since 1970-01-01 in India
  const weekday = (istDay + 4) % 7;                               // 0 = Sunday ... 1 = Monday
  const monday = istDay - ((weekday + 6) % 7);                    // this week's Monday
  const end = monday * 86400 - CM_IST;
  const start = end - 7 * 86400;
  return { start, end, label: `${cmDate(start)} to ${cmDate(end - 1)}` };
}

// Every number in the report, computed from Grist rows. data: { leads, appointments, conversations, messages, runlog } (records);
// caps: { messages, runlog } = the row limits used for the reads (to say when a count may be incomplete).
function cmWeeklyMetrics(data, nowMs, win, caps = {}) {
  const now = Math.floor(nowMs / 1000);
  const inWeek = (t) => cmSec(t) !== null && t >= win.start && t < win.end;
  const f = (r) => (r && r.fields) || {};
  const count = (list, fn) => list.filter(fn).length;
  const leads = (data.leads || []).map(f);
  const newLeads = leads.filter((l) => inWeek(l.Created_At));
  const bySource = {};
  for (const l of newLeads) { const s = cmText(l.Source, 30) || 'unknown'; bySource[s] = (bySource[s] || 0) + 1; }
  const firsts = newLeads.filter((l) => cmSec(l.First_Response_At) && cmSec(l.Created_At) && l.First_Response_At >= l.Created_At)
    .map((l) => Math.round((l.First_Response_At - l.Created_At) / 60)).sort((a, b) => a - b);
  const stage = { hot: 0, warm: 0, cold: 0, not_rated: 0 };
  for (const l of newLeads) stage[Object.prototype.hasOwnProperty.call(CM_ROLE, l.Lead_Stage) ? l.Lead_Stage : 'not_rated']++;
  const appts = (data.appointments || []).map(f);
  const week = appts.filter((a) => inWeek(a.Start));
  const msgs = (data.messages || []).map(f);
  const inbound = msgs.filter((m) => m.Direction === 'In' && inWeek(m.Created_At));
  const st = (s) => count(inbound, (m) => m.AI_Status === s);
  const intent = (s) => count(inbound, (m) => m.Intent === s);
  const convs = (data.conversations || []).map(f);
  const logs = (data.runlog || []).map(f).filter((l) => inWeek(l.At));
  const sent = (wf, re) => count(logs, (l) => l.Workflow === wf && l.Outcome === 'ok' && (!re || re.test(String(l.Record || ''))));
  const failures = {};
  for (const l of logs) if (l.Outcome === 'failed') failures[l.Workflow || 'unknown'] = (failures[l.Workflow || 'unknown'] || 0) + 1;
  return {
    leads: {
      new: newLeads.length,
      by_source: bySource,
      contacted: count(newLeads, (l) => !!cmSec(l.First_Response_At) || (l.Status && l.Status !== 'New')),
      booked: count(newLeads, (l) => l.Status === 'Booked' || l.Status === 'Converted'),
      still_new: count(newLeads, (l) => l.Status === 'New'),
      median_first_response_minutes: firsts.length ? firsts[Math.floor((firsts.length - 1) / 2)] : null,
      stage,
      opted_out_total: count(leads, (l) => l.Opted_Out === true),
    },
    appointments: {
      this_week: week.length,
      completed: count(week, (a) => a.Status === 'Completed'),
      no_show: count(week, (a) => a.Status === 'No-show'),
      cancelled: count(week, (a) => a.Status === 'Cancelled'),
      rescheduled: count(week, (a) => a.Status === 'Rescheduled'),
      still_marked_booked: count(appts, (a) => a.Status === 'Booked' && cmSec(a.Start) && a.Start < now - 3600),
      booked_next_7_days: count(appts, (a) => a.Status === 'Booked' && cmSec(a.Start) && a.Start >= now && a.Start < now + 7 * 86400),
    },
    ai: {
      patient_messages: inbound.length,
      replied: st('replied'), drafted: st('drafted'), handed_off: st('handed_off'), no_reply: st('no_reply'),
      skipped: st('skipped'), deferred: st('deferred'), failed: st('failed'), opted_out: st('opted_out'),
      outcome_better: intent('outcome_better'), outcome_same: intent('outcome_same'), outcome_worse: intent('outcome_worse'),
    },
    people: {
      waiting_for_a_person: count(convs, (c) => c.Needs_Human === true),
      paused_conversations: count(convs, (c) => c.Automation_Paused === true),
      staff_replies_sent: count(msgs, (m) => m.Direction === 'Out' && !cmIsAutomation(m.Sent_By) && ['sent', 'delivered', 'read'].includes(m.Status) && inWeek(m.Created_At)),
    },
    sent: {
      speed_to_lead_alerts: sent('W3-speed-to-lead'), reminders: sent('W5-reminders'), day2_followups: sent('W6-followups', /\(followup\)/),
      noshow_rebooks: sent('W6-followups', /\(rebook\)/), outcome_checkins: sent('W7-outcome-nudge'), review_requests: sent('W8-review-request'),
      ai_runs: sent('W13-ai-receptionist'),
    },
    failures: { total: Object.values(failures).reduce((a, b) => a + b, 0), by_workflow: failures },
    incomplete: { messages: !!caps.messages && (data.messages || []).length >= caps.messages, run_log: !!caps.runlog && (data.runlog || []).length >= caps.runlog },
  };
}

// The issues, from the numbers only (deterministic, always shown).
function cmIssues(m, reviewLinkSet) {
  const out = [];
  if (m.appointments.still_marked_booked) out.push(`${m.appointments.still_marked_booked} past appointment(s) are still marked Booked: mark them Completed or No-show (check-ins, reviews and no-show rebooking depend on it).`);
  if (m.people.waiting_for_a_person) out.push(`${m.people.waiting_for_a_person} conversation(s) are waiting for a person (Needs_Human).`);
  if (m.leads.still_new) out.push(`${m.leads.still_new} of this week's new leads were never contacted (Status still New).`);
  if (m.ai.outcome_worse) out.push(`${m.ai.outcome_worse} patient(s) said they feel worse after a visit.`);
  if (m.failures.total) out.push(`${m.failures.total} automation step(s) failed this week (see Run_Log, Outcome = failed).`);
  if (!reviewLinkSet) out.push('Settings > review_link is not set, so no review requests are sent.');
  if (m.incomplete.messages || m.incomplete.run_log) out.push('Very busy week: some message / log counts may be incomplete (read limit reached).');
  return out;
}

// Every number the AI may quote: each numeric value in the metrics, as text.
function cmAllowedNumbers(m) {
  const set = new Set();
  const walk = (v) => { if (typeof v === 'number' && Number.isFinite(v)) set.add(String(v)); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(m);
  return set;
}

const CM_REPORT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'observations', 'recommendations'],
  properties: { summary: { type: 'string' }, observations: { type: 'array', items: { type: 'string' } }, recommendations: { type: 'array', items: { type: 'string' } } },
};
const CM_REPORT_RULES = [
  'You write the weekly report of a physiotherapy clinic for its owner, from DATA only.',
  'Use ONLY numbers that appear in DATA, exactly as written. Never add, subtract, total, average or turn numbers into percentages; never write numbers as words; never mention money, prices, dates or names.',
  'summary: 2 or 3 short sentences on the week. observations: at most 3 facts from DATA worth the owner\'s attention. recommendations: at most 3 practical next steps for the clinic team (no medical advice).',
  'Answer with JSON only.',
].join('\n');

// One OpenRouter request per clinic per week (the model and credential are W13's: openrouter + openai/gpt-4o-mini).
function cmReportRequest(m, model) {
  return {
    model, temperature: 0.2, max_tokens: 700,
    messages: [{ role: 'system', content: CM_REPORT_RULES }, { role: 'user', content: `DATA\n${JSON.stringify(m)}` }],
    response_format: { type: 'json_schema', json_schema: { name: 'weekly_report', strict: true, schema: CM_REPORT_SCHEMA } },
    provider: { require_parameters: true },
  };
}

const CM_NUMBER_WORDS = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|thousand|dozen|half|double|twice|triple)\b/i;
// Every line the AI wrote is kept only if each number in it is one of the computed numbers, and it has no number words, % or ₹.
function cmCheckLine(line, allowed) {
  const s = cmText(line, 300).replace(/https?:\/\/\S+/gi, '');
  if (!s) return '';
  if (CM_NUMBER_WORDS.test(s) || /[%₹$]|\bRs\.?\b|\bINR\b/i.test(s)) return '';
  const nums = s.match(/\d+(?:[.,]\d+)?/g) || [];
  return nums.every((n) => allowed.has(n.replace(/,/g, ''))) ? s : '';
}
// OpenRouter's answer (or n8n's { error } item) -> { summary, observations, recommendations, dropped, error }.
function cmCheckAiReport(resp, allowed) {
  const empty = (error) => ({ summary: '', observations: [], recommendations: [], dropped: 0, error });
  if (!resp || resp.error) return empty(`AI not available: ${cmText(resp && resp.error && (resp.error.message || resp.error), 200) || 'no answer'}`);
  const c = resp.choices && resp.choices[0];
  let j;
  try { j = JSON.parse(c && c.message && c.message.content); } catch (e) { return empty('AI answer was not JSON'); }
  if (!j || typeof j.summary !== 'string' || !Array.isArray(j.observations) || !Array.isArray(j.recommendations)) return empty('AI answer did not match the schema');
  let dropped = 0;
  const keep = (list, n) => list.slice(0, n).map((x) => { const v = cmCheckLine(x, allowed); if (!v) dropped++; return v; }).filter(Boolean);
  const summary = cmText(j.summary, 600).split(/(?<=[.!?])\s+/).map((x) => { const v = cmCheckLine(x, allowed); if (!v && x.trim()) dropped++; return v; }).filter(Boolean).join(' ');
  return { summary, observations: keep(j.observations, 3), recommendations: keep(j.recommendations, 3), dropped, error: '' };
}

// The report: sections 2-6 are written by code from the numbers; 1 and 7 come from the checked AI text, or from code if it failed.
function cmRenderReport(m, ai, clinicName, win, reviewLinkSet) {
  const L = m.leads; const A = m.appointments; const I = m.ai; const P = m.people; const S = m.sent;
  const sources = Object.entries(L.by_source).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const headline = `${L.new} new leads (${L.booked} booked), ${A.completed} visits completed, ${A.no_show} no-show, ${A.cancelled} cancelled, ${I.handed_off} AI hand-offs, ${P.waiting_for_a_person} waiting for a person`;
  const issues = cmIssues(m, reviewLinkSet);
  const fallbackActions = issues.length ? issues.slice(0, 3) : ['No open issues this week: keep marking appointments Completed / No-show the same day.'];
  const summary = ai.summary || `This week: ${headline}.`;
  const recs = ai.recommendations.length ? ai.recommendations : fallbackActions;
  const lines = [
    `WEEKLY REPORT - ${clinicName} - ${win.label}`,
    'Numbers: computed by n8n from Grist. Summary, observations and recommendations: written by AI from those numbers only (checked: a line quoting any other number is dropped).',
    '',
    '1. Executive summary', summary, ...ai.observations.map((o) => `- ${o}`),
    '',
    '2. Lead performance',
    `- New leads: ${L.new} (${sources})`,
    `- Contacted: ${L.contacted} | booked: ${L.booked} | still New: ${L.still_new}`,
    `- Median first response: ${L.median_first_response_minutes === null ? 'n/a' : `${L.median_first_response_minutes} min`}`,
    `- Stage of new leads: hot ${L.stage.hot} | warm ${L.stage.warm} | cold ${L.stage.cold} | not rated ${L.stage.not_rated}`,
    `- Opted out (all time): ${L.opted_out_total}`,
    '',
    '3. Appointment performance (appointments that started this week)',
    `- Total ${A.this_week} | completed ${A.completed} | no-show ${A.no_show} | cancelled ${A.cancelled} | rescheduled ${A.rescheduled}`,
    `- Past appointments still marked Booked: ${A.still_marked_booked} | booked for the next 7 days: ${A.booked_next_7_days}`,
    '',
    '4. AI receptionist and hand-offs',
    `- Patient messages ${I.patient_messages} | AI replied ${I.replied} | handed to staff ${I.handed_off} | drafts ${I.drafted} | no reply needed ${I.no_reply} | deferred overnight ${I.deferred} | skipped ${I.skipped} | failed ${I.failed} | opted out ${I.opted_out}`,
    `- Check-in answers: better ${I.outcome_better} | same ${I.outcome_same} | worse ${I.outcome_worse}`,
    `- Conversations waiting for a person now: ${P.waiting_for_a_person} | paused: ${P.paused_conversations} | staff replies sent: ${P.staff_replies_sent}`,
    '',
    '5. Follow-up performance (messages sent)',
    `- Speed-to-lead alerts ${S.speed_to_lead_alerts} | reminders ${S.reminders} | day-2 follow-ups ${S.day2_followups} | no-show rebooks ${S.noshow_rebooks} | check-ins ${S.outcome_checkins} | review requests ${S.review_requests}`,
    '',
    '6. Important issues',
    ...(issues.length ? issues.map((x) => `- ${x}`) : ['- none']),
    '',
    `7. Recommended actions (${ai.recommendations.length ? 'AI suggestions' : 'suggested by the rules'}, not facts)`,
    ...recs.map((x) => `- ${x}`),
  ];
  if (ai.error) lines.push('', `(AI text not used: ${ai.error})`);
  else if (ai.dropped) lines.push('', `(${ai.dropped} AI line(s) dropped: they quoted a number that is not in the data)`);
  return { text: lines.join('\n'), headline, top_action: recs[0] };
}

// ---------------------------------------------------------------- W10: staff reply from the Grist inbox
// A Messages row staff wrote (Direction Out, Send ticked). -> { action: send | reject | hold | none, ... }.
//   reject: not sendable as it is (patch Status + AI_Reason, Send unticked)   hold: quiet hours, goes out at 08:00 (note only)
// Staff replies are human messages: Automation_Paused (stops AUTOMATED messages) does not block them; Opted_Out does.
function cmStaffReplyCheck(row, conv, lead, settings, nowMs, h) {
  const f = (row && row.fields) || {};
  const cf = (conv && conv.fields) || null;
  const lf = (lead && lead.fields) || {};
  const nowSec = Math.floor(nowMs / 1000);
  const reject = (status, why) => ({ action: 'reject', status, reason: why, patch: { Send: false, Status: status, AI_Reason: cmText(why, 500) } });
  if (f.Direction !== 'Out' || f.Send !== true) return { action: 'none', reason: 'not a pending staff reply' };
  if (cmText(f.WA_Message_ID, 120) || ['sent', 'delivered', 'read'].includes(f.Status)) return { action: 'reject', status: f.Status || 'sent', reason: 'already sent: not sent again', patch: { Send: false } };
  const body = String(f.Body === null || f.Body === undefined ? '' : f.Body).trim();
  if (!body) return reject('failed', 'empty message: write the reply in Body, then tick Send');
  if (cmText(f.Template, 80)) return reject('failed', 'templates are not sent from the inbox: leave Template empty and write the reply in Body');
  if (!cf) return reject('failed', 'conversation not found: add the reply in the patient\'s conversation');
  const patient = h.normalizeIndianPhone(cf.Phone || lf.Phone).phone;
  if (!patient) return reject('failed', 'the conversation has no valid patient phone number');
  if (lf.Opted_Out === true) return reject('failed', 'the patient opted out (STOP): not sent. Untick Leads > Opted_Out only if the patient asks to hear from you again');
  const last = cmSec(cf.Last_Inbound_At);
  if (last === null || nowSec - last >= CM_TEXT_WINDOW_SEC) return reject('needs_template', 'the patient\'s last message is older than 24 h: WhatsApp only allows an approved template now. Ask them to message you first, or call');
  const decision = h.decideSend({ kind: 'transactional', flag_value: null, opted_out: false, automation_paused: false, patient_phone: patient, test_mode: settings.TEST_MODE, test_phone: h.normalizeIndianPhone(settings.TEST_PHONE).phone, now_ms: nowMs });
  if (!decision.send && decision.reason === 'quiet hours') {
    const note = 'waiting: quiet hours (21:00-08:00 IST); it goes out at 08:00';
    return { action: 'hold', reason: note, patch: f.AI_Reason === note ? null : { AI_Reason: note } };
  }
  if (!decision.send) return reject('failed', `not sent: ${decision.reason}`);
  return {
    action: 'send', decision, reason: decision.reason,
    claim: { Send: false, Status: 'queued', AI_Reason: '', ...(cmSec(f.Created_At) ? {} : { Created_At: nowSec }), ...(cmText(f.Sent_By, 80) ? {} : { Sent_By: 'Staff' }) },
    message: { message_type: 'text', text_body: body.slice(0, 4096), message_text: body.slice(0, 2000), template: '', template_params: {}, last_inbound_at: last, lead_phone: patient, lead_row_id: Number(cf.Lead) || 0, inbox_row_id: row.id },
  };
}

// What W12 answered -> the writes for the staff row, the conversation and Run_Log.
function cmStaffReplyResult(rowId, res, nowSec) {
  const ok = res && res.sent === true;
  const err = cmText(res && res.send_error, 400);
  const status = ok ? 'sent' : /24-hour|24h window|131047/i.test(err) ? 'needs_template' : 'failed';
  const via = res && res.decision && res.decision.test_mode ? `TEST_MODE: sent to ${res.decision.to}` : '';
  return {
    message_patch: { Status: status, WA_Message_ID: ok ? cmText(res.wa_message_id, 120) : '', AI_Reason: ok ? [via, err].filter(Boolean).join('; ') : (err || 'not sent') },
    conversation_patch: ok ? { Unread: 0 } : null,
    log: { Workflow: 'W10-staff-reply', Record: `message ${rowId} (staff reply)${ok && res.wa_message_id ? ` ${cmText(res.wa_message_id, 80)}` : ''}`, Outcome: ok ? 'ok' : 'failed', Error: ok ? '' : (err || 'not sent'), At: nowSec },
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    CM_ROLE, CM_TEXT_WINDOW_SEC, CM_REPORT_SCHEMA, CM_REPORT_RULES, cmText, cmSec, cmDate, cmHttps, cmFirstName, cmIsAutomation, cmOn, cmConversations,
    cmOutcomePlan, cmReviewPlan, cmPatientMessage, cmWeekWindow, cmWeeklyMetrics, cmIssues, cmAllowedNumbers, cmReportRequest, cmCheckLine,
    cmCheckAiReport, cmRenderReport, cmStaffReplyCheck, cmStaffReplyResult,
  };
}
