  const cfg = $('W3 – Config').first().json;
  const nowMs = Date.now();
  const minAge = Number(cfg.new_for_minutes);           // waiting at least this long ...
  const maxAge = Number(cfg.max_age_hours) * 60;        // ... but not an old backlog
  const cap = Number(cfg.max_alerts_per_run);           // per clinic per run
  const clinics = $('W3 – Add settings').all();
  const leadsPerClinic = $('W3 – Leads').all();         // one LEADS answer per clinic (this node's input is W3 – Conversations)
  const out = [];

  $input.all().forEach((convs, i) => {
    const item = leadsPerClinic[i] || { json: {} };
    const base = clinics[i].json;
    // What W13 and staff wrote to Conversations (unreadable -> nothing known -> W3 escalates exactly as before).
    const conversations = lcConversations((convs.json && convs.json.records) || []);
    // if (!base.open_now) return;                         // outside clinic hours: leave everything for the next run

    const due = (item.json.records || [])
      .filter((r) => {                                      // the W3 rule, unchanged: New, not escalated, waiting minAge..maxAge
        const f = r.fields || {};
        if (f.Status !== 'New' || f.Escalated || typeof f.Created_At !== 'number') return false;
        const minutes = (nowMs - f.Created_At * 1000) / 60000;
        return minutes >= minAge && minutes <= maxAge;
      })
      .map((r) => {
        const x = leadContext(r, conversations[String(r.id)], nowMs);
        return { r, x, nba: nextBestAction(x, 'escalation') };
      })
      // Held back: staff own the conversation (Automation_Paused / Assigned_To), opted out, said not interested / stop, or a next
      // contact is already planned (Next_Action_At in the future). A lead the AI handed off is skipped through Escalated (set by
      // W13 only when its staff alert was delivered); a failed alert = still escalated here, with the AI's note.
      .filter((d) => d.nba.allowed)
      .sort((a, b) => a.x.rank - b.x.rank || a.r.fields.Created_At - b.r.fields.Created_At)   // hot, warm / unknown, cold; then oldest
      .slice(0, cap);

    for (const { r, x, nba } of due) {
      const f = r.fields;
      const waiting = Math.floor((nowMs - f.Created_At * 1000) / 60000);
      const brief = lcStaffBrief(x, nba, { name: String(f.Name || 'New lead'), phone: String(f.Phone || ''), clinic: base.clinic_name || 'Clinic', waiting_minutes: waiting });
      out.push({
        json: {
          ...base,
          lead_row_id: r.id,
          lead_id: f.Lead_id || `row ${r.id}`,
          lead_name: String(f.Name || ''),
          lead_phone: String(f.Phone || ''),
          source: String(f.Source || ''),
          enquiry: String(f.Enquiry || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          waiting_minutes: waiting,
          escalated: !!f.Escalated,
          lead_stage: x.stage,
          ai_summary: x.summary,
          next_best_action: nba.action,
          staff_brief: brief.brief,                         // -> the template's "enquiry" value
          staff_text: brief.text,                           // -> message_text
        },
        pairedItem: { item: i },
      });
    }
  });
  return out;
