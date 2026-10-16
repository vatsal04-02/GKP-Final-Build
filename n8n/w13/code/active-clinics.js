// 08:05 IST: every active clinic with a Grist doc and a WhatsApp number (messages deferred overnight are answered now).
const cfg = $('W13 – Config').first().json;
const txt = (v) => String(v === undefined || v === null ? '' : v).trim();
return ($json.records || [])
  .filter((r) => r && r.fields && txt(r.fields.Active).toUpperCase() === 'TRUE' && txt(r.fields.Grist_Doc_ID) && txt(r.fields.WA_Phone_Number_ID))
  .map((r) => ({ json: { grist_base_url: cfg.grist_base_url, doc_id: txt(r.fields.Grist_Doc_ID), wa_phone_number_id: txt(r.fields.WA_Phone_Number_ID), clinic_slug: txt(r.fields.Clinic_Slug) } }));
