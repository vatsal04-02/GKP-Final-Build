// The staff replies waiting to go: Messages rows with Direction Out and Send ticked (W10 – Pending), one item each.
const clinics = $('W10 – Split clinics').all();
const out = [];
$input.all().forEach((res, i) => {
  for (const row of res.json.records || []) {
    out.push({ json: { ...clinics[i].json, row, conversation_id: Number((row.fields || {}).Conversation) || 0 }, pairedItem: { item: i } });
  }
});
return out;
