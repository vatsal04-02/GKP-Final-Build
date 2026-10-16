// Race guard. Two messages from the same NEW patient can arrive in parallel (two executions), and both would create a lead.
// After creating, look again: whoever sees several leads for this phone uses the LOWEST row id, so both runs end up on the same lead.
// The extra row is left for staff to delete (W2 never deletes) and is named in the Run_Log note.
const ctx = $('W2 – Build New Lead').item.json;
const made = $('W2 – Create Lead').item.json;
const madeId = made && Array.isArray(made.records) && made.records[0] ? Number(made.records[0].id) : 0;
const rows = (Array.isArray($json.records) ? $json.records : []).filter((r) => r && Number.isInteger(r.id)).sort((a, b) => a.id - b.id);
const canon = rows[0] || (madeId ? { id: madeId, fields: { Lead_id: ctx.new_lead_id } } : null);
const race = !!canon && madeId > 0 && canon.id !== madeId;
const notes = Array.isArray(ctx.race_notes) ? ctx.race_notes.slice() : [];
if (race) notes.push(`parallel messages created lead row ${madeId} as a duplicate of row ${canon.id}; row ${canon.id} is used (row ${madeId} can be deleted)`);
return {
  json: {
    ...ctx,
    lead_found: false,
    lead_row_id: canon ? canon.id : 0,
    lead_id: canon ? String((canon.fields || {}).Lead_id || ctx.new_lead_id) : '',
    lead_created: !!canon && !race,
    race_notes: notes,
    run_outcome: canon ? '' : 'failed',
    run_error: canon ? '' : 'the lead was not found after it was created; message not stored',
  },
};
