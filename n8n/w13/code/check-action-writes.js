// Any appointment write that failed: the reply must not confirm it (W13 – Plan Ready turns the plan into a hand-off).
const errors = $input.all().filter((i) => i.json && i.json.error).map((i) => String(i.json.error.message || i.json.error).slice(0, 200));
return [{ json: { action_errors: errors } }];
