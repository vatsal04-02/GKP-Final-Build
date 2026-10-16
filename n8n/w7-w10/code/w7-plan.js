// Who gets a check-in now (cmOutcomePlan): the newest Completed visit per patient that ended after_hours..max_hours ago, Outcome_Sent
// empty, no check-in in the last min_days_between days, no future Booked visit, nobody from staff owning the conversation.
// Only for clinics with Settings > outcome_checkin = on (missing = off: switch it on once the outcome_check template is approved).
const cfg = $('W7 – Config').first().json;
const clinics = $('W7 – Add settings').all();
const appts = $('W7 – Appointments').all();
const leads = $('W7 – Leads').all();
const now = Date.now();
const out = [];
$input.all().forEach((conv, i) => {
  const c = clinics[i].json;
  if (!cmOn(c.settings.outcome_checkin)) return;
  const plan = cmOutcomePlan(appts[i].json.records || [], leads[i].json.records || [], conv.json.records || [], now, cfg);
  for (const it of plan.items.slice(0, Number(cfg.max_per_run) || 30)) {
    out.push({
      json: { grist_base_url: c.grist_base_url, doc_id: c.doc_id, clinic_name: c.clinic_name, wa_phone_number_id: c.wa_phone_number_id, test_mode: c.settings.TEST_MODE, test_phone: c.settings.TEST_PHONE, ...it },
      pairedItem: { item: i },
    });
  }
});
return out;
