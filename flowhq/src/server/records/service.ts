// Clinic records: patient register, prescriptions (+ photos), invoices, payments, visits. Grist is the only store.
// Rules kept here (not in the UI): stable text ids, ids generated under a lock, integer paise, no deletes, finance is append-only,
// invoices are final (void + re-issue), duplicate-submission keys, every write audited. Nothing here sends anything to a patient.
import { computeTotals, MAX_PAISE, paymentStatus } from '../../core/money';
import type { DoctorSummary } from '../../core/clinical';
import { PAYMENT_METHODS, PATIENT_STATUSES, SEXES, STAFF_STATUSES, VISIT_STATUSES, type ClinicProfile, type Invoice, type InvoiceInput, type Patient, type PatientList, type PatientProfile, type PatientRow, type Payment, type Prescription, type PrescriptionInput, type RxImage, type StaffMark, type StaffMarkInput, type StaffMember, type StaffMonth, type StaffStatus, type StaffWeek, type Visit, type VisitWeek, type VisitStatus } from '../../core/clinical';
import { BackendError, type GristClient, type GristRecord } from '../grist';
import { dayKey } from '../time';
import { normalizePhone } from '../adapters/autopilot/shared';
import { addDays, bad, dateIn, dateOut, mondayOf, Mutex, maxSeq, pad, validDate } from './ids';
import { hashPassword, verifyPassword } from '../auth';
import { RT, STAFF_ATT, STAFF_MEMBERS, STAFF_SETTINGS } from './schema';

const LOCK_KEY = 'edit_password_hash';
const MAX_WRONG = 5; const WRONG_WINDOW_MS = 10 * 60000;   // 5 wrong edit passwords per person, then 10 minutes of waiting

// A person on the clinic's team list (built by the route from the FLOW HQ logins and config/clinic.json). The key is stable; the name is display only.
export interface StaffPerson { key: string; name: string }

export interface ClinicConfig extends ClinicProfile { idPrefix: string }
export interface RecordsOptions { tz: string; clinic: () => ClinicConfig; now?: () => number }
export interface Actor { email: string; name: string; role: 'admin' | 'staff'; clinician?: string }
// Limits prescriptions and money to ONE doctor (the invoice's Created_By / the prescription's Treating_Physio). No `only` = everything.
// A doctor's login always gets their own name here; an admin may ask for one doctor; the patient register is never scoped.
export interface Scope { only?: string }
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const stamp = (v: unknown) => (typeof v === 'number' && v > 0 ? new Date(v * 1000).toISOString() : null);
const nameKey = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_RX = 6;

export function sniffImage(b: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  return null;
}

export class RecordsService {
  private lock = new Mutex();
  constructor(private grist: GristClient, private docId: string, private o: RecordsOptions) {}
  private now() { return (this.o.now ? this.o.now() : Date.now()); }
  private today() { return dayKey(this.now(), this.o.tz); }
  private ts() { return Math.floor(this.now() / 1000); }
  private rows(t: string) { return this.grist.records(this.docId, t); }
  private add(t: string, f: Record<string, unknown>[]) { return this.grist.add(this.docId, t, f as never); }
  private patch(t: string, id: number, fields: Record<string, unknown>) { return this.grist.update(this.docId, t, [{ id, fields: fields as never }]); }
  private prefix() { return this.o.clinic().idPrefix || 'GK'; }
  clinic(): ClinicProfile { const { idPrefix: _p, ...c } = this.o.clinic(); void _p; return c; }

  private async audit(a: Actor, action: string, record: string, summary: string) {
    try { await this.add(RT.audit, [{ At: this.ts(), User: a.email, Action: action, Record: record, Summary: summary.slice(0, 200) }]); }
    catch { console.error(`FLOW HQ: audit entry not written (${action} ${record})`); }   // the change itself is already saved; no clinical text is logged
  }

  // ------------------------------------------------------------------ mapping
  private toPatient(r: GristRecord): Patient {
    const f = r.fields;
    return { patientId: s(f.Patient_ID), serialNo: n(f.Serial_No), name: s(f.Name), phone: s(f.Phone), address: s(f.Address), age: s(f.Age), sex: (SEXES as readonly string[]).includes(s(f.Sex)) ? (s(f.Sex) as Patient['sex']) : '',
      referredBy: s(f.Referred_By), occupation: s(f.Occupation), mainComplaint: s(f.Main_Complaint), registeredOn: dateOut(f.Registered_On), status: (PATIENT_STATUSES as readonly string[]).includes(s(f.Status)) ? (s(f.Status) as Patient['status']) : 'Active',
      followUpOn: dateOut(f.Follow_Up_On), sourceLeadId: s(f.Source_Lead_ID), notes: s(f.Notes), createdAt: stamp(f.Created_At) };
  }
  private toPayment(r: GristRecord): Payment {
    const f = r.fields;
    return { paymentId: s(f.Payment_ID), invoiceNo: s(f.Invoice_No), patientId: s(f.Patient_ID), paidOn: dateOut(f.Paid_On), amountPaise: n(f.Amount_Paise), method: s(f.Method) as Payment['method'], reference: s(f.Reference), notes: s(f.Notes),
      voided: f.Voided === true, voidReason: s(f.Void_Reason), createdAt: stamp(f.Created_At), createdBy: s(f.Created_By) };
  }
  private toVisit(r: GristRecord): (Visit & { rowId: number }) | null {
    const f = r.fields; const d = dateOut(f.Visit_Date);
    return d && (VISIT_STATUSES as readonly string[]).includes(s(f.Status)) ? { rowId: r.id, patientId: s(f.Patient_ID), date: d, status: s(f.Status) as VisitStatus, notes: s(f.Notes) } : null;
  }

  // Patients with money and attendance derived from the finance and visit rows (never stored on the patient).
  private summarise(patients: Patient[], allInvRows: GristRecord[], payRows: GristRecord[], visitRows: GristRecord[], scope?: Scope): PatientRow[] {
    const invRows = scope?.only ? allInvRows.filter((r) => same(s(r.fields.Created_By), scope.only!)) : allInvRows;   // a doctor's dues: only the invoices they raised (their payments follow the invoice)
    const live = new Set(invRows.filter((r) => s(r.fields.Status) !== 'void').map((r) => s(r.fields.Invoice_No)));
    const billed = new Map<string, number>(); const paid = new Map<string, number>(); const latest = new Map<string, string>();
    for (const r of invRows) if (s(r.fields.Status) !== 'void') billed.set(s(r.fields.Patient_ID), (billed.get(s(r.fields.Patient_ID)) || 0) + n(r.fields.Total_Paise));
    for (const r of payRows) if (r.fields.Voided !== true && live.has(s(r.fields.Invoice_No))) paid.set(s(r.fields.Patient_ID), (paid.get(s(r.fields.Patient_ID)) || 0) + n(r.fields.Amount_Paise));
    for (const r of visitRows) { const v = this.toVisit(r); if (v && v.status === 'Attended' && v.date > (latest.get(v.patientId) || '')) latest.set(v.patientId, v.date); }
    return patients.map((p) => { const b = billed.get(p.patientId) || 0; const pd = paid.get(p.patientId) || 0; return { ...p, billedPaise: b, paidPaise: pd, outstandingPaise: Math.max(0, b - pd), latestVisit: latest.get(p.patientId) || null }; });
  }

