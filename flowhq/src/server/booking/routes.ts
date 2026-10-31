// The n8n-facing booking API, mounted at /api/booking. Bearer service tokens ONLY: no cookie, no CSRF header, no browser session
// (the parent app lets /api/booking/* skip both, and this router refuses anything without a valid token). Contract: docs/booking-api.md.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { bad } from '../records/ids';
import { readBodyLimited } from '../net';
import { tokenAllowed, tokenFailed, type Scope, type ServiceToken, type TokenStore } from './tokens';
import type { BookingActor, BookingService } from './service';
import type { PaymentService } from '../payments/service';
import { registerTokenPaymentRoutes } from '../payments/routes';

export interface BookingRouteDeps { tokens: TokenStore; service: (workspace: string) => Promise<BookingService | null>; payments?: (workspace: string) => Promise<PaymentService | null>; now?: () => number; clientKey: (c: Context) => string }
type E = { Variables: { tok: ServiceToken; svc: BookingService } };
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const createBody = z.object({
  slot_id: z.string().min(1).max(80),
  patient: z.object({ name: z.string().min(1).max(120), phone: z.string().min(1).max(30) }),
  reason: z.string().max(300).optional(), service: z.string().max(120).optional(), idempotency_key: z.string().max(80).optional(),
}).strict();
const moveBody = z.object({ patient_phone: z.string().min(1).max(30), slot_id: z.string().min(1).max(80), reason: z.string().max(300).optional() }).strict();
const cancelBody = z.object({ patient_phone: z.string().min(1).max(30), reason: z.string().max(200).optional() }).strict();

export function bookingRoutes(d: BookingRouteDeps) {
  const r = new Hono<E>();
  const now = () => (d.now ? d.now() : Date.now());
  const err = (c: Context, status: number, code: string, message: string) => c.json({ error: { code, message } }, status as 400);

  // 1. authenticate (token only), 2. find the token's clinic
  r.use('*', async (c, next) => {
    const key = d.clientKey(c);   // behind the proxy: the address the proxy appended, not anything the caller typed
    if (!tokenAllowed(key, now())) return err(c, 429, 'rate_limited', 'Too many failed attempts. Try again later.');
    const tok = d.tokens.verify(c.req.header('authorization'), now());
    if (!tok) { tokenFailed(key, now()); c.header('WWW-Authenticate', 'Bearer'); return err(c, 401, 'unauthorized', 'A valid service token is required'); }   // never says which part was wrong
    const svc = await d.service(tok.workspace);
    if (!svc) return err(c, 503, 'booking_unavailable', 'Booking is not available for this clinic');
    c.set('tok', tok); c.set('svc', svc);
    await next();
  });
  const need = (c: Context<E>, scope: Scope) => { if (!c.get('tok').scopes.has(scope)) throw bad('forbidden', `This token may not use ${scope}`, 403); return c.get('svc'); };
  const actor = (c: Context<E>): BookingActor => { const t = c.get('tok'); return { kind: 'service', id: t.id, name: t.id, source: t.source }; };
  const json = async (c: Context<E>): Promise<unknown> => {
    const text = await readBodyLimited(c, 20000);
    if (text === null) throw bad('too_large', 'Request body is too large', 413);
    try { return JSON.parse(text); } catch { throw bad('invalid_json', 'The body must be JSON', 400); }
  };

  const payments = async (c: Context<E>) => { const p = d.payments ? await d.payments(c.get('tok').workspace) : null; if (!p) throw bad('payments_unavailable', 'Payments are not set up for this clinic', 503); return p; };
  r.get('/config', async (c) => { const base = await need(c, 'config:read').config(); const p = d.payments ? await d.payments(c.get('tok').workspace) : null; return c.json(p ? { ...base, ...(await p.config().catch(() => ({}))) } : base); });

  r.get('/availability', async (c) => {
    const svc = need(c, 'availability:read');
    const q = z.object({ date: DATE, doctor_id: z.string().max(40).optional(), shift: z.string().max(12).optional() }).strict().parse({ date: c.req.query('date'), doctor_id: c.req.query('doctor_id'), shift: c.req.query('shift') });
    return c.json(await svc.availability({ date: q.date, ...(q.doctor_id ? { doctorId: q.doctor_id } : {}), ...(q.shift ? { shift: q.shift } : {}) }));
  });

  r.post('/appointments', async (c) => {
    const svc = need(c, 'appointments:create');
    const b = createBody.parse(await json(c));
    const header = c.req.header('idempotency-key');
    if (header && b.idempotency_key && header !== b.idempotency_key) throw bad('invalid_idempotency_key', 'The Idempotency-Key header and idempotency_key differ', 400);
    const pay = d.payments ? await d.payments(c.get('tok').workspace) : null;
    if (pay && (await pay.gate()).open) {   // payments are open: a WhatsApp booking becomes a HELD appointment + a payment request (same booking engine, same slot rules)
      const res = await pay.createRequest({ slotId: b.slot_id, patientName: b.patient.name, patientPhone: b.patient.phone, reason: b.reason, idempotencyKey: header || b.idempotency_key || '', channel: 'whatsapp' }, actor(c));
      return c.json(res, res.replayed ? 200 : 201);
    }
    const res = await svc.create({ slotId: b.slot_id, patientName: b.patient.name, patientPhone: b.patient.phone, reason: b.reason, service: b.service, idempotencyKey: header || b.idempotency_key || '' }, actor(c));
    return c.json(res, res.replayed ? 200 : 201);
  });

  r.get('/appointments/:ref', async (c) => {
    const svc = need(c, 'appointments:read');
    const phone = z.string().min(1).max(30).safeParse(c.req.query('patient_phone'));
    if (!phone.success) throw bad('invalid', 'patient_phone is required', 400);
    return c.json({ appointment: await svc.get(c.req.param('ref'), phone.data, actor(c)) });
  });

  r.patch('/appointments/:ref', async (c) => {
    const svc = need(c, 'appointments:update');
    const b = moveBody.parse(await json(c));
    const res = await svc.reschedule(c.req.param('ref'), { slotId: b.slot_id, patientPhone: b.patient_phone, reason: b.reason }, actor(c));
    return c.json(res);
  });

  r.post('/appointments/:ref/cancel', async (c) => {
    const svc = need(c, 'appointments:cancel');
    const b = cancelBody.parse(await json(c));
    const res = await svc.cancel(c.req.param('ref'), { patientPhone: b.patient_phone, reason: b.reason }, actor(c));
    return c.json({ appointment: res.appointment, already_cancelled: res.alreadyCancelled });
  });

  r.notFound((c) => err(c, 404, 'not_found', 'No such booking endpoint'));
  const big = async (c: Context<E>): Promise<unknown> => { const text = await readBodyLimited(c, 8_000_000); if (text === null) throw bad('too_large', 'Request body is too large', 413); try { return JSON.parse(text); } catch { throw bad('invalid_json', 'The body must be JSON', 400); } };
  registerTokenPaymentRoutes(r, { need: (c, scope) => { if (!(c as Context<E>).get('tok').scopes.has(scope)) throw bad('forbidden', `This token may not use ${scope}`, 403); }, payments: (c) => payments(c as Context<E>), actor: (c) => actor(c as Context<E>), json: (c) => big(c as Context<E>), rawBody: async (c, max) => { const t = await readBodyLimited(c, max); if (t === null) throw bad('too_large', 'Request body is too large', 413); return t; } });
  return r;
}
