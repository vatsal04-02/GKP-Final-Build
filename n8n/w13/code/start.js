// W13 handles ONE patient message per run: W2 calls it once per message ("Run once for each item"), the manual test and the
// morning retry call it the same way. This node checks that, and keeps only the fields W13 uses.
const items = $input.all();
if (items.length !== 1) throw new Error(`W13 handles one message per run but got ${items.length} items: call it with mode "Run once for each item"`);
const j = items[0].json;
const dry = j.dry_run === true;
return [{
  json: {
    // W13 – Config
    grist_base_url: j.grist_base_url,
    registry_doc_id: j.registry_doc_id,
    leads_table: j.leads_table,
    anthropic_model: j.anthropic_model,
    openrouter_model: j.openrouter_model,
    w12_workflow_id: String(j.w12_workflow_id || '').trim(),
    min_confidence: Number(j.min_confidence),
    confidence_auto: Number(j.confidence_auto),
    confidence_write: Number(j.confidence_write),
    max_ai_replies_per_hour: Number(j.max_ai_replies_per_hour),
    history_limit: Number(j.history_limit),
    slot_days: Number(j.slot_days),
    pause_on_handoff: j.pause_on_handoff === true,
    staff_alert_template: j.staff_alert_template,
    // the message (from W2, the morning retry or a test)
    dry_run: dry,
    w13_retry: j.w13_retry === true,
    wa_phone_number_id: String(j.wa_phone_number_id || '').trim(),
    clinic_slug: String(j.clinic_slug || '').trim(),
    message_row_id: Number(j.message_row_id) || 0,
    wa_message_id: String(j.wa_message_id || '').trim(),
    msg_type: j.msg_type ? String(j.msg_type) : '',
    patient_phone: normalizeIndianPhone(j.patient_phone).phone || '',
    sender_name: String(j.sender_name || '').slice(0, 60),
    text: dry ? String(j.text || '') : '',              // a real run reads the text from the Messages row, never from the caller
    test_case: String(j.test_case || ''),
  },
}];
