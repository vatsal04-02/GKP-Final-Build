// Security review finding: the request-size cap trusted the Content-Length header, so a CHUNKED body (no header) or a lying header was read without any limit.
// The cap now counts the bytes actually received (net.ts readBodyLimited). Both routers: the token API (20 KB) and the staff API (40 KB).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBodyLimited } from '../src/server/net';
import { resetTokenFailures } from '../src/server/booking/tokens';
import { M09, buildFixture, type Fixture } from './booking-fixture';
import { Hono } from 'hono';

let fx: Fixture;
beforeEach(async () => { vi.spyOn(console, 'error').mockImplementation(() => {}); resetTokenFailures(); fx = await buildFixture({ bookingOn: true }); });
afterEach(() => { vi.restoreAllMocks(); });

/** A request whose body arrives in chunks with NO Content-Length header (what a chunked upload looks like to the server). */
const chunked = (path: string, headers: Record<string, string>, text: string, chunk = 4096) => {
  const bytes = new TextEncoder().encode(text); let at = 0;
  const body = new ReadableStream<Uint8Array>({ pull(ctl) { if (at >= bytes.length) { ctl.close(); return; } ctl.enqueue(bytes.slice(at, at + chunk)); at += chunk; } });
  return fx.app.request(path, { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
};
const padded = (n: number) => JSON.stringify({ slot_id: M09, patient: { name: 'Pad Patient', phone: '9876543210' }, reason: 'x'.repeat(n) });

describe('request size is enforced on the bytes received', () => {
  it('readBodyLimited: under the limit is read whole; over it (chunked, no header) is refused; a lying small Content-Length does not help', async () => {
    const app = new Hono();
    app.post('/t', async (c) => { const t = await readBodyLimited(c, 100); return c.json({ t }); });
    const post = (body: BodyInit, headers: Record<string, string> = {}) => Promise.resolve(app.request('/t', { method: 'POST', body, headers, duplex: 'half' } as RequestInit)).then((r: Response) => r.json() as Promise<{ t: string | null }>);
    expect((await post('x'.repeat(100))).t).toBe('x'.repeat(100));
    expect((await post('x'.repeat(101))).t).toBeNull();
    expect((await post('')).t).toBe('');
    const stream = () => new ReadableStream<Uint8Array>({ start(ctl) { for (let i = 0; i < 5; i++) ctl.enqueue(new TextEncoder().encode('y'.repeat(40))); ctl.close(); } });
    expect((await post(stream(), {})).t, 'chunked, 200 bytes, no Content-Length').toBeNull();
    expect((await post(stream(), { 'content-length': '5' })).t, 'a lying header').toBeNull();
  });

  it('token API: a chunked 200 KB body gets 413 (not parsed); a normal booking still works', async () => {
    const h = { authorization: `Bearer ${fx.token}`, 'content-type': 'application/json', 'idempotency-key': 'body-limit-key-0001' };
    const big = await chunked('/api/booking/appointments', h, padded(200000));
    expect(big.status).toBe(413); expect((await big.json()).error.code).toBe('too_large');
    expect((await fx.api('/appointments', { method: 'POST', headers: { 'idempotency-key': 'body-limit-key-0002' }, body: JSON.parse(padded(50)) })).status).toBe(201);
    expect(fx.doc.Appointments!.filter((r) => String(r.fields.Idem_Key).startsWith('body-limit-key-0001'))).toHaveLength(0);
  });

  it('token API: a chunked body just under the limit is accepted (the cap is not stricter than before)', async () => {
    const h = { authorization: `Bearer ${fx.token}`, 'content-type': 'application/json', 'idempotency-key': 'body-limit-key-0003' };
    const ok = await chunked('/api/booking/appointments', h, padded(200), 100);   // the whole body is ~330 bytes, sent in 100-byte chunks
    expect(ok.status).toBe(201);
  });

  it('staff API: a chunked 300 KB body gets 413 and changes nothing', async () => {
    const before = JSON.stringify(fx.doc);
    const big = await chunked('/api/w/demo-physio/schedule/appointments', { cookie: fx.cookies.desk!, 'x-flowhq-csrf': '1', 'content-type': 'application/json' }, padded(300000));
    expect(big.status).toBe(413); expect((await big.json()).error.code).toBe('too_large');
    expect(JSON.stringify(fx.doc)).toBe(before);
  });

  it('a body that is not JSON is still invalid_json (400), and an empty body too', async () => {
    const h = { authorization: `Bearer ${fx.token}`, 'content-type': 'application/json', 'idempotency-key': 'body-limit-key-0004' };
    const bad = await chunked('/api/booking/appointments', h, '{not json'); expect(bad.status).toBe(400); expect((await bad.json()).error.code).toBe('invalid_json');
    const empty = await fx.app.request('/api/booking/appointments', { method: 'POST', headers: h }); expect(empty.status).toBe(400);
  });
});
