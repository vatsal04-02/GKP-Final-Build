// The payment service: UPI payment requests for bookings, screenshot intake, advisory screenshot checks, staff review, refunds, expiry.
// RULES (docs/payments.md): a screenshot, an OCR result or an AI score is NEVER proof of payment. PAID is set only by (a) a signed-in staff user who confirms the money is in the
// clinic's bank account, or (b) a cryptographically signed provider event. Payment status is stored apart from the appointment status. Every step writes an append-only
// Payment_Events row FIRST (write-ahead); a failed step adds a 'failed' event. Nothing here sends a message: n8n reads outbox() and sends through W12.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GristClient, GristRecord } from '../grist';
import { bad, maxSeq, Mutex, pad } from '../records/ids';
import { normalizePhone } from '../adapters/autopilot/shared';
import { displayStatus } from '../booking/engine';
import { can } from '../booking/permissions';
import type { BookingActor } from '../booking/service';
import type { StaffBooking } from '../booking/staff-service';
import { OPEN_STATUSES, PT, type PaymentStatus } from './schema';
import { MAX_IMAGE_BYTES, PATIENT_STATUS, assess, cleanUtr, editedBySoftware, sha256, sniffImage, toPaise, utrLooksValid, type Extraction } from './assess';

export interface PaymentOptions { now?: () => number; filesDir: string; qrFile?: string; webhookSecret?: string; tz?: string }
export interface PaymentSettings { enabled: boolean; authorized: boolean; feePaise: number; expiryMin: number; reviewHoldMin: number; payee: string; note: string }
const t = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const on = (v: unknown) => ['on', 'true', 'yes', '1'].includes(t(v).toLowerCase());
const SYSTEM: BookingActor = { kind: 'staff', id: 'system:payments', name: 'Payments (automatic)', source: 'Staff', role: 'admin' };
const FILE_RE = /^\d{6}\/[0-9a-f]{32}\.(jpg|png|webp)$/;
const rupees = (paise: number) => (paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2));
export const DEFAULT_PAYEE = 'VATSAL TRIPATHI';

export interface PaymentView { payment_ref: string; payment_id: string; status: PaymentStatus; patient_status: string; patient_message: string; amount_inr: string; expires_at: string | null; can_upload: boolean; appointment: { status: string; date: string; start_time: string; doctor_name: string | null } | null }

