// Staff alert for a brand-new lead: the PAYLOAD only. W2 sends nothing and does not call W12 (the one WhatsApp sender).
// decision.send is false on purpose, so even if this item is wired to W12 by mistake nothing is sent. After the merge, a guard node
// must fill decision (owner phone from Settings, TEST_MODE / TEST_PHONE, quiet hours) exactly like W3 does, then call W12.
const ctx = $('W2 – Message Saved').item.json;
const saved = ctx.message_row_id > 0;
let staff_alert = null;
if (ctx.lead_created === true) {
  const name = ctx.sender_name || ctx.default_lead_name || 'WhatsApp Lead';
  const quote = ctx.enquiry_text ? ` - "${ctx.enquiry_text.replace(/\s+/g, ' ').slice(0, 200)}"` : '';
  staff_alert = {
    prepared: true,
    audience: 'staff',
    source_workflow: 'W2-WhatsApp-Inbound',
    template: 'new_lead_staff_alert',                                  // W12's WA_TEMPLATES: clinic_name, lead_name, lead_phone, enquiry
    template_params: { clinic_name: ctx.clinic_name, lead_name: name, lead_phone: ctx.patient_phone, enquiry: ctx.enquiry_text || '' },
    message_text: `New WhatsApp lead (${ctx.clinic_name}): ${name}, ${ctx.patient_phone}${quote}. ${ctx.lead_id}.`,
    wa_phone_number_id: ctx.wa_phone_number_id,
    grist_base_url: ctx.grist_base_url,
    doc_id: ctx.doc_id,
    lead_row_id: ctx.lead_row_id,
    lead_phone: ctx.patient_phone,
    decision: { send: false, to: null, reason: 'W2 standalone: staff alert prepared only, not sent', test_mode: true },
  };
}
return {
  json: {
    ...ctx,
    staff_alert,
    run_outcome: saved ? 'ok' : 'failed',
    run_error: saved ? '' : 'the message insert returned no row id',
  },
};
