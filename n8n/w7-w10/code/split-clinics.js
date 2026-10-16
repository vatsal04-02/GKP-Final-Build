// Every active clinic of the Agency Registry (never a hard-coded clinic), one item each.
const cfg = $('%S% – Config').first().json;
const base = String(cfg.grist_base_url || '').replace(/\/+$/, '');
const clinics = ($input.first().json.records || []).filter((r) => r.fields && String(r.fields.Active).toUpperCase() === 'TRUE' && String(r.fields.Grist_Doc_ID || '').trim());
return clinics.map((r) => ({
  json: {
    grist_base_url: base,
    doc_id: String(r.fields.Grist_Doc_ID).trim(),
    clinic_slug: String(r.fields.Clinic_Slug || ''),
    registry_clinic_name: String(r.fields.Clinic_Name || ''),
    wa_phone_number_id: String(r.fields.WA_Phone_Number_ID || '').trim(),
  },
  pairedItem: { item: 0 },
}));
