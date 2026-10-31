// The n8n <-> FLOW HQ booking contract. n8n/final/tests/helpers/booking-contract.js describes it once; the workflow tests use it to reject any request the
// real API would reject. THIS test keeps that description honest: the same requests go to the REAL routes, and the verdicts must agree
// (a request the contract calls valid must never get 400 from the server; a request it calls invalid must get 400).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildFixture, M09, M10 } from './booking-fixture';

const require = createRequire(import.meta.url);
const contract = require('../../n8n/final/tests/helpers/booking-contract.js') as {
  validate: (r: { method: string; url: string; headers?: Record<string, string>; body?: unknown }) => null | { status: number; code: string; why: string };
  cases: (x: { slot: string; ref: string; phone: string }) => Array<[string, { method: string; url: string; headers?: Record<string, string>; body?: unknown }, boolean]>;
};

describe('the contract module agrees with the real booking routes', () => {
  it('every canonical request gets the verdict the contract gives it (valid: not 400; invalid: 400)', async () => {
    const f = await buildFixture({ bookingOn: true });
    // a real appointment to read / move / cancel, made through the same API
    const made = await f.api('/appointments', { method: 'POST', headers: { 'idempotency-key': 'contract-seed-key-1' }, body: { slot_id: M09, patient: { name: 'Seed Patient', phone: '+919876500001' } } });
    expect(made.status).toBe(201);
    const ref = made.json.appointment.booking_reference as string;
    const rows: string[] = [];
    for (const [name, req, valid] of contract.cases({ slot: M10, ref, phone: '+919876500001' })) {
      expect(contract.validate(req) === null, `contract verdict for "${name}"`).toBe(valid);
      const path = req.url.replace('/api/booking', '');
      const got = await f.api(path, { method: req.method, ...(req.headers ? { headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])) } : {}), ...(req.body !== undefined ? { body: req.body } : {}) });
      rows.push(`${name}: ${got.status}`);
      if (valid) expect(got.status, `"${name}" must be accepted by the server (got ${got.status} ${JSON.stringify(got.json)})`).not.toBe(400);
      else expect(got.status, `"${name}" must be rejected by the server with 400 (got ${got.status})`).toBe(400);
    }
    expect(rows.length).toBeGreaterThanOrEqual(17);
  });

  it('patient-phone ownership: a wrong phone cannot read, move or cancel (indistinguishable from not found); the right phone can', async () => {
    const f = await buildFixture({ bookingOn: true });
    const made = await f.api('/appointments', { method: 'POST', headers: { 'idempotency-key': 'phone-seed-key-01' }, body: { slot_id: M09, patient: { name: 'Owner Patient', phone: '+919876500002' } } });
    const ref = made.json.appointment.booking_reference as string; const other = '+919876500999';
    expect((await f.api(`/appointments/${ref}?patient_phone=${encodeURIComponent(other)}`)).status).toBe(404);
    expect((await f.api(`/appointments/${ref}`, { method: 'PATCH', body: { patient_phone: other, slot_id: M10 } })).status).toBe(404);
    expect((await f.api(`/appointments/${ref}/cancel`, { method: 'POST', body: { patient_phone: other } })).status).toBe(404);
    expect((await f.api(`/appointments/${ref}?patient_phone=${encodeURIComponent('+919876500002')}`)).status).toBe(200);
  });

  it('duplicate prevention: the same idempotency key replays (200, same reference); the same patient cannot take the same slot twice under another key (409)', async () => {
    const f = await buildFixture({ bookingOn: true });
    const body = { slot_id: M09, patient: { name: 'Dup Patient', phone: '+919876500003' } };
    const a = await f.api('/appointments', { method: 'POST', headers: { 'idempotency-key': 'dup-key-000001' }, body });
    const b = await f.api('/appointments', { method: 'POST', headers: { 'idempotency-key': 'dup-key-000001' }, body });
    expect(a.status).toBe(201); expect(b.status).toBe(200); expect(b.json.appointment.booking_reference).toBe(a.json.appointment.booking_reference);
    const c = await f.api('/appointments', { method: 'POST', headers: { 'idempotency-key': 'dup-key-000002' }, body });
    expect(c.status).toBe(409);
    expect((await f.booking()).constructor).toBeTruthy();
    expect(f.doc.Appointments!.length).toBe(1);   // exactly one appointment row exists
  });

  it('cancel then cancel again is idempotent (already_cancelled), reschedule moves the SAME reference', async () => {
    const f = await buildFixture({ bookingOn: true });
    const ph = '+919876500004';
    const made = await f.api('/appointments', { method: 'POST', headers: { 'idempotency-key': 'mv-key-0000001' }, body: { slot_id: M09, patient: { name: 'Move Patient', phone: ph } } });
    const ref = made.json.appointment.booking_reference as string;
    const moved = await f.api(`/appointments/${ref}`, { method: 'PATCH', body: { patient_phone: ph, slot_id: M10 } });
    expect(moved.status).toBe(200); expect(moved.json.appointment.booking_reference).toBe(ref);
    const c1 = await f.api(`/appointments/${ref}/cancel`, { method: 'POST', body: { patient_phone: ph } });
    const c2 = await f.api(`/appointments/${ref}/cancel`, { method: 'POST', body: { patient_phone: ph } });
    expect(c1.status).toBe(200); expect(c1.json.already_cancelled).toBe(false);
    expect(c2.status).toBe(200); expect(c2.json.already_cancelled).toBe(true);
  });
});