  // ------------------------------------------------------------------ patients
  private dupes(all: Patient[], name: string, phone: string, exceptId?: string) {
    const nk = nameKey(name);
    return all.filter((p) => p.patientId !== exceptId && ((phone && p.phone === phone) || (nk && nameKey(p.name) === nk))).slice(0, 5).map((p) => ({ patientId: p.patientId, name: p.name, phone: p.phone }));
  }
  private cleanPatient(i: Partial<Patient>): { fields: Record<string, unknown> } {
    const f: Record<string, unknown> = {};
    if (i.name !== undefined) { const nm = i.name.trim(); if (!nm) throw bad('invalid', 'Patient name is required'); f.Name = nm; }
    if (i.phone !== undefined) {
      if (i.phone.trim() === '') f.Phone = '';
      else { const p = normalizePhone(i.phone); if (!p.valid || !p.phone) throw bad('invalid_phone', 'Enter a valid Indian mobile number (10 digits starting 6-9)'); f.Phone = p.phone; }
    }
    for (const [k, col] of [['address', 'Address'], ['age', 'Age'], ['referredBy', 'Referred_By'], ['occupation', 'Occupation'], ['mainComplaint', 'Main_Complaint'], ['notes', 'Notes'], ['sourceLeadId', 'Source_Lead_ID']] as const) if (i[k] !== undefined) f[col] = i[k]!.trim();
    if (i.sex !== undefined) f.Sex = i.sex;
    if (i.status !== undefined) f.Status = i.status;
    for (const [k, col] of [['registeredOn', 'Registered_On'], ['followUpOn', 'Follow_Up_On']] as const) if (i[k] !== undefined) { if (i[k] && !validDate(i[k])) throw bad('invalid_date', 'Enter a valid date'); f[col] = dateIn(i[k]); }
    return { fields: f };
  }

  async listPatients(q: { q?: string; status?: string; followUp?: boolean; owing?: boolean; from?: string; to?: string; sort?: string; dir?: 'asc' | 'desc'; page?: number; pageSize?: number; week?: string }, scope?: Scope): Promise<PatientList> {
    const [pr, inv, pay, vis] = await Promise.all([this.rows(RT.patients), this.rows(RT.invoices), this.rows(RT.payments), this.rows(RT.visits)]);
    let rows = this.summarise(pr.map((r) => this.toPatient(r)).filter((p) => p.patientId), inv, pay, vis, scope);
    const term = (q.q || '').trim().toLowerCase(); const digits = term.replace(/\D/g, '');
    if (term) rows = rows.filter((p) => p.name.toLowerCase().includes(term) || p.patientId.toLowerCase().includes(term) || p.mainComplaint.toLowerCase().includes(term) || (digits.length >= 3 && p.phone.replace(/\D/g, '').includes(digits)));
    if (q.status) rows = rows.filter((p) => p.status === q.status);
    if (q.followUp) { const t = this.today(); rows = rows.filter((p) => p.followUpOn && p.followUpOn <= t && p.status === 'Active'); }
    if (q.owing) rows = rows.filter((p) => p.outstandingPaise > 0);
    // registration date range (inclusive); patients with no registration date drop out of a dated view
    if (q.from && validDate(q.from)) rows = rows.filter((p) => !!p.registeredOn && p.registeredOn >= q.from!);
    if (q.to && validDate(q.to)) rows = rows.filter((p) => !!p.registeredOn && p.registeredOn <= q.to!);
    const key: Record<string, (p: PatientRow) => string | number> = { serial: (p) => p.serialNo, name: (p) => p.name.toLowerCase(), registered: (p) => p.registeredOn || '', outstanding: (p) => p.outstandingPaise, latestVisit: (p) => p.latestVisit || '', followUp: (p) => p.followUpOn || '9999', billed: (p) => p.billedPaise };
    const k = key[q.sort || 'serial'] || key.serial!; const dir = q.dir === 'desc' ? -1 : 1;
    rows.sort((a, b) => { const x = k(a); const y = k(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a.serialNo - b.serialNo; });
    const totals = rows.reduce((t, p) => ({ billedPaise: t.billedPaise + p.billedPaise, paidPaise: t.paidPaise + p.paidPaise, outstandingPaise: t.outstandingPaise + p.outstandingPaise }), { billedPaise: 0, paidPaise: 0, outstandingPaise: 0 });
    const pageSize = Math.min(Math.max(q.pageSize || 50, 1), 200); const page = Math.max(q.page || 1, 1);
    const slice = rows.slice((page - 1) * pageSize, page * pageSize);
    if (q.week && validDate(q.week)) {
      const w0 = mondayOf(q.week); const w1 = addDays(w0, 6); const ids = new Set(slice.map((p) => p.patientId));
      for (const r of vis) { const v = this.toVisit(r); if (v && ids.has(v.patientId) && v.date >= w0 && v.date <= w1) { const p = slice.find((x) => x.patientId === v.patientId)!; (p.attendance ||= {})[v.date] = v.status; } }
    }
    return { rows: slice, total: rows.length, page, pageSize, totals };
  }

  async findDuplicates(name: string, phone: string, exceptId?: string) {
    const p = phone.trim() ? normalizePhone(phone).phone || '' : '';
    return this.dupes((await this.rows(RT.patients)).map((r) => this.toPatient(r)), name, p, exceptId);
  }

  createPatient(input: Partial<Patient>, a: Actor, confirmDuplicate = false): Promise<PatientRow> {
    return this.lock.run(async () => {
      const { fields } = this.cleanPatient({ ...input, name: input.name ?? '' });
      if (!fields.Registered_On) delete fields.Registered_On;   // a blank date means "today", not "no date"
      const existing = await this.rows(RT.patients);
      const dup = this.dupes(existing.map((r) => this.toPatient(r)), s(fields.Name), s(fields.Phone));
      if (dup.length && !confirmDuplicate) throw bad('possible_duplicate', 'A patient with the same phone number or name already exists', 409, { matches: dup });
      const prefix = `${this.prefix()}-P-`;
      const patientId = `${prefix}${pad(maxSeq(existing.map((r) => r.fields.Patient_ID), prefix) + 1)}`;
      const serial = Math.max(0, ...existing.map((r) => n(r.fields.Serial_No))) + 1;
      await this.add(RT.patients, [{ Status: 'Active', Registered_On: dateIn(this.today()), ...fields, Patient_ID: patientId, Serial_No: serial, Created_At: this.ts(), Created_By: a.name }]);
      const written = (await this.rows(RT.patients)).filter((r) => r.fields.Patient_ID === patientId);
      if (written.length !== 1) throw bad('id_collision', 'Another change used the same patient number at the same time. Please try again.', 409);
      await this.audit(a, 'patient.create', patientId, `Serial ${serial}`);
      return (await this.patientRow(patientId))!;
    });
  }

  updatePatient(patientId: string, input: Partial<Patient>, a: Actor, confirmDuplicate = false): Promise<PatientRow> {
    return this.lock.run(async () => {
      const all = await this.rows(RT.patients);
      const row = all.find((r) => r.fields.Patient_ID === patientId);
      if (!row) throw bad('not_found', 'Patient not found', 404);
      const { fields } = this.cleanPatient(input);
      if (!Object.keys(fields).length) throw bad('invalid', 'Nothing to change');
      // warn only about what this edit CHANGES: the edit form always sends the whole record, and a patient already registered as a
      // known duplicate must not be warned again for an unrelated edit (a note, an address) or for unchanged name / phone
      const nameChanged = fields.Name !== undefined && fields.Name !== s(row.fields.Name);
      const phoneChanged = fields.Phone !== undefined && fields.Phone !== s(row.fields.Phone);
      if ((nameChanged || phoneChanged) && !confirmDuplicate) {
        const dup = this.dupes(all.map((r) => this.toPatient(r)), nameChanged ? s(fields.Name) : '', phoneChanged ? s(fields.Phone) : '', patientId);
        if (dup.length) throw bad('possible_duplicate', 'Another patient has the same phone number or name', 409, { matches: dup });
      }
      await this.patch(RT.patients, row.id, fields);
      await this.audit(a, 'patient.update', patientId, `Changed: ${Object.keys(fields).join(', ')}`);
      return (await this.patientRow(patientId))!;
    });
  }

  private async patientRow(patientId: string, scope?: Scope): Promise<PatientRow | null> {
    const [pr, inv, pay, vis] = await Promise.all([this.rows(RT.patients), this.rows(RT.invoices), this.rows(RT.payments), this.rows(RT.visits)]);
    const p = pr.map((r) => this.toPatient(r)).find((x) => x.patientId === patientId);
    return p ? this.summarise([p], inv, pay, vis, scope)[0]! : null;
  }

  async profile(patientId: string, scope?: Scope): Promise<PatientProfile | null> {
    const patient = await this.patientRow(patientId, scope);
    if (!patient) return null;
    const [prescriptions, invoices, vis] = await Promise.all([this.listPrescriptions({ patientId }, scope), this.listInvoices({ patientId }, scope), this.rows(RT.visits)]);
    const visits = vis.map((r) => this.toVisit(r)).filter((v): v is Visit & { rowId: number } => !!v && v.patientId === patientId).sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 200).map(({ rowId: _r, ...v }) => { void _r; return v; });
    return { patient, prescriptions, invoices, payments: invoices.flatMap((i) => i.payments).sort((x, y) => ((y.paidOn || '') < (x.paidOn || '') ? -1 : 1)), visits };
  }

