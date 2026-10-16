// Optional: the headline and the first recommended action to Settings > owner_phone, through W12 (template weekly_owner_report).
// Off unless Settings > weekly_report_whatsapp = on (after Meta approves the template). Quiet hours and TEST_MODE (-> TEST_PHONE) apply;
// at most once per week.
const r = $('W9 – Report').item.json;
const { phone: owner } = normalizeIndianPhone(r.owner_phone);
const { phone: test_phone } = normalizeIndianPhone(r.test_phone);
const off = (reason) => ({ send: false, to: null, reason, test_mode: isTestMode(r.test_mode) });
const decision = !r.owner_send ? off('Settings > weekly_report_whatsapp is off')
  : !owner ? off('Settings > owner_phone is missing or not a valid mobile number')
    : decideSend({ kind: 'transactional', flag_value: r.owner_sent ? 1 : null, opted_out: false, automation_paused: false, patient_phone: owner, test_mode: r.test_mode, test_phone, now_ms: Date.now() });
const params = { clinic_name: r.clinic_name || 'the clinic', week: r.window.label, summary: r.headline, action: r.top_action };
return {
  json: {
    grist_base_url: r.grist_base_url, doc_id: r.doc_id, wa_phone_number_id: r.wa_phone_number_id, week: r.window.label,
    audience: 'staff', source_workflow: 'W9-weekly-report', template: 'weekly_owner_report', template_params: params,
    message_text: `Weekly report ${params.week} for ${params.clinic_name}: ${params.summary}. Next: ${params.action}`,
    decision, send: decision.send,
  },
};
