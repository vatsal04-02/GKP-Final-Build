// Shared by the booking form (browser) and the enquiry API (server): one list of choices and one set of rules, so the two cannot drift.
// Pure functions, no DOM, no network. Plain .mjs so `node --test` can load it.

export const CONCERNS = [
  'Back Pain',
  'Neck Pain',
  'Shoulder Pain / Frozen Shoulder',
  'Knee Pain / Arthritis',
  'Hip Pain',
  'Sciatica',
  'Slip Disc',
  'Sports Injuries',
  'Post-Surgical Rehabilitation',
  'Other',
];
export const VISITS = ['At the clinic', 'Home visit'];
export const SLOTS = ['Morning 9 AM–1 PM', 'Evening 4–8 PM'];
const DAY_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}$/;

/** Which wording of the WhatsApp-consent checkbox the visitor saw. DRAFT until the clinic approves the text (see PRIVACY_DRAFT.md). */
export const CONSENT_VERSION = 'DRAFT-2026-10-v1';

const noControl = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
export const oneLine = (v, max) => noControl(v).replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * A 10-digit Indian mobile (starts 6-9) from what a person typed or pasted: "98386 81421", "+91 98386 81421", "098386 81421".
 * Never invents or pads digits: anything that does not come out as exactly 10 valid digits is null.
 */
export function normalizeMobile10(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** The text stored in the CRM's existing Enquiry column (there are no separate columns for these fields). */
export function composeEnquiry({ concern, visit, day, slot }) {
  const parts = [];
  if (concern) parts.push(`Concern: ${concern}`);
  if (visit) parts.push(`Visit: ${visit}`);
  const when = [day, slot].filter(Boolean).join(', ');
  if (when) parts.push(`Preferred: ${when}`);
  return parts.join(' · ').slice(0, 1000);
}

/**
 * Validates one enquiry (browser object or request body). Required: name, phone. Everything else is optional, but when it is
 * given it must be one of the offered choices. Returns { ok: true, value } or { ok: false, errors: { field: code } }.
 */
export function validateEnquiry(input) {
  const errors = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: { body: 'invalid_body' } };
  const name = oneLine(input.name, 60);
  if (!name) errors.name = 'required';
  const mobile = normalizeMobile10(input.phone);
  if (!mobile) errors.phone = String(input.phone ?? '').trim() ? 'invalid' : 'required';
  const pick = (field, list) => {
    const v = oneLine(input[field], 60);
    if (!v) return '';
    if (!list.includes(v)) { errors[field] = 'invalid'; return ''; }
    return v;
  };
  const concern = pick('concern', CONCERNS);
  const visit = pick('visit', VISITS);
  const slot = pick('slot', SLOTS);
  let day = oneLine(input.day, 10);
  if (day && !DAY_RE.test(day)) { errors.day = 'invalid'; day = ''; }
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name, mobile, concern, visit, day, slot,
      consent_whatsapp: input.consent_whatsapp === true || input.consent_whatsapp === 'true' || input.consent_whatsapp === 'on',
      request_id: /^[A-Za-z0-9-]{8,64}$/.test(String(input.request_id ?? '')) ? String(input.request_id) : '',
      page_url: oneLine(input.page_url, 500),
      utm_campaign: oneLine(input.utm_campaign, 100),
      honeypot: oneLine(input.website, 200),
    },
  };
}
