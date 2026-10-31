// "Will this appointment get an automatic reminder, and if not, why?" for the staff drawer. A read-only mirror of the decision W5 takes
// (n8n/final/tools/4c/w5-find-due.body.js): same order of checks, same consent rule (consent.ts = reminder-consent.js). It decides nothing: W5 does. If the two ever
// disagree W5 wins, so the wording says "will be" only for what W5 would accept, and a test (booking-reminders.test.ts) walks the same cases as the n8n tests.
import { effectiveConsent } from './consent';

export type ReminderState = 'will_send' | 'held' | 'not_applicable';
export interface ReminderOutlook {
  state: ReminderState;
  /** plain-language reasons, most important first (empty when the reminder will be sent) */
  reasons: string[];
  /** machine codes for the same reasons: pending_confirmation, no_contact, opted_out, consent_no, consent_unknown, consent_unreadable, not_booked, already_started */
  codes: string[];
  r24_sent_at: string | null;
  r2_sent_at: string | null;
}

export interface ReminderInput {
  /** Appointments.Status (Booked / Rescheduled / Cancelled / Completed / No-show) */
  status: string;
  /** Appointments.Appt_Stage (Pending confirmation / Confirmed / Checked in / blank) */
  stage: string;
  startSec: number;
  nowSec: number;
  r24Sent: number | null;
  r2Sent: number | null;
  /** the +91 phone W5 would use (lead, else the appointment's own, else the register patient); '' = none */
  phone: string;
  /** the Reminder_Consent value for that phone ('Yes' / 'No' / '' = no row); null = the table could not be read */
  consent: string | null;
  optedOut: boolean;
}

const iso = (sec: number | null) => (typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString() : null);

export function reminderOutlook(i: ReminderInput): ReminderOutlook {
  const base = { r24_sent_at: iso(i.r24Sent), r2_sent_at: iso(i.r2Sent) };
  const out = (state: ReminderState, codes: string[], reasons: string[]): ReminderOutlook => ({ state, codes, reasons, ...base });
  if (i.status !== 'Booked') return out('not_applicable', ['not_booked'], [`Reminders are only sent for booked appointments (this one is ${(i.status || 'unknown').toLowerCase()}).`]);
  if (!(i.startSec > i.nowSec)) return out('not_applicable', ['already_started'], ['This appointment has already started.']);
  const codes: string[] = []; const reasons: string[] = [];
  if (i.stage === 'Pending confirmation') { codes.push('pending_confirmation'); reasons.push('Pending confirmation: reminders start after staff confirm the appointment.'); }
  if (!i.phone) { codes.push('no_contact'); reasons.push('No valid phone number on the lead, the appointment or the patient record.'); }
  else {
    const eff = effectiveConsent(i.consent === null ? null : i.consent ? { value: i.consent } : null, i.optedOut);
    if (!eff.allowed) {
      if (i.consent === null && !i.optedOut) { codes.push('consent_unreadable'); reasons.push('Reminder consent could not be read, so no reminder is sent.'); }
      else {
        codes.push(eff.reason);
        reasons.push({ opted_out: 'The patient has opted out of WhatsApp messages.', consent_no: 'The patient said No to reminders.', consent_unknown: 'No reminder consent is recorded for this number (a patient messaging first or the website tick-box does not count).', consent_yes: '' }[eff.reason as 'opted_out' | 'consent_no' | 'consent_unknown' | 'consent_yes']);
      }
    }
  }
  return codes.length ? out('held', codes, reasons) : out('will_send', [], []);
}
