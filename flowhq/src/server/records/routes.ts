// Clinic records API (mounted under /api/w/:ws). Auth, CSRF and workspace access are applied by the parent app before these run.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { PAYMENT_METHODS, PATIENT_STATUSES, SEXES, STAFF_STATUSES, VISIT_STATUSES, type InvoiceInput } from '../../core/clinical';
import type { Ctx, WorkspaceBackend } from '../adapters/types';
import { bad } from './ids';
import type { Actor, RecordsService, Scope, StaffPerson } from './service';

// A FLOW HQ login that can open this workspace (the app supplies them; this module never sees password hashes).
export interface TeamLogin { email: string; name: string; clinician?: string }
export interface RecordsRouteOptions { logins?: (workspaceId: string) => TeamLogin[] }

type E = { Variables: { backend: WorkspaceBackend; ctx: Ctx } };
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nullDate = date.nullable().or(z.literal(''));
const patientFields = z.object({
  name: z.string().max(120), phone: z.string().max(30), address: z.string().max(400), age: z.string().max(20), sex: z.enum([...SEXES, '']), referredBy: z.string().max(120), occupation: z.string().max(120),
  mainComplaint: z.string().max(500), notes: z.string().max(2000), status: z.enum(PATIENT_STATUSES), registeredOn: nullDate, followUpOn: nullDate, sourceLeadId: z.string().max(40),
}).partial();
const text = (n: number) => z.string().max(n);
const rxBody = z.object({ rxId: z.string().max(20).optional(), baseVersion: z.number().int().optional(), patientId: z.string().min(1).max(40), rxDate: nullDate, treatingPhysio: text(120), bp: text(40), vitals: text(300),
  history: text(4000), examination: text(4000), diagnosis: text(2000), treatmentPlan: text(4000), exercises: text(4000), advice: text(4000), followUpOn: nullDate });
const paise = z.number().int().min(0).max(99_99_99_999_99);
const paymentBody = z.object({ amountPaise: paise, method: z.enum(PAYMENT_METHODS), reference: text(120), paidOn: date });
const invoiceBody = z.object({ patientId: z.string().min(1).max(40), date, lines: z.array(z.object({ description: text(200), qty: z.number().int(), unitPaise: paise })).max(30), discountPaise: paise, applyTax: z.boolean(), notes: text(1000),
  idemKey: z.string().min(8).max(64), payment: paymentBody.optional(), doctor: text(120).optional() });

