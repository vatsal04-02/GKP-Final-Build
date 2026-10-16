// One item per message for W12, or one "none" item so the run always reaches W13 – Record Sends.
// A dry run (manual test) sends nothing: it only reports what it would send.
const dry = $('W13 – Build Context').first().json.x.dry_run;
const items = $json.send_items || [];
if (dry || !items.length) return [{ json: { w13_kind: 'none', would_send: dry ? items : [] } }];
return items.map((i) => ({ json: i }));
