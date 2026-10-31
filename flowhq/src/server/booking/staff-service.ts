// The staff side of the booking service. It EXTENDS BookingService, so staff create / reschedule / cancel are the very same code (the same lock, the
// same slot re-check, the same verified write) as the AI's: there is no second appointment-writing path. This file adds what staff need around it:
// listing and searching, the day calendar, the control-panel numbers, status changes (check-in, complete, no-show), and the admin settings
// (the AI switch, shifts, slot rules, doctors, schedules) and leave / blocked time. Rights come from permissions.ts and are enforced HERE.
import type { GristRecord } from '../grist';
import { BackendError } from '../grist';
import { bad, dateIn, dateOut, maxSeq, pad, validDate } from '../records/ids';
import { normalizePhone } from '../adapters/autopilot/shared';
import { dayKey, localParts } from '../time';
import { BT, BLOCK_KIND_CHOICES, WEEKDAY_CHOICES } from './schema';
import { can } from './permissions';
import { toBlock, toDoctor } from './mappers';
import { addDays } from '../records/ids';
import { BookingService, ownDoctor, type BookingActor, type State } from './service';
import { effectiveConsent, parseApprovedForms, validateConsent, type ConsentInput, type ConsentKind, type ConsentValue } from './consent';
import { reminderOutlook } from './reminders';
import {
  appointmentsInSlot, dayAvailability, displayStatus, parseBookingSettings, SHIFTS, toMin, validateScheduleRow,
  type DisplayStatus, type ScheduleRow, type Shift,
} from './engine';

const t = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());
const iso = (sec: unknown) => (typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString() : null);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const STATUSES: DisplayStatus[] = ['Pending confirmation', 'Confirmed', 'Checked in', 'Completed', 'Cancelled', 'No-show'];
export const SOURCES = ['WhatsApp AI', 'Staff', 'Cal.com', 'Other'];

export interface StaffAppointment {
  id: number; booking_reference: string; status: DisplayStatus; date: string; start_time: string; end_time: string; start: string;
  doctor_id: string | null; doctor_name: string | null; shift: Shift | null;
  patient: { name: string; phone: string; patient_id: string }; reason: string; service: string; source: string; ai_created: boolean;
  created_at: string | null; updated_at: string | null; created_by: string;
}
export interface ListQuery { from?: string; to?: string; doctorId?: string; shift?: string; status?: string; source?: string; q?: string; limit?: number; offset?: number; order?: 'asc' | 'desc' }
export const SETTING_KEYS = ['approved_consent_forms', 'booking_enabled', 'timezone', 'slot_minutes', 'buffer_minutes', 'capacity', 'min_notice_minutes', 'cancel_min_notice_minutes', 'max_advance_days', 'operating_days', 'open_windows', 'shift_morning_enabled', 'shift_evening_enabled'] as const;
export interface ScheduleInput { id?: string; doctorId: string; weekday: string; shift: Shift; start: string; end: string; slotMinutes: number | null; bufferMinutes: number | null; capacity: number | null; from: string | null; to: string | null; active: boolean; isOverride: boolean; reason: string }
export interface BlockInput { kind: string; doctorId?: string | null; shift?: Shift | null; dateFrom: string; dateTo?: string | null; start?: string | null; end?: string | null; reason?: string }

export class StaffBooking extends BookingService {
  // ---------------------------------------------------------------- shared helpers
  private async leadsById(): Promise<Map<number, { name: string; phone: string }>> {
    try { return new Map((await this.rows(this.o.leadsTable || 'LEADS')).map((r) => [r.id, { name: t(r.fields.Name), phone: normalizePhone(t(r.fields.Phone)).phone || t(r.fields.Phone) }])); } catch { return new Map(); }
  }
  private shiftOfRow(r: GristRecord): Shift | null {
    const s = t(r.fields.Shift).toLowerCase(); if ((SHIFTS as string[]).includes(s)) return s as Shift;
    const start = typeof r.fields.Start === 'number' ? r.fields.Start : 0; return start ? (localParts(start * 1000, this.o.tz).h < 14 ? 'morning' : 'evening') : null;   // older rows: by the time of day
  }
  private row(r: GristRecord, st: State, leads: Map<number, { name: string; phone: string }>): StaffAppointment {
    const v = this.view(r, st); const lead = typeof r.fields.Lead === 'number' ? leads.get(r.fields.Lead) : undefined;
    const phone = normalizePhone(t(r.fields.Patient_Phone)).phone || lead?.phone || '';
    const source = v.source;
    return { id: r.id, booking_reference: v.booking_reference, status: v.status, date: v.date, start_time: v.start_time, end_time: v.end_time, start: v.start, doctor_id: this.doctorIdOf(r, st), doctor_name: v.doctor_name, shift: this.shiftOfRow(r),
      patient: { name: v.patient.name || lead?.name || '', phone, patient_id: t(r.fields.Patient_ID) }, reason: v.reason, service: v.service, source, ai_created: source === 'WhatsApp AI', created_at: v.created_at, updated_at: v.updated_at, created_by: t(r.fields.Created_By) };
  }
  private async addVerified(table: string, fields: Record<string, unknown>, ok: (r: GristRecord) => boolean, what: string): Promise<GristRecord> {
    const [id] = await this.grist.add(this.docId, table, [fields as never]);
    const row = typeof id === 'number' ? (await this.rows(table)).find((r) => r.id === id) : undefined;
    if (!row || !ok(row)) { console.error(`FLOW HQ booking: ${what} could not be verified`); throw bad('write_unverified', 'The change could not be confirmed as saved. Check it before relying on it.', 502); }
    return row;
  }
  private async patchVerified(table: string, id: number, fields: Record<string, unknown>, ok: (r: GristRecord) => boolean, what: string): Promise<GristRecord> {
    await this.grist.update(this.docId, table, [{ id, fields: fields as never }]);
    const row = (await this.rows(table)).find((r) => r.id === id);
    if (!row || !ok(row)) { console.error(`FLOW HQ booking: ${what} could not be verified`); throw bad('write_unverified', 'The change could not be confirmed as saved. Check it before relying on it.', 502); }
    return row;
  }
  private validDay(d: string | undefined, what: string) { if (d !== undefined && d !== '' && !validDate(d)) throw bad('invalid_date', `${what} is not a real date`, 400); }

