// Reminder consent: the rules, pure and tested. Consent is about ONE thing: may we send automated WhatsApp appointment / follow-up REMINDERS to this phone.
//   * Unknown is the default and suppresses reminders. Nothing ever turns Unknown into Yes except an explicit, evidenced action by a permitted person.
//   * No always suppresses. An opt-out always suppresses. Both beat any earlier Yes.
//   * A patient messaging the clinic first, and the website tick-box, are NOT reminder consent (owner decision D2 / D4): they never count here.
// The same effective rule exists for n8n in n8n/snippets/reminder-consent.js (a test keeps the two identical).
import { validDate } from '../records/ids';
import { CONSENT_SOURCES } from './schema';

export type ConsentValue = 'Yes' | 'No' | 'Unknown';
export type ConsentKind = 'recorded' | 'corrected' | 'revoked';
export interface ConsentInput { phone: string; value: ConsentValue; source: string; evidenceRef?: string; evidenceDate?: string | null; formVersion?: string; note?: string; patientId?: string }
export interface Problem { code: string; message: string }

// A signed form or an import is only evidence if its wording was reviewed and approved (Booking_Config approved_consent_forms). None is approved yet.
const NEEDS_FORM = new Set(['Signed registration form', 'Imported with evidence']);
export const parseApprovedForms = (v: unknown): string[] => String(v ?? '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);

export function validateConsent(i: ConsentInput, ctx: { kind: ConsentKind; approvedForms: string[]; today: string }): Problem | null {
  const bad = (code: string, message: string): Problem => ({ code, message });
  if (!['Yes', 'No', 'Unknown'].includes(i.value)) return bad('invalid_consent', 'The answer must be Yes, No or Unknown');
  if (!CONSENT_SOURCES.includes(i.source)) return bad('invalid_source', 'Choose where this answer came from');
  const ref = (i.evidenceRef || '').trim(); const note = (i.note || '').trim();
  if (ref.length > 120 || note.length > 300) return bad('too_long', 'The evidence reference (120) or note (300) is too long');
  if (ctx.kind === 'recorded' && i.value === 'Unknown') return bad('invalid_consent', 'Unknown is the default: it cannot be recorded. Only an admin can reset an answer to Unknown, as a correction');
  if (ctx.kind !== 'recorded' && note.length < 5) return bad('note_required', 'A correction or revocation needs a note saying why (at least 5 characters)');
  if (i.value === 'Yes') {
    if (i.source === 'Patient withdrew') return bad('invalid_source', 'A withdrawal cannot be the source of a Yes');
    if (!ref) return bad('evidence_required', 'A Yes needs an evidence reference (for example the register serial, the form id or the call note)');
    if (i.evidenceDate && (!validDate(i.evidenceDate) || i.evidenceDate > ctx.today)) return bad('invalid_date', 'The evidence date must be a real date that is not in the future');
    if (NEEDS_FORM.has(i.source)) {
      if (!i.evidenceDate) return bad('evidence_date_required', 'A signed form needs the signature date');
      const v = (i.formVersion || '').trim();
      if (!v) return bad('form_version_required', 'A signed form needs its form version');
      if (!ctx.approvedForms.some((a) => a.toLowerCase() === v.toLowerCase())) return bad('form_not_approved', `Form version "${v}" is not approved as reminder consent. An admin must approve the form wording first (none is approved yet)`);
    }
  }
  return null;
}

export interface EffectiveConsent { value: ConsentValue; allowed: boolean; reason: 'opted_out' | 'consent_no' | 'consent_yes' | 'consent_unknown' }
/** May automated reminders go to this phone? `row` is its Reminder_Consent value (or null = Unknown); `optedOut` = any lead with this phone has Opted_Out. */
export function effectiveConsent(row: { value: string } | null, optedOut: boolean): EffectiveConsent {
  if (optedOut) return { value: 'No', allowed: false, reason: 'opted_out' };
  const v = row?.value;
  if (v === 'No') return { value: 'No', allowed: false, reason: 'consent_no' };
  if (v === 'Yes') return { value: 'Yes', allowed: true, reason: 'consent_yes' };
  return { value: 'Unknown', allowed: false, reason: 'consent_unknown' };   // anything else, including a blank or a typo: Unknown
}
