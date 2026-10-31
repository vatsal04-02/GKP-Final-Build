// The booking service: the ONE place that creates, moves or cancels an appointment (n8n / WhatsApp AI through the service API, staff through
// the CRM from Slice 3). It reads availability from the pure engine, and for every write it:
//   1. takes the lock, 2. reads fresh data, 3. re-checks the slot, 4. writes, 5. re-reads and VERIFIES the write, 6. audits.
// A booking is reported as made only after step 5. It never creates a patient or a lead.
//
// !! The Mutex below serialises writes inside THIS process only. It is safe only while ONE FLOW HQ backend process writes appointments.
// !! Two instances (or any other writer, e.g. W13 booking_mode=direct) could book the same slot at the same time. Step 5 detects and undoes
// !! such a collision after the fact (the later row loses), but that is a safety net, not a substitute: run exactly one instance.
import { BackendError, type GristClient, type GristRecord } from '../grist';
import { bad, maxSeq, Mutex, pad } from '../records/ids';
import { normalizePhone } from '../adapters/autopilot/shared';
import { dayKey, localParts } from '../time';
import { BT, WEEKDAY_CHOICES } from './schema';
import { can, limitedToOwnDoctor, type Right } from './permissions';
import { AuditOutbox, MemoryStore } from './outbox';
import { toAppt, toBlock, toDoctor, toSchedule } from './mappers';
import {
  appointmentsInSlot, bookableSlots, checkSlot, dayAvailability, displayStatus, doctorByName, occupiesSlot, parseBookingSettings, parseSlotId, slotId, SHIFTS,
  type Channel, type DayAvailability, type DisplayStatus, type EngineInput, type Shift, type Slot, type SlotCheck,
} from './engine';

// A staff actor carries the signed-in user's role (and doctor login, if any): the service enforces src/server/booking/permissions.ts itself.
// No role = plain staff (never admin).
export interface BookingActor { kind: 'service' | 'staff'; id: string; name: string; source: 'WhatsApp AI' | 'Staff' | 'Other'; role?: 'admin' | 'staff'; clinician?: string; doctorId?: string; grants?: string[] }
export type Unavailable = 'disabled' | 'config_invalid' | 'config_unavailable';
export interface BookingOptions { tz: string; now?: () => number; leadsTable?: string; patientsTable?: string; outbox?: AuditOutbox }   // outbox: the durable audit outbox (production); omitted = a volatile one (tests, demo)

export interface SlotView { slot_id: string; date: string; start_time: string; end_time: string; doctor_id: string; doctor_name: string; shift: Shift; remaining_capacity: number }
export interface AppointmentView {
  booking_reference: string; status: DisplayStatus; date: string; start_time: string; end_time: string; start: string; end: string;
  doctor_id: string | null; doctor_name: string | null; shift: Shift | null; slot_id: string | null;
  patient: { name: string; phone_masked: string }; reason: string; service: string; source: string; created_at: string | null; updated_at: string | null;
}
// patientId / stage are for staff bookings: the register patient this is for (must exist, its phone must match), and whether it starts as Pending confirmation.
export interface CreateInput { slotId: string; patientName: string; patientPhone: string; reason?: string; service?: string; idempotencyKey: string; patientId?: string; stage?: 'Pending confirmation' | 'Confirmed'; holdForPayment?: boolean }

export class ConfigUnavailable extends Error {}
// cfg = the raw Booking_Config rows; setting = what the admin's switch says (the AI may still be failed closed: ai.available is what counts)
export interface State { input: EngineInput; rows: GristRecord[]; cfg: GristRecord[]; setting: boolean; problems: string[]; ai: { available: boolean; reason: Unavailable | null } }

const t = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());
/** The doctor a doctor-login IS, for booking rights. By the stable Doctor_ID the admin set on the user (`doctorId`). Transitional fallback for a login that
 *  only has the older `clinician` name: an EXACT match (ignoring case and spaces) to exactly ONE doctor. No partial or "contains" matching: a vague name gets no rights. */
