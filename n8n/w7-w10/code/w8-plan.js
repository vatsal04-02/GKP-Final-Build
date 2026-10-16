// Who gets a review request now (cmReviewPlan): the newest Completed visit per patient that ended after_hours..max_days ago, Review_Sent
// empty, not asked in the last min_days_between days. No filter on mood or complaints (Google: no review gating).
// Only for clinics with Settings > review_requests = on (missing = off: switch it on once the review_request template is approved).
// No usable Settings > review_link: nothing is sent; once a day (config_warning_hour, IST) a Run_Log warning says how many are waiting.
const cfg = $('W8 – Config').first().json;
const clinics = $('W8 – Add settings').all();
const appts = $('W8 – Appointments').all();
const leads = $('W8 – Leads').all();
const now = Date.now();
const nowSec = Math.floor(now / 1000);
const hourIST = new Date(now + 5.5 * 3600 * 1000).getUTCHours();
const out = [];
$input.all().forEach((conv, i) => {
  const c = clinics[i].json;
  if (!cmOn(c.settings.review_requests)) return;
  const plan = cmReviewPlan(appts[i].json.records || [], leads[i].json.records || [], conv.json.records || [], now, cfg, c.settings.review_link);
  if (!plan.link_ok && plan.waiting > 0 && hourIST === Number(cfg.config_warning_hour)) {
    out.push({
      json: {
        kind: 'config_warning', grist_base_url: c.grist_base_url, doc_id: c.doc_id,
        log: { Workflow: 'W8-review-request', Record: 'config: Settings > review_link', Outcome: 'skipped', Error: `Settings > review_link is missing or not an https:// link: ${plan.waiting} review request(s) are waiting and none is sent until it is set.`, At: nowSec },
      },
      pairedItem: { item: i },
    });
  }
  for (const it of plan.items.slice(0, Number(cfg.max_per_run) || 30)) {
    out.push({
      json: { grist_base_url: c.grist_base_url, doc_id: c.doc_id, clinic_name: c.clinic_name, wa_phone_number_id: c.wa_phone_number_id, test_mode: c.settings.TEST_MODE, test_phone: c.settings.TEST_PHONE, ...it },
      pairedItem: { item: i },
    });
  }
});
return out;
