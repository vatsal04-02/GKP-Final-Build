const ctx = $('W2 – Read Duplicate').item.json;
const rec = Array.isArray($json.records) ? $json.records[0] : null;
return {
  json: {
    ...ctx,
    lead_found: !!rec,
    lead_row_id: rec ? rec.id : 0,
    lead_id: rec ? String((rec.fields || {}).Lead_id || `row ${rec.id}`) : '',
    lead_created: false,
  },
};
