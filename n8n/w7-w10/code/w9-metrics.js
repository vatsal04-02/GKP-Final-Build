// Every number of the report, computed here from Grist rows (cmWeeklyMetrics), for the week that ended last Monday 00:00 IST.
// The AI request carries these numbers only; the AI never computes or changes one.
const cfg = $('W9 – Config').first().json;
const clinics = $('W9 – Add settings').all();
const leads = $('W9 – Leads').all();
const appts = $('W9 – Appointments').all();
const convs = $('W9 – Conversations').all();
const msgs = $('W9 – Messages').all();
const now = Date.now();
const win = cmWeekWindow(now);
const cap = Number(cfg.read_limit) || 5000;
return $input.all().map((logs, i) => {
  const c = clinics[i].json;
  const runlog = logs.json.records || [];
  const metrics = cmWeeklyMetrics({
    leads: leads[i].json.records, appointments: appts[i].json.records, conversations: convs[i].json.records, messages: msgs[i].json.records, runlog,
  }, now, win, { messages: cap, runlog: cap });
  // the owner gets this week's report on WhatsApp at most once (a Run_Log "owner WhatsApp <week>" row with Outcome ok = already sent)
  const ownerSent = runlog.some((r) => (r.fields || {}).Workflow === 'W9-weekly-report' && (r.fields || {}).Outcome === 'ok' && (r.fields || {}).Record === `owner WhatsApp ${win.label}`);
  return {
    json: {
      grist_base_url: c.grist_base_url, doc_id: c.doc_id, clinic_name: c.clinic_name, wa_phone_number_id: c.wa_phone_number_id,
      owner_on: cmOn(c.settings.weekly_report_whatsapp), owner_phone: c.settings.owner_phone, test_mode: c.settings.TEST_MODE, test_phone: c.settings.TEST_PHONE, owner_sent: ownerSent,
      review_link_set: !!cmHttps(c.settings.review_link), window: win, metrics, body: cmReportRequest(metrics, cfg.openrouter_model),
    },
    pairedItem: { item: i },
  };
});
