// Click-to-chat links for the dashboard: the staff member taps "WhatsApp", WhatsApp opens with a ready-made message, and the staff member
// presses send themselves. FLOW HQ sends nothing and calls nothing here (the only sender of automated messages stays the messaging gateway).
// Pure functions, tested without a browser.
import { addDaysISO, daysBetween } from './dashboardLogic';

// wa.me wants the number as digits only, with the country code: "+91 98765 43210", "09876543210" and "9876543210" all become 919876543210.
export function waNumber(phone: string): string | null {
  const d = (phone || '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}
export function waLink(phone: string, text: string): string | null {
  const n = waNumber(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}

const first = (name: string) => name.trim().split(/\s+/)[0] || 'there';
const sign = (clinic: string) => (clinic.trim() ? `${clinic.trim()}` : 'the clinic');

// Follow-up due today, overdue, or coming up. Says what is due and asks for a convenient time; no medical advice, nothing invented.
export function followUpMessage(p: { name: string; clinic: string; followUpOn: string; today: string }): string {
  const late = daysBetween(p.followUpOn, p.today);
  const when = late > 0 ? 'was due a few days ago' : p.followUpOn === p.today ? 'is due today' : p.followUpOn === addDaysISO(p.today, 1) ? 'is due tomorrow' : 'is coming up soon';
  return `Hello ${first(p.name)}, this is ${sign(p.clinic)}. Your follow-up visit ${when}. Please let us know a convenient time and we will book it for you. Thank you.`;
}

// A patient under treatment who has not been seen for a while.
export function reviewMessage(p: { name: string; clinic: string; days: number; never: boolean }): string {
  return p.never
    ? `Hello ${first(p.name)}, this is ${sign(p.clinic)}. We would like to check how you are doing and help you book your first session. Please reply with a time that suits you. Thank you.`
    : `Hello ${first(p.name)}, this is ${sign(p.clinic)}. It has been ${p.days} days since your last visit and we would like to know how you are feeling. Would you like to book your next session? Please reply with a time that suits you. Thank you.`;
}
