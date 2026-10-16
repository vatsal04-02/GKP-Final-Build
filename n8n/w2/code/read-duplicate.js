// Has this WA_Message_ID been stored before? Meta retries deliveries, so the same id can arrive twice.
const ctx = $('W2 – Normalize Phone').item.json;
const rows = Array.isArray($json.records) ? $json.records : [];
const dup = rows.length > 0;
return {
  json: {
    ...ctx,
    is_duplicate: dup,
    run_outcome: dup ? 'skipped' : '',
    run_error: dup ? `duplicate WA_Message_ID (Messages row ${rows[0].id}); nothing was created` : '',
  },
};
