// Provisioning the payment tables: additive only, refuses to run without the booking tables, never touches existing tables. Synthetic data only.
import { describe, expect, it } from 'vitest';
import type { ProvisionClient } from '../src/server/records/provision';
import { provisionPayments } from '../src/server/payments/provision';
import { PAYMENT_TABLES } from '../src/server/payments/schema';

function fake(existing: Record<string, string[]>) {
  const calls: string[] = [];
  const c: ProvisionClient = { tableIds: async () => Object.keys(existing), columnIds: async (_d, t) => existing[t] || [],
    createTable: async (_d, id, cols) => { calls.push(`create ${id}`); existing[id] = cols.map((x) => x.id); }, addColumns: async (_d, t, cols) => { calls.push(`addcols ${t}`); existing[t] = [...(existing[t] || []), ...cols.map((x) => x.id)]; } };
  return { c, calls, existing };
}
describe('provisioning the payment tables', () => {
  it('stops without touching anything when the booking tables are missing', async () => { const f = fake({ LEADS: ['Name'] }); expect(await provisionPayments(f.c, 'D', true)).toEqual({ changes: 0, ready: false }); expect(f.calls).toEqual([]); });
  it('a dry run changes nothing; apply creates exactly the three payment tables and nothing else', async () => {
    const f = fake({ Appointments: ['Booking_UID', 'Status'], Booking_Config: ['Key', 'Value'], LEADS: ['Name'] });
    expect((await provisionPayments(f.c, 'D', false)).changes).toBe(3); expect(f.calls).toEqual([]);
    await provisionPayments(f.c, 'D', true); expect(f.calls).toEqual(Object.keys(PAYMENT_TABLES).map((t) => `create ${t}`)); expect(f.existing.Appointments).toEqual(['Booking_UID', 'Status']); expect(f.existing.LEADS).toEqual(['Name']);
  });
  it('is idempotent', async () => { const f = fake({ Appointments: ['x'], Booking_Config: ['Key'] }); await provisionPayments(f.c, 'D', true); f.calls.length = 0; expect((await provisionPayments(f.c, 'D', true)).changes).toBe(0); expect(f.calls).toEqual([]); });
});
