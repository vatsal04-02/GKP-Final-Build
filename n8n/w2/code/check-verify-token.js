// Meta webhook verification (GET). Meta sends hub.mode, hub.verify_token and hub.challenge as query parameters.
// The expected token comes from the "W2 – Verify Config" node (a placeholder you fill in); it is never written in this code
// and it is NOT copied into this node's output.
const q = $json.query || {};
const pick = (k) => {
  const v = q['hub.' + k] !== undefined ? q['hub.' + k] : (q.hub && q.hub[k]);   // n8n keeps "hub.mode" as one key; a nested hub{} is handled too
  return Array.isArray(v) ? String(v[0]) : (v === undefined || v === null ? '' : String(v));
};
const mode = pick('mode');
const sent = pick('verify_token');
const challenge = pick('challenge');
const want = String($json.meta_verify_token || '');
const PLACEHOLDER = 'PASTE_META_WEBHOOK_VERIFY_TOKEN';
const same = (a, b) => {                                  // compares every character, so the time taken does not reveal how much matched
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

let ok = false;
let status = 403;
let reason = '';
if (!want || want === PLACEHOLDER) reason = 'verify token is not configured (fill it in the "W2 – Verify Config" node)';
else if (mode !== 'subscribe') reason = 'hub.mode is not "subscribe"';
else if (!same(sent, want)) reason = 'verify token does not match';
else if (!/^[0-9A-Za-z_.~-]{1,128}$/.test(challenge)) { reason = 'hub.challenge is missing or malformed'; status = 400; }
else ok = true;

return { json: { ok, status_code: ok ? 200 : status, challenge: ok ? challenge : '', reason } };
