// Small pure helpers behind the dashboard (kept apart from the components so they are tested without a browser).
// Nothing here invents a number: every function only re-orders, re-labels or guards values the server already sent.
import type { DoctorSummary } from '@core/clinical';

type FollowUp = DoctorSummary['followUps'][number];

// Follow-ups to call: the most overdue first, then today, then the ones coming up; ties by date, then name. The server already sends
// them by date; this makes the priority explicit and stable.
export function sortFollowUps(list: FollowUp[]): FollowUp[] {
  return [...list].sort((a, b) => b.overdueDays - a.overdueDays || (a.followUpOn < b.followUpOn ? -1 : a.followUpOn > b.followUpOn ? 1 : 0) || a.name.localeCompare(b.name));
}

// "3 days overdue" / "Due today" / "Due in 2 days" / the date, from the server's own overdueDays and dates.
export function dueLabel(f: Pick<FollowUp, 'overdueDays' | 'followUpOn'>, today: string): { text: string; tone: 'red' | 'amber' | 'neutral' } {
  if (f.overdueDays > 0) return { text: `${f.overdueDays} day${f.overdueDays === 1 ? '' : 's'} overdue`, tone: 'red' };
  if (f.followUpOn === today) return { text: 'Due today', tone: 'amber' };
  const ahead = daysBetween(today, f.followUpOn);
  return { text: ahead > 0 && ahead <= 7 ? `Due in ${ahead} day${ahead === 1 ? '' : 's'}` : f.followUpOn, tone: 'neutral' };
}

const MS = 86400000;
const utc = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
export const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / MS);
export function addDaysISO(iso: string, n: number): string {
  const d = new Date(utc(iso) + n * MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
export const isISODate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && addDaysISO(s, 0) === s;

// The quick choices in the Reschedule box: always relative to today in the clinic's time zone, never to the old due date.
export function rescheduleChoices(today: string): Array<{ label: string; date: string }> {
  return [{ label: 'Tomorrow', date: addDaysISO(today, 1) }, { label: 'In 3 days', date: addDaysISO(today, 3) }, { label: 'In a week', date: addDaysISO(today, 7) }, { label: 'In 2 weeks', date: addDaysISO(today, 14) }];
}
// A new follow-up date must be a real date, today or later (clearing the date is a separate, explicit choice).
export function checkRescheduleDate(value: string, today: string): string | null {
  if (!value) return 'Choose a date, or use Clear';
  if (!isISODate(value)) return 'Enter a valid date';
  if (value < today) return 'Choose today or a later date';
  return null;
}

// The calendar day (YYYY-MM-DD) of a moment in a time zone: the same rule as the "today" the screens use.
export const dayOf = (iso: string | null, timeZone: string): string | null => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone }) : null);

// Money numbers must never turn "we have no records" into "zero rupees".
//   yes     = the clinic has invoices (visible to this user), so ₹0 is a real zero
//   none    = no invoices exist for this view: say so instead of showing ₹0
//   unknown = could not check (loading or error): a zero is not confirmed
export type MoneyState = 'yes' | 'none' | 'unknown';
export function moneyState(invoices: { loading: boolean; error: boolean; count: number | null }): MoneyState {
  if (invoices.error || invoices.loading || invoices.count === null) return 'unknown';
  return invoices.count > 0 ? 'yes' : 'none';
}
// What to show for a money tile: the real value, or an honest note when a zero is not backed by invoices.
export function moneyNote(value: number, state: MoneyState): string | null {
  if (value !== 0) return null;                  // a non-zero amount is real whatever the check says
  return state === 'yes' ? null : state === 'none' ? 'No invoices yet' : 'Not confirmed yet';
}

// Active patients who have not been seen for a while: "days since" counts from the latest attended visit, or from registration when there was none.
// Only re-orders and filters what the register already holds; the longest gap comes first.
export interface ReviewRow { patientId: string; name: string; phone: string; complaint: string; days: number; never: boolean }
export function patientsToReview(rows: Array<{ patientId: string; name: string; phone: string; mainComplaint: string; status: string; latestVisit: string | null; registeredOn: string | null }>, today: string, minDays = 10, limit = 6): ReviewRow[] {
  const out: ReviewRow[] = [];
  for (const r of rows) {
    if (r.status !== 'Active') continue;
    const since = r.latestVisit || r.registeredOn;
    if (!since) continue;
    const days = daysBetween(since.slice(0, 10), today);
    if (days >= minDays) out.push({ patientId: r.patientId, name: r.name, phone: r.phone, complaint: r.mainComplaint, days, never: !r.latestVisit });
  }
  return out.sort((a, b) => b.days - a.days || a.name.localeCompare(b.name)).slice(0, limit);
}
