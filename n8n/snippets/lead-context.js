// Lead intelligence for W3 / W5 / W6: a compact reading of what the AI receptionist (W13) and staff already wrote to the CRM,
// and the next best action for one workflow purpose. Deterministic: no model call, no network. Pasted into the Code nodes
// W3 – Find due, W5 – Find due and W6 – Plan follow-ups (keep identical).
//
// The AI recommends through the fields it writes (Lead_Stage, AI_Summary, Likely_Service, Next_Action_At on LEADS; Last_Intent,
// Needs_Human, Handoff_Reason on Conversations). This file validates them (known values only, real timestamps) and answers
// "is this automated step still right for this patient?". It can only HOLD BACK or REORDER a step the workflow's own rules
// already allow; it never creates a send, a time, a price or a link. Missing or unreadable fields = unknown = as before.
const LC_STAGE_RANK = { hot: 0, warm: 1, cold: 2 };
const LC_DONE_INTENTS = ['not_interested', 'opt_out'];
const LC_CHANGE_INTENTS = ['cancel_appointment', 'reschedule_appointment'];
const LC_RECENT_MIN = 48 * 60;   // W6: the patient wrote in the last 48 h = the conversation is live
const LC_ACTIVE_MIN = 60;        // W3: wrote in the last hour = reply now
const LC_REQUEST_MIN = 24 * 60;  // W5: a cancel / reschedule request older than this no longer holds a reminder

