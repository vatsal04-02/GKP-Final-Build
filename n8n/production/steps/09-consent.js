// STEP 09 - consent gate, central in W12 (the single sender).
//  * a business-initiated TEMPLATE to a patient needs Consent_WhatsApp = true on the lead (unless TEST_MODE redirects it to the clinic's own test phone);
//    a free-text reply inside the 24 h window (the patient wrote first) does not
//  * the lead is looked up by phone in LEADS; unreadable / missing lead / no consent = not sent ("blocked"), the caller may try again later
//  * W2 records consent for a patient who starts the chat (Consent_Source whatsapp-inbound), unless FLOWHQ_W2_IMPLIED_CONSENT=false
const GRIST = { httpHeaderAuth: { id: 'FhqCredGrist0001', name: 'FlowHQ Grist API' } };

module.exports = {
  id: '09-consent',
  title: 'Consent gate in W12; consent recorded for inbound WhatsApp leads',
  run(ctx) {
    ctx.editCode('W12 – Prepare request', [{
      find: '  return { json: { input, cfg, prep: { ...prep, idem_key } } };',
      replace: `  // PRODUCTION consent gate: business-initiated templates to a patient need Consent_WhatsApp on the lead (a TEST_MODE send goes to the clinic's own phone: no check)
  const needs_consent = prep.call_meta === true && input.audience === 'patient' && input.message_type !== 'text' && !((input.decision || {}).test_mode === true);
  const consent_phone = normalizeIndianPhone(input.lead_phone || input.patient_phone).phone || '';
  return { json: { input, cfg, prep: { ...prep, idem_key, needs_consent, consent_phone } } };`,
    }]);
    const base = ctx.node('W12 – Call Meta?').position;
    const at = (i) => [base[0] + 224 * i, base[1] + 80];
    const URL = "={{ $('W12 – Prepare request').first().json.input.grist_base_url }}/api/docs/{{ $('W12 – Prepare request').first().json.input.doc_id }}/tables/LEADS/records";
    ctx.ifNode('W12 – Consent needed?', '={{ $json.prep.needs_consent === true }}', at(0));
    ctx.httpGrist('W12 – Lead consent', 'GET', URL, at(1), { sendQuery: true, queryParameters: { parameters: [{ name: 'filter', value: "={{ JSON.stringify({ Phone: [$json.prep.consent_phone] }) }}" }, { name: 'limit', value: '5' }] } });
    ctx.codeNode('W12 – Consent decide', `// W12 CONSENT GATE: a business-initiated template to a patient needs Consent_WhatsApp = true on the lead (found by phone) and no Opted_Out.
// Not readable / no such lead / no consent = NOT sent ("blocked"; nothing is claimed in the ledger, the caller may try again later).
const p = $('W12 – Prepare request').first().json;
const stop = (why) => ({ json: { ...p, early: { send_status: 'blocked', send_error: why, ledger_status: '' } } });
if (!p.prep.consent_phone) return stop('consent check: the lead phone number is missing or invalid; nothing was sent');
if (!Array.isArray($json.records)) return stop(\`consent check: could not read the lead in Grist (\${String(($json.error && ($json.error.message || $json.error)) || 'no answer').replace(/\\s+/g, ' ').slice(0, 150)}); nothing was sent\`);
const lead = $json.records.find((r) => r && r.fields);
if (!lead) return stop('consent check: no lead with this phone number in LEADS; nothing was sent');
if (lead.fields.Opted_Out === true) return stop('the lead has opted out; nothing was sent');
if (lead.fields.Consent_WhatsApp !== true) return stop('no WhatsApp consent on file for this lead (LEADS.Consent_WhatsApp); a business-initiated template was not sent');
return { json: { ...p, consent_ok: true } };
`, at(2));
    ctx.ifNode('W12 – Consent stop?', '={{ !!$json.early }}', at(3));
    // Call Meta?(true) -> Consent needed? -> [true: lead consent -> decide -> stop? -> (false) Ledger lookup | (true) Return result] [false: Ledger lookup]
    ctx.setOutputs('W12 – Call Meta?', [['W12 – Consent needed?'], ['W12 – Return result']]);
    ctx.setOutputs('W12 – Consent needed?', [['W12 – Lead consent'], ['W12 – Ledger lookup']]);
    ctx.setOutputs('W12 – Lead consent', [['W12 – Consent decide']]);
    ctx.setOutputs('W12 – Consent decide', [['W12 – Consent stop?']]);
    ctx.setOutputs('W12 – Consent stop?', [['W12 – Return result'], ['W12 – Ledger lookup']]);
    ctx.editCode('W12 – Return result', [{ find: "from('W12 – Ledger winner') || from('W12 – Ledger decide') || {}", replace: "from('W12 – Ledger winner') || from('W12 – Ledger decide') || from('W12 – Consent decide') || {}" }]);
    ctx.log('09', 'W12: consent gate (Consent needed? / Lead consent / Consent decide / Consent stop?): a business-initiated template to a patient is sent only when LEADS.Consent_WhatsApp is true and Opted_Out is not (TEST_MODE sends and free-text replies in the 24 h window are exempt)');

    // ---- W2: a patient who starts the chat has consented to be answered / contacted about the enquiry
    ctx.setValue('W2 – Config', 'implied_consent', "={{ $env.FLOWHQ_W2_IMPLIED_CONSENT !== 'false' }}", 'boolean');
    ctx.editCode('W2 – Build New Lead', [{
      find: "  Status: 'New',\n};\nif (ctx.enquiry_text)",
      replace: "  Status: 'New',\n  Consent_WhatsApp: ctx.implied_consent !== false,                        // the patient started the chat\n  Consent_Source: ctx.implied_consent !== false ? 'whatsapp-inbound' : '',\n  Consent_At: ctx.implied_consent !== false ? Math.floor(now / 1000) : null,\n};\nif (ctx.enquiry_text)",
    }]);
    ctx.log('09', 'W2 – Build New Lead: a lead created by an inbound WhatsApp message carries Consent_WhatsApp=true / Consent_Source=whatsapp-inbound (FLOWHQ_W2_IMPLIED_CONSENT=false turns this off)');
  },
};
