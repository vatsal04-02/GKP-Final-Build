// n8n Code node helpers: message PURPOSES and the reminder-consent rule (Slice 4C). Pure functions, no I/O, so the same code runs pasted into n8n and in Node tests.
// Paste from RC_PURPOSE_BY_TEMPLATE down to (not including) the module.exports line.
//
// The rule is the same one FLOW HQ applies (flowhq/src/server/booking/consent.ts `effectiveConsent`; a vitest test keeps the two identical):
//   an opt-out (any lead with this phone has Opted_Out)  -> NO, beats everything
//   Reminder_Consent = No                                -> NO
//   Reminder_Consent = Yes                               -> YES
//   anything else (no row, blank, a typo, unreadable)    -> NO (Unknown suppresses)
// A patient messaging the clinic first, LEADS.Consent_WhatsApp set by the website tick-box or by an inbound message, are NOT reminder consent (decisions D2, D4).
//
// PURPOSES (decision D3 and rule E of the Slice 4 brief). Every patient-facing message has exactly one:
//   reply                 free text answering a patient who wrote in the last 24 h (W13). No consent rule; opt-out is still checked by the callers.
//   booking_transaction   the confirmation of a booking the patient or the clinic just made (W4). NOT governed by reminder consent, but bound by Meta's rules:
//                         a business-initiated template needs an opt-in on file (the lead's Consent_WhatsApp, or a recorded reminder Yes). An opt-out always blocks.
//   appointment_reminder  reminder_24h / reminder_2h (W5). Needs reminder consent Yes.
//   followup_reminder     the follow-up visit reminder (W15). Needs reminder consent Yes.
//   engagement            follow-ups, no-show rebook, outcome check, review request. Unchanged: the lead's Consent_WhatsApp and no opt-out.
//   staff_alert           messages to the clinic's own staff. No patient consent.
// A template that is not listed is `engagement` (the existing, stricter-than-nothing rule). A caller can only RAISE a message to a reminder purpose, never lower it.

const RC_PURPOSE_BY_TEMPLATE = {
  hello_world: 'engagement',
  booking_confirmation: 'booking_transaction',
  reminder_24h: 'appointment_reminder',
  reminder_2h: 'appointment_reminder',
  followup_reminder: 'followup_reminder',
  noshow_rebook: 'engagement',
  followup_day2: 'engagement',
  outcome_check: 'engagement',
  review_request: 'engagement',
  new_lead_staff_alert: 'staff_alert',
  lead_escalation: 'staff_alert',
  human_handoff_alert: 'staff_alert',
  weekly_owner_report: 'staff_alert',
};
const RC_REMINDER_PURPOSES = ['appointment_reminder', 'followup_reminder'];

// input: the caller's W12 item ({ template, message_type, audience, purpose }) -> one purpose string.
function rcPurpose(input) {
  const i = input || {};
  const declared = RC_REMINDER_PURPOSES.includes(i.purpose) ? i.purpose : '';
  if (declared) return declared;                                     // W15 sends its in-window reminder as free text: still a reminder
  if (i.audience && i.audience !== 'patient') return 'staff_alert';
  if (i.message_type === 'text') return 'reply';
  return Object.prototype.hasOwnProperty.call(RC_PURPOSE_BY_TEMPLATE, i.template) ? RC_PURPOSE_BY_TEMPLATE[i.template] : 'engagement';
}

// The value of one phone's Reminder_Consent rows ({ id, fields: { Phone, Reminder_Consent } }). The table keeps ONE row per phone; if a
// damaged table ever holds two, the stricter wins (No before Yes) so a withdrawal is never lost.
function rcValue(rows, phone) {
  let value = 'Unknown';
  for (const r of Array.isArray(rows) ? rows : []) {
    const f = (r && r.fields) || {};
    if (phone && f.Phone !== phone) continue;
    if (f.Reminder_Consent === 'No') return 'No';
    if (f.Reminder_Consent === 'Yes') value = 'Yes';
  }
  return value;
}

