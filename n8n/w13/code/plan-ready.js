// The final plan (a failed appointment write becomes a hand-off) and the messages for W12: the patient's reply (free text in
// the 24-hour window) and / or the staff alert (template). Each carries the send-guard decision (Opted_Out, quiet hours, TEST_MODE).
const b = $('W13 – Build Context').first().json;
const plan = $('W13 – Plan').first().json.plan;
const errs = Array.isArray($json.action_errors) ? $json.action_errors : [];
if (errs.length) aiToHandoff(plan, b.x, b.cfg, `could not save the appointment change in Grist: ${errs[0]}`);
const send_items = aiSendItems(plan, b.x, h);
return [{ json: { plan, send_items } }];
