// Which lead: the one the conversation points at, else the lead with the patient's phone (W2 makes one lead per phone; the
// lowest row id wins if there are more). Also the conversation row id for the history read.
const st = $('W13 – Start').first().json;
const convs = (Array.isArray($json.records) ? $json.records : []).filter((r) => r && r.fields).sort((a, b) => a.id - b.id);
const conv = convs[0];
const leadId = conv && Number(conv.fields.Lead) > 0 ? Number(conv.fields.Lead) : 0;
const phone = (conv && conv.fields.Phone) || st.patient_phone || '-';
return [{ json: { lead_filter: leadId ? { id: [leadId] } : { Phone: [phone] }, conversation_id: conv ? conv.id : 0 } }];