// Is any lead with this phone opted out? `normalize` = normalizeIndianPhone. leadRows: LEADS rows (all rows of a clinic, or the rows found for the phone).
function rcOptedOut(leadRows, phone, normalize) {
  for (const r of Array.isArray(leadRows) ? leadRows : []) {
    const f = (r && r.fields) || {};
    if (f.Opted_Out !== true) continue;
    const p = normalize ? normalize(f.Phone).phone : f.Phone;
    if (!phone || p === phone) return true;
  }
  return false;
}

// May automated REMINDERS go to this phone? -> { value, allowed, reason }  (identical to consent.ts effectiveConsent)
//   consentRows: Reminder_Consent rows for the phone, or null when the table could not be read (then: unreadable = not allowed, reason says so).
function rcEffective(consentRows, optedOut) {
  if (optedOut) return { value: 'No', allowed: false, reason: 'opted_out' };
  if (consentRows === null) return { value: 'Unknown', allowed: false, reason: 'consent_unreadable' };
  const v = rcValue(consentRows, '');
  if (v === 'No') return { value: 'No', allowed: false, reason: 'consent_no' };
  if (v === 'Yes') return { value: 'Yes', allowed: true, reason: 'consent_yes' };
  return { value: 'Unknown', allowed: false, reason: 'consent_unknown' };
}

const RC_REASON_TEXT = {
  opted_out: 'opted out',
  consent_no: 'reminder consent is No',
  consent_unknown: 'no reminder consent on file',
  consent_unreadable: 'reminder consent could not be read',
};

// The one decision W12 takes before a patient message goes to Meta.
//   purpose: from rcPurpose.  phone: the patient's +91 number.
//   leads: the LEADS rows found for the phone (null = unreadable).   consent: the Reminder_Consent rows for the phone (null = unreadable).
// -> { allowed, reason, purpose }.  `reason` is shown in send_error, so it says what to fix.
function rcDecide(purpose, phone, leads, consent, normalize) {
  const out = (allowed, reason) => ({ allowed, reason, purpose });
  if (purpose === 'staff_alert' || purpose === 'reply') return out(true, 'no patient consent rule for this purpose');
  if (!phone) return out(false, 'consent check: the patient phone number is missing or invalid; nothing was sent');
  if (leads === null) return out(false, 'consent check: could not read the lead in Grist; nothing was sent');
  const optedOut = rcOptedOut(leads, phone, normalize);
  const first = leads.find((r) => r && r.fields);                   // the lead W12 has always used (the first row found for the phone)
  const legacy = !!first && first.fields.Consent_WhatsApp === true;

  if (RC_REMINDER_PURPOSES.includes(purpose)) {
    const e = rcEffective(consent, optedOut);
    return e.allowed ? out(true, 'reminder consent: Yes') : out(false, `${RC_REASON_TEXT[e.reason] || e.reason}; a ${purpose.replace('_', ' ')} was not sent (record reminder consent in FLOW HQ > Schedule)`);
  }
  if (optedOut) return out(false, 'the lead has opted out; nothing was sent');
  if (purpose === 'booking_transaction') {
    // Meta: a business-initiated template needs an opt-in on file. The lead's own consent (they wrote to us / ticked the form) is enough for THIS message;
    // it is never reminder consent. A reminder Yes also proves an opt-in. Reminder consent No does not block a booking confirmation.
    if (legacy || rcValue(consent, '') === 'Yes') return out(true, 'booking confirmation: opt-in on file');
    return out(false, 'no WhatsApp opt-in on file for this patient (LEADS.Consent_WhatsApp or a recorded reminder consent); a business-initiated booking confirmation template was not sent');
  }
  // engagement (and anything unknown): the existing rule, unchanged
  if (!first) return out(false, 'consent check: no lead with this phone number in LEADS; nothing was sent');
  if (!legacy) return out(false, 'no WhatsApp consent on file for this lead (LEADS.Consent_WhatsApp); a business-initiated template was not sent');
  return out(true, 'ok');
}

if (typeof module !== 'undefined') module.exports = { RC_PURPOSE_BY_TEMPLATE, RC_REMINDER_PURPOSES, RC_REASON_TEXT, rcPurpose, rcValue, rcOptedOut, rcEffective, rcDecide };