export function ownDoctor<D extends { id: string; name: string }>(a: { doctorId?: string; clinician?: string }, doctors: D[]): D | null {
  if (a.doctorId) return doctors.find((d) => d.id === a.doctorId) || null;
  const want = t(a.clinician).toLowerCase().replace(/\s+/g, ' '); if (!want) return null;
  const hit = doctors.filter((d) => d.name.trim().toLowerCase().replace(/\s+/g, ' ') === want);
  return hit.length === 1 ? hit[0]! : null;
}
const iso = (sec: unknown) => (typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString() : null);
const blank = (r: GristRecord) => Object.values(r.fields).every((v) => v === null || v === undefined || v === '' || v === false || v === 0);
const IDEM_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const maskPhone = (p: string) => (p.length >= 4 ? `${p.slice(0, 3)}${'*'.repeat(Math.max(0, p.length - 7))}${p.slice(-4)}` : '****');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class BookingService {
  protected lock = new Mutex();
  constructor(protected grist: GristClient, protected docId: string, protected o: BookingOptions) { this.outbox = o.outbox || new AuditOutbox(new MemoryStore(), { ...(o.now ? { now: o.now } : {}) }); }
  protected now() { return this.o.now ? this.o.now() : Date.now(); }
  protected ts() { return Math.floor(this.now() / 1000); }
  protected rows(table: string) { return this.grist.records(this.docId, table); }
  protected channelOf(a: BookingActor): Channel { return a.kind === 'service' ? 'ai' : 'staff'; }

  // ---------------------------------------------------------------- reading the whole picture (always fresh)
  protected async state(): Promise<State> {
    let cfg: GristRecord[]; let docs: GristRecord[]; let sch: GristRecord[]; let blk: GristRecord[]; let apt: GristRecord[];
    try { [cfg, docs, sch, blk, apt] = await Promise.all([BT.config, BT.doctors, BT.schedules, BT.blocks, BT.appointments].map((x) => this.rows(x))); }
    catch (e) {
      if (e instanceof BackendError && e.status === 404) throw new ConfigUnavailable();   // a booking table is missing: not provisioned
      throw bad('booking_unavailable', 'The booking system cannot reach its data right now. Try again shortly.', 503);
    }
    const { settings, problems } = parseBookingSettings(cfg.map((r) => r.fields));
    const live = (rs: GristRecord[]) => rs.filter((r) => !blank(r));
    const doctors = live(docs).map(toDoctor); const schedules = live(sch).map(toSchedule); const blocks = live(blk).map(toBlock);
    // any configuration row we cannot read could hide a closure or a leave: the AI fails closed rather than guess
    for (const [name, list] of [[BT.doctors, doctors], [BT.schedules, schedules], [BT.blocks, blocks]] as const) { const n = list.filter((x) => x === null).length; if (n) problems.push(`${name}: ${n} unreadable row(s)`); }
    const ai = problems.length ? { available: false, reason: 'config_invalid' as const } : !settings.aiBookingEnabled ? { available: false, reason: 'disabled' as const } : { available: true, reason: null };
    return {
      rows: apt, cfg, setting: settings.aiBookingEnabled, problems, ai,
      input: { settings: { ...settings, aiBookingEnabled: ai.available }, doctors: doctors.filter((x) => x !== null), schedules: schedules.filter((x) => x !== null), blocks: blocks.filter((x) => x !== null), appointments: apt.map(toAppt).filter((x) => x !== null), now: this.now() },
    };
  }
  protected closedState(): State {   // what the AI is told when the booking tables cannot be read at all
    const { settings } = parseBookingSettings([]);
    return { rows: [], cfg: [], setting: false, problems: ['The booking tables are not set up'], ai: { available: false, reason: 'config_unavailable' }, input: { settings, doctors: [], schedules: [], blocks: [], appointments: [], now: this.now() } };
  }
  protected async stateOrClosed(): Promise<State> { try { return await this.state(); } catch (e) { if (e instanceof ConfigUnavailable) return this.closedState(); throw e; } }
  protected async stateFor(a: BookingActor): Promise<State> {
    try { return await this.state(); }
    catch (e) { if (e instanceof ConfigUnavailable) throw a.kind === 'service' ? bad('ai_booking_disabled', 'AI booking is not available right now', 403, { reason: 'config_unavailable' }) : bad('booking_unavailable', 'The booking tables are not set up for this clinic', 503); throw e; }
  }

  // ---------------------------------------------------------------- views
  /** The doctor an appointment row belongs to: its Doctor_ID, or (older Cal.com / W4 rows) the one its Physio name points at. */
  protected doctorIdOf(r: GristRecord, st: State): string | null { return t(r.fields.Doctor_ID) || doctorByName(t(r.fields.Physio), st.input.doctors)?.id || null; }
  protected slotView(s: Slot): SlotView { return { slot_id: s.slotId, date: s.date, start_time: s.start, end_time: s.end, doctor_id: s.doctorId, doctor_name: s.doctorName, shift: s.shift, remaining_capacity: s.remaining }; }
  protected hhmm(sec: number) { const p = localParts(sec * 1000, this.o.tz); return `${pad(p.h, 2)}:${pad(p.mi, 2)}`; }
  protected view(r: GristRecord, st: State, leadName = ''): AppointmentView {
    const f = r.fields; const start = typeof f.Start === 'number' ? f.Start : 0; const end = typeof f.End === 'number' && f.End > start ? f.End : start;
    const doc = st.input.doctors.find((d) => d.id === t(f.Doctor_ID)) || doctorByName(t(f.Physio), st.input.doctors);
    const uid = t(f.Booking_UID); const shift = t(f.Shift).toLowerCase();
    const phone = normalizePhone(t(f.Patient_Phone)).phone || '';
    const date = dayKey(start * 1000, this.o.tz); const st0 = this.hhmm(start);
    return {
      booking_reference: uid, status: displayStatus(t(f.Status), t(f.Appt_Stage)), date, start_time: st0, end_time: this.hhmm(end), start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString(),
      doctor_id: doc?.id || null, doctor_name: t(f.Physio) || doc?.name || null, shift: (SHIFTS as string[]).includes(shift) ? (shift as Shift) : null, slot_id: doc ? slotId(doc.id, date, st0) : null,
      patient: { name: t(f.Patient_Name) || leadName, phone_masked: maskPhone(phone) }, reason: t(f.Reason), service: t(f.Service),
      source: t(f.Booking_Source) || (uid.startsWith('wa-') ? 'WhatsApp AI' : 'Cal.com'), created_at: iso(f.Created_At), updated_at: iso(f.Updated_At),
    };
  }
  protected updatedAvailability(st: State, date: string, doctorId: string | undefined, channel: Channel) {
    const day = dayAvailability(st.input, date, { channel, ...(doctorId ? { doctorId } : {}) });
    return { date, closed: day.closed, slots: bookableSlots(day).map((x) => this.slotView(x)) };
  }
  protected refusal(chk: Extract<SlotCheck, { ok: false }>, st: State, ref: { date: string; doctorId: string }, channel: Channel) {
    if (chk.reason === 'ai_disabled') return bad('ai_booking_disabled', 'AI booking is switched off', 403, { reason: st.ai.reason || 'disabled' });
    if (chk.reason === 'invalid_date') return bad('invalid_date', 'The date is not a real calendar date', 400);
    return bad('slot_unavailable', 'That time cannot be booked', 409, { reason: chk.reason, ...(chk.closed ? { closed: chk.closed } : {}), availability: this.updatedAvailability(st, ref.date, ref.doctorId, channel) });
  }

  // ---------------------------------------------------------------- audit: the durable outbox (src/server/booking/outbox.ts)
  // Every booking mutation is written ahead as an INTENT (fsynced) before anything changes; if that cannot be saved the mutation is refused (503
  // audit_unavailable) and nothing is written. The Grist write stores the same Audit_ID on the row, so a crash can always be resolved: the row either has
  // the id (applied) or not (aborted). The outcome is recorded after the read-back; flushing to Booking_Audit is idempotent by Audit_ID. A saved
  // appointment is never reported as failed because of audit. Entries hold no patient name, phone, free text, idempotency key or secret.
  protected outbox: AuditOutbox;
  private flushLoop: Promise<void> | null = null; private flushAgain = false; private timer: ReturnType<typeof setInterval> | null = null;
  auditHealth() { return this.outbox.health(); }
  /** Open the outbox, recover any operation a crash left half-finished, flush, and keep flushing every 30 s. Safe to call more than once. */
  async start(): Promise<void> {
    let opened = true;
    try { await this.outbox.open(); } catch (e) { opened = false; console.error(`FLOW HQ AUDIT OUTBOX: not available (${(e as Error).message}); bookings are refused until it is. Trying again every 30 s.`); }
    if (opened) await this.flushAudit();
    // the 30 s loop also re-opens the outbox (flushOnce), so a temporary failure heals itself
    if (!this.timer) { this.timer = setInterval(() => { void this.flushAudit(); }, 30000); this.timer.unref?.(); }
  }
  async stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } await this.outbox.close(); }
  /** Resolve operations a crash left without an outcome (by the Audit_ID on the target row), then write completed entries to Booking_Audit. */
  flushAudit(): Promise<void> {
    if (this.flushLoop) { this.flushAgain = true; return this.flushLoop; }
    this.flushLoop = (async () => { do { this.flushAgain = false; await this.flushOnce(); } while (this.flushAgain); })().finally(() => { this.flushLoop = null; });
    return this.flushLoop;
  }
  private async flushOnce(): Promise<void> {
    try { await this.outbox.open(); } catch { return; }   // surfaced by health()
    try {
      await this.outbox.retryUnsavedOutcomes();
      for (const e of this.outbox.openIntents()) {   // an intent with no outcome and nobody working on it: a crash, or a write whose fate was unknown
        const rows = await this.grist.records(this.docId, e.table, { filter: { Audit_ID: [e.id] } });
        await this.outbox.outcome(e.id, rows.length ? { outcome: 'ok', reason: 'recovered' } : { outcome: 'aborted', reason: 'not_applied' });
      }
      const pending = this.outbox.pendingFlush(); if (!pending.length) return;
      // entries that might already be in Grist (found in the log after a restart, or after an uncertain insert) are looked up by Audit_ID first: no duplicates
      const maybe = pending.filter((e) => e.suspect); const have = new Set<string>();
      if (maybe.length) for (const r of await this.grist.records(this.docId, BT.audit, { filter: { Audit_ID: maybe.map((e) => e.id) } })) have.add(t(r.fields.Audit_ID));
      const fresh = pending.filter((e) => !have.has(e.id));
      if (fresh.length) {
        try {
          await this.grist.add(this.docId, BT.audit, fresh.map((e) => ({ At: e.at, Actor: e.actor, Source: e.source, Action: e.action, Record: e.outcome?.record || e.record, Outcome: e.outcome!.outcome === 'ok' ? 'ok' : 'rejected', Reason: e.outcome!.reason.slice(0, 80), Detail: JSON.stringify({ ...e.detail, ...(e.outcome!.detail || {}) }).slice(0, 400), Audit_ID: e.id })) as never);
        } catch (err) { this.outbox.markSuspect(fresh.map((e) => e.id)); throw err; }   // it may or may not have landed: the next pass checks by Audit_ID
        const back = new Set((await this.grist.records(this.docId, BT.audit, { filter: { Audit_ID: fresh.map((e) => e.id) } })).map((r) => t(r.fields.Audit_ID)));
        for (const e of fresh) if (!back.has(e.id)) throw new Error('audit rows could not be read back after writing');
      }
      await this.outbox.markFlushed(pending.map((e) => e.id));
    } catch (err) {
      this.outbox.noteFlushFailure(err);
      const h = this.outbox.health();
      console.error(`FLOW HQ booking: AUDIT WRITE FAILED; ${h.waiting_to_flush + h.open_intents} entr${h.waiting_to_flush + h.open_intents === 1 ? 'y' : 'ies'} waiting to retry, ${h.failed_since_start} failure(s) since start`);   // counts only: nothing about who or what
    }
  }
  /** Begin / finish the audited operations of one request. Refusals and replays are recorded as single events. */
  protected newScope(a: BookingActor, action: string, detail: Record<string, unknown>): OpScope { return new OpScope(this.outbox, a, action, detail); }
  /** Staff may only do what permissions.ts allows; a doctor's login only for its own doctor (doctorId). Throws 403. */
  protected guard(a: BookingActor, right: Right, doctorId?: string | null, doctors: Array<{ id: string; name: string }> = []) {
    if (a.kind !== 'staff') return;
    if (!can(a, right)) throw bad('forbidden', right === 'appointments:write' ? 'You cannot change appointments' : right === 'blocks:write' ? 'You cannot change leave or blocked time' : right === 'consent:record_yes' ? 'Recording a reminder-consent Yes needs permission: ask an admin to grant it' : right === 'consent:correct' ? 'Only an admin can correct or revoke recorded consent' : 'Only an admin can do this', 403);
    if (right === 'appointments:write' && limitedToOwnDoctor(a)) {
      const mine = ownDoctor(a, doctors);   // by the stable Doctor_ID, never by a loose name match
      if (!mine) throw bad('forbidden', 'Your login is not linked to a doctor, so you can only view. Ask the admin to link it.', 403);
      if (!doctorId || mine.id !== doctorId) throw bad('forbidden', 'You can only manage your own appointments', 403);
    }
  }
  protected async attempt<T>(action: string, a: BookingActor, record: string, detail: Record<string, unknown>, fn: (op: OpScope) => Promise<T>): Promise<T> {
    const op = this.newScope(a, action, detail);
    try { return await fn(op); }
    catch (e) { await op.fail(e, record); throw e; }
    finally { await this.flushAudit(); }   // best effort and awaited: the audit row is normally in Booking_Audit by the time the caller gets its answer
  }

  // ---------------------------------------------------------------- patient links (never created here)
  protected async findLead(phone: string): Promise<number | null> {
    try { return (await this.rows(this.o.leadsTable || 'LEADS')).find((r) => normalizePhone(t(r.fields.Phone)).phone === phone)?.id ?? null; } catch { return null; }
  }
  protected async findPatient(phone: string): Promise<string> {
    try { return t((await this.rows(this.o.patientsTable || 'Patients')).find((r) => normalizePhone(t(r.fields.Phone)).phone === phone)?.fields.Patient_ID); } catch { return ''; }
  }
  protected async ownerPhone(r: GristRecord): Promise<string> {
    const own = normalizePhone(t(r.fields.Patient_Phone)).phone; if (own) return own;
    const lead = typeof r.fields.Lead === 'number' ? r.fields.Lead : 0; if (!lead) return '';
    try { return normalizePhone(t((await this.rows(this.o.leadsTable || 'LEADS')).find((x) => x.id === lead)?.fields.Phone)).phone || ''; } catch { return ''; }
  }
  /** The service may touch an appointment only when the caller can prove the patient's phone. Anything else looks exactly like "not found". */
  protected async owned(r: GristRecord | undefined, a: BookingActor, phone: string | undefined): Promise<GristRecord> {
    if (!r) throw bad('not_found', 'Appointment not found', 404);
    if (a.kind === 'service') {
      const want = normalizePhone(phone || '').phone;
      if (!want || (await this.ownerPhone(r)) !== want) throw bad('not_found', 'Appointment not found', 404);
    }
    return r;
  }

  // ---------------------------------------------------------------- read endpoints
  async config(): Promise<Record<string, unknown>> {
    const st = await this.stateOrClosed(); const s = st.input.settings;
    return {
      ai_booking: { enabled: st.ai.available, reason: st.ai.reason }, booking_enabled: st.ai.available, timezone: s.timezone,
      operating_days: s.operatingDays.map((d) => WEEKDAY_CHOICES[d - 1]), open_windows: s.openWindows.map((w) => ({ start_time: w.start, end_time: w.end })),
      slot_minutes: s.slotMinutes, buffer_minutes: s.bufferMinutes, capacity: s.capacity, min_notice_minutes: s.minNoticeMinutes, cancel_min_notice_minutes: s.cancelNoticeMinutes, max_advance_days: s.maxAdvanceDays,
      shifts: { morning: { enabled: s.shiftEnabled.morning }, evening: { enabled: s.shiftEnabled.evening } },
      doctors: st.input.doctors.map((d) => ({ doctor_id: d.id, name: d.name, qualification: d.qualification, active: d.active, default_shift: d.defaultShift })),
      schedules: st.input.schedules.map((r) => ({ schedule_id: r.id, doctor_id: r.doctorId, weekday: WEEKDAY_CHOICES[r.weekday - 1], shift: r.shift, start_time: r.start, end_time: r.end, slot_minutes: r.slotMinutes, buffer_minutes: r.bufferMinutes, capacity: r.capacity, effective_from: r.from, effective_to: r.to, active: r.active, is_override: r.isOverride })),
      config_problems: st.problems,
    };
  }
  async availability(q: { date: string; doctorId?: string; shift?: string }): Promise<{ date: string; timezone: string; ai_booking: { available: boolean; reason: Unavailable | null }; closed: DayAvailability['closed']; slots: SlotView[]; generated_at: string }> {
    if (q.shift !== undefined && !(SHIFTS as string[]).includes(q.shift)) throw bad('invalid_shift', 'shift must be morning or evening', 400);
    const st = await this.stateOrClosed();
    const day = dayAvailability(st.input, q.date, { channel: 'ai', ...(q.doctorId ? { doctorId: q.doctorId } : {}), ...(q.shift ? { shift: q.shift as Shift } : {}) });
    if (day.closed === 'invalid_date') throw bad('invalid_date', 'date must be a real date like 2026-10-08', 400);
    return { date: q.date, timezone: st.input.settings.timezone, ai_booking: { available: st.ai.available, reason: st.ai.reason }, closed: day.closed, slots: bookableSlots(day).map((x) => this.slotView(x)), generated_at: new Date(this.now()).toISOString() };
  }
  async get(ref: string, phone: string | undefined, a: BookingActor): Promise<AppointmentView> {
    const st = await this.stateFor(a);
    const r = await this.owned(st.rows.find((x) => t(x.fields.Booking_UID) === ref), a, phone);
    return this.view(r, st);
  }

  // ---------------------------------------------------------------- create
  async create(i: CreateInput, a: BookingActor): Promise<{ appointment: AppointmentView; replayed: boolean }> {
    const detail = { slot: String(i.slotId).slice(0, 60), source: a.source };   // never the idempotency key, the patient or any free text
    return this.attempt('create', a, String(i.slotId).slice(0, 60), detail, async (op) => {
      if (!IDEM_RE.test(String(i.idempotencyKey || ''))) throw bad('invalid_idempotency_key', 'An idempotency key of 8 to 64 characters (letters, digits . _ : -) is required', 400);
      const slot = parseSlotId(i.slotId); if (!slot) throw bad('invalid_slot_id', 'slot_id must be one returned by the availability endpoint', 400);
      const name = t(i.patientName).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ');
      if (name.length < 1 || name.length > 120) throw bad('invalid_patient', 'Patient name is required (up to 120 characters)', 400);
      const normalised = normalizePhone(String(i.patientPhone || '')); if (!normalised.valid || !normalised.phone) throw bad('invalid_phone', 'Enter a valid Indian mobile number (10 digits starting 6-9)', 400);
      const ph = { phone: normalised.phone };   // a plain string from here on
      const reason = t(i.reason).slice(0, 300); const service = (t(i.service) || 'Physiotherapy').slice(0, 120);
      const channel = this.channelOf(a);

      return this.lock.run(async () => {
        const st = await this.stateFor(a);
        this.guard(a, 'appointments:write', slot.doctorId, st.input.doctors);   // staff: the signed-in user's role (a doctor's login: only its own doctor)
        // an exact retry gets the ORIGINAL result, whatever has happened since (even if the slot is full now, or the AI switch is off)
        const prior = st.rows.find((r) => t(r.fields.Idem_Key) === i.idempotencyKey);
        if (prior) {
          if (t(prior.fields.Slot_Key) !== i.slotId || normalizePhone(t(prior.fields.Patient_Phone)).phone !== ph.phone) throw bad('idempotency_conflict', 'This idempotency key was already used for a different booking', 409);
          await op.event('ok', 'replayed', t(prior.fields.Booking_UID));
          return { appointment: this.view(prior, st), replayed: true };
        }
        if (channel === 'ai' && !st.ai.available) throw bad('ai_booking_disabled', 'AI booking is switched off', 403, { reason: st.ai.reason });
        const chk = checkSlot(st.input, { date: slot.date, doctorId: slot.doctorId, start: slot.start }, channel);
        if (!chk.ok) throw this.refusal(chk, st, slot, channel);
        const twin = st.rows.find((r) => occupiesSlot(t(r.fields.Status)) && t(r.fields.Slot_Key) === i.slotId && normalizePhone(t(r.fields.Patient_Phone)).phone === ph.phone);
        if (twin) throw bad('duplicate_booking', 'This patient already has a booking in that slot', 409, { booking_reference: t(twin.fields.Booking_UID) });

        const seq = maxSeq(st.rows.map((r) => t(r.fields.Booking_UID).replace(/^wa-/, '')), 'GKA-') + 1;
        const uid = `${a.source === 'WhatsApp AI' ? 'wa-' : ''}GKA-${pad(seq)}`;
        const doctor = chk.slot.doctorName; const lead = await this.findLead(ph.phone);
        let patientId = await this.findPatient(ph.phone);
        if (a.kind === 'staff' && i.patientId) {   // staff picked a register patient: it must exist and its phone must match (no patient is ever created here)
          const p = (await this.rows(this.o.patientsTable || 'Patients').catch(() => [] as GristRecord[])).find((r) => t(r.fields.Patient_ID) === i.patientId);
          if (!p) throw bad('invalid_patient', 'That patient is not in the register', 400);
          const pp = normalizePhone(t(p.fields.Phone)).phone; if (pp && pp !== ph.phone) throw bad('patient_mismatch', 'That phone number does not match the patient record', 400);
          patientId = i.patientId;
        }
        const auditId = await op.begin(BT.appointments, uid);   // write-ahead: if this cannot be saved nothing below runs
        const fields: Record<string, unknown> = {
          Booking_UID: uid, Audit_ID: auditId, ...(lead ? { Lead: lead } : {}), Service: service, Physio: doctor, Start: chk.slot.startSec, End: chk.slot.endSec, Status: 'Booked',
          Patient_ID: patientId, Patient_Name: name, Patient_Phone: ph.phone, Doctor_ID: slot.doctorId, Shift: cap(chk.slot.shift), Slot_Key: i.slotId,
          Booking_Source: a.source, Appt_Stage: (a.kind === 'staff' || i.holdForPayment === true) && i.stage === 'Pending confirmation' ? 'Pending confirmation' : 'Confirmed', Reason: reason, Idem_Key: i.idempotencyKey, Created_At: this.ts(), Updated_At: this.ts(), Created_By: a.id,
        };
        const [id] = await this.grist.add(this.docId, BT.appointments, [fields as never]);

        // VERIFY: read it back. Only now is it a booking.
        const fresh = await this.rows(BT.appointments);
        const row = typeof id === 'number' ? fresh.find((r) => r.id === id) : undefined;
        if (!row || t(row.fields.Booking_UID) !== uid || t(row.fields.Idem_Key) !== i.idempotencyKey || row.fields.Start !== chk.slot.startSec) {
          console.error(`FLOW HQ booking: write of ${uid} could not be verified`);
          throw bad('write_unverified', 'The booking could not be confirmed as saved. Do not tell the patient it is booked. Retry with the same idempotency key.', 502);
        }
        // Someone else (a second process, Cal.com/W4, W13 direct) may have taken the slot between our check and our write: the later row loses.
        const live = { doctors: st.input.doctors, appointments: fresh.map(toAppt).filter((x) => x !== null) };
        const holders = appointmentsInSlot(live, slot.doctorId, chk.slot.startSec, chk.slot.endSec).sort((x, y) => Number(x.id) - Number(y.id));
        if (holders.findIndex((h) => h.id === String(id)) >= chk.slot.capacity) {
          await this.grist.update(this.docId, BT.appointments, [{ id: id as number, fields: { Status: 'Cancelled', Cancel_Reason: 'Slot was taken by a booking written at the same time', Updated_At: this.ts() } }]);
          throw bad('slot_unavailable', 'That time was just taken', 409, { reason: 'slot_full', availability: this.updatedAvailability({ ...st, input: { ...st.input, appointments: live.appointments.filter((x) => x.id !== String(id)) } }, slot.date, slot.doctorId, channel) });
        }
        await op.done(auditId, 'created', uid);
        return { appointment: this.view(row, st), replayed: false };
      });
    });
  }

  // ---------------------------------------------------------------- reschedule
  async reschedule(ref: string, i: { slotId: string; patientPhone?: string; reason?: string }, a: BookingActor): Promise<{ appointment: AppointmentView; replayed: boolean }> {
    const detail = { slot: String(i.slotId).slice(0, 60), source: a.source };
    return this.attempt('reschedule', a, ref, detail, async (op) => {
      const slot = parseSlotId(i.slotId); if (!slot) throw bad('invalid_slot_id', 'slot_id must be one returned by the availability endpoint', 400);
      const channel = this.channelOf(a);
      return this.lock.run(async () => {
        const st = await this.stateFor(a);
        const row = await this.owned(st.rows.find((x) => t(x.fields.Booking_UID) === ref), a, i.patientPhone);
        this.guard(a, 'appointments:write', this.doctorIdOf(row, st), st.input.doctors); this.guard(a, 'appointments:write', slot.doctorId, st.input.doctors);   // staff: allowed to move it, and to put it there
        const status = displayStatus(t(row.fields.Status), t(row.fields.Appt_Stage));
        if (status === 'Cancelled' || status === 'Completed' || status === 'No-show') throw bad('not_reschedulable', `A ${status.toLowerCase()} appointment cannot be moved`, 409);
        if (t(row.fields.Slot_Key) === i.slotId) { await op.event('ok', 'replayed', ref); return { appointment: this.view(row, st), replayed: true }; }   // already there: a retry
        if (channel === 'ai') {
          if (!st.ai.available) throw bad('ai_booking_disabled', 'AI booking is switched off', 403, { reason: st.ai.reason });
          const start = typeof row.fields.Start === 'number' ? row.fields.Start : 0;
          if (st.input.settings.cancelNoticeMinutes > 0 && start - this.ts() < st.input.settings.cancelNoticeMinutes * 60) throw bad('change_too_late', `Appointments can be changed up to ${st.input.settings.cancelNoticeMinutes} minutes before they start`, 409);
        }
        const without: EngineInput = { ...st.input, appointments: st.input.appointments.filter((x) => x.id !== String(row.id)) };   // this appointment is leaving its old slot
        const chk = checkSlot(without, { date: slot.date, doctorId: slot.doctorId, start: slot.start }, channel);
        if (!chk.ok) throw this.refusal(chk, { ...st, input: without }, slot, channel);
        const old = { ...row.fields };
        const auditId = await op.begin(BT.appointments, ref);   // write-ahead: if this cannot be saved nothing below runs
        const next = { Audit_ID: auditId, Start: chk.slot.startSec, End: chk.slot.endSec, Physio: chk.slot.doctorName, Doctor_ID: slot.doctorId, Shift: cap(chk.slot.shift), Slot_Key: i.slotId, Status: 'Booked', Appt_Stage: 'Confirmed',
          R24_Sent: null, R2_Sent: null, ...(i.reason ? { Reason: t(i.reason).slice(0, 300) } : {}), Updated_At: this.ts() };   // a new time needs new reminders (W5 only reminds Status = Booked)
        await this.grist.update(this.docId, BT.appointments, [{ id: row.id, fields: next as never }]);

        const fresh = await this.rows(BT.appointments); const after = fresh.find((r) => r.id === row.id);
        if (!after || after.fields.Start !== next.Start || t(after.fields.Slot_Key) !== i.slotId) { console.error(`FLOW HQ booking: reschedule of ${ref} could not be verified`); throw bad('write_unverified', 'The change could not be confirmed as saved. Check the appointment before telling the patient.', 502); }
        const live = { doctors: st.input.doctors, appointments: fresh.map(toAppt).filter((x) => x !== null) };
        // A moved appointment keeps its old row id, so "lowest id wins" would be wrong here: whoever was already in the slot keeps it, the mover yields.
        const already = appointmentsInSlot(live, slot.doctorId, chk.slot.startSec, chk.slot.endSec).filter((h) => h.id !== String(row.id));
        if (already.length >= chk.slot.capacity) {
          await this.grist.update(this.docId, BT.appointments, [{ id: row.id, fields: { Start: old.Start, End: old.End, Physio: old.Physio, Doctor_ID: old.Doctor_ID, Shift: old.Shift, Slot_Key: old.Slot_Key, Status: old.Status, Appt_Stage: old.Appt_Stage, Audit_ID: old.Audit_ID ?? null, R24_Sent: old.R24_Sent ?? null, R2_Sent: old.R2_Sent ?? null, Reason: old.Reason, Updated_At: old.Updated_At ?? null } as never }]);
          throw bad('slot_unavailable', 'That time was just taken; the appointment was left where it was', 409, { reason: 'slot_full', availability: this.updatedAvailability({ ...st, input: without }, slot.date, slot.doctorId, channel) });
        }
        await op.done(auditId, 'moved', ref, { from: t(old.Slot_Key).slice(0, 60) });
        return { appointment: this.view(after, st), replayed: false };
      });
    });
  }

  // ---------------------------------------------------------------- cancel
  async cancel(ref: string, i: { patientPhone?: string; reason?: string }, a: BookingActor): Promise<{ appointment: AppointmentView; alreadyCancelled: boolean }> {
    const detail = { source: a.source };
    return this.attempt('cancel', a, ref, detail, async (op) => this.lock.run(async () => {
      const st = await this.stateFor(a);
      // the AI path is read-only while AI booking is off: it cannot create, move OR cancel. Staff cancellation is never gated by this switch.
      if (this.channelOf(a) === 'ai' && !st.ai.available) throw bad('ai_booking_disabled', 'AI booking is switched off', 403, { reason: st.ai.reason });
      const row = await this.owned(st.rows.find((x) => t(x.fields.Booking_UID) === ref), a, i.patientPhone);
      this.guard(a, 'appointments:write', this.doctorIdOf(row, st), st.input.doctors);
      const status = displayStatus(t(row.fields.Status), t(row.fields.Appt_Stage));
      if (status === 'Cancelled') { await op.event('ok', 'already_cancelled', ref); return { appointment: this.view(row, st), alreadyCancelled: true }; }
      if (status === 'Completed' || status === 'No-show') throw bad('not_cancellable', `A ${status.toLowerCase()} appointment cannot be cancelled`, 409);
      if (this.channelOf(a) === 'ai') {   // clinic policy for patient-initiated cancellations (cancel_min_notice_minutes; 0 = no limit)
        const start = typeof row.fields.Start === 'number' ? row.fields.Start : 0; const notice = st.input.settings.cancelNoticeMinutes;
        if (start <= this.ts()) throw bad('not_cancellable', 'That appointment has already started', 409);
        if (notice > 0 && start - this.ts() < notice * 60) throw bad('cancel_too_late', `Appointments can be cancelled up to ${notice} minutes before they start`, 409);
      }
      const auditId = await op.begin(BT.appointments, ref);   // write-ahead: if this cannot be saved nothing below runs
      await this.grist.update(this.docId, BT.appointments, [{ id: row.id, fields: { Status: 'Cancelled', Cancel_Reason: t(i.reason).slice(0, 200), Audit_ID: auditId, Updated_At: this.ts() } as never }]);
      const after = (await this.rows(BT.appointments)).find((r) => r.id === row.id);
      if (!after || displayStatus(t(after.fields.Status), null) !== 'Cancelled') { console.error(`FLOW HQ booking: cancellation of ${ref} could not be verified`); throw bad('write_unverified', 'The cancellation could not be confirmed as saved. Check the appointment before telling the patient.', 502); }
      await op.done(auditId, 'cancelled', ref);
      return { appointment: this.view(after, st), alreadyCancelled: false };
    }));
  }
}

