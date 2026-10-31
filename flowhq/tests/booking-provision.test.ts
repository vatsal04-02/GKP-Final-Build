// Provisioning the booking tables: additive only, never creates Appointments, never overwrites, seeds only empty tables. Synthetic data only.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GristClient, memoryGrist, type GristRecord } from '../src/server/grist';
import type { ProvisionClient } from '../src/server/records/provision';
import { provisionBooking } from '../src/server/booking/provision';
import { SEED_CONFIG, SEED_DOCTORS, SEED_SCHEDULES, seedBooking } from '../src/server/booking/seed';
import { APPOINTMENT_EXTRA, BOOKING_TABLES, BT, bookingColNames } from '../src/server/booking/schema';

const LEGACY = ['Booking_UID', 'Lead', 'Service', 'Physio', 'Start', 'End', 'Status', 'Fee_INR', 'R24_Sent', 'R2_Sent', 'Rebook_Sent', 'Review_Sent', 'Outcome_Sent'];
function fake(existing: Record<string, string[]>) {
  const calls: string[] = [];
  const c: ProvisionClient = {
    tableIds: async () => Object.keys(existing),
    columnIds: async (_d, t) => existing[t] || [],
    createTable: async (_d, id, cols) => { calls.push(`create ${id}`); existing[id] = cols.map((x) => x.id); },
    addColumns: async (_d, t, cols) => { calls.push(`addcols ${t} ${cols.map((x) => x.id).join(',')}`); existing[t] = [...(existing[t] || []), ...cols.map((x) => x.id)]; },
  };
  return { c, calls, existing };
}
const NEW_TABLES = Object.keys(BOOKING_TABLES);

describe('provisioning the booking tables', () => {
  it('a dry run changes nothing and reports five new tables plus the Appointments columns', async () => {
    const f = fake({ LEADS: ['Name'], Appointments: LEGACY }); const lines: string[] = [];
    const r = await provisionBooking(f.c, 'DOC', false, (l) => lines.push(l));
    expect(f.calls).toEqual([]); expect(r).toEqual({ changes: NEW_TABLES.length + 1, appointmentsFound: true }); expect(lines.filter((l) => l.startsWith('would create'))).toHaveLength(NEW_TABLES.length); expect(lines.some((l) => l.startsWith('would add to Appointments'))).toBe(true);
  });
  it('apply creates only the five new tables and ADDS columns to Appointments; every legacy column and table is untouched', async () => {
    const f = fake({ LEADS: ['Name'], Appointments: [...LEGACY] });
    await provisionBooking(f.c, 'DOC', true);
    expect(f.calls.filter((c) => c.startsWith('create '))).toEqual(NEW_TABLES.map((t) => `create ${t}`)); expect(f.calls.filter((c) => c.startsWith('addcols '))).toHaveLength(1);
    expect(f.existing.Appointments).toEqual([...LEGACY, ...APPOINTMENT_EXTRA.map(([n]) => n)]); expect(f.existing.LEADS).toEqual(['Name']); expect(Object.keys(f.existing).sort()).toEqual(['Appointments', 'LEADS', ...NEW_TABLES].sort());
  });
  it('is idempotent: a second run finds nothing to do', async () => {
    const f = fake({ Appointments: [...LEGACY] }); await provisionBooking(f.c, 'DOC', true); f.calls.length = 0;
    expect((await provisionBooking(f.c, 'DOC', true)).changes).toBe(0); expect(f.calls).toEqual([]);
  });
  it('adds only the missing columns to a partly provisioned Appointments table', async () => {
    const f = fake({ Appointments: [...LEGACY, ...APPOINTMENT_EXTRA.map(([n]) => n).filter((n) => n !== 'Idem_Key' && n !== 'Reason')], ...Object.fromEntries(NEW_TABLES.map((t) => [t, bookingColNames(t)])) });
    await provisionBooking(f.c, 'DOC', true); expect(f.calls).toEqual(['addcols Appointments Reason,Idem_Key']);
  });
  it('STOPS if Appointments does not exist: it never creates a second appointments system', async () => {
    const f = fake({ LEADS: ['Name'] }); const lines: string[] = [];
    const r = await provisionBooking(f.c, 'DOC', true, (l) => lines.push(l));
    expect(r).toEqual({ changes: 0, appointmentsFound: false }); expect(f.calls).toEqual([]); expect(lines[0]).toMatch(/^STOP/);
  });
  it('uses the right Grist types, and no new column collides with a legacy Appointments column', async () => {
    const seen: Record<string, { type: string; widgetOptions?: string }> = {}; const f = fake({ Appointments: [...LEGACY] });
    f.c.createTable = async (_d, id, cols) => { for (const x of cols) seen[`${id}.${x.id}`] = x.fields as never; }; f.c.addColumns = async (_d, t, cols) => { for (const x of cols) seen[`${t}.${x.id}`] = x.fields as never; };
    await provisionBooking(f.c, 'DOC', true);
    expect(seen['Doctor_Schedules.Effective_From']!.type).toBe('Date'); expect(seen['Doctor_Schedules.Start_Time']!.type).toBe('Text'); expect(seen['Doctor_Schedules.Is_Override']!.type).toBe('Bool'); expect(seen['Booking_Audit.At']!.type).toBe('DateTime:Asia/Kolkata');
    expect(JSON.parse(seen['Appointments.Appt_Stage']!.widgetOptions!).choices).toEqual(['Pending confirmation', 'Confirmed', 'Checked in']); expect(JSON.parse(seen['Appointments.Booking_Source']!.widgetOptions!).choices).toEqual(['WhatsApp AI', 'Staff', 'Cal.com', 'Other']);
    expect(APPOINTMENT_EXTRA.map(([n]) => n).filter((n) => LEGACY.includes(n))).toEqual([]);
  });
});