  // ------------------------------------------------------------------ prescriptions
  private async names(): Promise<Map<string, string>> { return new Map((await this.rows(RT.patients)).map((r) => [s(r.fields.Patient_ID), s(r.fields.Name)])); }
  private toRx(r: GristRecord, names: Map<string, string>, images: RxImage[]): Prescription {
    const f = r.fields;
    return { rxId: s(f.Rx_ID), version: n(f.Version) || 1, patientId: s(f.Patient_ID), patientName: names.get(s(f.Patient_ID)) || '', rxDate: dateOut(f.Rx_Date), treatingPhysio: s(f.Treating_Physio), bp: s(f.BP), vitals: s(f.Vitals),
      history: s(f.History), examination: s(f.Examination), diagnosis: s(f.Diagnosis), treatmentPlan: s(f.Treatment_Plan), exercises: s(f.Exercises), advice: s(f.Advice), followUpOn: dateOut(f.Follow_Up_On), createdAt: stamp(f.Created_At), createdBy: s(f.Created_By), images };
  }
  private imagesByRx(rows: GristRecord[]): Map<string, RxImage[]> {
    const m = new Map<string, RxImage[]>();
    for (const r of rows) if (r.fields.Removed !== true && s(r.fields.Image_ID)) { const k = s(r.fields.Rx_ID); (m.get(k) || m.set(k, []).get(k)!).push({ imageId: s(r.fields.Image_ID), rxId: k, mime: s(r.fields.Mime), bytes: n(r.fields.Bytes), caption: s(r.fields.Caption), createdAt: stamp(r.fields.Created_At) }); }
    return m;
  }
  private async latestRx(): Promise<Prescription[]> {
    const [rx, im, names] = await Promise.all([this.rows(RT.prescriptions), this.rows(RT.rxImages), this.names()]);
    const imgs = this.imagesByRx(im); const best = new Map<string, GristRecord>();
    for (const r of rx) { const id = s(r.fields.Rx_ID); const cur = best.get(id); if (id && (!cur || n(r.fields.Version) > n(cur.fields.Version))) best.set(id, r); }
    return [...best.values()].map((r) => this.toRx(r, names, imgs.get(s(r.fields.Rx_ID)) || []));
  }
  async listPrescriptions(q: { patientId?: string; q?: string } = {}, scope?: Scope): Promise<Prescription[]> {
    let list = await this.latestRx();
    if (scope?.only) list = list.filter((x) => same(x.treatingPhysio, scope.only!));
    if (q.patientId) list = list.filter((x) => x.patientId === q.patientId);
    const t = (q.q || '').trim().toLowerCase();
    if (t) list = list.filter((x) => x.patientName.toLowerCase().includes(t) || x.rxId.toLowerCase().includes(t) || x.patientId.toLowerCase().includes(t) || x.diagnosis.toLowerCase().includes(t));
    return list.sort((x, y) => ((y.rxDate || '') < (x.rxDate || '') ? -1 : (y.rxDate || '') > (x.rxDate || '') ? 1 : y.rxId < x.rxId ? -1 : 1));
  }
  /** The conditions this clinic has actually written, most used first, each with the treatment / advice most recently used for it. Learned from saved prescriptions only:
   *  nothing is invented here and no patient name or id leaves this function. A doctor's login learns from its own prescriptions (same scope as the list). */
  async prescriptionSuggestions(scope?: Scope): Promise<Array<{ diagnosis: string; count: number; lastUsed: string | null; treatmentPlan: string; advice: string }>> {
    const byKey = new Map<string, { diagnosis: string; count: number; lastUsed: string | null; treatmentPlan: string; advice: string; at: string }>();
    for (const x of await this.listPrescriptions({}, scope)) {   // newest first
      const diagnosis = x.diagnosis.replace(/\s+/g, ' ').trim().slice(0, 160); if (!diagnosis) continue;
      const key = diagnosis.toLowerCase(); const cur = byKey.get(key);
      if (cur) { cur.count++; continue; }   // the first one seen is the newest: its wording and plan are the template
      byKey.set(key, { diagnosis, count: 1, lastUsed: x.rxDate, treatmentPlan: [x.treatmentPlan, x.exercises].filter(Boolean).join('\n\n').slice(0, 4000), advice: x.advice.slice(0, 4000), at: x.rxDate || '' });
    }
    return [...byKey.values()].sort((a, b) => b.count - a.count || (b.at < a.at ? -1 : b.at > a.at ? 1 : 0)).slice(0, 60).map(({ at, ...rest }) => { void at; return rest; });
  }
  async getPrescription(rxId: string, scope?: Scope): Promise<(Prescription & { versions: number[] }) | null> {
    const rx = (await this.latestRx()).find((x) => x.rxId === rxId);
    if (!rx || (scope?.only && !same(rx.treatingPhysio, scope.only))) return null;   // somebody else's prescription is simply not found
    const versions = (await this.rows(RT.prescriptions)).filter((r) => r.fields.Rx_ID === rxId).map((r) => n(r.fields.Version)).sort((x, y) => x - y);
    return { ...rx, versions };
  }
  savePrescription(input: PrescriptionInput, a: Actor, scope?: Scope): Promise<Prescription> {
    return this.lock.run(async () => {
      if (scope?.only) input = { ...input, treatingPhysio: scope.only };   // a doctor's name goes on their own prescriptions, whatever the form says
      const patients = await this.rows(RT.patients);
      if (!patients.some((r) => r.fields.Patient_ID === input.patientId)) throw bad('unknown_patient', 'Choose a registered patient first', 400);
      if (input.rxDate && !validDate(input.rxDate)) throw bad('invalid_date', 'Enter a valid prescription date');
      if (input.followUpOn && !validDate(input.followUpOn)) throw bad('invalid_date', 'Enter a valid follow-up date');
      const all = await this.rows(RT.prescriptions);
      let rxId = input.rxId; let version = 1;
      if (rxId) {
        const mine = all.filter((r) => r.fields.Rx_ID === rxId);
        if (!mine.length) throw bad('not_found', 'Prescription not found', 404);
        const latest = Math.max(...mine.map((r) => n(r.fields.Version)));
        if (scope?.only && !same(s(mine.find((r) => n(r.fields.Version) === latest)!.fields.Treating_Physio), scope.only)) throw bad('not_found', 'Prescription not found', 404);
        if (mine[0]!.fields.Patient_ID !== input.patientId) throw bad('patient_mismatch', 'A prescription cannot be moved to another patient', 409);
        if (input.baseVersion !== latest) throw bad('stale', 'This prescription was changed by someone else. Reload it and apply your edit again.', 409);
        version = latest + 1;
      } else rxId = `RX-${pad(maxSeq(all.map((r) => r.fields.Rx_ID), 'RX-') + 1)}`;
      await this.add(RT.prescriptions, [{ Rx_ID: rxId, Version: version, Patient_ID: input.patientId, Rx_Date: dateIn(input.rxDate || this.today()), Treating_Physio: input.treatingPhysio.trim(), BP: input.bp.trim(), Vitals: input.vitals.trim(), History: input.history,
        Examination: input.examination, Diagnosis: input.diagnosis, Treatment_Plan: input.treatmentPlan, Exercises: input.exercises, Advice: input.advice, Follow_Up_On: dateIn(input.followUpOn), Created_At: this.ts(), Created_By: a.name }]);
      await this.audit(a, version === 1 ? 'rx.create' : 'rx.update', rxId, `${input.patientId} v${version}`);   // ids only: no clinical text in the log
      // The follow-up date the doctor writes becomes the patient's: the dashboard, the register's "Follow-up due" and the W15 reminder all
      // read Patients.Follow_Up_On. Only when this save SETS or CHANGES it: re-saving an old prescription (a typo fix) must not drag the
      // patient back to its old date, and a prescription without a date never clears one set elsewhere (e.g. the dashboard's Reschedule).
      const before = version > 1 ? dateOut(all.find((r) => r.fields.Rx_ID === rxId && n(r.fields.Version) === version - 1)?.fields.Follow_Up_On) : null;
      if (input.followUpOn && input.followUpOn !== before) {
        const p = patients.find((r) => r.fields.Patient_ID === input.patientId)!;
        await this.patch(RT.patients, p.id, { Follow_Up_On: dateIn(input.followUpOn) });
        await this.audit(a, 'patient.followup', input.patientId, `follow-up ${input.followUpOn} (${rxId})`);
      }
      return (await this.getPrescription(rxId))!;
    });
  }

