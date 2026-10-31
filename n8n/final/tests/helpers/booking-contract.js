// The FLOW HQ booking API request contract (flowhq/src/server/booking/routes.ts + service.ts), written ONCE.
//   * n8n side: the fake booking API in 4c-w13-booking.test.js and 4d-contract.test.js reject any request that breaks it, so the workflow cannot drift from the real API unnoticed.
//   * FLOW HQ side: flowhq/tests/booking-contract.test.ts sends the same requests to the REAL routes and requires the same verdict, so this file cannot drift from the server.
// validate() returns null (the request is acceptable) or { status: 400, code, why } (the real server answers 400 for it).
'use strict';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IDEM = /^[A-Za-z0-9._:-]{8,64}$/;   // service.ts IDEM_RE
const SHIFTS = ['morning', 'evening'];
const bad = (code, why) => ({ status: 400, code, why });
const str = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const strictKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));

/** @param {{ method: string, url: string, headers?: Record<string,string>, body?: any }} r  url may be absolute or a path */
function validate(r) {
  const u = new URL(r.url, 'http://flowhq:8787');
  const m = u.pathname.match(/^\/api\/booking\/(config|availability|appointments)(?:\/([^/]+))?(\/cancel)?$/);
  if (!m) return bad('not_found', 'no such booking endpoint');
  const [, what, ref, cancel] = m;
  const h = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const method = r.method.toUpperCase();
  const body = r.body;

  if (what === 'config') return method === 'GET' && !ref ? null : bad('not_found', 'config is GET only');

  if (what === 'availability') {
    if (method !== 'GET' || ref) return bad('not_found', 'availability is GET only');
    // unknown query parameters are ignored by the server (only date, doctor_id and shift are read)
    if (!DATE.test(u.searchParams.get('date') || '')) return bad('invalid', 'date must be YYYY-MM-DD');
    const shift = u.searchParams.get('shift');
    if (shift !== null && shift !== '' && !SHIFTS.includes(shift)) return bad('invalid_shift', 'shift must be morning or evening');
    if ((u.searchParams.get('doctor_id') || '').length > 40) return bad('invalid', 'doctor_id too long');
    return null;
  }

  // appointments
  if (!ref) {
    if (method !== 'POST') return bad('not_found', 'POST /appointments only');
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('invalid', 'a JSON object is required');
    const extra = strictKeys(body, ['slot_id', 'patient', 'reason', 'service', 'idempotency_key']);
    if (extra.length) return bad('invalid', `unknown key ${extra.join(',')} (the body is strict: date, start and doctor_id are NOT accepted, the slot_id carries them)`);
    if (!str(body.slot_id, 1, 80)) return bad('invalid', 'slot_id is required');
    if (!body.patient || typeof body.patient !== 'object' || !str(body.patient.name, 1, 120) || !str(body.patient.phone, 1, 30)) return bad('invalid', 'patient { name, phone } is required');
    if (body.reason !== undefined && !str(body.reason, 0, 300)) return bad('invalid', 'reason too long');
    if (body.service !== undefined && !str(body.service, 0, 120)) return bad('invalid', 'service too long');
    const header = h['idempotency-key'];
    if (header && body.idempotency_key && header !== body.idempotency_key) return bad('invalid_idempotency_key', 'header and body key differ');
    if (!IDEM.test(String(header || body.idempotency_key || ''))) return bad('invalid_idempotency_key', 'an idempotency key of 8 to 64 characters is required');
    return null;
  }
  if (cancel) {
    if (method !== 'POST') return bad('not_found', 'cancel is POST');
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('invalid', 'a JSON object is required');
    if (strictKeys(body, ['patient_phone', 'reason']).length) return bad('invalid', `unknown key ${strictKeys(body, ['patient_phone', 'reason']).join(',')}`);
    if (!str(body.patient_phone, 1, 30)) return bad('invalid', 'patient_phone is required (the service may touch an appointment only for the patient who can prove their phone)');
    if (body.reason !== undefined && !str(body.reason, 0, 200)) return bad('invalid', 'reason too long');
    return null;
  }
  if (method === 'GET') return str(u.searchParams.get('patient_phone') || '', 1, 30) ? null : bad('invalid', 'patient_phone is required');
  if (method === 'PATCH') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('invalid', 'a JSON object is required');
    const extra = strictKeys(body, ['patient_phone', 'slot_id', 'reason']);
    if (extra.length) return bad('invalid', `unknown key ${extra.join(',')}`);
    if (!str(body.patient_phone, 1, 30) || !str(body.slot_id, 1, 80)) return bad('invalid', 'patient_phone and slot_id are required');
    if (body.reason !== undefined && !str(body.reason, 0, 300)) return bad('invalid', 'reason too long');
    return null;
  }
  return bad('not_found', 'method not allowed');
}

