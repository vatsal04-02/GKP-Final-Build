// phone_number_id -> clinic. The Agency Registry table Clinics is small, so it is read whole and matched here as TEXT
// (a Grist column holding the id as a number or as text both work). Active may come back as true or the string "TRUE".
const ctx = $('W2 – Loop Over Messages').item.json;
const rows = Array.isArray($json.records) ? $json.records : [];
const want = String(ctx.phone_number_id || '').trim();
const rec = rows.find((r) => r && r.fields && String(r.fields.WA_Phone_Number_ID === undefined || r.fields.WA_Phone_Number_ID === null ? '' : r.fields.WA_Phone_Number_ID).trim() === want);
const f = rec ? rec.fields : {};
const active = !!rec && String(f.Active).toUpperCase() === 'TRUE';
const doc = rec ? String(f.Grist_Doc_ID || '').trim() : '';
let reason = '';
if (!want) reason = 'no phone_number_id';
else if (!rec) reason = 'unknown phone_number_id';
else if (!active) reason = 'clinic is not active';
else if (!doc) reason = 'clinic has no Grist_Doc_ID';
return {
  json: {
    ...ctx,
    clinic_found: reason === '',
    clinic_reject_reason: reason,
    clinic_slug: rec ? String(f.Clinic_Slug || '') : '',
    clinic_name: rec ? String(f.Clinic_Name || '') : '',
    doc_id: reason === '' ? doc : '',
    wa_phone_number_id: want,
  },
};
