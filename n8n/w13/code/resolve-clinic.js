// The clinic, from the Agency Registry (CLAUDE.md "Clinic lookup"): by WhatsApp phone_number_id (W2, retries), or by
// Clinic_Slug (tests). Active must be TRUE and the clinic must have a Grist doc. Nothing is hard-coded.
const st = $('W13 – Start').first().json;
const rows = Array.isArray($json.records) ? $json.records : [];
const txt = (v) => String(v === undefined || v === null ? '' : v).trim();
const rec = st.wa_phone_number_id
  ? rows.find((r) => r && r.fields && txt(r.fields.WA_Phone_Number_ID) === st.wa_phone_number_id)
  : rows.find((r) => r && r.fields && st.clinic_slug && txt(r.fields.Clinic_Slug) === st.clinic_slug);
const f = rec ? rec.fields : {};
let reason = '';
if ($json.error) reason = `Agency Registry not readable: ${txt($json.error.message || $json.error).slice(0, 200)}`;
else if (!st.wa_phone_number_id && !st.clinic_slug) reason = 'no wa_phone_number_id or clinic_slug in the input';
else if (!rec) reason = 'clinic not found in the Agency Registry';
else if (txt(f.Active).toUpperCase() !== 'TRUE') reason = 'clinic is not active';
else if (!txt(f.Grist_Doc_ID)) reason = 'clinic has no Grist_Doc_ID';
return [{
  json: {
    clinic_ok: reason === '',
    reason,
    grist_base_url: st.grist_base_url,
    doc_id: reason ? '' : txt(f.Grist_Doc_ID),
    clinic_name: txt(f.Clinic_Name),
    clinic_slug: txt(f.Clinic_Slug),
    wa_phone_number_id: txt(f.WA_Phone_Number_ID),
  },
}];
