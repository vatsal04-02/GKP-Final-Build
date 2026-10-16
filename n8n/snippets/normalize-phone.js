// n8n Code node ("Run Once for Each Item"): normalise an Indian phone number to +91XXXXXXXXXX.
// Paste the function + the bottom block into a Code node placed right after the form/WhatsApp webhook.
// Input field: $json.phone (change PHONE_FIELD if your form uses another name).

function normalizeIndianPhone(raw) {
  if (raw === null || raw === undefined) return { phone: null, valid: false };
  let digits = String(raw).replace(/\D/g, '');          // keep digits only
  if (digits.startsWith('0091')) digits = digits.slice(4);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  const valid = /^[6-9]\d{9}$/.test(digits);            // Indian mobiles start 6-9
  return { phone: valid ? `+91${digits}` : null, valid };
}

// ---- n8n Code node body (uncomment inside n8n) ----
// const PHONE_FIELD = 'phone';
// const { phone, valid } = normalizeIndianPhone($json[PHONE_FIELD]);
// return { json: { ...$json, phone, phone_valid: valid } };

if (typeof module !== 'undefined') module.exports = { normalizeIndianPhone };
