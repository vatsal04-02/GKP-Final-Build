// W12 - Consent decide (Slice 4C): the consent gate is decided by the message PURPOSE (n8n/snippets/reminder-consent.js), not by one blanket flag.
//   reminders (reminder_24h / reminder_2h / followup_reminder, also sent as free text)  -> a recorded Reminder_Consent = Yes and no opt-out
//   booking_transaction (booking_confirmation)                                         -> a Meta opt-in on file (the lead's Consent_WhatsApp or a reminder Yes), no opt-out
//   engagement (follow-ups, rebook, outcome check, review request)                      -> the existing rule: the lead's Consent_WhatsApp, no opt-out
//   reply (free text inside the 24 h window) and staff_alert                            -> not checked here (needs_consent is false)
// Anything unreadable or unknown blocks. TEST_MODE sends (to the clinic's own phone) are not checked, as before.
const p = $('W12 – Prepare request').first().json;

const stop = (why) => ({
  json: {
    ...p,
    early: {
      send_status: 'blocked',
      send_error: why,
      ledger_status: ''
    }
  }
});

// Fail closed if the consent requirement is missing or invalid.
if (p.prep?.needs_consent === undefined ||
    p.prep?.needs_consent === null) {
  return stop('consent check: needs_consent flag is missing; nothing was sent');
}

// Consent is not required for this message.
// Continue to the ledger and normal send safeguards.
if (p.prep.needs_consent === false) {
  return {
    json: {
      ...p,
      consent_ok: true,
      consent_skipped: true
    }
  };
}

// Consent IS required from this point onward.
if (!p.prep.consent_phone) {
  return stop(
    'consent check: the lead phone number is missing or invalid; nothing was sent'
  );
}

const leadAnswer = $('W12 – Lead consent').first().json;
if (!Array.isArray(leadAnswer.records)) {
  return stop(
    `consent check: could not read the lead in Grist (${
      String(((leadAnswer.error &&
        (leadAnswer.error.message || leadAnswer.error))) || 'no answer')
        .replace(/\s+/g, ' ')
        .slice(0, 150)
    }); nothing was sent`
  );
}
const leads = leadAnswer.records.filter((r) => r && r.fields);
const consent = Array.isArray($json.records) ? $json.records.filter((r) => r && r.fields) : null;   // null = Reminder_Consent could not be read

const purpose = String(p.prep.purpose || 'engagement');
const d = rcDecide(purpose, p.prep.consent_phone, leads, consent, normalizeIndianPhone);
if (!d.allowed) return stop(d.reason);

return {
  json: {
    ...p,
    consent_ok: true,
    consent_skipped: false,
    consent_purpose: purpose
  }
};
