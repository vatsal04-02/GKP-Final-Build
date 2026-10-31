// Clinic records against the in-memory Grist (which rejects any column that is not in the schema). Synthetic data only.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GristClient, memoryGrist, type GristRecord } from '../src/server/grist';
import { RecordsService, sniffImage, type Actor, type ClinicConfig } from '../src/server/records/service';
import { RECORD_COLUMNS, RECORD_TABLE_NAMES, colNames } from '../src/server/records/schema';
import type { InvoiceInput, PrescriptionInput } from '../src/core/clinical';

const NOW = Date.UTC(2026, 9, 7, 6, 30);          // 2026-10-07 12:00 IST (a Wednesday)
const ADMIN: Actor = { email: 'admin@test', name: 'Admin', role: 'admin' };
const STAFF: Actor = { email: 'staff@test', name: 'Staff', role: 'staff' };
const CLINIC: ClinicConfig = { idPrefix: 'GK', name: 'Test Clinic', tagline: '', address: '', phones: [], timings: '', runBy: '', clinicians: [], tax: null };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

function setup(opts: { tax?: ClinicConfig['tax']; failOn?: (m: string, t: string) => boolean; now?: () => number } = {}) {
  const docs: Record<string, Record<string, GristRecord[]>> = { D: Object.fromEntries(RECORD_TABLE_NAMES.map((t) => [t, [] as GristRecord[]])) };
  const columns = Object.fromEntries(RECORD_TABLE_NAMES.map((t) => [t, colNames(t)]));
  const mem = memoryGrist(docs, { columns, failOn: opts.failOn });
  const svc = new RecordsService(new GristClient('http://memory', '', mem), 'D', { tz: 'Asia/Kolkata', clinic: () => ({ ...CLINIC, tax: opts.tax ?? null }), now: opts.now || (() => NOW) });
  return { svc, docs, mem };
}
const patient = (svc: RecordsService, name = 'Test Patient One', phone = '9876543210') => svc.createPatient({ name, phone }, STAFF);
const inv = (patientId: string, over: Partial<InvoiceInput> = {}): InvoiceInput => ({ patientId, date: '2026-10-07', lines: [{ description: 'Physiotherapy session', qty: 5, unitPaise: 60000 }], discountPaise: 0, applyTax: false, notes: '', idemKey: `key-${Math.random().toString(36).slice(2, 12)}`, ...over });
const rx = (patientId: string, over: Partial<PrescriptionInput> = {}): PrescriptionInput => ({ patientId, rxDate: '2026-10-07', treatingPhysio: 'Dr Test', bp: '120/80', vitals: '', history: 'h', examination: 'e', diagnosis: 'd', treatmentPlan: 't', exercises: '', advice: 'a', followUpOn: null, ...over });
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e as { code?: string }).code || String(e));

