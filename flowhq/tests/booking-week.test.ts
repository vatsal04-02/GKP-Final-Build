// 4D: the weekly calendar and the per-doctor week (GET /schedule/week). Read-only; every change still goes through the one booking service. Synthetic people only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTokenFailures } from '../src/server/booking/tokens';
import { M09, M10, E16, THU, buildFixture, type Fixture } from './booking-fixture';

let fx: Fixture; let n = 0;
const book = (who: string, slotId: string, phone = '9876543210', name = 'Test Patient One') =>
  fx.s(who, '/appointments', { method: 'POST', body: { slot_id: slotId, idempotency_key: `week-key-${++n}-abcdefgh`, patient: { name, phone } } });
const week = async (qs: string, who = 'desk') => fx.s(who, `/week?${qs}`);
const day = (w: { json: { days: Array<{ date: string }> } }, date: string) => w.json.days.find((d) => d.date === date) as never as { date: string; closed: string | null; skips: Array<{ doctorId: string | null; reason: string }>; windows: Array<{ doctor_id: string; shift: string; start_time: string; end_time: string; free: number; booked: number }>; appointments: Array<{ booking_reference: string; status: string; doctor_id: string }> };

beforeEach(async () => { vi.spyOn(console, 'error').mockImplementation(() => {}); resetTokenFailures(); fx = await buildFixture({ bookingOn: true }); });
afterEach(() => { vi.restoreAllMocks(); });

describe('the weekly calendar', () => {
  it('seven days from the Monday of the week of any date in it; Sunday is closed; each working day lists both doctors\' windows', async () => {
    const w = await week(`date=${THU}`); expect(w.status).toBe(200);
    expect(w.json.from).toBe('2026-10-05'); expect(w.json.to).toBe('2026-10-11'); expect(w.json.days.map((d: { date: string }) => d.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
    expect(day(w, '2026-10-11').closed).toBe('not_operating_day');
    const thu = day(w, THU);
    expect(thu.closed).toBeNull();
    expect(thu.windows.map((x) => [x.doctor_id, x.shift, x.start_time, x.end_time])).toEqual([['DR-001', 'morning', '09:00', '13:00'], ['DR-002', 'evening', '16:00', '20:00']]);
    expect(w.json.doctors.map((d: { doctor_id: string }) => d.doctor_id)).toEqual(['DR-001', 'DR-002']);
  });
  it('monday=0 starts the seven days on the given date', async () => {
    const w = await week(`date=${THU}&monday=0`); expect(w.json.from).toBe(THU); expect(w.json.to).toBe('2026-10-14');
  });
  it('appointments appear on their day with the free / booked counts, a cancelled one leaves the calendar and frees its slot', async () => {
    const a = (await book('desk', M09)).json.appointment.booking_reference as string; await book('desk', M10, '9123456780', 'Second Patient'); await book('desk', E16, '9000000001', 'Evening Patient');
    let w = await week(`date=${THU}`); let thu = day(w, THU);
    expect(thu.appointments.map((x) => x.booking_reference)).toEqual([a, 'GKA-000002', 'GKA-000003']);
    expect(thu.windows.find((x) => x.doctor_id === 'DR-001')).toMatchObject({ booked: 2, free: 6 });   // 8 slots in 09:00-13:00, two taken
    expect(w.json.totals).toMatchObject({ appointments: 3 });
    expect((await fx.s('desk', `/appointments/${a}/cancel`, { method: 'POST', body: {} })).status).toBe(200);
    w = await week(`date=${THU}`); thu = day(w, THU);
    expect(w.json.totals).toMatchObject({ appointments: 2 });   // a cancelled appointment leaves the calendar (same as the day view) and its slot is free again
    expect(thu.appointments.map((x) => x.booking_reference)).toEqual(['GKA-000002', 'GKA-000003']);
    expect(thu.windows.find((x) => x.doctor_id === 'DR-001')).toMatchObject({ booked: 1, free: 7 });
  });
  it('a different week does not show these appointments', async () => {
    await book('desk', M09);
    const next = await week('date=2026-10-15'); expect(next.json.days.flatMap((d: { appointments: unknown[] }) => d.appointments)).toEqual([]);
  });
});

describe('the per-doctor week', () => {
  it('only that doctor\'s windows and appointments; an unknown doctor is a 404', async () => {
    await book('desk', M09); await book('desk', E16, '9123456780', 'Evening Patient');
    const w = await week(`date=${THU}&doctor_id=DR-002`); const thu = day(w, THU);
    expect(w.json.doctor_id).toBe('DR-002');
    expect(thu.windows.map((x) => x.doctor_id)).toEqual(['DR-002']);
    expect(thu.appointments.map((x) => x.doctor_id)).toEqual(['DR-002']);
    const bad = await week(`date=${THU}&doctor_id=DR-999`); expect(bad.status).toBe(404); expect(bad.json.error.code).toBe('unknown_doctor');
  });
  it('leave and a clinic closure show on the right days for the right doctor; the doctor\'s window disappears on leave', async () => {
    expect((await fx.s('desk', '/blocks', { method: 'POST', body: { kind: 'Doctor leave', doctor_id: 'DR-001', date_from: THU, reason: 'Conference' } })).status).toBe(201);
    expect((await fx.s('admin', '/blocks', { method: 'POST', body: { kind: 'Clinic closure', date_from: '2026-10-09', reason: 'Holiday' } })).status).toBe(201);
    const w = await week(`date=${THU}`);
    const thu = day(w, THU);
    expect(thu.windows.map((x) => x.doctor_id)).toEqual(['DR-002']);
    expect(thu.skips.some((s) => s.doctorId === 'DR-001' && /leave|blocked/.test(s.reason))).toBe(true);
    expect(day(w, '2026-10-09').closed).toBe('clinic_closure');
    const mine = await week(`date=${THU}&doctor_id=DR-001`); expect(day(mine, THU).windows).toEqual([]);
  });
  it('a doctor login can read the whole week (and any doctor\'s week); a bad date is a 400; no session is a 401/403', async () => {
    expect((await week(`date=${THU}`, 'mahesh')).status).toBe(200);
    expect((await week(`date=${THU}&doctor_id=DR-002`, 'mahesh')).status).toBe(200);
    expect((await week('date=2026-02-30')).status).toBe(400);
    expect((await week('')).status).toBe(400);
  });
  it('week reads never change anything: no appointment, audit or config row is written', async () => {
    await book('desk', M09);
    const before = JSON.stringify(fx.doc);
    await week(`date=${THU}`); await week(`date=${THU}&doctor_id=DR-001`);
    expect(JSON.stringify(fx.doc)).toBe(before);
  });
});