export function recordsRoutes(opts: RecordsRouteOptions = {}) {
  const r = new Hono<E>();
  const svc = (c: Context<E>): RecordsService => { const s = c.get('backend').records?.(); if (!s) throw bad('records_unavailable', 'Clinic records are not set up for this workspace yet', 404); return s; };
  // A doctor's login is bound to ONE name from config/clinic.json: it only ever sees that doctor's prescriptions and dues (the patient register is shared).
  // Anyone else may ask for one doctor with ?doctor=<name>; an unknown name is refused, never ignored.
  const doctorOf = (c: Context<E>): string | null => { const v = c.get('ctx').viewer; if (!v.clinician) return null; const d = svc(c).clinic().clinicians.find((x) => x.name.trim().toLowerCase() === v.clinician!.trim().toLowerCase()); if (!d) throw bad('doctor_not_set_up', 'Your doctor profile is not set up in the clinic details. Ask the admin.', 403); return d.name; };
  const who = (c: Context<E>): Actor => { const v = c.get('ctx').viewer; const d = doctorOf(c); return { email: v.email, name: v.name, role: v.role, ...(d ? { clinician: d } : {}) }; };
  const scope = (c: Context<E>): Scope => {
    const d = doctorOf(c); if (d) return { only: d };
    const asked = (c.req.query('doctor') || '').trim(); if (!asked) return {};
    const hit = svc(c).clinic().clinicians.find((x) => x.name.trim().toLowerCase() === asked.toLowerCase());
    if (!hit) throw bad('unknown_doctor', 'Unknown doctor', 400);
    return { only: hit.name };
  };
  const doctorScope = (c: Context<E>): Scope => { const d = doctorOf(c); return d ? { only: d } : {}; };   // writes and photos: only a doctor login is limited (an admin's ?doctor= filter is for reading)
  const found = <T,>(x: T | null) => { if (x === null) throw bad('not_found', 'Not found', 404); return x; };
  const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === '' && /On$/.test(k) ? null : v])) as T;

  r.get('/clinic', (c) => c.json(svc(c).clinic()));
  r.get('/clinic-summary', async (c) => { const sc = scope(c); return c.json(await svc(c).doctorSummary(Number(c.req.query('days') || 7), sc, !sc.only && c.get('ctx').viewer.role === 'admin')); });

  r.get('/patients', async (c) => c.json(await svc(c).listPatients({ q: c.req.query('q'), status: c.req.query('status') || undefined, followUp: c.req.query('followUp') === '1', owing: c.req.query('owing') === '1', from: c.req.query('from') || undefined, to: c.req.query('to') || undefined,
    sort: c.req.query('sort'), dir: c.req.query('dir') === 'desc' ? 'desc' : 'asc', page: Number(c.req.query('page') || 1), pageSize: Number(c.req.query('pageSize') || 50), week: c.req.query('week') }, scope(c))));
  r.get('/patients/check', async (c) => c.json({ matches: await svc(c).findDuplicates(c.req.query('name') || '', c.req.query('phone') || '', c.req.query('except') || undefined) }));
  r.post('/patients', async (c) => {
    const b = patientFields.extend({ name: z.string().min(1).max(120), confirmDuplicate: z.boolean().optional() }).parse(await c.req.json());
    const { confirmDuplicate, ...f } = b;
    return c.json(await svc(c).createPatient(clean(f) as never, who(c), confirmDuplicate), 201);
  });
  r.get('/patients/:id', async (c) => c.json(found(await svc(c).profile(c.req.param('id'), scope(c)))));
  r.patch('/patients/:id', async (c) => {
    const { confirmDuplicate, ...f } = patientFields.extend({ confirmDuplicate: z.boolean().optional() }).parse(await c.req.json());
    return c.json(await svc(c).updatePatient(c.req.param('id'), clean(f) as never, who(c), confirmDuplicate));
  });

  r.get('/prescriptions', async (c) => c.json(await svc(c).listPrescriptions({ patientId: c.req.query('patient') || undefined, q: c.req.query('q') }, scope(c))));
  r.post('/prescriptions', async (c) => c.json(await svc(c).savePrescription(clean(rxBody.parse(await c.req.json())) as never, who(c), doctorScope(c)), 201));
  r.get('/prescriptions/suggestions', async (c) => c.json(await svc(c).prescriptionSuggestions(scope(c))));   // before :id; no patient data in it
  r.get('/prescriptions/:id', async (c) => c.json(found(await svc(c).getPrescription(c.req.param('id'), scope(c)))));
  r.put('/prescriptions/:id', async (c) => c.json(await svc(c).savePrescription(clean({ ...rxBody.parse(await c.req.json()), rxId: c.req.param('id') }) as never, who(c), doctorScope(c))));
  r.post('/prescriptions/:id/images', async (c) => {
    const len = Number(c.req.header('content-length') || 0);
    if (len > 6 * 1024 * 1024) throw bad('file_too_large', 'The photo is larger than 5 MB', 413);
    let form: FormData;
    try { form = await c.req.formData(); } catch { throw bad('invalid', 'Send the photo as a form upload'); }
    const f = form.get('file');
    if (!(f instanceof File)) throw bad('invalid', 'No photo was sent');
    const caption = typeof form.get('caption') === 'string' ? (form.get('caption') as string) : '';
    return c.json(await svc(c).addImage(c.req.param('id'), { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name, caption }, who(c), doctorScope(c)), 201);
  });
  r.delete('/prescriptions/:id/images/:imageId', async (c) => { await svc(c).removeImage(c.req.param('id'), c.req.param('imageId'), who(c), doctorScope(c)); return c.json({ ok: true }); });
  r.get('/prescriptions/:id/images/:imageId', async (c) => {      // patient photos are only ever served here, to a signed-in user with access to this workspace
    const img = found(await svc(c).readImage(c.req.param('id'), c.req.param('imageId'), doctorScope(c)));
    return c.body(img.bytes as unknown as ArrayBuffer, 200, { 'Content-Type': img.mime, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline; filename="photo"' });
  });

  r.get('/invoices', async (c) => c.json(await svc(c).listInvoices({ patientId: c.req.query('patient') || undefined, status: c.req.query('status') || undefined, q: c.req.query('q') }, scope(c))));
  r.post('/invoices', async (c) => {
    const body = invoiceBody.parse(await c.req.json()) as InvoiceInput;
    // a doctor's login always raises invoices under their own name; anyone else (admin, front desk) says which doctor the bill belongs to
    if (doctorOf(c) || !body.doctor?.trim()) delete body.doctor;
    else { const hit = svc(c).clinic().clinicians.find((x) => x.name.trim().toLowerCase() === body.doctor!.trim().toLowerCase()); if (!hit) throw bad('unknown_doctor', 'Unknown doctor', 400); body.doctor = hit.name; }
    const out = await svc(c).createInvoice(body, who(c), doctorScope(c));
    return c.json(out, out.duplicate ? 200 : 201);
  });
  r.get('/invoices/:no', async (c) => c.json(found(await svc(c).getInvoice(c.req.param('no'), scope(c)))));
  r.post('/invoices/:no/payments', async (c) => c.json(await svc(c).addPayment(c.req.param('no'), paymentBody.extend({ idemKey: z.string().min(8).max(64) }).parse(await c.req.json()), who(c), doctorScope(c)), 201));
  r.post('/invoices/:no/void', async (c) => c.json(await svc(c).voidInvoice(c.req.param('no'), z.object({ reason: z.string().max(300) }).parse(await c.req.json()).reason, who(c))));
  r.post('/payments/:id/void', async (c) => c.json(await svc(c).voidPayment(c.req.param('id'), z.object({ reason: z.string().max(300) }).parse(await c.req.json()).reason, who(c))));

  r.get('/visits', async (c) => c.json(await svc(c).visitsWeek(c.req.query('week') || '')));
  r.put('/visits', async (c) => {
    const b = z.object({ patientId: z.string().min(1).max(40), date, status: z.enum(VISIT_STATUSES).nullable(), notes: text(500).optional() }).parse(await c.req.json());
    return c.json({ visit: await svc(c).setVisit(b, who(c)) });
  });

  // ---- staff attendance: the clinic's own people. Team list = every login that can open this workspace + doctors in config/clinic.json who have no login.
  // Admin and front desk may mark anyone; a doctor's own login sees and marks only itself. The page exists only once the Staff_Attendance table does.
  const staffSvc = (c: Context<E>): RecordsService => { const s = svc(c); if (!c.get('backend').supported.modules.includes('staff_attendance')) throw bad('staff_attendance_unavailable', 'Staff attendance is not set up for this workspace yet', 404); return s; };
  const meKey = (c: Context<E>) => c.get('ctx').viewer.email.trim().toLowerCase();
  const onlyMe = (c: Context<E>) => (c.get('ctx').viewer.clinician ? meKey(c) : undefined);
  // logins + doctors in config/clinic.json without a login (always listed) ...
  const baseTeam = (c: Context<E>): StaffPerson[] => {
    const logins = opts.logins?.(c.get('backend').info.id) || [];
    const out: StaffPerson[] = logins.map((l) => ({ key: l.email.trim().toLowerCase(), name: l.name }));
    const seen = new Set(logins.flatMap((l) => [l.name, l.clinician || ''].map((x) => x.trim().toLowerCase()).filter(Boolean)));
    for (const d of svc(c).clinic().clinicians) { const nm = d.name.trim(); if (nm && !seen.has(nm.toLowerCase())) out.push({ key: `doctor:${nm.toLowerCase()}`, name: nm }); }
    return out;
  };
  // ... plus the people added by name on the page
  const team = async (c: Context<E>): Promise<StaffPerson[]> => [...baseTeam(c), ...(await svc(c).activeStaffMembers())];
  const mayMark = (c: Context<E>, key: string) => { const only = onlyMe(c); if (only && key !== only) throw bad('forbidden', 'You can only record your own attendance', 403); };
  const mayManage = (c: Context<E>) => { if (onlyMe(c)) throw bad('forbidden', 'Only the front desk or an admin can change the staff list', 403); };
  r.get('/staff-attendance', async (c) => c.json(await staffSvc(c).staffWeek(c.req.query('week') || '', await team(c), meKey(c), onlyMe(c), c.get('ctx').viewer.role === 'admin')));
  r.get('/staff-attendance/month', async (c) => c.json(await staffSvc(c).staffMonth(c.req.query('month') || '', await team(c), onlyMe(c))));
  r.put('/staff-attendance', async (c) => {
    const b = z.object({ staffKey: z.string().min(1).max(200), date, status: z.enum(STAFF_STATUSES).nullable(), notes: text(500).optional(), editPassword: z.string().max(200).optional() }).parse(await c.req.json());
    const sv = staffSvc(c); mayMark(c, b.staffKey);
    return c.json({ mark: await sv.setStaffMark(b, await team(c), who(c)) });   // a day that already has a mark is refused here without the right editPassword
  });
  // the attendance edit password: only an admin sets or changes it (the server stores only a hash)
  r.put('/staff-attendance/edit-password', async (c) => {
    const b = z.object({ password: z.string().max(200), currentPassword: z.string().max(200).optional() }).parse(await c.req.json());
    const sv = staffSvc(c); if (c.get('ctx').viewer.role !== 'admin' || onlyMe(c)) throw bad('forbidden', 'Only an admin can set the attendance edit password', 403);
    await sv.setEditPassword(b.password, who(c), b.currentPassword);   // changing an existing password needs the current one
    return c.json({ ok: true });
  });
  r.post('/staff-attendance/members', async (c) => {
    const b = z.object({ name: z.string().max(200) }).parse(await c.req.json());
    const sv = staffSvc(c); mayManage(c);
    const out = await sv.addStaffMember(b.name, baseTeam(c).map((p) => p.name), who(c));
    return c.json(out, out.reactivated ? 200 : 201);
  });
  r.delete('/staff-attendance/members/:key', async (c) => {
    const sv = staffSvc(c); mayManage(c);
    await sv.removeStaffMember(c.req.param('key'), who(c));
    return c.json({ ok: true });
  });
  return r;
}
