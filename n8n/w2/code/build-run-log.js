// The one place that turns any outcome (stored, skipped, failed) into a Run_Log row.
// Input is either (a) a full item with run_outcome / run_error, or (b) the error output of a Grist HTTP node ({ error }), in which case the
// message's context is taken from the nearest earlier stage of THIS message. No phone numbers are written: numbers are masked.
const STAGES = ['W2 – Message Saved', 'W2 – Conversation Ready', 'W2 – Read Created Conversation', 'W2 – Read Conversation', 'W2 – Lead Ready',
  'W2 – Read Created Lead', 'W2 – Read Lead', 'W2 – Read Duplicate', 'W2 – Normalize Phone', 'W2 – Resolve Clinic'];
const from = (name) => { try { return $(name).item.json; } catch (e) { return null; } };   // throws when that stage did not run for this message
const isFull = $json && $json.wa_message_id !== undefined;
const loop = from('W2 – Loop Over Messages');
let ctx = null;
let stage = '';
if (isFull) ctx = $json;
else {
  for (const s of STAGES) {
    const c = from(s);
    if (c && (!loop || c.wa_message_id === loop.wa_message_id)) { ctx = c; stage = s.replace('W2 – ', ''); break; }   // same message id = not left over from an earlier loop round
  }
  if (!ctx) ctx = loop || {};
}

const safe = (v, max) => String(v === undefined || v === null ? '' : v).replace(/bearer\s+\S+/gi, 'bearer [hidden]').replace(/\s+/g, ' ').trim().slice(0, max);
const failedHttp = !isFull;
const outcome = failedHttp ? 'failed' : (ctx.run_outcome || 'ok');
let err;
if (failedHttp) {
  const e = $json && $json.error;
  const msg = safe(e && typeof e === 'object' ? (e.message || e.description || JSON.stringify(e)) : e, 300) || 'unknown error';
  err = `Grist request failed${stage ? ` after "${stage}"` : ''}: ${msg}`;
} else if (outcome === 'ok' && Array.isArray(ctx.race_notes) && ctx.race_notes.length) err = ctx.race_notes.join('; ');
else err = ctx.run_error || '';
if (/failed/.test(String(ctx.ai_note || ''))) err = [err, ctx.ai_note].filter(Boolean).join('; ');   // the message is stored; only the AI step failed

const mask = (p) => String(p || '').replace(/\d(?=\d{4})/g, '*');
const id = ctx.wa_message_id || '';
const record = !failedHttp && outcome === 'ok'
  ? `${ctx.lead_id || 'lead'} ${id} (${ctx.lead_created ? 'new lead' : 'existing lead'}, ${ctx.msg_type || 'message'})`
  : `${id} ${mask(ctx.patient_phone || ctx.from)}`.trim();

return {
  json: {
    can_log: !!(ctx.grist_base_url && ctx.doc_id),                      // no clinic resolved = no CRM to log into
    grist_base_url: ctx.grist_base_url,
    doc_id: ctx.doc_id,
    log: { Workflow: 'W2-WhatsApp-Inbound', Record: safe(record, 200), Outcome: outcome, Error: safe(err, 500), At: Math.floor(Date.now() / 1000) },
    outcome,
    wa_message_id: id,
    lead_row_id: ctx.lead_row_id || 0,
    conversation_id: ctx.conversation_id || 0,
    message_row_id: ctx.message_row_id || 0,
    staff_alert: ctx.staff_alert || null,
    ai_handoff: ctx.ai_note || '',
    test_case: ctx.test_case,
  },
};
