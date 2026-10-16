// Public-copy redaction for this repository (it is public): the Meta verify token, the Cal.com webhook secret and the allowlisted
// phone number(s) become placeholders. Used ONLY for the copies committed here; the import file you get keeps your values.
const PH_SECRET = 'PASTE_CAL_WEBHOOK_SECRET_AFTER_IMPORT';
const PH_PHONE = 'PASTE_YOUR_TEST_NUMBER';
const PH_VERIFY = 'PASTE_META_WEBHOOK_VERIFY_TOKEN';
const assignment = (node, key) => (((node || {}).parameters || {}).assignments || { assignments: [] }).assignments.find((a) => a.name === key);
function redact(wf, report = []) {
  const nodes = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const copy = JSON.parse(JSON.stringify(wf));
  const cn = Object.fromEntries(copy.nodes.map((n) => [n.name, n]));
  const secret = assignment(cn['W4 – Config'], 'cal_webhook_secret');
  if (secret && secret.value !== PH_SECRET) { secret.value = PH_SECRET; report.push('W4 – Config > cal_webhook_secret'); }
  const verify = assignment(cn['W2 – Verify Config'], 'meta_verify_token');
  if (verify && verify.value !== PH_VERIFY) { verify.value = PH_VERIFY; report.push('W2 – Verify Config > meta_verify_token'); }
  const allow = assignment(nodes['W12 – Config'], 'w12_allowlist');
  const phones = String(allow ? allow.value : '').split(/[,;]+/).map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 10);
  let text = JSON.stringify(copy);
  for (const ph of phones) {
    const tail = ph.slice(-10);
    const re = new RegExp(`(\\+?91[\\s-]?)?${tail.slice(0, 5)}[\\s-]?${tail.slice(5)}`, 'g');
    const hits = (text.match(re) || []).length;
    if (hits) { text = text.replace(re, PH_PHONE); report.push(`${hits} occurrence(s) of the allowlisted phone number`); }
  }
  return JSON.parse(text);
}
module.exports = { redact, PH_SECRET, PH_PHONE, PH_VERIFY };