function lcText(v, max) { return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function lcSec(v) { const n = typeof v === 'number' ? v : NaN; return Number.isFinite(n) && n > 0 ? n : null; }   // Grist DateTime = seconds
function lcAgo(min) { return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`; }

// Conversations rows -> { [lead row id]: compact state }. Several conversations for one lead are merged (any Needs_Human /
// Automation_Paused counts; the newest inbound decides Last_Intent and Handoff_Reason).
function lcConversations(records) {
  const byLead = {};
  for (const r of Array.isArray(records) ? records : []) {
    const f = (r && r.fields) || {};
    const lead = String(f.Lead === null || f.Lead === undefined ? '' : f.Lead);
    if (!/^[1-9]\d*$/.test(lead)) continue;
    const c = byLead[lead] || (byLead[lead] = { needs_human: false, paused: false, assigned_to: '', last_inbound_at: null, last_intent: '', handoff_note: '' });
    if (f.Needs_Human === true) c.needs_human = true;
    if (f.Automation_Paused === true) c.paused = true;
    if (!c.assigned_to) c.assigned_to = lcText(f.Assigned_To, 60);
    const at = lcSec(f.Last_Inbound_At);
    const newer = at !== null && (c.last_inbound_at === null || at >= c.last_inbound_at);
    if (newer || (c.last_inbound_at === null && !c.last_intent)) {
      if (at !== null) c.last_inbound_at = at;
      c.last_intent = lcText(f.Last_Intent, 40);
      c.handoff_note = lcText(f.Handoff_Reason, 160);
    }
  }
  return byLead;
}

// One lead (Grist row) + its conversation state -> the compact context the workflows use.
function leadContext(lead, conv, nowMs) {
  const f = (lead && lead.fields) || {};
  const c = conv || null;
  const stage = Object.prototype.hasOwnProperty.call(LC_STAGE_RANK, f.Lead_Stage) ? f.Lead_Stage : '';
  const next = lcSec(f.Next_Action_At);
  const inbound = c ? c.last_inbound_at : null;
  return {
    stage,
    rank: stage ? LC_STAGE_RANK[stage] : 1,                  // unknown ranks with warm: no AI data = no change in order
    summary: lcText(f.AI_Summary, 200),
    service: lcText(f.Likely_Service, 80),
    enquiry: lcText(f.Enquiry, 200),
    last_intent: c ? c.last_intent : '',
    handoff_note: c ? c.handoff_note : '',
    last_inbound_at: inbound,
    minutes_since_inbound: inbound !== null ? Math.max(0, Math.floor((nowMs / 1000 - inbound) / 60)) : null,
    next_action_at: next,
    next_action_future: next !== null && next * 1000 > nowMs,
    needs_human: !!(c && c.needs_human),
    paused: !!(c && c.paused),
    assigned_to: c ? c.assigned_to : '',
    opted_out: f.Opted_Out === true,
  };
}

// purpose: 'escalation' (W3 staff alert), 'reminder' (W5, o.kind = r24 | r2), 'followup' (W6 day 2), 'rebook' (W6 no-show,
// o.since = the missed appointment's Start). -> { action, allowed, reason }. allowed = false holds the step back.
function nextBestAction(x, purpose, o = {}) {
  const act = (action, allowed, reason) => ({ action, allowed, reason });
  const wrote = x.minutes_since_inbound;
  const owner = x.assigned_to ? `assigned to ${x.assigned_to}` : 'automation paused';
  const done = x.last_intent === 'opt_out' ? 'the patient asked us to stop' : 'the patient said they are not interested';
  const planned = () => `next contact planned for ${new Date(x.next_action_at * 1000 + 5.5 * 3600 * 1000).toISOString().slice(0, 10)}`;

  if (purpose === 'reminder') {   // reminders stay transactional: only a pending cancel / reschedule request holds the 24 h one
    if (o.kind === 'r24' && x.needs_human && LC_CHANGE_INTENTS.includes(x.last_intent) && wrote !== null && wrote < LC_REQUEST_MIN) {
      return act('human_handoff', false, `24 h reminder held: the patient asked to ${x.last_intent === 'cancel_appointment' ? 'cancel' : 'reschedule'} on WhatsApp ${lcAgo(wrote)} and staff have not answered yet`);
    }
    return act('appointment_reminder', true, 'reminder due');
  }
  if (purpose === 'escalation') {
    if (x.paused || x.assigned_to) return act('wait', false, `staff own this conversation (${owner})`);
    if (x.opted_out) return act('no_action', false, 'the patient opted out');
    if (LC_DONE_INTENTS.includes(x.last_intent)) return act('no_action', false, done);
    if (x.next_action_future) return act('wait', false, planned());
    if (x.needs_human) return act('human_handoff', true, `AI hand-off: ${x.handoff_note || 'see the Grist inbox'}`);
    if (wrote !== null && wrote <= LC_ACTIVE_MIN) return act('reply_now', true, 'reply on WhatsApp now, the patient is active');
    if (x.stage === 'hot') return act('reply_now', true, 'call now, ready to book');
    return act('follow_up', true, 'call or message today');
  }
  if (purpose === 'followup' || purpose === 'rebook') {   // opted out / paused: still stopped later by W6 – Decide send, as before
    if (x.needs_human) return act('human_handoff', false, 'waiting for a person (Needs_Human)');
    if (x.assigned_to) return act('wait', false, `staff own this conversation (${owner})`);
    if (LC_DONE_INTENTS.includes(x.last_intent)) return act('no_action', false, done);
    if (x.next_action_future) return act('wait', false, planned());
    if (purpose === 'rebook') {
      if (x.last_inbound_at !== null && Number.isFinite(o.since) && x.last_inbound_at > o.since) return act('wait', false, 'the patient has written since the missed appointment');
      return act('rebook', true, 'no-show: offer a new time');
    }
    if (wrote !== null && wrote < LC_RECENT_MIN) return act('wait', false, `the patient wrote ${lcAgo(wrote)}`);
    if (x.stage === 'cold') return act('nurture', false, 'the AI rated this lead cold: no day-2 push');
    return act('follow_up', true, x.stage === 'hot' ? 'hot lead: day-2 follow-up first' : 'day-2 follow-up');
  }
  throw new Error(`nextBestAction: unknown purpose ${purpose}`);
}

// W3: what staff need in one look. WHO (name, phone), WHAT (AI summary or enquiry, likely service), RECENT (last intent, when),
// HOW HOT (stage, waiting time), NEXT (the action). brief = the template's "enquiry" value; text = message_text.
function lcStaffBrief(x, nba, o) {
  const tag = x.stage ? `[${x.stage.toUpperCase()}] ` : '';
  const what = (x.summary || x.enquiry || 'no details yet').replace(/[.\s]+$/, '');
  const service = x.service ? ` (${x.service})` : '';
  const recent = [x.last_intent ? x.last_intent.replace(/_/g, ' ') : '', x.minutes_since_inbound !== null ? `wrote ${lcAgo(x.minutes_since_inbound)}` : ''].filter(Boolean).join(', ');
  const tail = `${recent ? ` Last: ${recent}.` : ''} Next: ${nba.reason.replace(/[.\s]+$/, '')}.`;
  return {
    brief: lcText(`${tag}${what}${service}.${tail}`, 240),
    text: lcText(`New lead ${tag}${o.name} (${o.phone}) for ${o.clinic}, waiting ${o.waiting_minutes} min. ${what}${service}.${tail}`, 500),
  };
}

if (typeof module !== 'undefined') {
  module.exports = { LC_STAGE_RANK, LC_DONE_INTENTS, LC_CHANGE_INTENTS, lcText, lcSec, lcAgo, lcConversations, leadContext, nextBestAction, lcStaffBrief };
}
