// W5 - Find due (Slice 4C). The text below the pasted helpers (lead-context.js, normalize-phone.js, reminder-consent.js) is this node.
// Time windows, sent flags, the Booked-only rule and the "patient asked to cancel / reschedule" hold are exactly as before. New:
//   * a Pending confirmation appointment is never reminded (staff have not confirmed it);
//   * the patient need not be a Lead: the phone and name come from the lead, else the appointment's own Patient_Phone / Patient_Name, else the Patients row (Patient_ID);
//   * automated reminders need REMINDER consent (Reminder_Consent = Yes) and no opt-out: Unknown, No, opted out or an unreadable table all stop the reminder;
//   * every appointment that is due but not reminded leaves the node as an item with hold_reason (W5 - Decide send turns it into "not sent", W5 - Skip digest writes it
//     to Run_Log), so nobody has to guess why a patient got no reminder. Nothing is written to Appointments for a skipped reminder.
const cfg = $('W5 – Config').first().json;
const nowMs = Date.now();
const r24 = [Number(cfg.r24_min_hours) * 60, Number(cfg.r24_max_hours) * 60];   // minutes before the start
const r2 = [Number(cfg.r2_min_minutes), Number(cfg.r2_max_minutes)];
const clinics = $('W5 – Add appointments').all();
const leadsPerClinic = $('W5 – Leads').all();                   // one answer per clinic (this node's input is W5 – Conversations)
const consentPerClinic = $('W5 – Reminder consent').all();
const patientsPerClinic = $('W5 – Patients').all();
const records = (x) => (x && x.json && Array.isArray(x.json.records) ? x.json.records : null);   // null = the table could not be read
const out = [];

$input.all().forEach((convs, i) => {
  const { appointments, ...base } = clinics[i].json;
  const leadRows = records(leadsPerClinic[i]) || [];
  const leads = {};
  for (const r of leadRows) leads[r.id] = r.fields || {};
  const consentRows = records(consentPerClinic[i]);               // null = unreadable: every reminder is held, with that reason
  const consentByPhone = {};
  for (const r of consentRows || []) { const p = normalizeIndianPhone(r.fields && r.fields.Phone).phone; if (p) (consentByPhone[p] = consentByPhone[p] || []).push(r); }
  const patientById = {};
  for (const r of records(patientsPerClinic[i]) || []) { const id = r.fields && r.fields.Patient_ID; if (id) patientById[id] = r.fields; }
  // What W13 and staff wrote to Conversations (unreadable -> nothing known -> every due reminder goes, exactly as before).
  const conversations = lcConversations((convs.json && convs.json.records) || []);

  for (const a of appointments) {
    const f = a.fields || {};
    if (f.Status !== 'Booked' || !f.Start) continue;
    const minutes = (f.Start * 1000 - nowMs) / 60000;   // minutes until the appointment starts
    let kind = null;
    if (minutes > r2[0] && minutes <= r2[1]) kind = 'r2';
    else if (minutes > r24[0] && minutes <= r24[1]) kind = 'r24';
    if (!kind) continue;

    const flag_column = kind === 'r24' ? 'R24_Sent' : 'R2_Sent';
    if (f[flag_column]) continue;                       // already sent (rule 4: check the flag first)

    const lead = leads[f.Lead];
    const patient = f.Patient_ID ? patientById[f.Patient_ID] : null;
    const options = [lead && { phone: lead.Phone, name: lead.Name, via: 'lead' }, f.Patient_Phone && { phone: f.Patient_Phone, name: f.Patient_Name, via: 'appointment' }, patient && { phone: patient.Phone, name: patient.Name, via: 'patient record' }].filter(Boolean);
    const who = options.find((o) => normalizeIndianPhone(o.phone).phone) || null;
    const phone = who ? normalizeIndianPhone(who.phone).phone : '';
    const item = {
      ...base,
      kind,
      template: kind === 'r24' ? 'reminder_24h' : 'reminder_2h',
      purpose: 'appointment_reminder',
      flag_column,
      flag_value: f[flag_column] || null,
      appt_row_id: a.id,
      booking_uid: f.Booking_UID || '',
      service: f.Service || '',
      physio: f.Physio || '',
      start: f.Start,
      patient_name: (who && who.name) || (lead && lead.Name) || f.Patient_Name || (patient && patient.Name) || '',
      patient_phone: phone,
      lead_row_id: lead ? f.Lead : null,
      contact_via: who ? who.via : '',
      opted_out: false,
    };
    const hold = (code, text) => out.push({ json: { ...item, skip_code: code, hold_reason: text }, pairedItem: { item: i } });

    if (f.Appt_Stage === 'Pending confirmation') { hold('pending_confirmation', 'pending confirmation: staff have not confirmed it yet'); continue; }
    if (!who) { hold('no_contact', 'no valid phone on the lead, the appointment or the patient record'); continue; }

    // The hold that existed before: the patient asked on WhatsApp to cancel / reschedule (< 24 h ago) and staff have not answered yet (Needs_Human):
    // no 24 h "see you tomorrow". The 2 h reminder always goes. Needs a lead (that is where the conversation lives).
    if (lead) {
      const nba = nextBestAction(leadContext({ id: f.Lead, fields: lead }, conversations[String(f.Lead)], nowMs), 'reminder', { kind });
      if (!nba.allowed) { hold('change_requested', nba.reason); continue; }
    }

    // Reminder consent (decisions D2 / D4): only a recorded Yes sends. A patient who wrote first, or the website tick-box, is Unknown.
    const optedOut = rcOptedOut(leadRows, phone, normalizeIndianPhone) || (!!lead && lead.Opted_Out === true);
    const e = rcEffective(consentRows === null ? null : (consentByPhone[phone] || []), optedOut);
    if (!e.allowed) { hold(e.reason, RC_REASON_TEXT[e.reason]); continue; }

    out.push({ json: { ...item, consent: e.reason }, pairedItem: { item: i } });
  }
});
return out;
