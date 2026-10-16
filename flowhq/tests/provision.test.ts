import { describe, expect, it } from 'vitest';
import { provision, type ProvisionClient } from '../src/server/records/provision';
import { RECORD_COLUMNS, RECORD_TABLE_NAMES } from '../src/server/records/schema';

function fake(existing: Record<string, string[]>) {
  const calls: string[] = [];
  const c: ProvisionClient = {
    tableIds: async () => Object.keys(existing),
    columnIds: async (_d, t) => existing[t] || [],
    createTable: async (_d, id, cols) => { calls.push(`create ${id} ${cols.length}`); existing[id] = cols.map((x) => x.id); },
    addColumns: async (_d, t, cols) => { calls.push(`addcols ${t} ${cols.map((x) => x.id).join(',')}`); existing[t] = [...(existing[t] || []), ...cols.map((x) => x.id)]; },
  };
  return { c, calls, existing };
}
describe('provisioning the Clinic Records tables', () => {
  it('dry run changes nothing and reports every table', async () => {
    const f = fake({ LEADS: ['Name'], Settings: ['Key', 'Value'] }); const lines: string[] = [];
    const r = await provision(f.c, 'DOC', false, (l) => lines.push(l));
    expect(f.calls).toEqual([]); expect(r.changes).toBe(RECORD_TABLE_NAMES.length); expect(lines.every((l) => l.startsWith('would create'))).toBe(true);
  });
  it('apply creates only the missing tables and never touches existing ones', async () => {
    const f = fake({ LEADS: ['Name'], Settings: ['Key', 'Value'] });
    await provision(f.c, 'DOC', true);
    expect(f.calls.every((c) => c.startsWith('create '))).toBe(true); expect(f.calls).toHaveLength(RECORD_TABLE_NAMES.length);
    expect(Object.keys(f.existing)).toEqual(expect.arrayContaining(['LEADS', 'Settings', ...RECORD_TABLE_NAMES])); expect(f.existing.LEADS).toEqual(['Name']);
  });
  it('is idempotent: a second run finds nothing to do', async () => {
    const f = fake({}); await provision(f.c, 'DOC', true); f.calls.length = 0;
    expect((await provision(f.c, 'DOC', true)).changes).toBe(0); expect(f.calls).toEqual([]);
  });
  it('adds only the missing columns to a partly provisioned table', async () => {
    const all = Object.fromEntries(RECORD_TABLE_NAMES.map((t) => [t, RECORD_COLUMNS[t].map(([n]) => n)]));
    all.Patients = all.Patients!.filter((c) => c !== 'Occupation' && c !== 'Notes');
    const f = fake(all); await provision(f.c, 'DOC', true);
    expect(f.calls).toEqual(['addcols Patients Occupation,Notes']);
  });
  it('creates Choice, Date, DateTime and Attachments columns with the right Grist types', async () => {
    let seen: Record<string, { type: string; widgetOptions?: string }> = {};
    const f = fake({}); f.c.createTable = async (_d, id, cols) => { if (id === 'Rx_Images' || id === 'Patients') for (const x of cols) seen[`${id}.${x.id}`] = x.fields as never; };
    await provision(f.c, 'DOC', true);
    expect(seen['Rx_Images.File']!.type).toBe('Attachments'); expect(seen['Patients.Created_At']!.type).toBe('DateTime:Asia/Kolkata'); expect(seen['Patients.Registered_On']!.type).toBe('Date');
    expect(seen['Patients.Sex']!.type).toBe('Choice'); expect(JSON.parse(seen['Patients.Sex']!.widgetOptions!).choices).toEqual(['Male', 'Female', 'Other']); seen = {};
  });
});
