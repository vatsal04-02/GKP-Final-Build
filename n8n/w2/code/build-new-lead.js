// Same Lead_id rule as W1: L-YYYYMMDD-NNNN (IST date, next free number of the day, read from the 200 newest leads).
const ctx = $('W2 – Read Lead').item.json;
const now = Date.now();
const ymd = new Date(now + 5.5 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');   // IST date
const prefix = `L-${ymd}-`;
let max = 0;
for (const r of $json.records || []) {
  const id = String((r.fields || {}).Lead_id || '');
  if (id.startsWith(prefix)) max = Math.max(max, parseInt(id.slice(prefix.length), 10) || 0);
}
const lead_id = prefix + String(max + 1).padStart(4, '0');
const fields = {
  Lead_id: lead_id,
  Created_At: Math.floor(now / 1000),                                   // Grist DateTime = epoch seconds
  Name: ctx.sender_name || ctx.default_lead_name || 'WhatsApp Lead',
  Phone: ctx.patient_phone,
  Source: 'WhatsApp',
  Status: 'New',
};
if (ctx.enquiry_text) fields.Enquiry = ctx.enquiry_text;                // only when the patient wrote text
return { json: { ...ctx, new_lead_id: lead_id, create: { records: [{ fields }] } } };