export class PaymentService {
  private lock = new Mutex();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private grist: GristClient, private docId: string, private booking: StaffBooking, private o: PaymentOptions) {}
  private now() { return this.o.now ? this.o.now() : Date.now(); }
  private ts() { return Math.floor(this.now() / 1000); }
  private rows(table: string) { return this.grist.records(this.docId, table); }
  async start() { if (!this.timer) { this.timer = setInterval(() => { void this.tick().catch((e) => console.error(`FLOW HQ payments: housekeeping failed (${(e as Error).message})`)); }, 60000); this.timer.unref?.(); } await this.tick().catch(() => undefined); }
  async stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  // ---------------------------------------------------------------- settings: nothing is shown to a patient until an admin has set ALL of these
  async settings(): Promise<PaymentSettings> {
    let rows: GristRecord[] = []; try { rows = await this.rows('Booking_Config'); } catch { /* not provisioned: everything stays closed */ }
    const m = new Map(rows.map((r) => [t(r.fields.Key), t(r.fields.Value)]));
    const int = (k: string, d: number, lo: number, hi: number) => { const v = Number(m.get(k)); return Number.isInteger(v) && v >= lo && v <= hi ? v : d; };
    return { enabled: on(m.get('payments_enabled')), authorized: on(m.get('payee_authorized')), feePaise: int('consultation_fee_inr', 0, 0, 100000) * 100, expiryMin: int('payment_expiry_minutes', 30, 5, 1440), reviewHoldMin: int('payment_review_hold_minutes', 720, 60, 10080), payee: m.get('payee_name') || DEFAULT_PAYEE, note: m.get('payee_authorization_note') || '' };
  }
  private async qrAvailable() { if (!this.o.qrFile) return false; try { await fs.access(this.o.qrFile); return true; } catch { return false; } }
  /** Why patient-facing payment requests are (not) allowed. The QR is only ever returned when this says open. */
  async gate(): Promise<{ open: boolean; reasons: string[]; settings: PaymentSettings }> {
    const s = await this.settings(); const reasons: string[] = [];
    if (!s.enabled) reasons.push('payments_enabled is off');
    if (!s.authorized) reasons.push('the clinic has not authorized collecting payments into the payee account (payee_authorized is off)');
    if (s.feePaise <= 0) reasons.push('the appointment fee (consultation_fee_inr) is not set');
    if (!(await this.qrAvailable())) reasons.push('the payment QR image is not installed');
    return { open: reasons.length === 0, reasons, settings: s };
  }
  async config(): Promise<Record<string, unknown>> {
    const g = await this.gate();
    return { payments: { required: g.open, state: g.open ? 'open' : 'disabled', reasons: g.open ? [] : g.reasons, fee_inr: g.open ? rupees(g.settings.feePaise) : null, expiry_minutes: g.settings.expiryMin, payee_name: g.open ? g.settings.payee : null } };
  }
  async settingsView(a: BookingActor) {
    if (!can(a, 'settings:write')) throw bad('forbidden', 'Only an admin can see or change payment settings', 403);
    const g = await this.gate(); const s = g.settings;
    return { enabled: s.enabled, payee_authorized: s.authorized, payee_authorization_note: s.note, fee_inr: s.feePaise ? rupees(s.feePaise) : '', expiry_minutes: s.expiryMin, review_hold_minutes: s.reviewHoldMin, payee_name: s.payee, open_to_patients: g.open, closed_because: g.reasons, provider_webhook: !!this.o.webhookSecret };
  }
  async updateSettings(v: Record<string, string>, a: BookingActor) {
    if (!can(a, 'settings:write')) throw bad('forbidden', 'Only an admin can change payment settings', 403);
    const keys = Object.keys(v); const allowed = ['payments_enabled', 'payee_authorized', 'consultation_fee_inr', 'payment_expiry_minutes', 'payment_review_hold_minutes', 'payee_name', 'payee_authorization_note'];
    for (const k of keys) if (!allowed.includes(k)) throw bad('invalid_setting', `Unknown setting: ${k}`, 400);
    const num = (k: string, lo: number, hi: number) => { const x = Number(v[k]); if (!Number.isInteger(x) || x < lo || x > hi) throw bad('invalid_setting', `${k} must be a whole number from ${lo} to ${hi}`, 400); };
    for (const k of ['payments_enabled', 'payee_authorized']) if (k in v && !['on', 'off'].includes(v[k]!)) throw bad('invalid_setting', `${k} must be on or off`, 400);
    if ('consultation_fee_inr' in v) num('consultation_fee_inr', 1, 100000);
    if ('payment_expiry_minutes' in v) num('payment_expiry_minutes', 5, 1440);
    if ('payment_review_hold_minutes' in v) num('payment_review_hold_minutes', 60, 10080);
    if ('payee_name' in v && (t(v.payee_name).length < 3 || t(v.payee_name).length > 80)) throw bad('invalid_setting', 'payee_name must be 3 to 80 characters', 400);
    const cur = await this.settings();
    if (v.payee_authorized === 'on' && !(cur.authorized) && t(v.payee_authorization_note ?? cur.note).length < 10) throw bad('authorization_note_required', 'Recording the clinic\'s authorization needs a note (at least 10 characters) saying who at the clinic authorized it and how', 400);
    if (v.payments_enabled === 'on' && !(v.payee_authorized === 'on' || cur.authorized)) { /* allowed: patients still see nothing until the gate is open */ }
    return this.lock.run(async () => {
      const cfg = await this.rows('Booking_Config'); const stamp = { Updated_At: this.ts(), Updated_By: a.id };
      for (const k of keys) {
        const val = t(v[k]); const row = cfg.find((r) => t(r.fields.Key) === k); const from = row ? t(row.fields.Value) : '';
        if (from === val) continue;
        await this.ev('settings', '', a, 'setting', '', '', 'ok', { key: k, from: k === 'payee_authorization_note' ? '(text)' : from.slice(0, 60), to: k === 'payee_authorization_note' ? '(text)' : val.slice(0, 60) });
        if (row) await this.grist.update(this.docId, 'Booking_Config', [{ id: row.id, fields: { Value: val, ...stamp } }]); else await this.grist.add(this.docId, 'Booking_Config', [{ Key: k, Value: val, ...stamp }]);
        const back = (await this.rows('Booking_Config')).find((r) => t(r.fields.Key) === k);
        if (!back || t(back.fields.Value) !== val) throw bad('write_unverified', 'The setting could not be confirmed as saved', 502);
      }
      return this.settingsView(a);
    });
  }

  // ---------------------------------------------------------------- audit (append-only)
  private async ev(paymentId: string, ref: string, a: BookingActor | { id: string }, action: string, from: string, to: string, outcome: 'ok' | 'failed' | 'rejected', detail: Record<string, unknown> = {}, eventId?: string) {
    const fields = { Event_ID: eventId || randomUUID(), At: this.ts(), Payment_ID: paymentId, Booking_UID: ref, Actor: a.id, Action: action, From_Status: from, To_Status: to, Outcome: outcome, Detail: JSON.stringify(detail).slice(0, 1500) };
    try { await this.grist.add(this.docId, PT.events, [fields as never]); }
    catch (e) { console.error(`FLOW HQ payments: AUDIT EVENT NOT WRITTEN (${action} ${paymentId}): ${(e as Error).message}`); throw bad('audit_unavailable', 'The payment history cannot be written right now, so nothing was changed.', 503); }
  }
  private async patch(row: GristRecord, fields: Record<string, unknown>, ok: (r: GristRecord) => boolean): Promise<GristRecord> {
    await this.grist.update(this.docId, PT.payments, [{ id: row.id, fields: { ...fields, Updated_At: this.ts() } as never }]);
    const back = (await this.rows(PT.payments)).find((r) => r.id === row.id);
    if (!back || !ok(back)) throw bad('write_unverified', 'The change could not be confirmed as saved. Check the payment before relying on it.', 502);
    return back;
  }
  /** Status change = event first, then the write, then a read-back; a failed write is recorded as a failed event. */
  private async move(row: GristRecord, to: PaymentStatus, fields: Record<string, unknown>, a: BookingActor | { id: string }, action: string, detail: Record<string, unknown> = {}) {
    const from = t(row.fields.Status);
    await this.ev(t(row.fields.Payment_ID), t(row.fields.Booking_UID), a, action, from, to, 'ok', detail);
    try { return await this.patch(row, { Status: to, Last_Event_At: this.ts(), ...fields }, (r) => t(r.fields.Status) === to); }
    catch (e) { await this.ev(t(row.fields.Payment_ID), t(row.fields.Booking_UID), a, action, from, to, 'failed', { error: (e as Error).message.slice(0, 120) }).catch(() => undefined); throw e; }
  }

  // ---------------------------------------------------------------- reading helpers
  private async byRef(ref: string): Promise<GristRecord | undefined> { return (await this.rows(PT.payments)).find((r) => t(r.fields.Booking_UID) === ref); }
  private owned(r: GristRecord | undefined, phone: string | undefined): GristRecord {
    const want = normalizePhone(phone || '').phone;
    if (!r || !want || normalizePhone(t(r.fields.Patient_Phone)).phone !== want) throw bad('not_found', 'Payment not found', 404);   // a wrong phone looks exactly like "no such payment"
    return r;
  }
  private async apptOf(ref: string) { try { const x = (await this.rows('Appointments')).find((r) => t(r.fields.Booking_UID) === ref); return x ? { status: displayStatus(t(x.fields.Status), t(x.fields.Appt_Stage)), row: x } : null; } catch { return null; } }
  private async apptSummary(ref: string) { try { const d = (await this.booking.detail(ref, SYSTEM)).appointment; return { status: d.status, date: d.date, start_time: d.start_time, doctor_name: d.doctor_name }; } catch { return null; } }
  private async view(r: GristRecord): Promise<PaymentView> {
    const s = t(r.fields.Status) as PaymentStatus; const ps = PATIENT_STATUS[s]!; const exp = n(r.fields.Expires_At);
    return { payment_ref: t(r.fields.Booking_UID), payment_id: t(r.fields.Payment_ID), status: s, patient_status: ps.code, patient_message: ps.text, amount_inr: rupees(n(r.fields.Amount_Paise)), expires_at: exp ? new Date(exp * 1000).toISOString() : null, can_upload: OPEN_STATUSES.includes(s) && (!exp || exp > this.ts()) && n(r.fields.Screenshot_Count) < 5, appointment: await this.apptSummary(t(r.fields.Booking_UID)) };
  }

  // ---------------------------------------------------------------- 1. a payment request = a held (Pending confirmation) appointment + a payment row
  async createRequest(i: { slotId: string; patientName: string; patientPhone: string; reason?: string; idempotencyKey: string; channel: 'website' | 'whatsapp' }, a: BookingActor): Promise<{ appointment: unknown; payment: PaymentView; replayed: boolean }> {
    const g = await this.gate(); if (!g.open) throw bad('payments_disabled', 'Payment requests are not open yet', 403, { reasons: g.reasons });
    const res = await this.booking.create({ slotId: i.slotId, patientName: i.patientName, patientPhone: i.patientPhone, ...(i.reason ? { reason: i.reason } : {}), idempotencyKey: i.idempotencyKey, stage: 'Pending confirmation', holdForPayment: true }, a);
    const ref = res.appointment.booking_reference;
    return this.lock.run(async () => {
      let row = await this.byRef(ref);
      if (!row) {
        const rows = await this.rows(PT.payments); const id = `PAY-${pad(maxSeq(rows.map((r) => t(r.fields.Payment_ID)), 'PAY-') + 1, 6)}`; const now = this.ts();
        const phone = normalizePhone(i.patientPhone).phone || i.patientPhone;
        const fields = { Payment_ID: id, Booking_UID: ref, Channel: i.channel, Patient_Name: t(i.patientName).slice(0, 120), Patient_Phone: phone, Amount_Paise: g.settings.feePaise, Currency: 'INR', Status: 'PENDING_PAYMENT', Expires_At: now + g.settings.expiryMin * 60, Idem_Key: i.idempotencyKey, Screenshot_Count: 0, Request_Sent: false, Notify_Attempts: 0, Created_At: now, Updated_At: now, Last_Event_At: now };
        try {
          await this.ev(id, ref, a, 'created', '', 'PENDING_PAYMENT', 'ok', { amount_paise: g.settings.feePaise, channel: i.channel });
          const [rid] = await this.grist.add(this.docId, PT.payments, [fields as never]);
          row = (await this.rows(PT.payments)).find((r) => r.id === rid);
          if (!row) throw new Error('payment row not readable after writing');
        } catch (e) {   // never leave a held slot with no payment row behind: release it
          await this.booking.cancel(ref, { reason: 'Payment request could not be created' }, SYSTEM).catch(() => undefined);
          throw e instanceof Error && 'status' in e ? e : bad('write_unverified', 'The payment request could not be saved, so the booking was not held.', 502);
        }
      }
      return { appointment: res.appointment, payment: await this.view(row), replayed: res.replayed };
    });
  }
  async get(ref: string, phone: string | undefined): Promise<PaymentView> { return this.view(this.owned(await this.byRef(ref), phone)); }
  /** Open payments of one phone number (WhatsApp: which booking does this screenshot belong to?). */
  async openFor(phone: string): Promise<PaymentView[]> {
    const want = normalizePhone(phone).phone; if (!want) return [];
    const mine = (await this.rows(PT.payments)).filter((r) => normalizePhone(t(r.fields.Patient_Phone)).phone === want && OPEN_STATUSES.includes(t(r.fields.Status) as PaymentStatus) && n(r.fields.Expires_At) > this.ts());
    return Promise.all(mine.sort((x, y) => n(y.fields.Created_At) - n(x.fields.Created_At)).slice(0, 5).map((r) => this.view(r)));
  }
  /** The QR image, only while the gate is open (authorization recorded, fee set, payments on). */
  async qr(): Promise<Buffer | null> { const g = await this.gate(); if (!g.open || !this.o.qrFile) return null; return fs.readFile(this.o.qrFile); }

  // ---------------------------------------------------------------- 2. screenshot intake: stored, hashed, de-duplicated. The status becomes SCREENSHOT_RECEIVED, never PAID.
  async receiveScreenshot(ref: string, phone: string | undefined, i: { data: Buffer; utr?: string; source: 'website' | 'whatsapp'; mediaId?: string }, a: BookingActor) {
    if (i.data.length === 0 || i.data.length > MAX_IMAGE_BYTES) throw bad('invalid_image', `The image must be between 1 byte and ${MAX_IMAGE_BYTES / 1048576} MB`, 413);
    const kind = sniffImage(i.data); if (!kind) throw bad('invalid_image', 'Only a JPEG, PNG or WebP picture is accepted', 415);
    const hash = sha256(i.data); const patientUtr = cleanUtr(i.utr);
    return this.lock.run(async () => {
      const row = this.owned(await this.byRef(ref), phone); const id = t(row.fields.Payment_ID); const s = t(row.fields.Status) as PaymentStatus;
      const files = await this.rows(PT.files);
      const own = files.find((f) => t(f.fields.Payment_ID) === id && t(f.fields.SHA256) === hash);
      if (own) return { payment: await this.view(row), replayed: true };   // the same image again for the same payment: nothing changes (replay-safe)
      if (!OPEN_STATUSES.includes(s)) throw bad('not_accepting', 'This payment can no longer take a screenshot', 409, { status: s });
      if (n(row.fields.Expires_At) && n(row.fields.Expires_At) <= this.ts()) throw bad('expired', 'The payment time has run out', 409);
      if (n(row.fields.Screenshot_Count) >= 5) throw bad('too_many_screenshots', 'Too many screenshots for this booking. Please contact the clinic.', 429);
      const dup = files.some((f) => t(f.fields.SHA256) === hash && t(f.fields.Payment_ID) !== id);   // the same picture was already used for ANOTHER payment
      const folder = new Date(this.now()).toISOString().slice(0, 7).replace('-', ''); const fileRef = `${folder}/${randomBytes(16).toString('hex')}.${kind.ext}`;
      await fs.mkdir(path.join(this.o.filesDir, folder), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(this.o.filesDir, fileRef), i.data, { mode: 0o600, flag: 'wx' });
      const flags = new Set(t(row.fields.Flags).split(',').filter(Boolean)); if (dup) flags.add('duplicate_image'); if (editedBySoftware(i.data)) flags.add('edited_by_software');
      try {
        await this.ev(id, ref, a, 'screenshot_received', s, 'SCREENSHOT_RECEIVED', 'ok', { sha256: hash.slice(0, 16), bytes: i.data.length, source: i.source, duplicate_image: dup });
        await this.grist.add(this.docId, PT.files, [{ File_Ref: fileRef, Payment_ID: id, SHA256: hash, Bytes: i.data.length, Mime: kind.mime, Source: i.source, At: this.ts(), Meta_Media_ID: t(i.mediaId).slice(0, 80) } as never]);
        const hold = this.ts() + (await this.settings()).reviewHoldMin * 60;
        const after = await this.patch(row, { Status: 'SCREENSHOT_RECEIVED', Screenshot_Ref: fileRef, Screenshot_Hash: hash, Screenshot_Count: n(row.fields.Screenshot_Count) + 1, Flags: [...flags].join(','), Expires_At: Math.max(n(row.fields.Expires_At), hold), ...(patientUtr ? { UTR: patientUtr, UTR_Source: 'patient' } : {}), Last_Event_At: this.ts() }, (r) => t(r.fields.Status) === 'SCREENSHOT_RECEIVED');
        return { payment: await this.view(after), replayed: false };
      } catch (e) { await fs.rm(path.join(this.o.filesDir, fileRef), { force: true }); throw e; }
    });
  }

  // ---------------------------------------------------------------- 3. extraction (from n8n's OCR/AI: UNTRUSTED text). Result: REVIEW_REQUIRED with flags. Never PAID.
  async applyExtraction(ref: string, phone: string | undefined, i: { extraction: Extraction | null; ocrError?: string }, a: BookingActor) {
    return this.lock.run(async () => {
      const row = this.owned(await this.byRef(ref), phone); const id = t(row.fields.Payment_ID); const s = t(row.fields.Status) as PaymentStatus;
      if (s === 'REVIEW_REQUIRED') return { payment: await this.view(row), replayed: true };
      if (s !== 'SCREENSHOT_RECEIVED') throw bad('no_screenshot', 'There is no screenshot waiting to be checked', 409, { status: s });
      const g = await this.settings();
      const pay = await this.rows(PT.payments); const files = await this.rows(PT.files);
      const patientUtr = cleanUtr(row.fields.UTR); const probeUtr = cleanUtr(i.extraction?.utr) || patientUtr;
      const usedElsewhere = !!probeUtr && pay.some((r) => r.id !== row.id && (cleanUtr(r.fields.UTR) === probeUtr || cleanUtr(r.fields.OCR_UTR) === probeUtr));
      const prior = new Set(t(row.fields.Flags).split(',').filter(Boolean));
      const r = assess({ extraction: i.extraction, feePaise: n(row.fields.Amount_Paise) || g.feePaise, payeeName: g.payee, createdAtSec: n(row.fields.Created_At), nowSec: this.ts(), patientUtr, utrUsedElsewhere: usedElsewhere, imageDuplicate: prior.has('duplicate_image') || files.some((f) => t(f.fields.SHA256) === t(row.fields.Screenshot_Hash) && t(f.fields.Payment_ID) !== id), edited: prior.has('edited_by_software'), ...(i.ocrError ? { ocrError: i.ocrError } : {}) });
      return { payment: await this.view(await this.move(row, 'REVIEW_REQUIRED', { Flags: r.flags.join(','), OCR_Amount_Paise: r.amountPaise ?? 0, OCR_UTR: cleanUtr(i.extraction?.utr), OCR_Txn_At: r.txnAtSec ?? 0, OCR_Payee: r.payee, OCR_Payer: r.payer, OCR_Status: r.status, OCR_Confidence: r.confidence === null ? '' : String(r.confidence), ...(r.utr && !patientUtr ? { UTR: r.utr, UTR_Source: r.utrSource } : {}) }, a, 'extraction', { flags: r.flags, consistent: r.consistent, advisory: 'a screenshot is not proof of payment' })), replayed: false };
    });
  }

  // ---------------------------------------------------------------- 4. staff review (the only way to PAID besides a signed provider event)
  private reviewer(a: BookingActor) { if (a.kind !== 'staff' || !can(a, 'payments:review')) throw bad('forbidden', 'Only front-desk staff and admins can review payments', 403); }
  async list(q: { status?: string; q?: string; limit?: number }, a: BookingActor) {
    this.reviewer(a);
    const all = await this.rows(PT.payments); const appts = await this.rows('Appointments').catch(() => [] as GristRecord[]);
    const counts: Record<string, number> = {}; for (const r of all) counts[t(r.fields.Status)] = (counts[t(r.fields.Status)] || 0) + 1;
    const needle = t(q.q).toLowerCase(); const st = t(q.status);
    const rows = all.filter((r) => (!st || t(r.fields.Status) === st) && (!needle || [r.fields.Booking_UID, r.fields.Payment_ID, r.fields.UTR, r.fields.Patient_Name, r.fields.Patient_Phone].some((x) => t(x).toLowerCase().includes(needle))))
      .sort((x, y) => n(y.fields.Last_Event_At) - n(x.fields.Last_Event_At)).slice(0, Math.min(200, q.limit || 100)).map((r) => this.staffRow(r, appts));
    return { rows, counts, needs_review: (counts.REVIEW_REQUIRED || 0) + (counts.SCREENSHOT_RECEIVED || 0), refund_due: rows.filter((x) => x.refund_due).length };
  }
  private staffRow(r: GristRecord, appts: GristRecord[]) {
    const f = r.fields; const ap = appts.find((x) => t(x.fields.Booking_UID) === t(f.Booking_UID)); const as = ap ? displayStatus(t(ap.fields.Status), t(ap.fields.Appt_Stage)) : null;
    const ts = (v: unknown) => (n(v) ? new Date(n(v) * 1000).toISOString() : null);
    return { id: t(f.Payment_ID), booking_reference: t(f.Booking_UID), channel: t(f.Channel), status: t(f.Status), appointment_status: as, patient: { name: t(f.Patient_Name), phone: t(f.Patient_Phone) }, amount_inr: rupees(n(f.Amount_Paise)), utr: t(f.UTR), utr_source: t(f.UTR_Source),
      screenshots: n(f.Screenshot_Count), flags: t(f.Flags).split(',').filter(Boolean), extracted: { amount_inr: n(f.OCR_Amount_Paise) ? rupees(n(f.OCR_Amount_Paise)) : null, utr: t(f.OCR_UTR), txn_at: ts(f.OCR_Txn_At), payee: t(f.OCR_Payee), payer: t(f.OCR_Payer), status: t(f.OCR_Status), confidence: t(f.OCR_Confidence) },
      verification_method: t(f.Verification_Method), received_inr: n(f.Received_Paise) ? rupees(n(f.Received_Paise)) : null, reviewed_by: t(f.Reviewed_By), reviewed_at: ts(f.Reviewed_At), review_note: t(f.Review_Note), refunded_at: ts(f.Refunded_At), refunded_by: t(f.Refunded_By),
      expires_at: ts(f.Expires_At), created_at: ts(f.Created_At), refund_due: t(f.Status) === 'PAID' && as === 'Cancelled' };
  }
  async detail(id: string, a: BookingActor) {
    this.reviewer(a); const r = (await this.rows(PT.payments)).find((x) => t(x.fields.Payment_ID) === id); if (!r) throw bad('not_found', 'Payment not found', 404);
    const events = (await this.rows(PT.events)).filter((e) => t(e.fields.Payment_ID) === id).sort((x, y) => n(x.fields.At) - n(y.fields.At)).map((e) => ({ at: new Date(n(e.fields.At) * 1000).toISOString(), actor: t(e.fields.Actor), action: t(e.fields.Action), from: t(e.fields.From_Status), to: t(e.fields.To_Status), outcome: t(e.fields.Outcome), detail: t(e.fields.Detail) }));
    return { payment: this.staffRow(r, await this.rows('Appointments').catch(() => [] as GristRecord[])), events, appointment: await this.apptSummary(t(r.fields.Booking_UID)) };
  }
  async screenshot(id: string, a: BookingActor): Promise<{ data: Buffer; mime: string }> {
    this.reviewer(a); const r = (await this.rows(PT.payments)).find((x) => t(x.fields.Payment_ID) === id); const ref = t(r?.fields.Screenshot_Ref);
    if (!r || !FILE_RE.test(ref)) throw bad('not_found', 'No screenshot for this payment', 404);
    await this.ev(id, t(r.fields.Booking_UID), a, 'screenshot_viewed', t(r.fields.Status), t(r.fields.Status), 'ok');   // looking at a patient's payment image is itself logged
    return { data: await fs.readFile(path.join(this.o.filesDir, ref)), mime: ref.endsWith('.png') ? 'image/png' : ref.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
  }
  async approve(id: string, i: { receivedInr: string; utr: string; confirmReceipt: boolean; note?: string }, a: BookingActor) {
    this.reviewer(a);
    if (i.confirmReceipt !== true) throw bad('confirmation_required', 'Tick the box to confirm you saw the money in the clinic\'s bank account', 400);
    const utr = cleanUtr(i.utr); if (!utrLooksValid(utr)) throw bad('invalid_utr', 'Enter the 12-digit UPI reference (UTR) from the bank statement', 400);
    const received = toPaise(i.receivedInr); if (received === null) throw bad('invalid_amount', 'Enter the amount that reached the bank account', 400);
    return this.lock.run(async () => {
      const row = (await this.rows(PT.payments)).find((x) => t(x.fields.Payment_ID) === id); if (!row) throw bad('not_found', 'Payment not found', 404);
      const s = t(row.fields.Status) as PaymentStatus; const ref = t(row.fields.Booking_UID);
      if (s === 'PAID') return { payment: this.staffRow(row, await this.rows('Appointments')), replayed: true };   // a second approval changes nothing and creates nothing
      if (!['PENDING_PAYMENT', 'SCREENSHOT_RECEIVED', 'REVIEW_REQUIRED', 'REJECTED'].includes(s)) throw bad('not_approvable', `A ${s.toLowerCase()} payment cannot be approved. If the money really arrived, refund it or book the patient again.`, 409);
      if (received !== n(row.fields.Amount_Paise)) { await this.ev(id, ref, a, 'approve_refused', s, s, 'rejected', { reason: 'amount_mismatch', received_paise: received }); throw bad('amount_mismatch', `The amount received (₹${rupees(received)}) is not the fee (₹${rupees(n(row.fields.Amount_Paise))}). Reject it, or ask the patient to pay the difference.`, 422); }
      const clash = (await this.rows(PT.payments)).find((x) => x.id !== row.id && (cleanUtr(x.fields.UTR) === utr || cleanUtr(x.fields.OCR_UTR) === utr));
      if (clash) { await this.ev(id, ref, a, 'approve_refused', s, s, 'rejected', { reason: 'utr_already_used', other: t(clash.fields.Payment_ID) }); throw bad('utr_already_used', `This UTR is already recorded on payment ${t(clash.fields.Payment_ID)}. One transfer can pay for one booking only.`, 409); }
      const ap = await this.apptOf(ref); if (!ap || ap.status === 'Cancelled') throw bad('appointment_released', 'The held appointment was already released. Refund the patient or book them again.', 409);
      const after = await this.move(row, 'PAID', { UTR: utr, UTR_Source: 'staff', Verification_Method: 'staff_bank_statement', Received_Paise: received, Reviewed_By: a.id, Reviewed_At: this.ts(), Review_Note: t(i.note).slice(0, 300), Flags: t(row.fields.Flags) }, a, 'approved', { utr, received_paise: received, method: 'staff_bank_statement' });
      if (ap.status === 'Pending confirmation') await this.booking.setStatus(ref, 'Confirmed', a);   // PAID first; the tick re-confirms if this step is interrupted
      return { payment: this.staffRow(after, await this.rows('Appointments')), replayed: false };
    });
  }
  async reject(id: string, i: { reason: string }, a: BookingActor) {
    this.reviewer(a); const reason = t(i.reason); if (reason.length < 3) throw bad('reason_required', 'Give a short reason', 400);
    return this.lock.run(async () => {
      const row = (await this.rows(PT.payments)).find((x) => t(x.fields.Payment_ID) === id); if (!row) throw bad('not_found', 'Payment not found', 404);
      const s = t(row.fields.Status); if (s === 'REJECTED') return { payment: this.staffRow(row, []), replayed: true };
      if (!['SCREENSHOT_RECEIVED', 'REVIEW_REQUIRED', 'PENDING_PAYMENT'].includes(s)) throw bad('not_rejectable', `A ${s.toLowerCase()} payment cannot be rejected`, 409);
      const after = await this.move(row, 'REJECTED', { Reviewed_By: a.id, Reviewed_At: this.ts(), Review_Note: reason.slice(0, 300) }, a, 'rejected', { reason: reason.slice(0, 120) });
      return { payment: this.staffRow(after, await this.rows('Appointments')), replayed: false };
    });
  }
  async refund(id: string, i: { reason: string; cancelAppointment?: boolean }, a: BookingActor) {
    if (a.kind !== 'staff' || !can(a, 'settings:write')) throw bad('forbidden', 'Only an admin can record a refund', 403);
    const reason = t(i.reason); if (reason.length < 3) throw bad('reason_required', 'Give a short reason', 400);
    return this.lock.run(async () => {
      const row = (await this.rows(PT.payments)).find((x) => t(x.fields.Payment_ID) === id); if (!row) throw bad('not_found', 'Payment not found', 404);
      const s = t(row.fields.Status); if (s === 'REFUNDED') return { payment: this.staffRow(row, []), replayed: true };
      if (s !== 'PAID') throw bad('not_refundable', 'Only a verified (PAID) payment can be refunded', 409);
      if (i.cancelAppointment !== false) await this.booking.cancel(t(row.fields.Booking_UID), { reason: `Refunded: ${reason}`.slice(0, 200) }, a);   // history is kept: a cancelled row, never a deleted one
      const after = await this.move(row, 'REFUNDED', { Refunded_At: this.ts(), Refunded_By: a.id, Refund_Note: reason.slice(0, 300) }, a, 'refunded', { reason: reason.slice(0, 120), appointment_cancelled: i.cancelAppointment !== false });
      return { payment: this.staffRow(after, await this.rows('Appointments')), replayed: false, note: 'This records the refund. Send the money back to the patient from the bank / UPI app yourself.' };
    });
  }

  // ---------------------------------------------------------------- 5. a signed provider event (for a future bank / payment-provider link). Disabled until a secret is set.
  async providerEvent(raw: string, signature: string | undefined) {
    const secret = this.o.webhookSecret; if (!secret) throw bad('provider_disabled', 'No payment provider is connected', 503);
    const want = createHmac('sha256', secret).update(raw).digest('hex'); const got = t(signature).toLowerCase();
    if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw bad('bad_signature', 'The signature does not match', 401);
    let b: { event_id?: string; payment_ref?: string; amount_inr?: unknown; utr?: unknown; status?: string; txn_time?: unknown };
    try { b = JSON.parse(raw); } catch { throw bad('invalid_json', 'The body must be JSON', 400); }
    const evId = `prov:${t(b.event_id)}`; if (!t(b.event_id) || !t(b.payment_ref)) throw bad('invalid', 'event_id and payment_ref are required', 400);
    const age = parseTxnTime(b.txn_time); if (age !== null && Math.abs(this.ts() - age) > 7 * 86400) throw bad('stale_event', 'The event is too old to be accepted', 400);
    return this.lock.run(async () => {
      if ((await this.rows(PT.events)).some((e) => t(e.fields.Event_ID) === evId)) return { ok: true, replayed: true };   // the same event delivered twice does nothing
      const row = await this.byRef(t(b.payment_ref)); if (!row) { await this.ev('', t(b.payment_ref), { id: 'provider' }, 'provider_event_unmatched', '', '', 'rejected', {}, evId); return { ok: true, matched: false }; }
      const id = t(row.fields.Payment_ID); const s = t(row.fields.Status) as PaymentStatus; const utr = cleanUtr(b.utr); const paise = toPaise(b.amount_inr);
      if (t(b.status).toUpperCase() !== 'SUCCESS') { await this.ev(id, t(row.fields.Booking_UID), { id: 'provider' }, 'provider_event_not_success', s, s, 'ok', { status: t(b.status).slice(0, 20) }, evId); return { ok: true, paid: false }; }
      if (s === 'PAID' || s === 'REFUNDED') { await this.ev(id, t(row.fields.Booking_UID), { id: 'provider' }, 'provider_event_duplicate', s, s, 'ok', {}, evId); return { ok: true, replayed: true }; }
      const clash = utr && (await this.rows(PT.payments)).some((x) => x.id !== row.id && (cleanUtr(x.fields.UTR) === utr || cleanUtr(x.fields.OCR_UTR) === utr));
      const ap = await this.apptOf(t(row.fields.Booking_UID)); const live = OPEN_STATUSES.includes(s) && ap && ap.status !== 'Cancelled';
      const flags = new Set(t(row.fields.Flags).split(',').filter(Boolean));
      if (paise !== n(row.fields.Amount_Paise)) flags.add('provider_amount_mismatch'); if (clash || !utrLooksValid(utr)) flags.add(clash ? 'utr_already_used' : 'utr_format'); if (!live) flags.add('paid_after_release');
      await this.ev(id, t(row.fields.Booking_UID), { id: 'provider' }, 'provider_event', s, flags.size ? 'REVIEW_REQUIRED' : 'PAID', 'ok', { flags: [...flags], utr }, evId);
      if (flags.size) { await this.patch(row, { Status: 'REVIEW_REQUIRED', Flags: [...flags].join(','), Last_Event_At: this.ts() }, (r) => t(r.fields.Status) === 'REVIEW_REQUIRED'); return { ok: true, paid: false, review: true }; }
      await this.patch(row, { Status: 'PAID', UTR: utr, UTR_Source: 'ocr', Verification_Method: 'provider_webhook', Received_Paise: paise ?? 0, Reviewed_By: 'provider', Reviewed_At: this.ts(), Last_Event_At: this.ts() }, (r) => t(r.fields.Status) === 'PAID');
      if (ap && ap.status === 'Pending confirmation') await this.booking.setStatus(t(row.fields.Booking_UID), 'Confirmed', SYSTEM);
      return { ok: true, paid: true };
    });
  }

  // ---------------------------------------------------------------- 6. housekeeping: expiry, released-slot reconciliation, interrupted confirmations
  async tick(): Promise<{ expired: number; cancelled: number; confirmed: number }> {
    const out = { expired: 0, cancelled: 0, confirmed: 0 }; let rows: GristRecord[];
    try { rows = await this.rows(PT.payments); } catch { return out; }   // payment tables not provisioned
    for (const r0 of rows) {
      const s = t(r0.fields.Status) as PaymentStatus; if (!OPEN_STATUSES.includes(s) && s !== 'PAID') continue;
      await this.lock.run(async () => {
        const r = (await this.rows(PT.payments)).find((x) => x.id === r0.id); if (!r || t(r.fields.Status) !== s) return;
        const ref = t(r.fields.Booking_UID); const ap = await this.apptOf(ref);
        if (s === 'PAID') { if (ap?.status === 'Pending confirmation') { await this.booking.setStatus(ref, 'Confirmed', SYSTEM).catch(() => undefined); out.confirmed++; } return; }
        if (ap?.status === 'Cancelled') { await this.move(r, 'CANCELLED', {}, SYSTEM, 'booking_cancelled'); out.cancelled++; return; }
        if (n(r.fields.Expires_At) && n(r.fields.Expires_At) <= this.ts()) {
          if (ap && ap.status === 'Pending confirmation') await this.booking.cancel(ref, { reason: 'Payment not received in time' }, SYSTEM);   // the slot is free again; the row is kept
          await this.move(r, 'EXPIRED', {}, SYSTEM, 'expired', { appointment_status: ap?.status || 'missing' }); out.expired++;
        }
      }).catch((e) => console.error(`FLOW HQ payments: ${t(r0.fields.Payment_ID)} housekeeping failed (${(e as Error).message})`));
    }
    return out;
  }

  // ---------------------------------------------------------------- 7. what n8n should tell WhatsApp patients (website patients see their status on the page)
  async outbox(): Promise<Array<{ payment_ref: string; kind: 'payment_request' | 'status'; status: string; phone: string; text: string; amount_inr: string; last_inbound_at: number }>> {
    const out: Array<{ payment_ref: string; kind: 'payment_request' | 'status'; status: string; phone: string; text: string; amount_inr: string; last_inbound_at: number }> = [];
    const g = await this.settings(); const files = await this.rows(PT.files);
    for (const r of (await this.rows(PT.payments)).filter((x) => t(x.fields.Channel) === 'whatsapp' && n(x.fields.Notify_Attempts) < 5)) {
      const s = t(r.fields.Status) as PaymentStatus; const ref = t(r.fields.Booking_UID); const phone = t(r.fields.Patient_Phone); const amt = rupees(n(r.fields.Amount_Paise));
      // WhatsApp's 24-hour reply window starts when the patient last wrote: the booking chat (request) or the screenshot (everything after)
      const win = Math.max(n(r.fields.Created_At), ...files.filter((f) => t(f.fields.Payment_ID) === t(r.fields.Payment_ID) && t(f.fields.Source) === 'whatsapp').map((f) => n(f.fields.At)));
      if (s === 'PENDING_PAYMENT' && !on(r.fields.Request_Sent)) {
        const ap = await this.apptSummary(ref); const mins = Math.max(1, Math.round((n(r.fields.Expires_At) - this.ts()) / 60));
        out.push({ payment_ref: ref, kind: 'payment_request', status: s, phone, amount_inr: amt, last_inbound_at: win, text: `Your appointment time${ap ? ` (${ap.date}, ${ap.start_time}${ap.doctor_name ? `, ${ap.doctor_name}` : ''})` : ''} is held for you. To confirm it, pay ₹${amt} to the QR code shown above (any UPI app), then send the payment screenshot here. Booking reference: ${ref}. Please pay within ${Math.min(mins, g.expiryMin)} minutes. Never share your UPI PIN, OTP or bank password with anyone, including us.` });
      } else if (['SCREENSHOT_RECEIVED', 'REVIEW_REQUIRED', 'PAID', 'REJECTED', 'EXPIRED', 'REFUNDED'].includes(s) && t(r.fields.Notified_Status) !== s && (s !== 'REVIEW_REQUIRED' || t(r.fields.Notified_Status) !== 'SCREENSHOT_RECEIVED')) {
        const ap = s === 'PAID' ? await this.apptSummary(ref) : null;
        out.push({ payment_ref: ref, kind: 'status', status: s, phone, amount_inr: amt, last_inbound_at: win, text: `${PATIENT_STATUS[s]!.text}${ap ? ` ${ap.date}, ${ap.start_time}${ap.doctor_name ? `, ${ap.doctor_name}` : ''}.` : ''} Reference: ${ref}.` });
      }
    }
    return out;
  }
  async markNotified(ref: string, kind: string, ok: boolean) {
    return this.lock.run(async () => {
      const r = await this.byRef(ref); if (!r) throw bad('not_found', 'Payment not found', 404);
      const f: Record<string, unknown> = {}; const s = t(r.fields.Status);
      if (ok) { if (kind === 'payment_request') f.Request_Sent = true; else f.Notified_Status = s; f.Notify_Attempts = 0; } else f.Notify_Attempts = n(r.fields.Notify_Attempts) + 1;
      await this.patch(r, f, () => true); return { ok: true };
    });
  }
}
function parseTxnTime(v: unknown): number | null { const ms = Date.parse(String(v ?? '')); return Number.isFinite(ms) ? Math.floor(ms / 1000) : null; }
