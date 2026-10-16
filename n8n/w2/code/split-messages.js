// One item per inbound message (Meta may batch several in one webhook). The next node processes them ONE AT A TIME,
// so two messages from the same new patient can never create two leads, and Lead_ids stay unique inside a batch.
const out = [];
$input.all().forEach((item, i) => {
  const { events, rejected, statuses_seen, http_status, response_body, reject_reason, kind, ...ctx } = item.json;
  for (const ev of events || []) out.push({ json: { ...ctx, ...ev }, pairedItem: { item: i } });
});
return out;