/** The audited operations of ONE request. `begin` is the write-ahead intent (throws 503 audit_unavailable if it cannot be saved: the caller must not mutate);
 *  `done` records the verified outcome; `event` records a refusal or a replay; `fail` closes whatever is still open when the request fails. */
export class OpScope {
  private open = new Set<string>(); private began = false; private logged = false;
  constructor(private outbox: AuditOutbox, readonly a: BookingActor, readonly action: string, readonly detail: Record<string, unknown>) {}
  private who() { return { actor: this.a.kind === 'service' ? `token:${this.a.id}` : this.a.id, source: this.a.kind === 'service' ? 'API' : 'Staff' }; }
  async begin(table: string, record: string, detail: Record<string, unknown> = this.detail, action: string = this.action): Promise<string> {
    try { const id = await this.outbox.intent({ ...this.who(), action, record: record.slice(0, 80), table, detail }); this.open.add(id); this.began = true; return id; }
    catch { throw bad('audit_unavailable', 'Bookings are paused because the audit log cannot be saved right now. Nothing was changed. An admin can see this on the Schedule page.', 503); }
  }
  async done(id: string, reason: string, record?: string, detail?: Record<string, unknown>) {
    this.open.delete(id); this.logged = true;
    await this.outbox.outcome(id, { outcome: 'ok', reason: reason.slice(0, 80), ...(record ? { record: record.slice(0, 80) } : {}), ...(detail ? { detail } : {}) });   // never throws: a verified change is never reported failed because of audit
  }
  async event(outcome: 'ok' | 'rejected', reason: string, record: string, detail: Record<string, unknown> = this.detail) {
    this.logged = true; await this.outbox.event({ ...this.who(), action: this.action, record: record.slice(0, 80), table: '', detail, outcome, reason: reason.slice(0, 80) });
  }
  async fail(e: unknown, record: string) {
    const code = e instanceof BackendError ? e.code : 'internal';
    if (code === 'audit_unavailable') return;   // nothing was begun and there is nowhere to write; the caller already has the 503
    // A clean refusal (4xx) after the intent means the mutation did not happen. Anything else (unverified write, backend 5xx, an unexpected error) may or may not
    // have been applied: leave the intent open and let recovery decide by the Audit_ID on the row.
    const definitive = e instanceof BackendError && e.status >= 400 && e.status < 500;
    for (const id of this.open) { if (definitive) await this.outbox.outcome(id, { outcome: 'rejected', reason: code }); else this.outbox.release(id); }
    this.open.clear();
    if (!this.began && !this.logged) await this.event('rejected', code, record);
  }
}
