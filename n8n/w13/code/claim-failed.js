// The message could not be marked "processing" in Grist: do not ask the AI or send anything (W13 – Plan makes this a failure).
const e = $json.error;
return [{ json: { claim_error: String((e && (e.message || e.description)) || e || 'unknown error').slice(0, 200) } }];