/** Canonical requests with the verdict they MUST get: used by flowhq/tests/booking-contract.test.ts against the real server. `slot` / `ref` / `phone` are filled in by the caller. */
function cases({ slot, ref, phone }) {
  const key = 'contract-test-key-01';
  const P = { name: 'Contract Test', phone };
  return [
    ['config', { method: 'GET', url: '/api/booking/config' }, true],
    ['availability with date', { method: 'GET', url: '/api/booking/availability?date=2026-10-08' }, true],
    ['availability with date + shift + doctor', { method: 'GET', url: '/api/booking/availability?date=2026-10-08&shift=morning&doctor_id=DR-001' }, true],
    ['availability without date', { method: 'GET', url: '/api/booking/availability' }, false],
    ['availability with a bad shift', { method: 'GET', url: '/api/booking/availability?date=2026-10-08&shift=night' }, false],
    ['create (slot_id, patient, Idempotency-Key header)', { method: 'POST', url: '/api/booking/appointments', headers: { 'Idempotency-Key': key }, body: { slot_id: slot, patient: P, reason: 'contract test' } }, true],
    ['create without an idempotency key', { method: 'POST', url: '/api/booking/appointments', body: { slot_id: slot, patient: P } }, false],
    ['create with a short idempotency key', { method: 'POST', url: '/api/booking/appointments', headers: { 'Idempotency-Key': 'abc' }, body: { slot_id: slot, patient: P } }, false],
    ['create with date / start / doctor_id (the V4 shape)', { method: 'POST', url: '/api/booking/appointments', headers: { 'Idempotency-Key': key }, body: { slot_id: slot, date: '2026-10-08', start: '09:00', doctor_id: 'DR-001', patient: P } }, false],
    ['create without a patient phone', { method: 'POST', url: '/api/booking/appointments', headers: { 'Idempotency-Key': key }, body: { slot_id: slot, patient: { name: 'No Phone' } } }, false],
    ['get with patient_phone', { method: 'GET', url: `/api/booking/appointments/${ref}?patient_phone=${encodeURIComponent(phone)}` }, true],
    ['get without patient_phone', { method: 'GET', url: `/api/booking/appointments/${ref}` }, false],
    ['reschedule (patient_phone, slot_id)', { method: 'PATCH', url: `/api/booking/appointments/${ref}`, body: { patient_phone: phone, slot_id: slot } }, true],
    ['reschedule without patient_phone', { method: 'PATCH', url: `/api/booking/appointments/${ref}`, body: { slot_id: slot } }, false],
    ['reschedule with date / start / doctor_id (the V4 shape)', { method: 'PATCH', url: `/api/booking/appointments/${ref}`, body: { slot_id: slot, date: '2026-10-08', start: '09:00', doctor_id: 'DR-001' } }, false],
    ['cancel (patient_phone)', { method: 'POST', url: `/api/booking/appointments/${ref}/cancel`, body: { patient_phone: phone, reason: 'contract test' } }, true],
    ['cancel without patient_phone (the V4 shape)', { method: 'POST', url: `/api/booking/appointments/${ref}/cancel`, body: { reason: 'patient request' } }, false],
  ];
}

module.exports = { validate, cases };
