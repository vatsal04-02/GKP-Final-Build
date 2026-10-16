// Which conversation: the one the message row points at; a dry run (no row) looks it up by the patient's phone.
const st = $('W13 – Start').first().json;
const msg = (Array.isArray($json.records) ? $json.records : [])[0];
const conv = msg && msg.fields && Number(msg.fields.Conversation) > 0 ? Number(msg.fields.Conversation) : 0;
return [{ json: { conversation_filter: conv ? { id: [conv] } : { Phone: [st.patient_phone || '-'] } } }];
