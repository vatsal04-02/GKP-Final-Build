// Shared pieces of the Schedule page: the shapes the server returns, badges, plain-language error text, a confirmation dialog.
import { useRef, type ReactNode } from 'react';
import { Sparkles, UserRound, CalendarDays } from 'lucide-react';
import { ApiError } from '../../lib/api';
import { Badge, Button, StatusDot, type Tone } from '../../components/ui/primitives';
import { Modal } from '../../components/ui/feedback';

export type Shift = 'morning' | 'evening';
export type Status = 'Pending confirmation' | 'Confirmed' | 'Checked in' | 'Completed' | 'Cancelled' | 'No-show';
export const STATUSES: Status[] = ['Pending confirmation', 'Confirmed', 'Checked in', 'Completed', 'Cancelled', 'No-show'];
export const SOURCES = ['WhatsApp AI', 'Staff', 'Cal.com', 'Other'];
export interface Appt {
  id: number; booking_reference: string; status: Status; date: string; start_time: string; end_time: string; start: string; doctor_id: string | null; doctor_name: string | null; shift: Shift | null;
  patient: { name: string; phone: string; patient_id: string }; reason: string; service: string; source: string; ai_created: boolean; created_at: string | null; updated_at: string | null; created_by: string;
}
export interface SlotRow { slot_id: string; start_time: string; end_time: string; doctor_id: string; doctor_name: string; shift: Shift; state: 'open' | 'full' | 'blocked' | 'past'; capacity: number; booked: number; remaining: number; blocked_by: string | null; appointments: Appt[] }
export interface DayView { date: string; closed: string | null; skips: Array<{ shift: Shift; doctorId: string | null; reason: string }>; slots: SlotRow[]; outside_slots: Appt[]; summary: { total: number; available: number; occupied: number; blocked: number; past: number } }
export interface Overview {
  me: { doctor_id: string | null; is_doctor_login: boolean };
  date: string; timezone: string; ai_booking: { setting: boolean; available: boolean; reason: string | null; problems: string[] }; tables_ready: boolean; shifts: { morning: boolean; evening: boolean }; closed: string | null;
  today_counts: { appointments: number; cancelled: number; available_slots: number; occupied_slots: number; blocked_slots: number }; upcoming: number;
  doctors: Array<{ doctor_id: string; name: string; qualification: string; default_shift: Shift | null; active: boolean; today: 'working' | 'on_leave' | 'inactive' | 'not_scheduled' }>;
  last_config_update: { at: string | null; by: string } | null; audit_health?: AuditHealth;
}
export interface AuditHealth { durable: boolean; level: 'ok' | 'amber' | 'red'; reasons: string[]; ready: boolean; lock_held: boolean; persistent_volume: 'yes' | 'no' | 'unchecked'; waiting_to_flush: number; open_intents: number; unsaved_outcomes: number; oldest_waiting_age_sec: number | null; failed_since_start: number; waiting_to_retry: number; last_failure_at: string | null; last_error: string | null; rejected_for_audit: number; corrupt_lines: number; break_glass: boolean; location: string }
export interface Doctor { doctor_id: string; name: string; qualification: string; default_shift: Shift | null; active: boolean; notes: string }
export interface ScheduleItem { schedule_id: string; doctor_id: string; weekday: string; shift: Shift; start_time: string; end_time: string; slot_minutes: number | null; buffer_minutes: number | null; capacity: number | null; effective_from: string | null; effective_to: string | null; active: boolean; is_override: boolean; reason: string }
export interface BlockItem { block_id: string; kind: string; doctor_id: string | null; shift: Shift | null; date_from: string; date_to: string; start_time: string | null; end_time: string | null; reason: string; active: boolean }

export const sourceLabel = (s: string) => (s === 'WhatsApp AI' ? 'AI booked' : s === 'Staff' ? 'Staff booked' : s);
export function SourceBadge({ source }: { source: string }) {
  if (source === 'WhatsApp AI') return <Badge tone="blue" icon={<Sparkles className="h-3 w-3" />}>AI booked</Badge>;
  if (source === 'Staff') return <Badge tone="neutral" icon={<UserRound className="h-3 w-3" />}>Staff booked</Badge>;
  return <Badge tone="amber" icon={<CalendarDays className="h-3 w-3" />}>{source}</Badge>;
}
const STATUS_TONE: Record<Status, Tone> = { 'Pending confirmation': 'amber', Confirmed: 'blue', 'Checked in': 'green', Completed: 'green', Cancelled: 'neutral', 'No-show': 'red' };
// Status reads as a coloured dot plus plain text: it is the most repeated mark on the page, so it stays light.
export const StatusBadge = ({ status }: { status: Status }) => <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium text-fg"><StatusDot tone={STATUS_TONE[status]} />{status}</span>;

const REASON: Record<string, string> = {
  slot_full: 'That time was just taken.', blocked: 'That time is blocked.', in_past: 'That time has already passed.', closed: 'The clinic is closed that day.', shift_disabled: 'That shift is switched off.',
  doctor_unavailable: 'That doctor is not available then.', slot_not_found: 'That is not a bookable time.', beyond_booking_window: 'That date is too far ahead.',
};
/** What to tell a person when the server refuses something (never raw codes). */
export function problem(e: unknown): string {
  if (e instanceof ApiError) {
    const reason = typeof e.data?.reason === 'string' ? e.data.reason : '';
    if (e.code === 'slot_unavailable') return `${REASON[reason] || 'That time cannot be booked.'} The list has been refreshed: pick another.`;
    if (e.code === 'forbidden') return e.message;
    if (e.code === 'duplicate_booking') return 'This patient already has a booking at that time.';
    if (e.code === 'write_unverified') return 'The change could not be confirmed as saved. Check the appointment before telling the patient.';
    if (e.code === 'booking_unavailable') return 'Booking data cannot be reached right now. Try again in a moment.';
    if (e.code === 'audit_unavailable') return 'Bookings are paused because the change log cannot be saved right now. Nothing was changed. Please tell an admin: the Schedule page shows what is wrong.';
    if (e.code === 'invalid_phone') return 'Enter a valid Indian mobile number (10 digits starting 6-9).';
    return e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong';
}
/** One fresh key per opened form, reused if the same form is submitted again: a double click cannot book twice. */
export function useIdemKey() { const k = useRef<string>(''); if (!k.current) k.current = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`; return { key: k.current, renew: () => { k.current = ''; } }; }

export function Confirm({ open, title, body, confirmLabel, danger, busy, onConfirm, onClose }: { open: boolean; title: string; body: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} label={title} className="max-w-md">
      <div className="space-y-4 p-6">
        <h2 className="font-display text-lg font-semibold">{title}</h2>
        <div className="text-[13.5px] leading-relaxed text-fg-2">{body}</div>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>{confirmLabel}</Button></div>
      </div>
    </Modal>
  );
}
export const fdateLong = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
