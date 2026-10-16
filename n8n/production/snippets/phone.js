// E.164 phone normaliser pasted into every Code node that handles a phone number (replaces the +91-only function; the function name is kept so that
// every call site stays as it was). Accepts: +<country><number>, 00<country><number>, and numbers written locally for the DEFAULT country
// (FLOWHQ_DEFAULT_COUNTRY_CODE, default 91 = India: 10-digit mobile starting 6-9, optional leading 0 or 91). Result: +<digits> (8-15 digits) or null.
// It checks the SHAPE only. Whether a number can receive WhatsApp is up to Meta (error 131026 etc.), whether we may write to it up to W12.
function normalizeIndianPhone(raw) {
  if (raw === null || raw === undefined) return { phone: null, valid: false };
  const s = String(raw).trim();
  const cc = (typeof $env !== 'undefined' && $env && /^[1-9]\d{0,2}$/.test(String($env.FLOWHQ_DEFAULT_COUNTRY_CODE || ''))) ? String($env.FLOWHQ_DEFAULT_COUNTRY_CODE) : '91';
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('00')) digits = digits.slice(2);
  else if (!s.startsWith('+')) {                                  // written locally
    if (cc === '91') { if (!(digits.length === 12 && digits.startsWith('91'))) { if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1); digits = `91${digits}`; } }
    else digits = `${cc}${digits.replace(/^0+/, '')}`;
  }
  let valid = /^[1-9]\d{7,14}$/.test(digits);
  if (valid && digits.startsWith('91')) valid = /^91[6-9]\d{9}$/.test(digits);   // +91 numbers are Indian mobiles
  return { phone: valid ? `+${digits}` : null, valid };
}
