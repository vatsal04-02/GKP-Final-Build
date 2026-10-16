// W13 was started for this message (it runs on its own; W2 does not wait for it). If starting it failed (wrong ai_workflow_id,
// W13 not saved), the message is still stored: the reason goes to Run_Log and nothing else changes.
const ctx = $('W2 – Prepare Staff Alert').item.json;
const e = $json && $json.error;
return { json: { ...ctx, ai_note: e ? `AI hand-off failed: ${String(e.message || e).replace(/\s+/g, ' ').slice(0, 200)}` : 'AI hand-off started' } };
