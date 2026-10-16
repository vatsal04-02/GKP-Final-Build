const ctx = $('W2 – Lead Ready').item.json;
const rows = (Array.isArray($json.records) ? $json.records : []).filter((r) => r && Number.isInteger(r.id)).sort((a, b) => a.id - b.id);
const conv = rows[0] || null;                                           // several rows for one phone: the oldest wins
const f = conv ? conv.fields || {} : {};
return {
  json: {
    ...ctx,
    conversation_found: !!conv,
    conversation_id: conv ? conv.id : 0,
    conversation_created: false,
    conv_unread: Number(f.Unread) || 0,
    conv_last_inbound: Number(f.Last_Inbound_At) || 0,
  },
};
