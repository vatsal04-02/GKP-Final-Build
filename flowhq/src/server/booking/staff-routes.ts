// The staff / admin booking API, mounted at /api/w/:ws/schedule. It sits BEHIND the app's normal protection: a signed-in CRM session (cookie), the CSRF
// header on every write, and access to the workspace. Who may do what is decided server-side from the signed-in user (never from the request) by the
// booking service itself (permissions.ts). Every write goes through the same BookingService as the AI's: there is no second writing path.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Ctx, WorkspaceBackend } from '../adapters/types';
import { bad } from '../records/ids';
import { readBodyLimited } from '../net';
import type { BookingActor } from './service';
import type { StaffBooking } from './staff-service';

type E = { Variables: { backend: WorkspaceBackend; ctx: Ctx } };
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');
const SHIFT = z.enum(['morning', 'evening']);
const createBody = z.object({
  slot_id: z.string().min(1).max(80), idempotency_key: z.string().min(8).max(64),
  patient: z.object({ name: z.string().min(1).max(120), phone: z.string().min(1).max(30), patient_id: z.string().max(40).optional() }).strict(),
  reason: z.string().max(300).optional(), service: z.string().max(120).optional(), stage: z.enum(['Pending confirmation', 'Confirmed']).optional(),
}).strict();
const moveBody = z.object({ slot_id: z.string().min(1).max(80), reason: z.string().max(300).optional() }).strict();
const cancelBody = z.object({ reason: z.string().max(200).optional() }).strict();
const statusBody = z.object({ status: z.string().max(30) }).strict();
const settingsBody = z.object({ values: z.record(z.string().max(60), z.string().max(200)) }).strict();
const doctorBody = z.object({ name: z.string().max(120).optional(), qualification: z.string().max(120).optional(), active: z.boolean().optional(), notes: z.string().max(500).optional(), default_shift: SHIFT.nullable().optional() }).strict();
const scheduleBody = z.object({
  doctor_id: z.string().min(1).max(40), weekday: z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']), shift: SHIFT, start_time: TIME, end_time: TIME,
  slot_minutes: z.number().int().nullable(), buffer_minutes: z.number().int().nullable(), capacity: z.number().int().nullable(),
  effective_from: DATE.nullable(), effective_to: DATE.nullable(), active: z.boolean(), is_override: z.boolean(), reason: z.string().max(200),
}).strict();
const consentBody = z.object({ phone: z.string().min(1).max(30), value: z.enum(['Yes', 'No', 'Unknown']), source: z.string().max(80), evidence_ref: z.string().max(120).optional(), evidence_date: DATE.nullable().optional(), form_version: z.string().max(60).optional(), note: z.string().max(300).optional(), patient_id: z.string().max(40).optional() }).strict();
const revokeBody = z.object({ phone: z.string().min(1).max(30), source: z.string().max(80).optional(), note: z.string().min(1).max(300) }).strict();
const blockBody = z.object({ kind: z.string().max(20), doctor_id: z.string().max(40).nullable().optional(), shift: SHIFT.nullable().optional(), date_from: DATE, date_to: DATE.nullable().optional(), start_time: TIME.nullable().optional(), end_time: TIME.nullable().optional(), reason: z.string().max(200).optional() }).strict();

