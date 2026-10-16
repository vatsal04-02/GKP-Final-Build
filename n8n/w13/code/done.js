// The run's result (what a caller such as the manual test gets back). A failed CRM write stops with an error so the error
// workflow (W11) alerts: the message row may still say "processing".
const report = $('W13 – Record Sends').first().json.report;
const p = $('W13 – Plan').first().json;
const failed = $input.all().filter((i) => i.json && i.json.error).map((i) => String(i.json.error.message || i.json.error).slice(0, 200));
if (failed.length) throw new Error(`W13: ${failed.length} Grist write(s) failed (${report.status}): ${failed[0]}`);
const would = ($('W13 – Split Sends').first().json.would_send || []).map((s) => ({ kind: s.w13_kind, send: !!(s.decision && s.decision.send), to: (s.decision && s.decision.to) || null, text: s.text_body || s.message_text }));
return [{ json: { ...report, decision: p.decision, ai_error: p.ai_error, usage: p.usage, would_send: would } }];
