// The Messages row exists. Work out the conversation update: Last_Inbound_At never moves backwards (messages can arrive out of order),
// Unread counts up by one (grist/schema.md: Integer) - or becomes true when unread_mode is 'flag' (a Toggle column).
// This runs only for a NEW WA_Message_ID (duplicates stop earlier), so Unread can never be counted twice for one message.
const ctx = $('W2 – Conversation Ready').item.json;
const rec = Array.isArray($json.records) ? $json.records[0] : null;
const unread = ctx.unread_mode === 'flag' ? true : (Number(ctx.conv_unread) || 0) + 1;
const lastInbound = Math.max(Number(ctx.conv_last_inbound) || 0, ctx.msg_timestamp);
return {
  json: {
    ...ctx,
    message_row_id: rec ? Number(rec.id) || 0 : 0,
    conv_update: { records: [{ id: ctx.conversation_id, fields: { Lead: ctx.lead_row_id, Last_Inbound_At: lastInbound, Unread: unread } }] },
  },
};