export function scheduleRoutes() {
  const r = new Hono<E>();
  const svc = (c: Context<E>): StaffBooking => { const s = c.get('backend').booking?.(); if (!s) throw bad('booking_unavailable', 'Appointment booking is not set up for this workspace', 404); return s; };
  const who = (c: Context<E>): BookingActor => { const v = c.get('ctx').viewer; return { kind: 'staff', id: v.email, name: v.name, source: 'Staff', role: v.role, ...(v.clinician ? { clinician: v.clinician } : {}), ...(v.doctorId ? { doctorId: v.doctorId } : {}), ...(v.grants?.length ? { grants: v.grants } : {}) }; };
  const json = async (c: Context<E>): Promise<unknown> => {
    const text = await readBodyLimited(c, 40000);
    if (text === null) throw bad('too_large', 'Request body is too large', 413);
    try { return JSON.parse(text); } catch { throw bad('invalid_json', 'The body must be JSON', 400); }
  };
  const q = (c: Context<E>, k: string) => c.req.query(k) || undefined;
  const num = (c: Context<E>, k: string) => { const v = c.req.query(k); return v === undefined || v === '' ? undefined : Number(v); };

  // ---- reading (any signed-in user with access to the workspace)
  r.get('/schedule/overview', async (c) => c.json(await svc(c).overview(q(c, 'date'), who(c))));
  r.get('/schedule/day', async (c) => c.json(await svc(c).dayView(q(c, 'date') || '', { doctorId: q(c, 'doctor_id'), shift: q(c, 'shift') }, who(c))));
  r.get('/schedule/week', async (c) => c.json(await svc(c).weekView(q(c, 'date') || '', { doctorId: q(c, 'doctor_id'), monday: c.req.query('monday') !== '0' }, who(c))));
  r.get('/schedule/appointments', async (c) => c.json(await svc(c).listAppointments({ from: q(c, 'from'), to: q(c, 'to'), doctorId: q(c, 'doctor_id'), shift: q(c, 'shift'), status: q(c, 'status'), source: q(c, 'source'), q: q(c, 'q'), limit: num(c, 'limit'), offset: num(c, 'offset'), order: c.req.query('order') === 'desc' ? 'desc' : 'asc' }, who(c))));
  r.get('/schedule/appointments/:ref', async (c) => c.json(await svc(c).detail(c.req.param('ref'), who(c))));
  r.get('/schedule/doctors', async (c) => c.json(await svc(c).doctorsView(who(c))));
  r.get('/schedule/settings', async (c) => c.json(await svc(c).settingsView(who(c))));
  r.get('/schedule/consent', async (c) => c.json(await svc(c).consentState(q(c, 'phone') || '', who(c))));
  r.get('/schedule/consent/summary', async (c) => c.json(await svc(c).consentSummary(who(c))));
  r.get('/schedule/audit', async (c) => c.json(await svc(c).auditLog({ limit: num(c, 'limit'), q: q(c, 'q') }, who(c))));

  // ---- appointments (staff create / move / cancel / status all run through the one booking service)
  r.post('/schedule/appointments', async (c) => {
    const b = createBody.parse(await json(c));
    const res = await svc(c).create({ slotId: b.slot_id, patientName: b.patient.name, patientPhone: b.patient.phone, patientId: b.patient.patient_id, reason: b.reason, service: b.service, stage: b.stage, idempotencyKey: b.idempotency_key }, who(c));
    return c.json(res, res.replayed ? 200 : 201);
  });
  r.patch('/schedule/appointments/:ref', async (c) => { const b = moveBody.parse(await json(c)); return c.json(await svc(c).reschedule(c.req.param('ref'), { slotId: b.slot_id, reason: b.reason }, who(c))); });
  r.post('/schedule/appointments/:ref/cancel', async (c) => { const b = cancelBody.parse(await json(c)); const res = await svc(c).cancel(c.req.param('ref'), { reason: b.reason }, who(c)); return c.json({ appointment: res.appointment, already_cancelled: res.alreadyCancelled }); });
  r.post('/schedule/appointments/:ref/status', async (c) => { const b = statusBody.parse(await json(c)); return c.json({ appointment: await svc(c).setStatus(c.req.param('ref'), b.status, who(c)) }); });

  // ---- reminder consent: record (a Yes needs a grant, a No any staff member), correct / revoke (admin only). Nothing here is reachable with a service token.
  const consentInput = (b: z.infer<typeof consentBody>) => ({ phone: b.phone, value: b.value, source: b.source, evidenceRef: b.evidence_ref, evidenceDate: b.evidence_date ?? null, formVersion: b.form_version, note: b.note, patientId: b.patient_id });
  r.post('/schedule/consent', async (c) => c.json(await svc(c).recordConsent(consentInput(consentBody.parse(await json(c))), who(c)), 201));
  r.post('/schedule/consent/correct', async (c) => c.json(await svc(c).correctConsent(consentInput(consentBody.parse(await json(c))), who(c))));
  r.post('/schedule/consent/revoke', async (c) => { const b = revokeBody.parse(await json(c)); return c.json(await svc(c).revokeConsent({ phone: b.phone, source: b.source, note: b.note }, who(c))); });

  // ---- admin: the AI switch and the rest of the booking settings, doctors, schedules
  r.put('/schedule/settings', async (c) => { const b = settingsBody.parse(await json(c)); return c.json(await svc(c).updateSettings(b.values, who(c))); });
  r.patch('/schedule/doctors/:id', async (c) => { const b = doctorBody.parse(await json(c)); const d = await svc(c).updateDoctor(c.req.param('id'), { name: b.name, qualification: b.qualification, active: b.active, notes: b.notes, defaultShift: b.default_shift }, who(c)); return c.json({ doctor: d }); });
  const saveSchedule = async (c: Context<E>, id?: string) => {
    const b = scheduleBody.parse(await json(c));
    return c.json(await svc(c).saveSchedule({ id, doctorId: b.doctor_id, weekday: b.weekday, shift: b.shift, start: b.start_time, end: b.end_time, slotMinutes: b.slot_minutes, bufferMinutes: b.buffer_minutes, capacity: b.capacity, from: b.effective_from, to: b.effective_to, active: b.active, isOverride: b.is_override, reason: b.reason }, who(c)), id ? 200 : 201);
  };
  r.post('/schedule/schedules', (c) => saveSchedule(c));
  r.put('/schedule/schedules/:id', (c) => saveSchedule(c, c.req.param('id')));

  // ---- leave, closures, blocked time (staff may add and switch off; nothing is ever deleted and no appointment is touched)
  r.post('/schedule/blocks', async (c) => {
    const b = blockBody.parse(await json(c));
    return c.json(await svc(c).addBlock({ kind: b.kind, doctorId: b.doctor_id, shift: b.shift, dateFrom: b.date_from, dateTo: b.date_to, start: b.start_time, end: b.end_time, reason: b.reason }, who(c)), 201);
  });
  r.post('/schedule/blocks/:id/deactivate', async (c) => c.json(await svc(c).deactivateBlock(c.req.param('id'), who(c))));
  return r;
}