describe('seeding the starting values', () => {
  const mem = (rows: Partial<Record<string, GristRecord[]>> = {}) => {
    const docs = { D: { Doctors: rows.Doctors || [], Doctor_Schedules: rows.Doctor_Schedules || [], Booking_Config: rows.Booking_Config || [] } as Record<string, GristRecord[]> };
    const m = memoryGrist(docs, { columns: { Doctors: bookingColNames('Doctors'), Doctor_Schedules: bookingColNames('Doctor_Schedules'), Booking_Config: bookingColNames('Booking_Config') } });
    return { docs, grist: new GristClient('http://memory', '', m), mem: m };
  };
  it('a dry run writes nothing', async () => {
    const t = mem(); const r = await seedBooking(t.grist, 'D', false); expect(r.inserted).toBe(0); expect(t.docs.D!.Doctors).toHaveLength(0); expect(t.mem.calls.some((c) => c.method === 'POST')).toBe(false);
  });
  it('apply fills the three empty tables with the approved values (the columns are all real: memoryGrist rejects unknown ones)', async () => {
    const t = mem(); const r = await seedBooking(t.grist, 'D', true);
    expect(r.inserted).toBe(SEED_DOCTORS.length + SEED_SCHEDULES.length + SEED_CONFIG.length); expect(t.docs.D!.Doctors).toHaveLength(2); expect(t.docs.D!.Doctor_Schedules).toHaveLength(12); expect(t.docs.D!.Booking_Config!.length).toBe(SEED_CONFIG.length);
  });
  it('never overwrites a table that already has rows, and a second run adds nothing', async () => {
    const t = mem({ Doctors: [{ id: 1, fields: { Doctor_ID: 'DR-001', Name: 'Edited by staff' } }] });
    await seedBooking(t.grist, 'D', true); expect(t.docs.D!.Doctors).toHaveLength(1); expect(t.docs.D!.Doctors![0]!.fields.Name).toBe('Edited by staff'); expect(t.docs.D!.Doctor_Schedules).toHaveLength(12);
    expect((await seedBooking(t.grist, 'D', true)).inserted).toBe(0); expect(t.docs.D!.Doctor_Schedules).toHaveLength(12);
  });
});

describe('schema doc and code agree', () => {
  const md = readFileSync(new URL('../../grist/booking-schema.md', import.meta.url), 'utf8');
  it('every new table and column is documented in grist/booking-schema.md', () => {
    for (const t of NEW_TABLES) { const section = md.split(/^## /m).find((x) => x.startsWith(t + '\n')); expect(section, `table ${t} in the doc`).toBeTruthy(); for (const c of bookingColNames(t)) expect(section!, `${t}.${c}`).toMatch(new RegExp(`\\b${c}\\b`)); }
    const appt = md.split(/^## /m).find((x) => x.startsWith('Appointments')); expect(appt).toBeTruthy(); for (const c of bookingColNames(BT.appointments)) expect(appt!, `Appointments.${c}`).toMatch(new RegExp(`\\b${c}\\b`));
  });
  it('documents the single-process assumption and the W13 direct-mode requirement', () => {
    expect(md).toMatch(/ONE FLOW HQ backend process/); expect(md).toMatch(/booking_mode=direct/);
  });
});
