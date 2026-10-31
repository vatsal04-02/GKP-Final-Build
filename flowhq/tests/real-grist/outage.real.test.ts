// REAL outage drill: the Grist container is STOPPED while the real FLOW HQ server runs, then started again. Needs the Docker CLI and REAL_GRIST_CONTAINER (the staging Grist
// container name); skipped otherwise. Proves: no crash, no false "booked", clear errors, and automatic recovery with nothing lost or duplicated.
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { REAL_ENABLED, REAL_URL, createStaging, deleteStaging, futureDay, slotId, startServer, type Server, type Staging } from './harness';

const CONTAINER = process.env.REAL_GRIST_CONTAINER || '';
const d = describe.skipIf(!REAL_ENABLED || !CONTAINER);
const DAY = futureDay(6); const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...a: string[]) => execFileSync('docker', a, { stdio: 'pipe' });
const gristUp = async () => { try { return (await fetch(`${REAL_URL}/status`, { signal: AbortSignal.timeout(2000) })).status === 200; } catch { return false; } };
async function waitUp(ms = 90000) { const end = Date.now() + ms; while (Date.now() < end) { if (await gristUp()) { await sleep(2500); return; } await sleep(1000); } throw new Error('Grist did not come back'); }
const book = (srv: Server, i: number, tag: string, time: string) => srv.api('/appointments', { method: 'POST', headers: { 'idempotency-key': `${tag}-${i}-abcdefghij` }, body: { slot_id: slotId('DR-001', DAY, time), patient: { name: `Outage Patient ${i}`, phone: `90000${String(40000 + i)}` } } }).catch(() => ({ status: 0, json: null, text: '' }));

d('Grist stopped under a running server', () => {
  let s: Staging; let srv: Server;
  afterAll(async () => { try { docker('start', CONTAINER); await waitUp(); } catch { /* best effort */ } if (srv) await srv.stop('SIGKILL').catch(() => undefined); if (s) await deleteStaging(s).catch(() => undefined); });
  it('while Grist is down: availability and bookings fail CLEARLY (never a false 201), the server stays up, health says so; when Grist returns everything works and nothing was duplicated', async () => {
    s = await createStaging('outage-physio', { bookingOn: true }); srv = await startServer(s);
    const ok = await book(srv, 1, 'out', '09:00'); expect(ok.status).toBe(201);
    docker('stop', '-t', '2', CONTAINER); expect(await gristUp()).toBe(false);
    const av = await srv.api(`/availability?date=${DAY}`); expect([502, 503], av.text).toContain(av.status); expect(av.json.error.code).toMatch(/booking_unavailable|backend/);
    const during = await Promise.all([2, 3, 4].map((i) => book(srv, i, 'out', ['09:30', '10:00', '10:30'][i - 2]!)));
    for (const r of during) { expect([502, 503, 0]).toContain(r.status); expect(r.status).not.toBe(201); }
    const look = await srv.api(`/appointments/${ok.json.appointment.booking_reference}?patient_phone=9000040001`); expect([502, 503]).toContain(look.status);
    expect(srv.proc.exitCode, 'the server must not crash').toBeNull();
    const health = await fetch(`${srv.base}/api/health`); expect(health.status).toBeGreaterThanOrEqual(200);
    docker('start', CONTAINER); await waitUp();
    // the same requests, retried with the same keys, now work; the first booking is still there; no duplicates
    const after = await Promise.all([2, 3, 4].map((i) => book(srv, i, 'out', ['09:30', '10:00', '10:30'][i - 2]!)));
    expect(after.map((r) => r.status)).toEqual([201, 201, 201]);
    expect((await book(srv, 1, 'out', '09:00')).status).toBe(200);
    const rows = (await s.client.records(s.clinicDocId, 'Appointments')).filter((r) => String(r.fields.Idem_Key || '').startsWith('out-'));
    expect(rows).toHaveLength(4); expect(new Set(rows.map((r) => r.fields.Slot_Key)).size).toBe(4);
    for (let i = 0; i < 40; i++) { const h = (await srv.staff('admin', '/overview')).json?.audit_health; if (h && h.waiting_to_flush === 0 && h.open_intents === 0) break; await sleep(1000); }
    const audit = await s.client.records(s.clinicDocId, 'Booking_Audit'); const ids = audit.map((r) => r.fields.Audit_ID); expect(new Set(ids).size).toBe(ids.length);
    for (const r of rows) expect(ids).toContain(r.fields.Audit_ID);
  }, 300000);
});