  // a doctor may only touch the photos of their own prescriptions
  private async ownsRx(rxId: string, scope?: Scope): Promise<boolean> { return !scope?.only || !!(await this.getPrescription(rxId, scope)); }

  addImage(rxId: string, file: { bytes: Uint8Array; name: string; caption?: string }, a: Actor, scope?: Scope): Promise<RxImage> {
    return this.lock.run(async () => {
      if (!(await this.ownsRx(rxId, scope))) throw bad('not_found', 'Prescription not found', 404);
      if (file.bytes.length === 0) throw bad('invalid_file', 'The file is empty');
      if (file.bytes.length > MAX_IMAGE_BYTES) throw bad('file_too_large', 'The photo is larger than 5 MB', 413);
      const mime = sniffImage(file.bytes);
      if (!mime) throw bad('invalid_file_type', 'Only JPEG or PNG photos can be attached', 415);
      const rx = (await this.rows(RT.prescriptions)).find((r) => r.fields.Rx_ID === rxId);
      if (!rx) throw bad('not_found', 'Prescription not found', 404);
      const imgs = await this.rows(RT.rxImages);
      if (imgs.filter((r) => r.fields.Rx_ID === rxId && r.fields.Removed !== true).length >= MAX_IMAGES_PER_RX) throw bad('too_many_images', `A prescription can have up to ${MAX_IMAGES_PER_RX} photos`, 409);
      const attachment = await this.grist.uploadAttachment(this.docId, `${rxId}-${Date.now()}.${mime === 'image/png' ? 'png' : 'jpg'}`, mime, file.bytes);   // stored in Grist; the original filename is not kept
      const imageId = `IMG-${pad(maxSeq(imgs.map((r) => r.fields.Image_ID), 'IMG-') + 1)}`;
      await this.add(RT.rxImages, [{ Image_ID: imageId, Rx_ID: rxId, Patient_ID: s(rx.fields.Patient_ID), File: ['L', attachment], Mime: mime, Bytes: file.bytes.length, Caption: (file.caption || '').slice(0, 200), Removed: false, Created_At: this.ts(), Created_By: a.name }]);
      await this.audit(a, 'rx.image.add', rxId, imageId);
      return { imageId, rxId, mime, bytes: file.bytes.length, caption: (file.caption || '').slice(0, 200), createdAt: new Date(this.now()).toISOString() };
    });
  }
  removeImage(rxId: string, imageId: string, a: Actor, scope?: Scope): Promise<void> {
    return this.lock.run(async () => {
      if (!(await this.ownsRx(rxId, scope))) throw bad('not_found', 'Photo not found', 404);
      const row = (await this.rows(RT.rxImages)).find((r) => r.fields.Image_ID === imageId && r.fields.Rx_ID === rxId && r.fields.Removed !== true);
      if (!row) throw bad('not_found', 'Photo not found', 404);
      await this.patch(RT.rxImages, row.id, { Removed: true });   // hidden, not deleted: the file stays in the doc
      await this.audit(a, 'rx.image.remove', rxId, imageId);
    });
  }
  async readImage(rxId: string, imageId: string, scope?: Scope): Promise<{ bytes: Uint8Array; mime: string } | null> {
    if (!(await this.ownsRx(rxId, scope))) return null;
    const row = (await this.rows(RT.rxImages)).find((r) => r.fields.Image_ID === imageId && r.fields.Rx_ID === rxId && r.fields.Removed !== true);
    const file = row?.fields.File;
    if (!row || !Array.isArray(file) || typeof file[1] !== 'number') return null;
    const got = await this.grist.downloadAttachment(this.docId, file[1]);
    return { bytes: got.bytes, mime: s(row.fields.Mime) === 'image/png' ? 'image/png' : 'image/jpeg' };
  }

  // ------------------------------------------------------------------ invoices and payments
  private assemble(inv: GristRecord[], lines: GristRecord[], pay: GristRecord[], names: Map<string, string>): Invoice[] {
    const lineBy = new Map<string, GristRecord[]>(); for (const l of lines) { const k = s(l.fields.Invoice_No); (lineBy.get(k) || lineBy.set(k, []).get(k)!).push(l); }
    const payBy = new Map<string, Payment[]>(); for (const p of pay) { const x = this.toPayment(p); (payBy.get(x.invoiceNo) || payBy.set(x.invoiceNo, []).get(x.invoiceNo)!).push(x); }
    return inv.filter((r) => s(r.fields.Invoice_No)).map((r) => {
      const f = r.fields; const no = s(f.Invoice_No); const payments = (payBy.get(no) || []).sort((x, y) => (x.createdAt || '') < (y.createdAt || '') ? -1 : 1);
      const paidPaise = payments.filter((p) => !p.voided).reduce((t, p) => t + p.amountPaise, 0); const total = n(f.Total_Paise); const status = s(f.Status) === 'void' ? 'void' : 'issued';
      return { invoiceNo: no, patientId: s(f.Patient_ID), patientName: names.get(s(f.Patient_ID)) || '', date: dateOut(f.Invoice_Date), status, subtotalPaise: n(f.Subtotal_Paise), discountPaise: n(f.Discount_Paise), taxLabel: s(f.Tax_Label), taxRateBp: n(f.Tax_Rate_Bp),
        taxPaise: n(f.Tax_Paise), totalPaise: total, paidPaise, balancePaise: status === 'void' ? 0 : Math.max(0, total - paidPaise), paymentStatus: paymentStatus(status, total, paidPaise), notes: s(f.Notes), voidReason: s(f.Void_Reason),
        createdAt: stamp(f.Created_At), createdBy: s(f.Created_By),
        lines: (lineBy.get(no) || []).map((l) => ({ lineNo: n(l.fields.Line_No), description: s(l.fields.Description), qty: n(l.fields.Qty), unitPaise: n(l.fields.Unit_Price_Paise), totalPaise: n(l.fields.Line_Total_Paise) })).sort((x, y) => x.lineNo - y.lineNo), payments };
    });
  }
  private async allInvoices(): Promise<Invoice[]> {
    const [inv, lines, pay, names] = await Promise.all([this.rows(RT.invoices), this.rows(RT.invoiceLines), this.rows(RT.payments), this.names()]);
    return this.assemble(inv, lines, pay, names);
  }
  async listInvoices(q: { patientId?: string; status?: string; q?: string } = {}, scope?: Scope): Promise<Invoice[]> {
    let list = await this.allInvoices();
    if (scope?.only) list = list.filter((i) => same(i.createdBy, scope.only!));
    if (q.patientId) list = list.filter((i) => i.patientId === q.patientId);
    if (q.status) list = list.filter((i) => i.paymentStatus === q.status);
    const t = (q.q || '').trim().toLowerCase();
    if (t) list = list.filter((i) => i.invoiceNo.toLowerCase().includes(t) || i.patientName.toLowerCase().includes(t) || i.patientId.toLowerCase().includes(t));
    return list.sort((x, y) => ((y.date || '') < (x.date || '') ? -1 : (y.date || '') > (x.date || '') ? 1 : y.invoiceNo < x.invoiceNo ? -1 : 1));
  }
  async getInvoice(no: string, scope?: Scope): Promise<Invoice | null> { return (await this.allInvoices()).find((i) => i.invoiceNo === no && (!scope?.only || same(i.createdBy, scope.only))) || null; }

