// Same race guard as for leads: after creating, the lowest conversation row id for this phone is the one everybody uses.
const ctx = $('W2 – Read Conversation').item.json;
const made = $('W2 – Create Conversation').item.json;
const madeId = made && Array.isArray(made.records) && made.records[0] ? Number(made.records[0].id) : 0;
const rows = (Array.isArray($json.records) ? $json.records : []).filter((r) => r && Number.isInteger(r.id)).sort((a, b) => a.id - b.id);
const conv = rows[0] || (madeId ? { id: madeId, fields: {} } : null);
const f = conv ? conv.fields || {} : {};
const race = !!conv && madeId > 0 && conv.id !== madeId;
const notes = Array.isArray(ctx.race_notes) ? ctx.race_notes.slice() : [];
if (race) notes.push(`parallel messages created conversation row ${madeId} as a duplicate of row ${conv.id}; row ${conv.id} is used (row ${madeId} can be deleted)`);
return {
  json: {
    ...ctx,
    conversation_found: false,
    conversation_id: conv ? conv.id : 0,
    conversation_created: !!conv && !race,
    conv_unread: Number(f.Unread) || 0,
    conv_last_inbound: Number(f.Last_Inbound_At) || 0,
    race_notes: notes,
    run_outcome: conv ? '' : 'failed',
    run_error: conv ? '' : 'the conversation was not found after it was created; message not stored',
  },
};
