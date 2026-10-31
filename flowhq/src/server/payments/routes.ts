// HTTP for payments. Two surfaces, both behind the app's existing protection:
//   token (n8n only, mounted inside /api/booking, which is NOT published on the public domain): payment requests, screenshot intake, extraction, status, outbox, the QR.
//   staff (signed-in session + CSRF header, /api/w/:ws/schedule/payments...): the review queue, the screenshot viewer, approve / reject / refund, settings.
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { bad } from '../records/ids';
import { readBodyLimited } from '../net';
import type { BookingActor } from '../booking/service';
import type { PaymentService } from './service';

const PHONE = z.string().min(1).max(30);
const requestBody = z.object({ slot_id: z.string().min(1).max(80), patient: z.object({ name: z.string().min(1).max(120), phone: PHONE }).strict(), reason: z.string().max(300).optional(), idempotency_key: z.string().min(8).max(64), channel: z.enum(['website', 'whatsapp']) }).strict();
const shotBody = z.object({ patient_phone: PHONE, data_base64: z.string().min(8).max(7_500_000), utr: z.string().max(40).optional(), source: z.enum(['website', 'whatsapp']), media_id: z.string().max(80).optional() }).strict();
const extractBody = z.object({ patient_phone: PHONE, extraction: z.object({ amount: z.unknown().optional(), utr: z.unknown().optional(), txn_time: z.unknown().optional(), payee: z.unknown().optional(), payer: z.unknown().optional(), status: z.unknown().optional(), reference: z.unknown().optional(), confidence: z.unknown().optional(), looks_edited: z.unknown().optional(), is_payment_screenshot: z.unknown().optional() }).passthrough().nullable(), ocr_error: z.string().max(80).optional() }).strict();
const notifiedBody = z.object({ kind: z.string().max(20), ok: z.boolean() }).strict();

export interface TokenHelpers { need: (c: Context<any>, scope: 'payments:read' | 'payments:write') => void; payments: (c: Context<any>) => Promise<PaymentService>; actor: (c: Context<any>) => BookingActor; json: (c: Context<any>) => Promise<unknown>; rawBody: (c: Context<any>, max: number) => Promise<string> }