  // ---------------------------------------------------------------- reading
  async listAppointments(q: ListQuery, a: BookingActor): Promise<{ rows: StaffAppointment[]; total: number }> {
    this.guard(a, 'view');
    this.validDay(q.from, 'From'); this.validDay(q.to, 'To');
    if (q.shift && !(SHIFTS as string[]).includes(q.shift)) throw bad('invalid_shift', 'shift must be morning or evening', 400);
    if (q.status && !STATUSES.includes(q.status as DisplayStatus)) throw bad('invalid_status', 'Unknown status', 400);
    if (q.source && !SOURCES.includes(q.source)) throw bad('invalid_source', 'Unknown booking source', 400);
    const st = await this.stateOrClosed(); const leads = await this.leadsById();
    const needle = t(q.q).toLowerCase(); const digits = needle.replace(/\D/g, '');
    let rows = st.rows.filter((r) => typeof r.fields.Start === 'number' && r.fields.Start > 0).map((r) => this.row(r, st, leads));
    rows = rows.filter((x) => (!q.from || x.date >= q.from) && (!q.to || x.date <= q.to) && (!q.doctorId || x.doctor_id === q.doctorId) && (!q.shift || x.shift === q.shift) && (!q.status || x.status === q.status) && (!q.source || x.source === q.source)
      && (!needle || x.patient.name.toLowerCase().includes(needle) || x.booking_reference.toLowerCase().includes(needle) || (digits.length >= 3 && x.patient.phone.replace(/\D/g, '').includes(digits))));
    rows.sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : x.id - y.id) * (q.order === 'desc' ? -1 : 1));
    const offset = Math.max(0, q.offset || 0); const limit = Math.min(Math.max(q.limit || 100, 1), 500);
    return { rows: rows.slice(offset, offset + limit), total: rows.length };
  }

  /** One day for the calendar: every slot (open, full, blocked, past) with who is in it, plus appointments that sit outside any slot. */
  async dayView(date: string, opts: { doctorId?: string; shift?: string }, a: BookingActor) {
    this.guard(a, 'view'); this.validDay(date, 'Date'); if (!date) throw bad('invalid_date', 'A date is required', 400);
    if (opts.shift && !(SHIFTS as string[]).includes(opts.shift)) throw bad('invalid_shift', 'shift must be morning or evening', 400);
    const st = await this.stateOrClosed(); const leads = await this.leadsById();
    return this.dayFrom(st, leads, date, opts);
  }

  /** The week (7 days from `from`, or the Monday of its week when `monday` is set): per day the bookable windows, leave / closures and the appointments, optionally for ONE doctor. Reads once. */
  async weekView(from: string, opts: { doctorId?: string; monday?: boolean }, a: BookingActor) {
    this.guard(a, 'view'); this.validDay(from, 'Date'); if (!from) throw bad('invalid_date', 'A date is required', 400);
    const st = await this.stateOrClosed(); const leads = await this.leadsById();
    if (opts.doctorId && !st.input.doctors.some((d) => d.id === opts.doctorId)) throw bad('unknown_doctor', 'No such doctor', 404);
    let start = from;
    if (opts.monday) { const dow = new Date(Date.parse(`${from}T00:00:00Z`)).getUTCDay(); start = addDays(from, -((dow + 6) % 7)); }
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((date) => {
      const d = this.dayFrom(st, leads, date, opts.doctorId ? { doctorId: opts.doctorId } : {});
      // the bookable windows per doctor and shift (first start to last end of that doctor's slots), so a week reads as "who works when"
      const windows = new Map<string, { doctor_id: string; doctor_name: string; shift: Shift; start_time: string; end_time: string; free: number; booked: number }>();
      for (const s of d.slots) {
        const k = `${s.doctor_id}|${s.shift}`; const w = windows.get(k);
        if (!w) windows.set(k, { doctor_id: s.doctor_id, doctor_name: s.doctor_name, shift: s.shift, start_time: s.start_time, end_time: s.end_time, free: s.state === 'open' ? 1 : 0, booked: s.appointments.length });
        else { if (s.start_time < w.start_time) w.start_time = s.start_time; if (s.end_time > w.end_time) w.end_time = s.end_time; if (s.state === 'open') w.free++; w.booked += s.appointments.length; }
      }
      const appts = [...d.slots.flatMap((s) => s.appointments), ...d.outside_slots];
      const unique = [...new Map(appts.map((x) => [x.id, x])).values()].sort((x, y) => x.start.localeCompare(y.start));
      return { date, closed: d.closed, skips: d.skips, windows: [...windows.values()], appointments: unique, summary: d.summary };
    });
    return {
      from: start, to: addDays(start, 6), doctor_id: opts.doctorId || null,
      doctors: st.input.doctors.map((d) => ({ doctor_id: d.id, name: d.name, active: d.active })),
      days,
      // cancelled appointments are not on the calendar (as in the day view); the Appointments list with the Cancelled filter shows them
      totals: { appointments: days.reduce((n, d) => n + d.appointments.length, 0), free_slots: days.reduce((n, d) => n + d.summary.available, 0) },
    };
  }

  private dayFrom(st: State, leads: Map<number, { name: string; phone: string }>, date: string, opts: { doctorId?: string; shift?: string }) {
    const day = dayAvailability(st.input, date, { channel: 'staff', ...(opts.doctorId ? { doctorId: opts.doctorId } : {}), ...(opts.shift ? { shift: opts.shift as Shift } : {}) });
    const byRef = new Map(st.rows.map((r) => [String(r.id), r]));
    const placed = new Set<string>();
    const slots = day.slots.map((s) => {
      const here = appointmentsInSlot(st.input, s.doctorId, s.startSec, s.endSec).map((x) => { placed.add(x.id); const r = byRef.get(x.id); return r ? this.row(r, st, leads) : null; }).filter((x) => x !== null);
      return { slot_id: s.slotId, start_time: s.start, end_time: s.end, doctor_id: s.doctorId, doctor_name: s.doctorName, shift: s.shift, state: s.state, capacity: s.capacity, booked: s.booked, remaining: s.remaining, blocked_by: s.blockedBy || null, appointments: here };
    });
    const others = st.rows.filter((r) => !placed.has(String(r.id)) && typeof r.fields.Start === 'number' && dayKey(r.fields.Start * 1000, this.o.tz) === date && displayStatus(t(r.fields.Status), null) !== 'Cancelled')
      .map((r) => this.row(r, st, leads)).filter((x) => (!opts.doctorId || x.doctor_id === opts.doctorId) && (!opts.shift || x.shift === opts.shift));
    return { date, closed: day.closed, skips: day.skips, slots, outside_slots: others, summary: day.summary };
  }

  /** The control panel: the AI switch state, today's numbers, who is working, when the settings last changed. */
  async overview(date: string | undefined, a: BookingActor) {
    this.guard(a, 'view'); this.validDay(date, 'Date');
    const st = await this.stateOrClosed(); const today = date || dayKey(this.now(), this.o.tz);
    const day = dayAvailability(st.input, today, { channel: 'staff' });
    const live = st.rows.filter((r) => typeof r.fields.Start === 'number' && r.fields.Start > 0).map((r) => ({ r, date: dayKey((r.fields.Start as number) * 1000, this.o.tz), status: displayStatus(t(r.fields.Status), t(r.fields.Appt_Stage)) }));
    const nowSec = this.ts(); const horizon = addDays(today, 7);
    const updated = st.cfg.filter((r) => typeof r.fields.Updated_At === 'number').sort((x, y) => (y.fields.Updated_At as number) - (x.fields.Updated_At as number))[0];
    const doctors = st.input.doctors.map((d) => {
      const skip = day.skips.find((k) => k.doctorId === d.id); const works = day.slots.some((s) => s.doctorId === d.id);
      return { doctor_id: d.id, name: d.name, qualification: d.qualification, default_shift: d.defaultShift, active: d.active, today: !d.active ? 'inactive' : works ? 'working' : skip?.reason === 'doctor_on_leave' || skip?.reason === 'blocked_all_day' ? 'on_leave' : 'not_scheduled' };
    });
    return {
      date: today, timezone: st.input.settings.timezone,
      ai_booking: { setting: st.setting, available: st.ai.available, reason: st.ai.reason, problems: st.problems },
      tables_ready: st.ai.reason !== 'config_unavailable',
      me: { doctor_id: ownDoctor(a, st.input.doctors)?.id || null, is_doctor_login: a.role !== 'admin' && !!(a.doctorId || a.clinician), can: { record_yes: can(a, 'consent:record_yes'), record_no: can(a, 'consent:record_no'), correct: can(a, 'consent:correct') } },   // the page enables doctor-only buttons from THIS; the server still decides every write
      shifts: st.input.settings.shiftEnabled, closed: day.closed,
      today_counts: { appointments: live.filter((x) => x.date === today && x.status !== 'Cancelled').length, cancelled: live.filter((x) => x.date === today && x.status === 'Cancelled').length, available_slots: day.summary.available, occupied_slots: day.summary.occupied, blocked_slots: day.summary.blocked },
      upcoming: live.filter((x) => x.status !== 'Cancelled' && x.status !== 'Completed' && x.status !== 'No-show' && (x.r.fields.Start as number) >= nowSec && x.date <= horizon).length,
      doctors,
      last_config_update: updated ? { at: iso(updated.fields.Updated_At), by: t(updated.fields.Updated_By) } : null,
      ...(can(a, 'audit:read') ? { audit_health: this.auditHealth() } : {}),
    };
  }

  async detail(ref: string, a: BookingActor) {
    this.guard(a, 'view');
    const st = await this.stateFor(a); const r = st.rows.find((x) => t(x.fields.Booking_UID) === ref);
    if (!r) throw bad('not_found', 'Appointment not found', 404);
    const history = (await this.rows(BT.audit).catch(() => [] as GristRecord[])).filter((x) => t(x.fields.Record) === ref).sort((x, y) => (y.fields.At as number) - (x.fields.At as number) || y.id - x.id).slice(0, 50)
      .map((x) => ({ at: iso(x.fields.At), actor: t(x.fields.Actor), source: t(x.fields.Source), action: t(x.fields.Action), outcome: t(x.fields.Outcome), reason: t(x.fields.Reason) }));
    const leads = await this.leadsById();
    return { appointment: this.row(r, st, leads), history, reminder: await this.reminderFor(r, leads) };
  }

  /** Will W5 remind this appointment, and if not, why. Same order of checks as W5 (reminders.ts); it reads only. */
  private async reminderFor(r: GristRecord, leads: Map<number, { name: string; phone: string }>) {
    const lead = typeof r.fields.Lead === 'number' ? leads.get(r.fields.Lead) : undefined;
    let phone = normalizePhone(lead?.phone || '').phone || normalizePhone(t(r.fields.Patient_Phone)).phone || '';
    if (!phone && t(r.fields.Patient_ID)) {
      const patient = (await this.rows('Patients').catch(() => [] as GristRecord[])).find((x) => t(x.fields.Patient_ID) === t(r.fields.Patient_ID));
      phone = normalizePhone(t(patient?.fields.Phone)).phone || '';
    }
    let consent: string | null = null;
    try {
      const mine = (await this.rows(BT.consent)).filter((x) => t(x.fields.Phone) === phone);
      consent = mine.some((x) => t(x.fields.Reminder_Consent) === 'No') ? 'No' : mine.some((x) => t(x.fields.Reminder_Consent) === 'Yes') ? 'Yes' : '';
    } catch { consent = null; }
    const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null);
    return reminderOutlook({
      status: t(r.fields.Status), stage: t(r.fields.Appt_Stage), startSec: num(r.fields.Start) || 0, nowSec: this.ts(), r24Sent: num(r.fields.R24_Sent), r2Sent: num(r.fields.R2_Sent),
      phone, consent, optedOut: phone ? await this.optedOutPhone(phone) : false,
    });
  }

  async doctorsView(a: BookingActor) {
    this.guard(a, 'view');
    const st = await this.stateOrClosed();
    const doctorsRaw = (await this.rows(BT.doctors).catch(() => [] as GristRecord[])).map(toDoctor).filter((x) => x !== null);
    const notes = new Map((await this.rows(BT.doctors).catch(() => [] as GristRecord[])).map((r) => [t(r.fields.Doctor_ID), t(r.fields.Notes)]));
    const blocks = (await this.rows(BT.blocks).catch(() => [] as GristRecord[])).map((r) => ({ r, b: toBlock(r) })).filter((x) => x.b !== null).map(({ b }) => ({ block_id: b!.id, kind: b!.kind, doctor_id: b!.doctorId, shift: b!.shift, date_from: b!.from, date_to: b!.to, start_time: b!.start, end_time: b!.end, reason: b!.reason, active: b!.active }));
    return {
      doctors: doctorsRaw.map((d) => ({ doctor_id: d!.id, name: d!.name, qualification: d!.qualification, default_shift: d!.defaultShift, active: d!.active, notes: notes.get(d!.id) || '' })),
      schedules: st.input.schedules.map((r) => ({ schedule_id: r.id, doctor_id: r.doctorId, weekday: WEEKDAY_CHOICES[r.weekday - 1], shift: r.shift, start_time: r.start, end_time: r.end, slot_minutes: r.slotMinutes, buffer_minutes: r.bufferMinutes, capacity: r.capacity, effective_from: r.from, effective_to: r.to, active: r.active, is_override: r.isOverride, reason: r.reason })),
      blocks, problems: st.problems,
    };
  }

  async settingsView(a: BookingActor) {
    this.guard(a, 'view'); const st = await this.stateOrClosed(); const s = st.input.settings;
    const raw = Object.fromEntries(st.cfg.map((r) => [t(r.fields.Key), t(r.fields.Value)]));
    return { values: Object.fromEntries(SETTING_KEYS.map((k) => [k, raw[k] ?? ''])), effective: { slot_minutes: s.slotMinutes, buffer_minutes: s.bufferMinutes, capacity: s.capacity, min_notice_minutes: s.minNoticeMinutes, cancel_min_notice_minutes: s.cancelNoticeMinutes, max_advance_days: s.maxAdvanceDays, timezone: s.timezone }, problems: st.problems };
  }

  async auditLog(q: { limit?: number; q?: string }, a: BookingActor) {
    this.guard(a, 'audit:read');
    const needle = t(q.q).toLowerCase(); const limit = Math.min(Math.max(q.limit || 100, 1), 500);
    const rows = (await this.rows(BT.audit).catch(() => [] as GristRecord[])).sort((x, y) => (y.fields.At as number) - (x.fields.At as number) || y.id - x.id)   // newest first; entries in the same second: the later row
      .map((x) => ({ at: iso(x.fields.At), actor: t(x.fields.Actor), source: t(x.fields.Source), action: t(x.fields.Action), record: t(x.fields.Record), outcome: t(x.fields.Outcome), reason: t(x.fields.Reason), detail: t(x.fields.Detail) }))
      .filter((x) => !needle || [x.actor, x.action, x.record, x.reason, x.outcome].some((v) => v.toLowerCase().includes(needle)));
    return { rows: rows.slice(0, limit), total: rows.length, health: this.auditHealth() };
  }

  // ---------------------------------------------------------------- appointment status (check-in, complete, no-show)
  async setStatus(ref: string, to: string, a: BookingActor): Promise<StaffAppointment> {
    return this.attempt('status', a, ref, { to }, async (op) => {
      if (!STATUSES.includes(to as DisplayStatus) || to === 'Cancelled') throw bad('invalid_status', 'Use one of: Pending confirmation, Confirmed, Checked in, Completed, No-show (cancel with the cancel action)', 400);
      return this.lock.run(async () => {
        const st = await this.stateFor(a); const r = st.rows.find((x) => t(x.fields.Booking_UID) === ref);
        if (!r) throw bad('not_found', 'Appointment not found', 404);
        this.guard(a, 'appointments:write', this.doctorIdOf(r, st), st.input.doctors);
        if (displayStatus(t(r.fields.Status), t(r.fields.Appt_Stage)) === 'Cancelled') throw bad('not_changeable', 'A cancelled appointment cannot change status; book a new one', 409);
        // Status keeps its old vocabulary (W4-W9 read it): Completed / No-show are Status values; the other three are Appt_Stage on a Booked row.
        const fields: Record<string, unknown> = to === 'Completed' ? { Status: 'Completed' } : to === 'No-show' ? { Status: 'No-show' } : { Status: 'Booked', Appt_Stage: to };
        const auditId = await op.begin(BT.appointments, ref);   // write-ahead
        const after = await this.patchVerified(BT.appointments, r.id, { ...fields, Audit_ID: auditId, Updated_At: this.ts() }, (x) => displayStatus(t(x.fields.Status), t(x.fields.Appt_Stage)) === to, `status change of ${ref}`);
        await op.done(auditId, to, ref);
        return this.row(after, st, await this.leadsById());
      });
    });
  }

  // ---------------------------------------------------------------- admin: settings, doctors, schedules
  async updateSettings(values: Record<string, string>, a: BookingActor) {
    return this.attempt('settings', a, 'Booking_Config', { keys: Object.keys(values).slice(0, 12) }, async (op) => {
      this.guard(a, 'settings:write'); if ('booking_enabled' in values) this.guard(a, 'ai_switch');
      const keys = Object.keys(values); if (!keys.length) throw bad('invalid', 'Nothing to change', 400);
      for (const k of keys) if (!(SETTING_KEYS as readonly string[]).includes(k)) throw bad('invalid_setting', `Unknown setting: ${k}`, 400);
      return this.lock.run(async () => {
        const st = await this.stateOrClosed().then((s) => { if (s.ai.reason === 'config_unavailable') throw bad('booking_unavailable', 'The booking tables are not set up for this clinic', 503); return s; });
        const want = Object.fromEntries(keys.map((k) => [k, t(values[k])]));
        const candidate = [...st.cfg.filter((r) => !(t(r.fields.Key) in want)).map((r) => r.fields), ...Object.entries(want).map(([Key, Value]) => ({ Key, Value }))];
        const check = parseBookingSettings(candidate);
        if (check.problems.length) throw bad('invalid_setting', check.problems[0]!, 400, { problems: check.problems });
        const stamp = { Updated_At: this.ts(), Updated_By: a.id };
        for (const [k, v] of Object.entries(want)) {
          const cur = st.cfg.find((r) => t(r.fields.Key) === k); const from = cur ? t(cur.fields.Value) : '';
          if (cur && from === v) continue;
          const auditId = await op.begin(BT.config, k, { key: k, from: from.slice(0, 80), to: v.slice(0, 80) }, k === 'booking_enabled' ? 'booking_enabled' : 'setting');   // write-ahead, one per setting (settings hold no patient data)
          if (cur) await this.patchVerified(BT.config, cur.id, { Value: v, Audit_ID: auditId, ...stamp }, (x) => t(x.fields.Value) === v, `setting ${k}`);
          else await this.addVerified(BT.config, { Key: k, Value: v, Audit_ID: auditId, ...stamp }, (x) => t(x.fields.Value) === v, `setting ${k}`);
          await op.done(auditId, 'changed', k);
        }
        return this.settingsView(a);
      });
    });
  }

  async updateDoctor(id: string, p: { name?: string; qualification?: string; active?: boolean; notes?: string; defaultShift?: Shift | null }, a: BookingActor) {
    return this.attempt('doctor', a, id, { fields: Object.keys(p) }, async (op) => {
      this.guard(a, 'settings:write');
      return this.lock.run(async () => {
        const rows = await this.rows(BT.doctors); const r = rows.find((x) => t(x.fields.Doctor_ID) === id); if (!r) throw bad('not_found', 'Doctor not found', 404);
        const f: Record<string, unknown> = {};
        if (p.name !== undefined) { const n = t(p.name); if (n.length < 2 || n.length > 120) throw bad('invalid', 'Enter the doctor\'s name', 400); f.Name = n; }
        if (p.qualification !== undefined) f.Qualification = t(p.qualification).slice(0, 120);
        if (p.active !== undefined) f.Active = p.active === true;
        if (p.notes !== undefined) f.Notes = t(p.notes).slice(0, 500);
        if (p.defaultShift !== undefined) { if (p.defaultShift !== null && !(SHIFTS as string[]).includes(p.defaultShift)) throw bad('invalid_shift', 'shift must be morning or evening', 400); f.Default_Shift = p.defaultShift ? cap(p.defaultShift) : ''; }
        if (!Object.keys(f).length) throw bad('invalid', 'Nothing to change', 400);
        const auditId = await op.begin(BT.doctors, id, { fields: Object.keys(f), ...(p.active !== undefined ? { active: p.active } : {}) });   // write-ahead
        const after = await this.patchVerified(BT.doctors, r.id, { ...f, Audit_ID: auditId, Updated_At: this.ts(), Updated_By: a.id }, (x) => Object.entries(f).every(([k, v]) => x.fields[k] === v || (v === '' && !x.fields[k])), `doctor ${id}`);
        await op.done(auditId, 'updated', id);
        return toDoctor(after);
      });
    });
  }

  async saveSchedule(i: ScheduleInput, a: BookingActor) {
    return this.attempt('schedule', a, i.id || 'new', { doctor: i.doctorId, weekday: i.weekday, shift: i.shift, override: i.isOverride }, async (op) => {
      this.guard(a, 'settings:write');
      return this.lock.run(async () => {
        const st = await this.stateFor(a); const doc = st.input.doctors.find((d) => d.id === i.doctorId) || null;
        const wd = WEEKDAY_CHOICES.indexOf(i.weekday) + 1;
        if (wd < 1) throw bad('invalid_schedule', 'Choose a weekday', 400);
        const id = i.id || `SCH-${pad(maxSeq((await this.rows(BT.schedules)).map((r) => r.fields.Schedule_ID), 'SCH-') + 1, 3)}`;
        const cand: ScheduleRow = { id, doctorId: i.doctorId, weekday: wd, shift: i.shift, start: i.start, end: i.end, slotMinutes: i.slotMinutes, bufferMinutes: i.bufferMinutes, capacity: i.capacity, from: i.from || null, to: i.to || null, active: i.active, isOverride: i.isOverride, reason: t(i.reason) };
        const problems = validateScheduleRow(cand, doc, st.input.schedules);
        if (problems.length) throw bad('invalid_schedule', problems[0]!.message, 400, { problems });
        const f = { Schedule_ID: id, Doctor_ID: i.doctorId, Weekday: i.weekday, Shift: cap(i.shift), Start_Time: i.start, End_Time: i.end, Slot_Minutes: i.slotMinutes, Buffer_Minutes: i.bufferMinutes, Capacity: i.capacity, Effective_From: dateIn(i.from), Effective_To: dateIn(i.to), Active: i.active, Is_Override: i.isOverride, Override_Reason: t(i.reason).slice(0, 200), Updated_At: this.ts(), Updated_By: a.id };
        const existing = (await this.rows(BT.schedules)).find((r) => t(r.fields.Schedule_ID) === id);
        if (i.id && !existing) throw bad('not_found', 'Schedule not found', 404);
        const ok = (x: GristRecord) => t(x.fields.Start_Time) === i.start && t(x.fields.End_Time) === i.end && x.fields.Active === i.active;
        const auditId = await op.begin(BT.schedules, id, { doctor: i.doctorId, weekday: i.weekday, shift: i.shift, active: i.active, override: i.isOverride });   // write-ahead
        const fa = { ...f, Audit_ID: auditId };
        if (existing) await this.patchVerified(BT.schedules, existing.id, fa, ok, `schedule ${id}`); else await this.addVerified(BT.schedules, fa, ok, `schedule ${id}`);
        await op.done(auditId, existing ? 'updated' : 'created', id);
        return { schedule_id: id };
      });
    });
  }

  // ---------------------------------------------------------------- leave, closures and blocked time (never touches an existing appointment)
  async addBlock(i: BlockInput, a: BookingActor) {
    return this.attempt('block', a, 'new', { kind: i.kind, doctor: i.doctorId || null, from: i.dateFrom }, async (op) => {
      this.guard(a, 'blocks:write');
      if (!BLOCK_KIND_CHOICES.includes(i.kind)) throw bad('invalid_block', 'Choose clinic closure, doctor leave or blocked time', 400);
      const from = i.dateFrom; const to = i.dateTo || i.dateFrom;
      if (!validDate(from) || !validDate(to)) throw bad('invalid_date', 'Enter real dates', 400);
      if (to < from) throw bad('invalid_block', 'The end date is before the start date', 400);
      const s = t(i.start); const e = t(i.end);
      if (!!s !== !!e || (s && (toMin(s) === null || toMin(e) === null || toMin(e)! <= toMin(s)!))) throw bad('invalid_block', 'Give both times (the end after the start), or neither for the whole day', 400);
      if (i.shift && !(SHIFTS as string[]).includes(i.shift)) throw bad('invalid_shift', 'shift must be morning or evening', 400);
      return this.lock.run(async () => {
        const st = await this.stateFor(a);
        if (i.kind === 'Doctor leave' && !i.doctorId) throw bad('invalid_block', 'Choose the doctor who is on leave', 400);
        if (i.kind === 'Clinic closure' && i.doctorId) throw bad('invalid_block', 'A clinic closure applies to everyone; use doctor leave for one doctor', 400);
        if (i.doctorId && !st.input.doctors.some((d) => d.id === i.doctorId)) throw bad('invalid_block', 'That doctor does not exist', 400);
        const id = `BLK-${pad(maxSeq((await this.rows(BT.blocks)).map((r) => r.fields.Block_ID), 'BLK-') + 1)}`;
        const f = { Block_ID: id, Kind: i.kind, Doctor_ID: i.doctorId || '', Shift: i.shift ? cap(i.shift) : '', Date_From: dateIn(from), Date_To: dateIn(to), Start_Time: s, End_Time: e, Reason: t(i.reason).slice(0, 200), Active: true, Created_At: this.ts(), Created_By: a.id };
        const auditId = await op.begin(BT.blocks, id, { kind: i.kind, doctor: i.doctorId || null, from, to, whole_day: !s });   // write-ahead
        await this.addVerified(BT.blocks, { ...f, Audit_ID: auditId }, (x) => t(x.fields.Block_ID) === id && x.fields.Active === true, `block ${id}`);
        // appointments already inside the blocked time stay as they are: staff are told so they can move them
        const leads = await this.leadsById();
        const affected = st.rows.filter((r) => typeof r.fields.Start === 'number' && displayStatus(t(r.fields.Status), null) !== 'Cancelled').map((r) => ({ r, date: dayKey((r.fields.Start as number) * 1000, this.o.tz) }))
          .filter(({ r, date }) => {
            if (date < from || date > to) return false;
            if (i.doctorId && this.doctorIdOf(r, st) !== i.doctorId) return false;
            if (i.shift && this.shiftOfRow(r) !== i.shift) return false;
            if (!s) return true;
            const lp = localParts((r.fields.Start as number) * 1000, this.o.tz); const m = lp.h * 60 + lp.mi; return m < toMin(e)! && m >= toMin(s)! - 29;   // starts inside the range (a 30-minute visit that begins just before it also touches it)
          }).slice(0, 50).map(({ r }) => this.row(r, st, leads));
        await op.done(auditId, 'created', id, { affected: affected.length });
        return { block_id: id, affected: affected.map((x) => ({ booking_reference: x.booking_reference, date: x.date, start_time: x.start_time, doctor_name: x.doctor_name, patient_name: x.patient.name })) };
      });
    });
  }

  async deactivateBlock(id: string, a: BookingActor) {
    return this.attempt('block', a, id, {}, async (op) => {
      this.guard(a, 'blocks:write');
      return this.lock.run(async () => {
        const r = (await this.rows(BT.blocks)).find((x) => t(x.fields.Block_ID) === id); if (!r) throw bad('not_found', 'Block not found', 404);
        if (r.fields.Active !== true) return { block_id: id, already_inactive: true };
        const auditId = await op.begin(BT.blocks, id, {});   // write-ahead
        await this.patchVerified(BT.blocks, r.id, { Active: false, Audit_ID: auditId }, (x) => x.fields.Active === false, `block ${id}`);   // switched off, never deleted
        await op.done(auditId, 'removed', id);
        return { block_id: id, already_inactive: false };
      });
    });
  }

  // ---------------------------------------------------------------- reminder consent (per phone; append-only history; see consent.ts)
  // Order matters for recovery: the HISTORY row is written first (it carries the Audit_ID and is the record of truth), then the current-state row.
  // If a crash leaves the state behind the log, repairConsentState() (run at start) rebuilds it from the newest log row.
  private async optedOutPhone(phone: string): Promise<boolean> {
    try { return (await this.rows(this.o.leadsTable || 'LEADS')).some((r) => r.fields.Opted_Out === true && normalizePhone(t(r.fields.Phone)).phone === phone); } catch { return false; }
  }
  private consentRowView(r: GristRecord | undefined) {
    const f = r?.fields; return { consent_id: t(f?.Consent_ID), value: (['Yes', 'No'].includes(t(f?.Reminder_Consent)) ? t(f?.Reminder_Consent) : 'Unknown') as 'Yes' | 'No' | 'Unknown', at: iso(f?.Reminder_Consent_At), source: t(f?.Reminder_Consent_Source), evidence_ref: t(f?.Evidence_Ref), evidence_date: dateOut(f?.Evidence_Date), form_version: t(f?.Form_Version), recorded_by: t(f?.Recorded_By), previous_value: t(f?.Previous_Value) || 'Unknown', patient_id: t(f?.Patient_ID) };
  }
  /** The current answer for one phone, whether automated reminders would go out, and the full history (newest first). */
  async consentState(phoneRaw: string, a: BookingActor) {
    this.guard(a, 'view');
    const ph = normalizePhone(phoneRaw); if (!ph.valid || !ph.phone) throw bad('invalid_phone', 'Enter a valid Indian mobile number', 400);
    const [state, log] = await Promise.all([this.rows(BT.consent).catch(() => [] as GristRecord[]), this.rows(BT.consentLog).catch(() => [] as GristRecord[])]);
    const cur = state.find((r) => t(r.fields.Phone) === ph.phone); const eff = effectiveConsent(cur ? { value: t(cur.fields.Reminder_Consent) } : null, await this.optedOutPhone(ph.phone));
    const history = log.filter((r) => t(r.fields.Phone) === ph.phone).sort((x, y) => (y.fields.At as number) - (x.fields.At as number) || y.id - x.id)
      .map((r) => ({ log_id: t(r.fields.Log_ID), kind: t(r.fields.Kind), value: t(r.fields.Value), previous_value: t(r.fields.Previous_Value), at: iso(r.fields.At), source: t(r.fields.Source), evidence_ref: t(r.fields.Evidence_Ref), evidence_date: dateOut(r.fields.Evidence_Date), form_version: t(r.fields.Form_Version), actor: t(r.fields.Actor), note: t(r.fields.Note) }));
    return { phone: ph.phone, ...this.consentRowView(cur), effective: eff, history, can: { record_yes: can(a, 'consent:record_yes'), record_no: can(a, 'consent:record_no'), correct: can(a, 'consent:correct') } };
  }
  async consentSummary(a: BookingActor) {
    this.guard(a, 'view');
    const state = await this.rows(BT.consent).catch(() => [] as GristRecord[]);
    const count = (v: string) => state.filter((r) => t(r.fields.Reminder_Consent) === v).length;
    return { yes: count('Yes'), no: count('No'), recorded: state.length, note: 'People with no record are Unknown: reminders are not sent to them.' };
  }
  recordConsent(i: ConsentInput, a: BookingActor) { return this.changeConsent('recorded', i, a); }
  correctConsent(i: ConsentInput, a: BookingActor) { return this.changeConsent('corrected', i, a); }
  revokeConsent(i: { phone: string; source?: string; note: string }, a: BookingActor) { return this.changeConsent('revoked', { phone: i.phone, value: 'No', source: i.source || 'Patient withdrew', note: i.note }, a); }

  private async changeConsent(kind: ConsentKind, i: ConsentInput, a: BookingActor) {
    return this.attempt('consent', a, 'consent', { kind }, async (op) => {
      const value: ConsentValue = kind === 'revoked' ? 'No' : i.value;
      this.guard(a, kind === 'recorded' ? (value === 'Yes' ? 'consent:record_yes' : 'consent:record_no') : 'consent:correct');
      const ph = normalizePhone(String(i.phone || '')); if (!ph.valid || !ph.phone) throw bad('invalid_phone', 'Enter a valid Indian mobile number (10 digits starting 6-9)', 400);
      const phone = ph.phone;
      return this.lock.run(async () => {
        let cfg: GristRecord[]; let state: GristRecord[]; let log: GristRecord[];
        try { [cfg, state, log] = await Promise.all([this.rows(BT.config), this.rows(BT.consent), this.rows(BT.consentLog)]); }
        catch (e) { throw e instanceof BackendError && e.status === 404 ? bad('booking_unavailable', 'The consent tables are not set up for this clinic yet', 503) : bad('booking_unavailable', 'Consent data cannot be reached right now', 503); }
        const problem = validateConsent({ ...i, value }, { kind, approvedForms: parseApprovedForms(cfg.find((r) => t(r.fields.Key) === 'approved_consent_forms')?.fields.Value), today: dayKey(this.now(), this.o.tz) });
        if (problem) throw bad(problem.code, problem.message, 400);
        const cur = state.find((r) => t(r.fields.Phone) === phone); const prev = this.consentRowView(cur).value;
        if (cur && prev === value && t(cur.fields.Reminder_Consent_Source) === i.source && t(cur.fields.Evidence_Ref) === t(i.evidenceRef) && kind === 'recorded') { await op.event('ok', 'unchanged', t(cur.fields.Consent_ID)); return this.consentState(phone, a); }
        const consentId = cur ? t(cur.fields.Consent_ID) : `RC-${pad(maxSeq(state.map((r) => r.fields.Consent_ID), 'RC-') + 1)}`;
        const logId = `RCL-${pad(maxSeq(log.map((r) => r.fields.Log_ID), 'RCL-') + 1)}`;
        const auditId = await op.begin(BT.consentLog, consentId, { kind, from: prev, to: value, source: i.source });   // write-ahead
        const at = this.ts(); const ev = { Evidence_Ref: t(i.evidenceRef).slice(0, 120), Evidence_Date: dateIn(i.evidenceDate || null), Form_Version: t(i.formVersion).slice(0, 60) };
        await this.addVerified(BT.consentLog, { Log_ID: logId, Consent_ID: consentId, Phone: phone, Value: value, Previous_Value: prev, At: at, Source: i.source, ...ev, Actor: a.id, Kind: kind, Note: t(i.note).slice(0, 300), Audit_ID: auditId }, (x) => t(x.fields.Log_ID) === logId && t(x.fields.Value) === value, `consent history ${logId}`);
        const sf = { Consent_ID: consentId, Phone: phone, Patient_ID: t(i.patientId) || t(cur?.fields.Patient_ID), Reminder_Consent: value, Reminder_Consent_At: at, Reminder_Consent_Source: i.source, ...ev, Recorded_By: a.id, Previous_Value: prev, Updated_At: at, Audit_ID: auditId };
        const okState = (x: GristRecord) => t(x.fields.Reminder_Consent) === value && t(x.fields.Audit_ID) === auditId;
        if (cur) await this.patchVerified(BT.consent, cur.id, sf, okState, `consent ${consentId}`); else await this.addVerified(BT.consent, sf, okState, `consent ${consentId}`);
        await op.done(auditId, kind, consentId, { from: prev, to: value });   // no phone, no evidence text in the audit
        return this.consentState(phone, a);
      });
    });
  }

  /** After a crash between the history row and the state row: make the current answer equal the newest history row. Never changes a value that the log does not support. */
  async repairConsentState(): Promise<number> {
    let state: GristRecord[]; let log: GristRecord[];
    try { [state, log] = await Promise.all([this.rows(BT.consent), this.rows(BT.consentLog)]); } catch { return 0; }
    const newest = new Map<string, GristRecord>();
    for (const r of log) { const p = t(r.fields.Phone); const c = newest.get(p); if (!c || (r.fields.At as number) > (c.fields.At as number) || ((r.fields.At as number) === (c.fields.At as number) && r.id > c.id)) newest.set(p, r); }
    let fixed = 0;
    for (const [phone, l] of newest) {
      const cur = state.find((r) => t(r.fields.Phone) === phone); if (cur && t(cur.fields.Audit_ID) === t(l.fields.Audit_ID)) continue;
      const f = { Consent_ID: t(l.fields.Consent_ID), Phone: phone, Reminder_Consent: t(l.fields.Value), Reminder_Consent_At: l.fields.At, Reminder_Consent_Source: t(l.fields.Source), Evidence_Ref: t(l.fields.Evidence_Ref), Evidence_Date: l.fields.Evidence_Date ?? null, Form_Version: t(l.fields.Form_Version), Recorded_By: t(l.fields.Actor), Previous_Value: t(l.fields.Previous_Value), Updated_At: l.fields.At, Audit_ID: t(l.fields.Audit_ID) };
      if (cur) await this.grist.update(this.docId, BT.consent, [{ id: cur.id, fields: f as never }]); else await this.grist.add(this.docId, BT.consent, [f as never]);
      fixed++;
    }
    if (fixed) console.error(`FLOW HQ booking: consent state repaired from the history for ${fixed} phone(s) after an interrupted change`);
    return fixed;
  }
  async start(): Promise<void> { await super.start(); await this.repairConsentState().catch(() => 0); }
}