  createInvoice(input: InvoiceInput, a: Actor, scope?: Scope): Promise<{ invoice: Invoice; duplicate: boolean; paymentError?: string }> {
    return this.lock.run(async () => {
      const [inv, lineRows, patients] = await Promise.all([this.rows(RT.invoices), this.rows(RT.invoiceLines), this.rows(RT.patients)]);
      const again = inv.find((r) => r.fields.Idem_Key === input.idemKey);
      if (again) { const first = await this.getInvoice(s(again.fields.Invoice_No), scope); if (!first) throw bad('conflict', 'This form was already submitted', 409); return { invoice: first, duplicate: true }; }   // the same form submitted twice: return the first result
      if (!patients.some((r) => r.fields.Patient_ID === input.patientId)) throw bad('unknown_patient', 'Choose a registered patient first');
      if (!validDate(input.date)) throw bad('invalid_date', 'Enter a valid invoice date');
      if (!input.lines.length || input.lines.length > 30) throw bad('invalid_lines', 'Add between 1 and 30 services');
      for (const l of input.lines) {
        if (!l.description.trim()) throw bad('invalid_lines', 'Every service needs a description');
        if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 9999) throw bad('invalid_qty', 'Quantity must be a whole number from 1 to 9999');
        if (!Number.isInteger(l.unitPaise) || l.unitPaise < 0 || l.unitPaise > MAX_PAISE) throw bad('invalid_price', 'Enter a valid price');
      }
      const tax = this.o.clinic().tax;
      if (input.applyTax && !tax) throw bad('tax_not_configured', 'No tax is configured for this clinic');
      const rateBp = input.applyTax && tax ? Math.round(tax.ratePercent * 100) : 0;
      const t = computeTotals(input.lines.map((l) => ({ ...l, description: l.description.trim() })), input.discountPaise, rateBp);
      if (t.subtotalPaise <= 0) throw bad('invalid_total', 'The invoice total must be more than zero');
      if (t.subtotalPaise > MAX_PAISE) throw bad('invalid_price', 'The invoice total is too large');
      if (!Number.isInteger(input.discountPaise) || input.discountPaise < 0 || input.discountPaise > t.subtotalPaise) throw bad('invalid_discount', 'Discount cannot be more than the subtotal');
      if (input.payment) this.checkPayment(input.payment.amountPaise, input.payment.method, input.payment.paidOn, t.totalPaise);

      const year = input.date.slice(0, 4); const prefix = `${this.prefix()}-${year}-`;
      const invoiceNo = `${prefix}${pad(Math.max(maxSeq(inv.map((r) => r.fields.Invoice_No), prefix), maxSeq(lineRows.map((r) => r.fields.Invoice_No), prefix)) + 1)}`;   // lines count too: an orphaned line never gets its number reused
      // lines first, header last: an invoice exists only once its header is written
      await this.add(RT.invoiceLines, t.lines.map((l, i) => ({ Invoice_No: invoiceNo, Line_No: i + 1, Description: l.description, Qty: l.qty, Unit_Price_Paise: l.unitPaise, Line_Total_Paise: l.totalPaise })));
      await this.add(RT.invoices, [{ Invoice_No: invoiceNo, Patient_ID: input.patientId, Invoice_Date: dateIn(input.date), Status: 'issued', Subtotal_Paise: t.subtotalPaise, Discount_Paise: t.discountPaise, Tax_Paise: t.taxPaise, Total_Paise: t.totalPaise,
        Tax_Label: rateBp && tax ? tax.label : '', Tax_Rate_Bp: rateBp, Notes: input.notes.trim(), Void_Reason: '', Idem_Key: input.idemKey, Created_At: this.ts(), Created_By: a.clinician || input.doctor || a.name }]);   // the doctor who raises an invoice owns its dues
      await this.audit(a, 'invoice.create', invoiceNo, `${input.patientId} total ${t.totalPaise}p`);
      let paymentError: string | undefined;
      if (input.payment) {
        try { await this.recordPayment(invoiceNo, input.payment, `${input.idemKey}-p`, a); }
        catch (e) { paymentError = e instanceof BackendError ? e.message : 'The payment could not be recorded'; }
      }
      return { invoice: (await this.getInvoice(invoiceNo))!, duplicate: false, ...(paymentError ? { paymentError } : {}) };
    });
  }

  private checkPayment(amount: number, method: string, paidOn: string, balance: number) {
    if (!Number.isInteger(amount) || amount <= 0) throw bad('invalid_amount', 'Enter an amount greater than zero');
    if (amount > balance) throw bad('overpayment', 'The payment is more than the balance due');
    if (!(PAYMENT_METHODS as readonly string[]).includes(method)) throw bad('invalid_method', 'Choose a payment method');
    if (!validDate(paidOn)) throw bad('invalid_date', 'Enter a valid payment date');
    if (paidOn > this.today()) throw bad('future_date', 'The payment date cannot be in the future');
  }
  private async recordPayment(invoiceNo: string, p: NonNullable<InvoiceInput['payment']>, idemKey: string, a: Actor): Promise<void> {
    const pays = await this.rows(RT.payments);
    if (pays.some((r) => r.fields.Idem_Key === idemKey)) return;
    const inv = await this.getInvoice(invoiceNo);
    if (!inv) throw bad('not_found', 'Invoice not found', 404);
    if (inv.status === 'void') throw bad('invoice_void', 'This invoice has been voided', 409);
    this.checkPayment(p.amountPaise, p.method, p.paidOn, inv.balancePaise);
    const paymentId = `PAY-${pad(maxSeq(pays.map((r) => r.fields.Payment_ID), 'PAY-') + 1)}`;
    await this.add(RT.payments, [{ Payment_ID: paymentId, Invoice_No: invoiceNo, Patient_ID: inv.patientId, Paid_On: dateIn(p.paidOn), Amount_Paise: p.amountPaise, Method: p.method, Reference: p.reference.trim(), Notes: '', Voided: false, Void_Reason: '', Idem_Key: idemKey, Created_At: this.ts(), Created_By: a.name }]);
    await this.audit(a, 'payment.add', paymentId, `${invoiceNo} ${p.amountPaise}p ${p.method}`);
  }
  addPayment(invoiceNo: string, p: NonNullable<InvoiceInput['payment']> & { idemKey: string }, a: Actor, scope?: Scope): Promise<Invoice> {
    return this.lock.run(async () => { if (p.idemKey.length < 8) throw bad('invalid', 'Missing duplicate-submission key'); if (!(await this.getInvoice(invoiceNo, scope))) throw bad('not_found', 'Invoice not found', 404); await this.recordPayment(invoiceNo, p, p.idemKey, a); return (await this.getInvoice(invoiceNo))!; });
  }
  voidPayment(paymentId: string, reason: string, a: Actor): Promise<Invoice> {
    return this.lock.run(async () => {
      if (a.role !== 'admin') throw bad('forbidden', 'Only an admin can void a payment', 403);
      if (reason.trim().length < 3) throw bad('reason_required', 'Give a reason');
      const row = (await this.rows(RT.payments)).find((r) => r.fields.Payment_ID === paymentId);
      if (!row) throw bad('not_found', 'Payment not found', 404);
      if (row.fields.Voided === true) throw bad('already_void', 'This payment is already voided', 409);
      await this.patch(RT.payments, row.id, { Voided: true, Void_Reason: reason.trim().slice(0, 300) });
      await this.audit(a, 'payment.void', paymentId, s(row.fields.Invoice_No));
      return (await this.getInvoice(s(row.fields.Invoice_No)))!;
    });
  }
  voidInvoice(invoiceNo: string, reason: string, a: Actor): Promise<Invoice> {
    return this.lock.run(async () => {
      if (a.role !== 'admin') throw bad('forbidden', 'Only an admin can void an invoice', 403);
      if (reason.trim().length < 3) throw bad('reason_required', 'Give a reason');
      const row = (await this.rows(RT.invoices)).find((r) => r.fields.Invoice_No === invoiceNo);
      if (!row) throw bad('not_found', 'Invoice not found', 404);
      if (s(row.fields.Status) === 'void') throw bad('already_void', 'This invoice is already voided', 409);
      if ((await this.getInvoice(invoiceNo))!.paidPaise > 0) throw bad('has_payments', 'Void its payments first, then void the invoice', 409);
      await this.patch(RT.invoices, row.id, { Status: 'void', Void_Reason: reason.trim().slice(0, 300) });
      await this.audit(a, 'invoice.void', invoiceNo, 'voided');
      return (await this.getInvoice(invoiceNo))!;
    });
  }

  // ------------------------------------------------------------------ visits / attendance
  // Doctor's overview: today's clinic, follow-ups, recent prescriptions and money, for the dashboard.
  // scope: a doctor's own prescriptions and dues only (attendance, follow-ups and the patient register stay shared). breakdown: the admin's per-doctor split.
  async doctorSummary(daysIn: number, scope?: Scope, breakdown = false): Promise<DoctorSummary> {
    const R = [1, 7, 30].includes(daysIn) ? daysIn : 7;
    const today = this.today(); const from = addDays(today, -(R - 1)); const prevTo = addDays(from, -1); const prevFrom = addDays(from, -R);
    const [pr, vis, allInv, allRx] = await Promise.all([this.rows(RT.patients), this.rows(RT.visits), this.allInvoices(), this.latestRx()]);
    const invoices = scope?.only ? allInv.filter((i) => same(i.createdBy, scope.only!)) : allInv;
    const rx = scope?.only ? allRx.filter((x) => same(x.treatingPhysio, scope.only!)) : allRx;
    const patients = pr.map((r) => this.toPatient(r)).filter((p) => p.patientId);
    const name = new Map(patients.map((p) => [p.patientId, p.name]));
    const visits = vis.map((r) => this.toVisit(r)).filter((v): v is NonNullable<typeof v> => !!v);
    const live = invoices.filter((i) => i.status !== 'void');
    const pays = live.flatMap((i) => i.payments).filter((p) => !p.voided && p.paidOn);
    const inR = (d: string | null | undefined, a: string, b: string) => !!d && d >= a && d <= b;
    // earliest date anything was recorded: a "previous period" only exists if the records reach back before it ended
    const dates = [...patients.map((p) => p.registeredOn), ...visits.map((v) => v.date), ...live.map((i) => i.date), ...pays.map((p) => p.paidOn), ...rx.map((x) => x.rxDate)].filter((d): d is string => !!d);
    const first = dates.length ? dates.reduce((m, d) => (d < m ? d : m)) : null;
    const hasPrev = !!first && first <= prevTo;
    const days7 = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
    const attended = visits.filter((v) => v.status === 'Attended');
    const count = <T,>(rows: T[], dateOf: (r: T) => string | null | undefined) => (a: string, b: string) => rows.filter((r) => inR(dateOf(r), a, b)).length;
    const sum = <T,>(rows: T[], dateOf: (r: T) => string | null | undefined, amt: (r: T) => number) => (a: string, b: string) => rows.filter((r) => inR(dateOf(r), a, b)).reduce((t, r) => t + amt(r), 0);
    const seenIn = (a: string, b: string) => new Set(attended.filter((v) => inR(v.date, a, b)).map((v) => v.patientId)).size;
    const visitsIn = count(attended, (v) => v.date);
    const newIn = count(patients, (p) => p.registeredOn);
    const rxIn = count(rx, (x) => x.rxDate);
    const paidIn = sum(pays, (p) => p.paidOn, (p) => p.amountPaise);
    const owedAt = (d: string) => Math.max(0, live.filter((i) => (i.date || '') <= d).reduce((t, i) => t + i.totalPaise, 0) - pays.filter((p) => (p.paidOn || '') <= d).reduce((t, p) => t + p.amountPaise, 0));
    const daily = (f: (a: string, b: string) => number) => days7.map((d) => f(d, d));
    const active = patients.filter((p) => p.status === 'Active');
    const horizon = addDays(today, 3);
    const due = active.filter((p) => p.followUpOn && p.followUpOn <= horizon).sort((x, y) => ((x.followUpOn || '') < (y.followUpOn || '') ? -1 : 1));
    const dueNow = due.filter((p) => (p.followUpOn || '') <= today);
    const owingBy = new Map<string, number>();
    for (const i of live) if (i.balancePaise > 0) owingBy.set(i.patientId, (owingBy.get(i.patientId) || 0) + i.balancePaise);
    const dayDiff = (d: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86400000);
    const todays = visits.filter((v) => v.date === today);
    const span = Math.max(7, R);
    const prev = (f: (a: string, b: string) => number) => (hasPrev ? f(prevFrom, prevTo) : null);
    let byDoctor: DoctorSummary['byDoctor'];
    if (breakdown) {   // admin: each doctor's dues, collections and prescriptions side by side; whatever no doctor raised (front desk / admin) is its own line
      const names = this.o.clinic().clinicians.map((c) => c.name).filter(Boolean);
      const liveAll = allInv.filter((i) => i.status !== 'void');
      const lines = [...names, ''].map((nm) => {
        const mine = liveAll.filter((i) => (names.find((x) => same(x, i.createdBy)) || '') === nm);
        return { name: nm || 'Other (front desk / admin)', outstandingPaise: mine.reduce((t, i) => t + i.balancePaise, 0),
          collectedPaise: mine.flatMap((i) => i.payments).filter((p) => !p.voided && inR(p.paidOn, from, today)).reduce((t, p) => t + p.amountPaise, 0),
          prescriptions: allRx.filter((x) => (nm ? same(x.treatingPhysio, nm) : !names.some((m) => same(m, x.treatingPhysio))) && inR(x.rxDate, from, today)).length };
      });
      byDoctor = lines.filter((l, i) => i < names.length || l.outstandingPaise || l.collectedPaise || l.prescriptions);
    }
    return {
      today, days: R, seriesDays: days7,
      tiles: {
        seen: { value: seenIn(from, today), previous: prev(seenIn), series: days7.map((d) => seenIn(d, d)) },
        followUps: { value: dueNow.length, previous: null, series: days7.map((d) => active.filter((p) => p.followUpOn === d).length) },
        active: { value: active.length, previous: null, series: days7.map((d) => active.filter((p) => (p.registeredOn || '') <= d && p.registeredOn).length) },
        newPatients: { value: newIn(from, today), previous: prev(newIn), series: daily(newIn) },
        prescriptions: { value: rxIn(from, today), previous: prev(rxIn), series: daily(rxIn) },
        collected: { value: paidIn(from, today), previous: prev(paidIn), series: daily(paidIn) },
        outstanding: { value: [...owingBy.values()].reduce((t, v) => t + v, 0), previous: hasPrev ? owedAt(prevTo) : null, series: days7.map(owedAt) },
        visits: { value: visitsIn(from, today), previous: prev(visitsIn), series: daily(visitsIn) },
      },
      collectedTodayPaise: paidIn(today, today),
      followUps: due.slice(0, 8).map((p) => ({ patientId: p.patientId, name: p.name, phone: p.phone, complaint: p.mainComplaint, followUpOn: p.followUpOn as string, overdueDays: Math.max(0, dayDiff(p.followUpOn as string)) })),
      todaysVisits: todays.map((v) => ({ patientId: v.patientId, name: name.get(v.patientId) || v.patientId, status: v.status })),
      recentPrescriptions: rx.filter((x) => inR(x.rxDate, from, today)).sort((x, y) => ((y.rxDate || '') < (x.rxDate || '') ? -1 : (y.rxDate || '') > (x.rxDate || '') ? 1 : 0)).slice(0, 6)
        .map((x) => ({ rxId: x.rxId, patientId: x.patientId, patientName: x.patientName, rxDate: x.rxDate, diagnosis: x.diagnosis })),
      owing: [...owingBy.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([id, v]) => ({ patientId: id, name: name.get(id) || id, outstandingPaise: v })),
      attendance: Array.from({ length: span }, (_, i) => { const d = addDays(today, i - (span - 1)); return { date: d, attended: visitsIn(d, d) }; }),
      ...(byDoctor ? { byDoctor } : {}),
    };
  }

  async visitsWeek(weekStart: string): Promise<VisitWeek> {
    const w0 = mondayOf(validDate(weekStart) ? weekStart : this.today()); const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));
    const [pr, vis] = await Promise.all([this.rows(RT.patients), this.rows(RT.visits)]);
    const cells = new Map<string, Record<string, { status: VisitStatus; notes: string }>>();
    for (const r of vis) { const v = this.toVisit(r); if (v && v.date >= w0 && v.date <= days[6]!) (cells.get(v.patientId) || cells.set(v.patientId, {}).get(v.patientId)!)[v.date] = { status: v.status, notes: v.notes }; }
    const rows = pr.map((r) => this.toPatient(r)).filter((p) => p.patientId && (p.status === 'Active' || cells.has(p.patientId))).sort((x, y) => x.serialNo - y.serialNo)
      .map((p) => ({ patientId: p.patientId, name: p.name, phone: p.phone, cells: Object.fromEntries(days.map((d) => [d, cells.get(p.patientId)?.[d] || null])) }));
    return { weekStart: w0, days, rows };
  }
  setVisit(i: { patientId: string; date: string; status: VisitStatus | null; notes?: string }, a: Actor): Promise<Visit | null> {
    return this.lock.run(async () => {
      if (!validDate(i.date)) throw bad('invalid_date', 'Enter a valid date');
      if (i.date > this.today()) throw bad('future_date', 'Attendance cannot be recorded for a future date');
      const [pr, vis] = await Promise.all([this.rows(RT.patients), this.rows(RT.visits)]);
      if (!pr.some((r) => r.fields.Patient_ID === i.patientId)) throw bad('unknown_patient', 'Patient not found', 404);
      const row = vis.find((r) => r.fields.Patient_ID === i.patientId && dateOut(r.fields.Visit_Date) === i.date);
      const fields = { Status: i.status ?? '', ...(i.notes !== undefined ? { Notes: i.notes.slice(0, 500) } : {}), Recorded_By: a.name };
      if (row) await this.patch(RT.visits, row.id, fields);
      else if (i.status) await this.add(RT.visits, [{ Patient_ID: i.patientId, Visit_Date: dateIn(i.date), Notes: i.notes?.slice(0, 500) || '', Created_At: this.ts(), ...fields }]);
      else return null;
      await this.audit(a, 'visit.set', i.patientId, `${i.date} ${i.status ?? 'cleared'}`);
      return i.status ? { patientId: i.patientId, date: i.date, status: i.status, notes: i.notes || '' } : null;
    });
  }

  // ------------------------------------------------------------------ staff attendance (the clinic's own people; optional tables Staff_Attendance + Staff_Members)
  private toStaff(r: GristRecord): { rowId: number; key: string; name: string; date: string; mark: StaffMark } | null {
    const f = r.fields; const d = dateOut(f.Att_Date); const st = s(f.Status);
    return d && s(f.Staff_Key) && (STAFF_STATUSES as readonly string[]).includes(st) ? { rowId: r.id, key: s(f.Staff_Key), name: s(f.Staff_Name), date: d, mark: { status: st as StaffStatus, notes: s(f.Notes) } } : null;
  }

  // People added by name on the page (staff with no login). Removed ones (Active off) are not listed, but their past marks stay.
  async activeStaffMembers(): Promise<StaffPerson[]> {
    return (await this.rows(STAFF_MEMBERS)).filter((r) => r.fields.Active === true && s(r.fields.Staff_Key) && s(r.fields.Name)).map((r) => ({ key: s(r.fields.Staff_Key), name: s(r.fields.Name) }));
  }
  // `listed`: the names already on the team list from logins and clinic.json, so the same person cannot be added twice.
  addStaffMember(rawName: string, listed: string[], a: Actor): Promise<{ member: StaffMember; reactivated: boolean }> {
    return this.lock.run(async () => {
      const name = rawName.replace(/\s+/g, ' ').trim();
      if (!name) throw bad('invalid', 'Enter the staff member\'s name');
      if (name.length > 80) throw bad('invalid', 'The name is too long (80 characters at most)');
      const key = nameKey(name);
      if (listed.some((x) => nameKey(x) === key)) throw bad('duplicate_staff', `${name} is already on the list`, 409);
      const rows = await this.rows(STAFF_MEMBERS);
      const same = rows.find((r) => nameKey(s(r.fields.Name)) === key);
      if (same) {
        if (same.fields.Active === true) throw bad('duplicate_staff', `${name} is already on the list`, 409);
        await this.patch(STAFF_MEMBERS, same.id, { Active: true });   // removed earlier: switch them back on, keeping the same key and all past marks
        await this.audit(a, 'staff.add', s(same.fields.Staff_Key), 'added again');
        return { member: { key: s(same.fields.Staff_Key), name: s(same.fields.Name) }, reactivated: true };
      }
      const staffKey = `staff:${pad(maxSeq(rows.map((r) => r.fields.Staff_Key), 'staff:') + 1)}`;
      await this.add(STAFF_MEMBERS, [{ Staff_Key: staffKey, Name: name, Active: true, Created_At: this.ts(), Created_By: a.email }]);
      await this.audit(a, 'staff.add', staffKey, 'added');
      return { member: { key: staffKey, name }, reactivated: false };
    });
  }
  // "Remove" hides the person from the list; nothing is deleted. Only people added by name can be removed (logins and doctors come from elsewhere).
  removeStaffMember(staffKey: string, a: Actor): Promise<void> {
    return this.lock.run(async () => {
      const row = (await this.rows(STAFF_MEMBERS)).find((r) => s(r.fields.Staff_Key) === staffKey);
      if (!row) throw bad('unknown_staff', 'That person was not added on this page', 404);
      if (row.fields.Active === true) { await this.patch(STAFF_MEMBERS, row.id, { Active: false }); await this.audit(a, 'staff.remove', staffKey, 'removed'); }
    });
  }

  // ---- the edit lock: a day that already has a mark can only be changed or cleared with the attendance edit password (set by an admin; only its hash is stored)
  private wrong = new Map<string, { n: number; first: number }>();
  private async lockRow() { return (await this.rows(STAFF_SETTINGS)).find((r) => s(r.fields.Key) === LOCK_KEY && s(r.fields.Value)); }
  async lockPasswordSet(): Promise<boolean> { return !!(await this.lockRow()); }
  // FIRST time: an admin just sets it. CHANGING it: the admin must also give the CURRENT edit password (so a logged-in admin session alone cannot replace the lock).
  // Wrong current passwords count towards the same 5-tries limit and are audited.
  setEditPassword(password: string, a: Actor, currentPassword?: string): Promise<void> {
    return this.lock.run(async () => {
      if (a.role !== 'admin') throw bad('forbidden', 'Only an admin can set the attendance edit password', 403);
      if (typeof password !== 'string' || password.length < 8) throw bad('weak_password', 'Use at least 8 characters', 400);
      if (password.length > 200) throw bad('weak_password', 'That password is too long', 400);
      const existing = await this.lockRow();
      if (existing) await this.unlock(currentPassword, a, LOCK_KEY, 'password change:', 'change');   // throws unless the current password is right: nothing is written
      const fields = { Value: hashPassword(password), Updated_At: this.ts(), Updated_By: a.email };
      const row = (await this.rows(STAFF_SETTINGS)).find((r) => s(r.fields.Key) === LOCK_KEY);
      if (row) await this.patch(STAFF_SETTINGS, row.id, fields); else await this.add(STAFF_SETTINGS, [{ Key: LOCK_KEY, ...fields }]);
      this.wrong.delete(a.email.toLowerCase());
      await this.audit(a, 'staffatt.password_set', LOCK_KEY, existing ? 'edit password changed' : 'edit password set');   // never the password
    });
  }
  // Throws unless `password` is the edit password. Wrong guesses are counted per person and audited. purpose: unlocking a marked day, or changing the password itself.
  private async unlock(password: string | undefined, a: Actor, record: string, what: string, purpose: 'edit' | 'change' = 'edit') {
    const who = a.email.toLowerCase(); const t = this.now(); const w = this.wrong.get(who);
    if (w && t - w.first <= WRONG_WINDOW_MS && w.n >= MAX_WRONG) throw bad('too_many_attempts', 'Too many wrong passwords. Wait 10 minutes and try again.', 429);
    const row = await this.lockRow();
    if (!row) throw bad('lock_not_set', 'This day is already marked and locked. Ask the admin to set the attendance edit password first.', 403);
    if (!password) throw bad(purpose === 'change' ? 'current_password_required' : 'edit_password_required', purpose === 'change' ? 'Enter the current edit password to change it.' : 'This day is already marked. Enter the attendance edit password to change it.', 403);
    if (!verifyPassword(password, s(row.fields.Value))) {
      this.wrong.set(who, w && t - w.first <= WRONG_WINDOW_MS ? { n: w.n + 1, first: w.first } : { n: 1, first: t });
      await this.audit(a, 'staffatt.edit_denied', record, `${what} wrong password`);
      throw bad(purpose === 'change' ? 'current_password_wrong' : 'edit_password_wrong', purpose === 'change' ? 'The current edit password is not right' : 'That password is not right', 403);
    }
    this.wrong.delete(who);
  }

  // The week, Monday to Sunday: everyone on the team list, plus anyone who has a mark that week but has since left the list.
  // onlyKey: a doctor's own login sees and marks only itself (and cannot manage the team). canSetPassword: the viewer is an admin.
  async staffWeek(weekStart: string, team: StaffPerson[], meKey: string, onlyKey?: string, canSetPassword = false): Promise<StaffWeek> {
    const w0 = mondayOf(validDate(weekStart) ? weekStart : this.today()); const days = Array.from({ length: 7 }, (_, i) => addDays(w0, i));
    const all = (await this.rows(STAFF_ATT)).map((r) => this.toStaff(r)).filter((x): x is NonNullable<typeof x> => !!x && x.date >= w0 && x.date <= days[6]!);
    const people = new Map<string, { name: string; former: boolean }>(team.map((p) => [p.key, { name: p.name, former: false }]));
    for (const x of all) if (!people.has(x.key)) people.set(x.key, { name: x.name || x.key, former: true });
    const rows = [...people.entries()].filter(([k]) => !onlyKey || k === onlyKey).map(([key, p]) => ({
      key, name: p.name, isMe: key === meKey, former: p.former, removable: !p.former && key.startsWith('staff:'),
      cells: Object.fromEntries(days.map((d) => [d, all.find((x) => x.key === key && x.date === d)?.mark || null])) as Record<string, StaffMark | null>,
    }));
    return { weekStart: w0, days, today: this.today(), canMarkOthers: !onlyKey, canManageTeam: !onlyKey, lockPasswordSet: await this.lockPasswordSet(), canSetLockPassword: canSetPassword && !onlyKey, rows };
  }

  // Days per status for one calendar month (YYYY-MM).
  async staffMonth(month: string, team: StaffPerson[], onlyKey?: string): Promise<StaffMonth> {
    const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : this.today().slice(0, 7);
    const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).getUTCDate();
    const a = `${m}-01`; const b = `${m}-${pad(last, 2)}`;
    const all = (await this.rows(STAFF_ATT)).map((r) => this.toStaff(r)).filter((x): x is NonNullable<typeof x> => !!x && x.date >= a && x.date <= b);
    const people = new Map<string, string>(team.map((p) => [p.key, p.name]));
    for (const x of all) if (!people.has(x.key)) people.set(x.key, x.name || x.key);
    const rows = [...people.entries()].filter(([k]) => !onlyKey || k === onlyKey).map(([key, name]) => {
      const mine = all.filter((x) => x.key === key);
      const count = (st: StaffStatus) => mine.filter((x) => x.mark.status === st).length;
      return { key, name, present: count('Present'), halfDay: count('Half day'), absent: count('Absent'), leave: count('Leave') };
    });
    return { month: m, rows };
  }

  // Set (or clear, with status null) one person's mark for one day. A note left out keeps its saved value.
  // The FIRST mark of a day is free. Once a day is marked it is locked: changing or clearing it needs the edit password (saving the same status and note again changes nothing).
  setStaffMark(i: StaffMarkInput, team: StaffPerson[], a: Actor): Promise<StaffMark | null> {
    return this.lock.run(async () => {
      if (!validDate(i.date)) throw bad('invalid_date', 'Enter a valid date');
      if (i.date > this.today()) throw bad('future_date', 'Attendance cannot be recorded for a future date');
      const person = team.find((p) => p.key === i.staffKey);
      const rows = await this.rows(STAFF_ATT);
      const row = rows.find((r) => s(r.fields.Staff_Key) === i.staffKey && dateOut(r.fields.Att_Date) === i.date);
      if (!person && !row) throw bad('unknown_staff', 'That person is not on the team list', 404);
      const prev = row ? this.toStaff(row)?.mark : undefined;
      const status = i.status;
      const notes = i.notes !== undefined ? i.notes.trim().slice(0, 500) : (prev?.notes ?? '');
      if (prev && status === prev.status && notes === prev.notes) return prev;          // nothing would change
      if (!prev && !status) return null;                                                // clearing a day that is not marked
      if (prev) await this.unlock(i.editPassword, a, i.staffKey, i.date);        // a marked day: needs the edit password (throws otherwise, nothing is written)
      const name = person?.name || (row ? s(row.fields.Staff_Name) : '') || i.staffKey;
      const fields = { Staff_Name: name, Status: status ?? '', Notes: status ? notes : '', Recorded_By: a.email, Updated_At: this.ts() };
      if (row) await this.patch(STAFF_ATT, row.id, fields);
      else if (status) await this.add(STAFF_ATT, [{ Staff_Key: i.staffKey, Att_Date: dateIn(i.date), Created_At: this.ts(), ...fields }]);
      else return null;
      await this.audit(a, prev ? 'staffatt.override' : 'staffatt.set', i.staffKey, prev ? `${i.date} ${prev.status} -> ${status ?? 'cleared'}` : `${i.date} ${status}`);
      return status ? { status, notes } : null;
    });
  }
}
