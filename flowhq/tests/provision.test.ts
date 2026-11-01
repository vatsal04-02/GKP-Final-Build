import { describe, expect, it } from 'vitest';
import { provision, type ProvisionClient } from '../src/server/records/provision';
import { ALL_RECORD_COLUMNS, RECORD_COLUMNS, RECORD_TABLE_NAMES, STAFF_ATT, STAFF_COLUMNS, STAFF_MEMBERS, STAFF_SETTINGS, STAFF_TABLE_NAMES } from '../src/server/records/schema';

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

describe('provisioning with the optional staff tables (what npm run provision-records runs)', () => {
  const required = Object.fromEntries(RECORD_TABLE_NAMES.map((t) => [t, RECORD_COLUMNS[t].map(([n]) => n)]));
  const create = (t: (typeof STAFF_TABLE_NAMES)[number]) => `create ${t} ${STAFF_COLUMNS[t].length}`;
  it('on a clinic that has the required tables, adds ONLY the three staff tables and touches nothing else', async () => {
    const f = fake({ ...required });
    const r = await provision(f.c, 'DOC', true, () => {}, ALL_RECORD_COLUMNS);
    expect(f.calls).toEqual(STAFF_TABLE_NAMES.map(create)); expect(r.changes).toBe(3);
    expect(Object.keys(f.existing).sort()).toEqual([...RECORD_TABLE_NAMES, ...STAFF_TABLE_NAMES].sort());
  });
  it('PRODUCTION CASE (v2 deployed): Staff_Attendance (with the two old clock-time columns) and Staff_Members already exist: only Staff_Settings is created, nothing else is touched', async () => {
    const legacy = [...STAFF_COLUMNS[STAFF_ATT].map(([n]) => n), 'Check_In', 'Check_Out'];
    const members = STAFF_COLUMNS[STAFF_MEMBERS].map(([n]) => n);
    const f = fake({ ...required, [STAFF_ATT]: legacy, [STAFF_MEMBERS]: members });
    const r = await provision(f.c, 'DOC', true, () => {}, ALL_RECORD_COLUMNS);
    expect(f.calls).toEqual([create(STAFF_SETTINGS)]); expect(r.changes).toBe(1);
    expect(f.existing[STAFF_ATT]).toEqual(legacy); expect(f.existing[STAFF_MEMBERS]).toEqual(members);   // nothing renamed, retyped, added or removed
    expect((await provision(f.c, 'DOC', true, () => {}, ALL_RECORD_COLUMNS)).changes).toBe(0);
  });
  it('a dry run reports them without creating anything, and a second apply finds nothing to do', async () => {
    const f = fake({ ...required }); const lines: string[] = [];
    expect((await provision(f.c, 'DOC', false, (l) => lines.push(l), ALL_RECORD_COLUMNS)).changes).toBe(3);
    expect(f.calls).toEqual([]); expect(lines).toEqual(STAFF_TABLE_NAMES.map((t) => `would create table ${t} (${STAFF_COLUMNS[t].length} columns)`));
    await provision(f.c, 'DOC', true, () => {}, ALL_RECORD_COLUMNS); f.calls.length = 0;
    expect((await provision(f.c, 'DOC', true, () => {}, ALL_RECORD_COLUMNS)).changes).toBe(0); expect(f.calls).toEqual([]);
  });
  it('creates the right Grist types: Status Choice, Att_Date Date, Updated_At DateTime, Active Toggle', async () => {
    const seen: Record<string, { type: string; widgetOptions?: string }> = {};
    const f = fake({ ...required }); f.c.createTable = async (_d, id, cols) => { for (const x of cols) seen[`${id}.${x.id}`] = x.fields as never; };
    await provision(f.c, 'DOC', true, () => {}, ALL_RECORD_COLUMNS);
    expect(seen[`${STAFF_ATT}.Status`]!.type).toBe('Choice'); expect(JSON.parse(seen[`${STAFF_ATT}.Status`]!.widgetOptions!).choices).toEqual(['Present', 'Absent', 'Half day', 'Leave']);
    expect(seen[`${STAFF_ATT}.Att_Date`]!.type).toBe('Date'); expect(seen[`${STAFF_ATT}.Updated_At`]!.type).toBe('DateTime:Asia/Kolkata');
    expect(seen[`${STAFF_SETTINGS}.Updated_At`]!.type).toBe('DateTime:Asia/Kolkata'); expect(seen[`${STAFF_SETTINGS}.Value`]!.type).toBe('Text');
    expect(seen[`${STAFF_MEMBERS}.Active`]!.type).toBe('Bool'); expect(seen[`${STAFF_MEMBERS}.Created_At`]!.type).toBe('DateTime:Asia/Kolkata');
    expect(seen[`${STAFF_ATT}.Check_In`]).toBeUndefined();               // the clock-time columns are not created any more
  });
  it('the default (required-only) provisioning is unchanged and does NOT create the optional tables', async () => {
    const f = fake({}); await provision(f.c, 'DOC', true);
    for (const t of STAFF_TABLE_NAMES) expect(Object.keys(f.existing)).not.toContain(t);
  });
});