describe('schema doc and code agree', () => {
  const md = readFileSync(new URL('../../grist/clinic-records-schema.md', import.meta.url), 'utf8');
  it('every table and column in schema.ts is documented in grist/clinic-records-schema.md', () => {
    for (const t of RECORD_TABLE_NAMES) {
      const section = md.split(/^## /m).find((x) => x.startsWith(t + '\n'));
      expect(section, `table ${t} in the doc`).toBeTruthy();
      for (const c of colNames(t)) expect(section!, `${t}.${c}`).toMatch(new RegExp(`\\b${c}\\b`));
    }
    expect(Object.keys(RECORD_COLUMNS).sort()).toEqual([...RECORD_TABLE_NAMES].sort());
  });
});

describe('patients', () => {
  it('assigns stable ids and serials, normalises the phone', async () => {
    const { svc } = setup();
    const a = await patient(svc, 'Anita Test', '98765 43210'); const b = await patient(svc, 'Bharat Test', '+91 91234 56789');
    expect([a.patientId, a.serialNo, a.phone]).toEqual(['GK-P-000001', 1, '+919876543210']);
    expect([b.patientId, b.serialNo]).toEqual(['GK-P-000002', 2]);
    expect(a.registeredOn).toBe('2026-10-07'); expect(a.status).toBe('Active');
  });
  it('a blank registration date means today (the form sends null)', async () => {
    const { svc } = setup();
    expect((await svc.createPatient({ name: 'Blank Date Test', registeredOn: null, followUpOn: null }, STAFF)).registeredOn).toBe('2026-10-07');
    expect((await svc.createPatient({ name: 'Set Date Test', registeredOn: '2026-09-01' }, STAFF)).registeredOn).toBe('2026-09-01');
  });
  it('concurrent registrations never share an id', async () => {
    const { svc } = setup();
    const made = await Promise.all(Array.from({ length: 6 }, (_, i) => patient(svc, `Person ${String.fromCharCode(65 + i)}`, `98765432${10 + i}`)));
    expect(new Set(made.map((p) => p.patientId)).size).toBe(6); expect(new Set(made.map((p) => p.serialNo)).size).toBe(6);
  });
  it('validates name and phone', async () => {
    const { svc } = setup();
    expect(await code(svc.createPatient({ name: '  ', phone: '' }, STAFF))).toBe('invalid');
    expect(await code(svc.createPatient({ name: 'X Test', phone: '12345' }, STAFF))).toBe('invalid_phone');
    expect((await svc.createPatient({ name: 'No Phone Test' }, STAFF)).phone).toBe('');
  });
  it('warns about a duplicate (same phone or same name) and never merges', async () => {
    const { svc, docs } = setup();
    await patient(svc, 'Anita Test', '9876543210');
    const e = await svc.createPatient({ name: 'Different Name', phone: '098765 43210' }, STAFF).catch((x) => x);
    expect([e.code, e.status, e.extra.matches[0].patientId]).toEqual(['possible_duplicate', 409, 'GK-P-000001']);
    expect(await code(svc.createPatient({ name: '  ANITA   test ', phone: '' }, STAFF))).toBe('possible_duplicate');
    expect(docs.D!.Patients).toHaveLength(1);
    expect((await svc.createPatient({ name: 'Different Name', phone: '9876543210' }, STAFF, true)).patientId).toBe('GK-P-000002');
  });
  it('editing warns only about what the edit changes (a known duplicate is not nagged about on every save)', async () => {
    const { svc } = setup();
    await patient(svc, 'Twin One', '9000000001');
    const twin = await svc.createPatient({ name: 'Twin Two', phone: '9000000001' }, STAFF, true);          // registered on purpose: same phone as Twin One
    await patient(svc, 'Third Person', '9000000003');
    // the edit form sends the whole record: unchanged name and phone, changed notes -> no warning
    expect((await svc.updatePatient(twin.patientId, { name: 'Twin Two', phone: '9000000001', notes: 'edited', occupation: 'Teacher' }, STAFF)).notes).toBe('edited');
    // changing the phone TO another patient's number, or the name TO another patient's name, does warn
    expect(await code(svc.updatePatient(twin.patientId, { name: 'Twin Two', phone: '9000000003' }, STAFF))).toBe('possible_duplicate');
    expect(await code(svc.updatePatient(twin.patientId, { name: 'third person' }, STAFF))).toBe('possible_duplicate');
    expect((await svc.updatePatient(twin.patientId, { name: 'third person', phone: '9000000009' }, STAFF, true)).name).toBe('third person');   // confirmed
  });
  it('searches by name, phone digits and id; sorts; paginates; filters', async () => {
    const { svc } = setup();
    for (const [n, p] of [['Charu Test', '9000000001'], ['Anil Test', '9000000002'], ['Bina Test', '9000000003']] as const) await patient(svc, n, p);
    expect((await svc.listPatients({ q: 'anil' })).rows.map((r) => r.name)).toEqual(['Anil Test']);
    expect((await svc.listPatients({ q: '90000 00003' })).rows.map((r) => r.name)).toEqual(['Bina Test']);
    expect((await svc.listPatients({ q: 'gk-p-000001' })).rows.map((r) => r.name)).toEqual(['Charu Test']);
    expect((await svc.listPatients({ sort: 'name' })).rows.map((r) => r.name)).toEqual(['Anil Test', 'Bina Test', 'Charu Test']);
    expect((await svc.listPatients({ sort: 'name', dir: 'desc', pageSize: 2, page: 2 })).rows.map((r) => r.name)).toEqual(['Anil Test']);
    await svc.updatePatient('GK-P-000002', { followUpOn: '2026-10-06' }, STAFF);
    expect((await svc.listPatients({ followUp: true })).rows.map((r) => r.name)).toEqual(['Anil Test']);
  });
  it('edits, and refuses an unknown id', async () => {
    const { svc } = setup(); await patient(svc);
    const u = await svc.updatePatient('GK-P-000001', { occupation: 'Teacher', referredBy: 'Dr Ref', mainComplaint: 'Knee pain' }, STAFF);
    expect([u.occupation, u.referredBy, u.mainComplaint]).toEqual(['Teacher', 'Dr Ref', 'Knee pain']);
    expect(await code(svc.updatePatient('GK-P-999999', { occupation: 'x' }, STAFF))).toBe('not_found');
  });
});

describe('prescriptions', () => {
  it('needs a registered patient; saves optional fields blank; versions instead of overwriting', async () => {
    const { svc, docs } = setup();
    expect(await code(svc.savePrescription(rx('GK-P-000001'), STAFF))).toBe('unknown_patient');
    await patient(svc);
    const v1 = await svc.savePrescription(rx('GK-P-000001', { history: '', examination: '', diagnosis: '', treatmentPlan: '', advice: '' }), STAFF);
    expect([v1.rxId, v1.version, v1.patientName]).toEqual(['RX-000001', 1, 'Test Patient One']);
    const v2 = await svc.savePrescription({ ...rx('GK-P-000001', { diagnosis: 'Updated' }), rxId: 'RX-000001', baseVersion: 1 }, STAFF);
    expect([v2.version, v2.diagnosis]).toEqual([2, 'Updated']);
    expect(docs.D!.Prescriptions).toHaveLength(2);                                              // v1 is kept
    expect((await svc.listPrescriptions({ patientId: 'GK-P-000001' }))).toHaveLength(1);        // the list shows the latest only
    expect((await svc.getPrescription('RX-000001'))!.versions).toEqual([1, 2]);
  });
  it('the follow-up date the doctor writes becomes the patient\'s, only when the save sets or changes it (W15 and the dashboard read it)', async () => {
    const { svc, docs } = setup(); await patient(svc);
    const fu = async () => (await svc.listPatients({})).rows[0]!.followUpOn;
    await svc.savePrescription(rx('GK-P-000001', { followUpOn: '2026-10-20' }), STAFF);
    expect(await fu()).toBe('2026-10-20');                                       // a new prescription sets it
    await svc.updatePatient('GK-P-000001', { followUpOn: '2026-10-25' }, STAFF);  // the dashboard's Reschedule
    await svc.savePrescription({ ...rx('GK-P-000001', { followUpOn: '2026-10-20', diagnosis: 'typo fixed' }), rxId: 'RX-000001', baseVersion: 1 }, STAFF);
    expect(await fu()).toBe('2026-10-25');                                       // re-saving the SAME date (a typo fix) does not undo the reschedule
    await svc.savePrescription({ ...rx('GK-P-000001', { followUpOn: '2026-11-02' }), rxId: 'RX-000001', baseVersion: 2 }, STAFF);
    expect(await fu()).toBe('2026-11-02');                                       // changing it on the prescription moves the patient's date
    await svc.savePrescription(rx('GK-P-000001', { followUpOn: null }), STAFF);
    expect(await fu()).toBe('2026-11-02');                                       // a prescription without a date never clears it
    expect(docs.D!.Audit_Log!.filter((r) => r.fields.Action === 'patient.followup').map((r) => r.fields.Summary)).toEqual(['follow-up 2026-10-20 (RX-000001)', 'follow-up 2026-11-02 (RX-000001)']);
  });
  it('refuses a stale edit and a move to another patient', async () => {
    const { svc } = setup(); await patient(svc); await patient(svc, 'Other Test', '9111111111');
    await svc.savePrescription(rx('GK-P-000001'), STAFF);
    await svc.savePrescription({ ...rx('GK-P-000001'), rxId: 'RX-000001', baseVersion: 1 }, STAFF);
    expect(await code(svc.savePrescription({ ...rx('GK-P-000001'), rxId: 'RX-000001', baseVersion: 1 }, STAFF))).toBe('stale');
    expect(await code(svc.savePrescription({ ...rx('GK-P-000002'), rxId: 'RX-000001', baseVersion: 2 }, STAFF))).toBe('patient_mismatch');
  });
  it('photos: type by file signature, size cap, count cap, round trip, hidden not deleted', async () => {
    const { svc, docs } = setup(); await patient(svc); await svc.savePrescription(rx('GK-P-000001'), STAFF);
    expect(await code(svc.addImage('RX-000001', { bytes: new TextEncoder().encode('<script>alert(1)</script>'), name: 'x.jpg' }, STAFF))).toBe('invalid_file_type');
    expect(await code(svc.addImage('RX-000001', { bytes: new Uint8Array(0), name: 'x.jpg' }, STAFF))).toBe('invalid_file');
    expect(await code(svc.addImage('RX-000001', { bytes: new Uint8Array(5 * 1024 * 1024 + 1).fill(0xff), name: 'x.jpg' }, STAFF))).toBe('file_too_large');
    expect(await code(svc.addImage('RX-999999', { bytes: JPEG, name: 'x.jpg' }, STAFF))).toBe('not_found');
    const a = await svc.addImage('RX-000001', { bytes: JPEG, name: 'a.jpg', caption: 'front' }, STAFF); const b = await svc.addImage('RX-000001', { bytes: PNG, name: 'b.png' }, STAFF);
    expect([a.imageId, a.mime, b.mime]).toEqual(['IMG-000001', 'image/jpeg', 'image/png']);
    expect(Array.from((await svc.readImage('RX-000001', a.imageId))!.bytes)).toEqual(Array.from(JPEG));
    expect(await svc.readImage('RX-000002', a.imageId)).toBeNull();                              // an image is only served through its own prescription
    const row = docs.D!.Rx_Images![0]!.fields; expect(row.File).toEqual(['L', 1]); expect(row.Patient_ID).toBe('GK-P-000001');   // referenced by an Attachments cell, so Grist keeps it
    expect((await svc.getPrescription('RX-000001'))!.images).toHaveLength(2);
    await svc.removeImage('RX-000001', a.imageId, STAFF);
    expect((await svc.getPrescription('RX-000001'))!.images.map((i) => i.imageId)).toEqual([b.imageId]);
    expect(await svc.readImage('RX-000001', a.imageId)).toBeNull(); expect(docs.D!.Rx_Images).toHaveLength(2);   // hidden, the record remains
    for (let i = 0; i < 5; i++) await svc.addImage('RX-000001', { bytes: JPEG, name: 'n.jpg' }, STAFF);   // 1 left + 5 = 6 active (the cap)
    expect(await code(svc.addImage('RX-000001', { bytes: JPEG, name: 'n.jpg' }, STAFF))).toBe('too_many_images');
  });
  it('a failed photo upload is reported, and nothing is recorded', async () => {
    const { svc, docs } = setup({ failOn: (_m, t) => t === 'attachments' }); await patient(svc); await svc.savePrescription(rx('GK-P-000001'), STAFF);
    expect(await code(svc.addImage('RX-000001', { bytes: JPEG, name: 'a.jpg' }, STAFF))).not.toBe('ok');
    expect(docs.D!.Rx_Images).toHaveLength(0);
  });
  it('sniffImage', () => { expect(sniffImage(JPEG)).toBe('image/jpeg'); expect(sniffImage(PNG)).toBe('image/png'); expect(sniffImage(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull(); });
});

describe('invoices', () => {
  it('numbers invoices by year, stores integer paise, and computes totals on the server', async () => {
    const { svc } = setup(); await patient(svc);
    const a = (await svc.createInvoice(inv('GK-P-000001', { discountPaise: 50000, lines: [{ description: 'Session', qty: 5, unitPaise: 60000 }, { description: 'Ultrasound', qty: 1, unitPaise: 15050 }] }), STAFF)).invoice;
    expect([a.invoiceNo, a.subtotalPaise, a.discountPaise, a.taxPaise, a.totalPaise, a.balancePaise, a.paymentStatus]).toEqual(['GK-2026-000001', 315050, 50000, 0, 265050, 265050, 'unpaid']);
    expect((await svc.createInvoice(inv('GK-P-000001'), STAFF)).invoice.invoiceNo).toBe('GK-2026-000002');
    expect((await svc.createInvoice(inv('GK-P-000001', { date: '2027-01-02' }), STAFF)).invoice.invoiceNo).toBe('GK-2027-000001');
  });
  it('applies tax only when configured, on the discounted amount', async () => {
    const off = setup(); await patient(off.svc);
    expect(await code(off.svc.createInvoice(inv('GK-P-000001', { applyTax: true }), STAFF))).toBe('tax_not_configured');
    const on = setup({ tax: { label: 'GST', ratePercent: 5 } }); await patient(on.svc);
    const i = (await on.svc.createInvoice(inv('GK-P-000001', { applyTax: true, discountPaise: 100000, lines: [{ description: 'x', qty: 2, unitPaise: 150050 }] }), STAFF)).invoice;
    expect([i.taxLabel, i.taxRateBp, i.taxPaise, i.totalPaise]).toEqual(['GST', 500, 10005, 210105]);   // (300100-100000)=200100 -> 5% = 10005
    expect((await on.svc.createInvoice(inv('GK-P-000001'), STAFF)).invoice.taxPaise).toBe(0);           // tax is opt-in per invoice
  });
  it('rejects bad money and bad input before writing anything', async () => {
    const { svc, docs } = setup(); await patient(svc);
    const L = (qty: number, unitPaise: number) => [{ description: 'x', qty, unitPaise }];
    expect(await code(svc.createInvoice(inv('GK-P-000001', { lines: L(0, 100) }), STAFF))).toBe('invalid_qty');
    expect(await code(svc.createInvoice(inv('GK-P-000001', { lines: L(1.5, 100) }), STAFF))).toBe('invalid_qty');
    expect(await code(svc.createInvoice(inv('GK-P-000001', { lines: L(1, -5) }), STAFF))).toBe('invalid_price');
    expect(await code(svc.createInvoice(inv('GK-P-000001', { lines: L(1, 100.5) }), STAFF))).toBe('invalid_price');
    expect(await code(svc.createInvoice(inv('GK-P-000001', { lines: L(1, 0) }), STAFF))).toBe('invalid_total');
    expect(await code(svc.createInvoice(inv('GK-P-000001', { lines: [] }), STAFF))).toBe('invalid_lines');
    expect(await code(svc.createInvoice(inv('GK-P-000001', { lines: [{ description: ' ', qty: 1, unitPaise: 100 }] }), STAFF))).toBe('invalid_lines');
    expect(await code(svc.createInvoice(inv('GK-P-000001', { lines: L(1, 100), discountPaise: 101 }), STAFF))).toBe('invalid_discount');
    expect(await code(svc.createInvoice(inv('GK-P-000001', { date: '2026-02-30' }), STAFF))).toBe('invalid_date');
    expect(await code(svc.createInvoice(inv('GK-P-404404'), STAFF))).toBe('unknown_patient');
    expect(await code(svc.createInvoice(inv('GK-P-000001', { payment: { amountPaise: 9999999, method: 'Cash', reference: '', paidOn: '2026-10-07' } }), STAFF))).toBe('overpayment');
    expect(docs.D!.Invoices).toHaveLength(0); expect(docs.D!.Invoice_Lines).toHaveLength(0); expect(docs.D!.Payments).toHaveLength(0);
  });
  it('the same form submitted twice, even at the same instant, makes one invoice', async () => {
    const { svc, docs } = setup(); await patient(svc);
    const same = inv('GK-P-000001', { idemKey: 'one-form-submit' });
    const [x, y] = await Promise.all([svc.createInvoice(same, STAFF), svc.createInvoice(same, STAFF)]);
    expect(x.invoice.invoiceNo).toBe(y.invoice.invoiceNo); expect([x.duplicate, y.duplicate].sort()).toEqual([false, true]);
    expect(docs.D!.Invoices).toHaveLength(1);
  });
  it('a failed header write leaves no invoice, and the number is not reused for other lines', async () => {
    let fail = true;
    const { svc, docs } = setup({ failOn: (m, t) => fail && m === 'POST' && t === 'Invoices' }); await patient(svc);
    expect(await code(svc.createInvoice(inv('GK-P-000001'), STAFF))).not.toBe('ok');
    expect((await svc.listInvoices())).toHaveLength(0);
    expect((await svc.listPatients({})).rows[0]!.billedPaise).toBe(0);
    fail = false;
    const i = (await svc.createInvoice(inv('GK-P-000001', { lines: [{ description: 'Second', qty: 1, unitPaise: 1000 }] }), STAFF)).invoice;
    expect(i.invoiceNo).toBe('GK-2026-000002'); expect(i.lines).toHaveLength(1); expect(i.lines[0]!.description).toBe('Second');   // never inherits the orphaned line of number 000001
    expect(docs.D!.Invoice_Lines).toHaveLength(2);
  });
  it('records payments, keeps balances right, refuses overpayment, and is safe against double clicks', async () => {
    const { svc } = setup(); await patient(svc);
    const no = (await svc.createInvoice(inv('GK-P-000001'), STAFF)).invoice.invoiceNo;     // 5 x 600 = 3000.00
    const pay = (amountPaise: number, key: string, over = {}) => svc.addPayment(no, { amountPaise, method: 'UPI', reference: 'ref', paidOn: '2026-10-07', idemKey: key, ...over }, STAFF);
    const p1 = await pay(100000, 'pay-key-0001'); expect([p1.paidPaise, p1.balancePaise, p1.paymentStatus]).toEqual([100000, 200000, 'partial']);
    await Promise.all([pay(50000, 'pay-key-0002'), pay(50000, 'pay-key-0002')]);
    expect((await svc.getInvoice(no))!.paidPaise).toBe(150000);                            // 100000 + 50000: the double click counted once
    expect(await code(pay(150001, 'pay-key-0003'))).toBe('overpayment');
    expect(await code(pay(0, 'pay-key-0004'))).toBe('invalid_amount');
    expect(await code(pay(1000, 'pay-key-0005', { paidOn: '2026-10-09' }))).toBe('future_date');
    expect(await code(pay(1000, 'pay-key-0006', { method: 'Barter' }))).toBe('invalid_method');
    const done = await pay(150000, 'pay-key-0007'); expect([done.balancePaise, done.paymentStatus]).toEqual([0, 'paid']);
    expect(await code(pay(1, 'pay-key-0008'))).toBe('overpayment');                       // nothing left to pay
    expect(done.payments).toHaveLength(3);
  });
  it('an initial payment is recorded with the invoice; a payment failure is reported honestly', async () => {
    const { svc } = setup(); await patient(svc);
    const r = await svc.createInvoice(inv('GK-P-000001', { payment: { amountPaise: 100000, method: 'Cash', reference: '', paidOn: '2026-10-07' } }), STAFF);
    expect([r.invoice.paidPaise, r.invoice.paymentStatus, r.paymentError]).toEqual([100000, 'partial', undefined]);
    const f = setup({ failOn: (m, t) => m === 'POST' && t === 'Payments' }); await patient(f.svc);
    const r2 = await f.svc.createInvoice(inv('GK-P-000001', { payment: { amountPaise: 100000, method: 'Cash', reference: '', paidOn: '2026-10-07' } }), STAFF);
    expect(r2.invoice.invoiceNo).toBe('GK-2026-000001'); expect(r2.invoice.paidPaise).toBe(0); expect(r2.paymentError).toBeTruthy();
  });
  it('voiding: admin only, reason required, payments first; nothing is deleted; totals follow', async () => {
    const { svc, docs } = setup(); await patient(svc);
    const no = (await svc.createInvoice(inv('GK-P-000001', { payment: { amountPaise: 100000, method: 'Cash', reference: '', paidOn: '2026-10-07' } }), STAFF)).invoice.invoiceNo;
    expect((await svc.listPatients({})).rows[0]).toMatchObject({ billedPaise: 300000, paidPaise: 100000, outstandingPaise: 200000 });
    expect(await code(svc.voidInvoice(no, 'entered twice', STAFF))).toBe('forbidden');
    expect(await code(svc.voidInvoice(no, 'entered twice', ADMIN))).toBe('has_payments');
    expect(await code(svc.voidPayment('PAY-000001', 'x', ADMIN))).toBe('reason_required');
    expect(await code(svc.voidPayment('PAY-000001', 'wrong amount', STAFF))).toBe('forbidden');
    expect((await svc.voidPayment('PAY-000001', 'wrong amount', ADMIN)).paidPaise).toBe(0);
    expect(await code(svc.voidPayment('PAY-000001', 'again', ADMIN))).toBe('already_void');
    const v = await svc.voidInvoice(no, 'entered twice', ADMIN);
    expect([v.status, v.paymentStatus, v.balancePaise]).toEqual(['void', 'void', 0]);
    expect(await code(svc.addPayment(no, { amountPaise: 100, method: 'Cash', reference: '', paidOn: '2026-10-07', idemKey: 'late-payment-1' }, STAFF))).toBe('invoice_void');
    expect((await svc.listPatients({})).rows[0]).toMatchObject({ billedPaise: 0, paidPaise: 0, outstandingPaise: 0 });
    expect(docs.D!.Invoices).toHaveLength(1); expect(docs.D!.Payments).toHaveLength(1);      // history is kept
  });
});

describe('visits and attendance', () => {
  it('marks, updates and clears a day; shows a Monday-Sunday week; older weeks keep their history', async () => {
    const { svc, docs } = setup(); await patient(svc); await patient(svc, 'Second Test', '9111111111');
    await svc.setVisit({ patientId: 'GK-P-000001', date: '2026-10-05', status: 'Attended' }, STAFF);       // Monday
    await svc.setVisit({ patientId: 'GK-P-000001', date: '2026-10-06', status: 'Missed' }, STAFF);
    await svc.setVisit({ patientId: 'GK-P-000001', date: '2026-10-06', status: 'Attended', notes: 'came late' }, STAFF);   // same day: updated, not duplicated
    await svc.setVisit({ patientId: 'GK-P-000001', date: '2026-09-29', status: 'Attended' }, STAFF);       // last week
    const w = await svc.visitsWeek('2026-10-07');
    expect(w.weekStart).toBe('2026-10-05'); expect(w.days).toHaveLength(7); expect(w.days[6]).toBe('2026-10-11');
    expect(w.rows[0]!.cells['2026-10-05']!.status).toBe('Attended'); expect(w.rows[0]!.cells['2026-10-06']).toEqual({ status: 'Attended', notes: 'came late' }); expect(w.rows[0]!.cells['2026-10-07']).toBeNull();
    expect((await svc.visitsWeek('2026-09-29')).rows[0]!.cells['2026-09-29']!.status).toBe('Attended');
    expect(docs.D!.Visits).toHaveLength(3);
    await svc.setVisit({ patientId: 'GK-P-000001', date: '2026-10-06', status: null }, STAFF);
    expect((await svc.visitsWeek('2026-10-05')).rows[0]!.cells['2026-10-06']).toBeNull();
    expect((await svc.listPatients({ week: '2026-10-05' })).rows[0]!.attendance).toEqual({ '2026-10-05': 'Attended' });
    expect((await svc.listPatients({})).rows[0]!.latestVisit).toBe('2026-10-05');
  });
  it('refuses future dates and unknown patients', async () => {
    const { svc } = setup(); await patient(svc);
    expect(await code(svc.setVisit({ patientId: 'GK-P-000001', date: '2026-10-08', status: 'Attended' }, STAFF))).toBe('future_date');
    expect(await code(svc.setVisit({ patientId: 'GK-P-404', date: '2026-10-07', status: 'Attended' }, STAFF))).toBe('unknown_patient');
  });
});

describe('profile and audit', () => {
  it('links prescriptions, invoices, payments and visits to one stable patient id', async () => {
    const { svc } = setup(); await patient(svc); await patient(svc, 'Other Test', '9111111111');
    await svc.savePrescription(rx('GK-P-000001'), STAFF);
    await svc.createInvoice(inv('GK-P-000001', { payment: { amountPaise: 100000, method: 'Cash', reference: '', paidOn: '2026-10-07' } }), STAFF);
    await svc.createInvoice(inv('GK-P-000002'), STAFF);
    await svc.setVisit({ patientId: 'GK-P-000001', date: '2026-10-07', status: 'Attended' }, STAFF);
    const p = (await svc.profile('GK-P-000001'))!;
    expect([p.prescriptions.length, p.invoices.length, p.payments.length, p.visits.length]).toEqual([1, 1, 1, 1]);
    expect(p.invoices[0]!.patientId).toBe('GK-P-000001'); expect(p.patient.outstandingPaise).toBe(200000);
    expect((await svc.profile('GK-P-000002'))!.payments).toHaveLength(0);
    expect(await svc.profile('GK-P-404')).toBeNull();
  });
  it('writes an audit trail that holds ids and amounts, never clinical text', async () => {
    const { svc, docs } = setup(); await patient(svc, 'Secret Name Test', '9111111111');
    await svc.savePrescription(rx('GK-P-000001', { diagnosis: 'UNIQUE-DIAGNOSIS-TEXT', history: 'UNIQUE-HISTORY-TEXT' }), STAFF);
    await svc.createInvoice(inv('GK-P-000001'), STAFF);
    const log = JSON.stringify(docs.D!.Audit_Log);
    expect(docs.D!.Audit_Log!.map((r) => r.fields.Action)).toEqual(['patient.create', 'rx.create', 'invoice.create']);
    expect(log).not.toMatch(/UNIQUE-DIAGNOSIS|UNIQUE-HISTORY|Secret Name/);
  });
});
