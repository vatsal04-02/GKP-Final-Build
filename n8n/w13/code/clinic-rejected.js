// Unknown or inactive clinic: there is no CRM to write to, so W13 stops here (W2 already stored the message).
const c = $json;
return [{ json: { status: 'skipped', reason: c.reason, test_case: $('W13 – Start').first().json.test_case } }];