export function registerTokenPaymentRoutes(r: Hono<any>, h: TokenHelpers) {
  r.get('/payments/config', async (c) => { h.need(c, 'payments:read'); return c.json(await (await h.payments(c)).config()); });
  r.get('/payments/qr', async (c) => {
    h.need(c, 'payments:read'); const img = await (await h.payments(c)).qr();
    if (!img) throw bad('payments_disabled', 'The payment QR is not available yet', 403);
    return c.body(img as unknown as ArrayBuffer, 200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
  });
  r.get('/payments/outbox', async (c) => { h.need(c, 'payments:read'); return c.json({ items: await (await h.payments(c)).outbox() }); });
  r.get('/payments/open', async (c) => { h.need(c, 'payments:read'); const p = PHONE.safeParse(c.req.query('patient_phone')); if (!p.success) throw bad('invalid', 'patient_phone is required', 400); return c.json({ payments: await (await h.payments(c)).openFor(p.data) }); });
  r.post('/payments/requests', async (c) => {
    h.need(c, 'payments:write'); const b = requestBody.parse(await h.json(c));
    const res = await (await h.payments(c)).createRequest({ slotId: b.slot_id, patientName: b.patient.name, patientPhone: b.patient.phone, ...(b.reason ? { reason: b.reason } : {}), idempotencyKey: b.idempotency_key, channel: b.channel }, h.actor(c));
    return c.json(res, res.replayed ? 200 : 201);
  });
  r.post('/payments/provider-event', async (c) => {
    h.need(c, 'payments:write'); const raw = await h.rawBody(c, 20000);
    return c.json(await (await h.payments(c)).providerEvent(raw, c.req.header('x-payment-signature')));
  });
  r.get('/payments/:ref', async (c) => { h.need(c, 'payments:read'); const p = PHONE.safeParse(c.req.query('patient_phone')); if (!p.success) throw bad('invalid', 'patient_phone is required', 400); return c.json({ payment: await (await h.payments(c)).get(c.req.param('ref'), p.data) }); });
  r.post('/payments/:ref/screenshot', async (c) => {
    h.need(c, 'payments:write'); const b = shotBody.parse(await h.json(c));
    const data = Buffer.from(b.data_base64, 'base64'); if (!data.length) throw bad('invalid_image', 'The image is empty', 400);
    const res = await (await h.payments(c)).receiveScreenshot(c.req.param('ref'), b.patient_phone, { data, ...(b.utr ? { utr: b.utr } : {}), source: b.source, ...(b.media_id ? { mediaId: b.media_id } : {}) }, h.actor(c));
    return c.json(res, res.replayed ? 200 : 201);
  });
  r.post('/payments/:ref/extraction', async (c) => { h.need(c, 'payments:write'); const b = extractBody.parse(await h.json(c)); return c.json(await (await h.payments(c)).applyExtraction(c.req.param('ref'), b.patient_phone, { extraction: b.extraction, ...(b.ocr_error ? { ocrError: b.ocr_error } : {}) }, h.actor(c))); });
  r.post('/payments/:ref/notified', async (c) => { h.need(c, 'payments:write'); const b = notifiedBody.parse(await h.json(c)); return c.json(await (await h.payments(c)).markNotified(c.req.param('ref'), b.kind, b.ok)); });
}

const approveBody = z.object({ received_inr: z.string().min(1).max(12), utr: z.string().min(1).max(40), confirm_receipt: z.boolean(), note: z.string().max(300).optional() }).strict();
const rejectBody = z.object({ reason: z.string().min(1).max(300) }).strict();
const refundBody = z.object({ reason: z.string().min(1).max(300), cancel_appointment: z.boolean().optional() }).strict();
const settingsBody = z.object({ values: z.record(z.string().max(60), z.string().max(300)) }).strict();

export interface StaffHelpers { payments: (c: Context<any>) => PaymentService; who: (c: Context<any>) => BookingActor }
export function registerStaffPaymentRoutes(r: Hono<any>, h: StaffHelpers) {
  const json = async (c: Context<any>): Promise<unknown> => { const t = await readBodyLimited(c, 20000); if (t === null) throw bad('too_large', 'Request body is too large', 413); try { return JSON.parse(t); } catch { throw bad('invalid_json', 'The body must be JSON', 400); } };
  r.get('/schedule/payments/settings', async (c) => c.json(await h.payments(c).settingsView(h.who(c))));
  r.put('/schedule/payments/settings', async (c) => c.json(await h.payments(c).updateSettings(settingsBody.parse(await json(c)).values, h.who(c))));
  r.get('/schedule/payments', async (c) => c.json(await h.payments(c).list({ status: c.req.query('status') || undefined, q: c.req.query('q') || undefined, limit: Number(c.req.query('limit')) || undefined }, h.who(c))));
  r.get('/schedule/payments/:id', async (c) => c.json(await h.payments(c).detail(c.req.param('id'), h.who(c))));
  r.get('/schedule/payments/:id/screenshot', async (c) => { const s = await h.payments(c).screenshot(c.req.param('id'), h.who(c)); return c.body(s.data as unknown as ArrayBuffer, 200, { 'content-type': s.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline' }); });
  r.post('/schedule/payments/:id/approve', async (c) => { const b = approveBody.parse(await json(c)); return c.json(await h.payments(c).approve(c.req.param('id'), { receivedInr: b.received_inr, utr: b.utr, confirmReceipt: b.confirm_receipt, ...(b.note ? { note: b.note } : {}) }, h.who(c))); });
  r.post('/schedule/payments/:id/reject', async (c) => c.json(await h.payments(c).reject(c.req.param('id'), { reason: rejectBody.parse(await json(c)).reason }, h.who(c))));
  r.post('/schedule/payments/:id/refund', async (c) => { const b = refundBody.parse(await json(c)); return c.json(await h.payments(c).refund(c.req.param('id'), { reason: b.reason, ...(b.cancel_appointment === false ? { cancelAppointment: false } : {}) }, h.who(c))); });
}
