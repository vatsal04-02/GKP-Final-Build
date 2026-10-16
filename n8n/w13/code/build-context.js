// Everything W13 knows about this message (aiContext): clinic Settings and Knowledge, the message, conversation, lead, recent
// history, free slots and the patient's appointments. Then the gates: only gate.route = 'ai' asks Claude.
const g = (name) => $(name).first().json;
const st = g('W13 – Start');
const cfg = {
  model: st.anthropic_model, leads_table: st.leads_table, min_confidence: st.min_confidence, confidence_auto: st.confidence_auto,
  confidence_write: st.confidence_write, max_ai_replies_per_hour: st.max_ai_replies_per_hour,
  history_limit: st.history_limit, slot_days: st.slot_days, pause_on_handoff: st.pause_on_handoff, staff_alert_template: st.staff_alert_template,
};
const raw = {
  start: st, clinic: g('W13 – Resolve Clinic'), settings: g('W13 – Settings'), knowledge: g('W13 – Knowledge'), message: g('W13 – Message'),
  conversation: g('W13 – Conversation'), lead: g('W13 – Lead'), history: g('W13 – History'), appointments: g('W13 – Appointments'),
};
const t0 = Date.now();
const { x, gate } = aiContext(raw, cfg, t0, h);
return [{ json: { x, gate, cfg, t0, request: gate.route === 'ai' ? aiBuildRequest(x, cfg) : null } }];
