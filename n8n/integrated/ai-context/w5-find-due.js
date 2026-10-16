  const cfg = $('W5 – Config').first().json;
  const nowMs = Date.now();
  const r24 = [Number(cfg.r24_min_hours) * 60, Number(cfg.r24_max_hours) * 60];   // minutes before the start
  const r2 = [Number(cfg.r2_min_minutes), Number(cfg.r2_max_minutes)];
  const clinics = $('W5 – Add appointments').all();
  const leadsPerClinic = $('W5 – Leads').all();         // one LEADS answer per clinic (this node's input is W5 – Conversations)
  const out = [];

  $input.all().forEach((convs, i) => {
    const { appointments, ...base } = clinics[i].json;
    const leads = {};
    for (const r of (leadsPerClinic[i] || { json: {} }).json.records || []) leads[r.id] = r.fields || {};
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
      if (!lead) continue;

      // The only hold: the patient asked on WhatsApp to cancel / reschedule (< 24 h ago) and staff have not answered yet
      // (Needs_Human): no 24 h "see you tomorrow". The 2 h reminder always goes. Time, flag and status rules above are unchanged.
      const nba = nextBestAction(leadContext({ id: f.Lead, fields: lead }, conversations[String(f.Lead)], nowMs), 'reminder', { kind });
      if (!nba.allowed) continue;

      out.push({
        json: {
          ...base,
          kind,
          template: kind === 'r24' ? 'reminder_24h' : 'reminder_2h',
          flag_column,
          flag_value: f[flag_column] || null,
          appt_row_id: a.id,
          booking_uid: f.Booking_UID || '',
          service: f.Service || '',
          physio: f.Physio || '',
          start: f.Start,
          patient_name: lead.Name || '',
          patient_phone: lead.Phone || '',
          opted_out: lead.Opted_Out === true,
        },
        pairedItem: { item: i },
      });
    }
  });
  return out;
