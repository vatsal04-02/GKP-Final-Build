// Cold start: two requests arriving together must BOTH see the clinical pages (regression: the second one used to return before the
// first request's probe for the Clinic Records tables had finished, and the browser then cached a workspace without them).
import { describe, expect, it } from 'vitest';
import { memoryGrist } from '../src/server/grist';
import { createAutopilotAdapter } from '../src/server/adapters/autopilot';
import { demoDocs } from '../src/server/demo/fixtures';
import { RECORD_TABLE_NAMES } from '../src/server/records/schema';

const build = (withTables: boolean) => {
  const d = demoDocs(Date.UTC(2026, 9, 7, 6, 30));
  const doc = d.docs.REGISTRY!.Clinics!.find((r) => r.fields.Clinic_Slug === 'demo-physio')!.fields.Grist_Doc_ID as string;
  for (const t of RECORD_TABLE_NAMES) { if (withTables) d.docs[doc]![t] = []; else delete d.docs[doc]![t]; }   // the demo physio business ships with records, so "without" must remove them
  const mem = memoryGrist(d.docs);
  const slow: typeof mem = Object.assign(async (u: string, i?: Parameters<typeof mem>[1]) => { await new Promise((r) => setTimeout(r, 15)); return mem(u, i); }, { docs: mem.docs, calls: mem.calls }) as never;
  return { adapter: createAutopilotAdapter({ gristBaseUrl: 'http://memory', gristApiKey: 'k', registryDocId: 'REGISTRY', timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR', fetchImpl: slow, cacheMs: 0 }), mem };
};
describe('clinic records probe', () => {
  it('concurrent first requests all see the records modules', async () => {
    const { adapter } = build(true);
    const first = adapter.workspace('demo-physio'); const second = adapter.workspace('demo-physio'); const third = adapter.workspace('demo-physio');
    for (const p of [second, third, first]) expect((await p)!.supported.modules).toEqual(expect.arrayContaining(['patients', 'prescriptions', 'invoices', 'visits']));   // awaiting the LATER callers first is the case that used to fail
  });
  it('probes once for concurrent callers, not once each', async () => {
    const { adapter, mem } = build(true);
    await Promise.all([adapter.workspace('demo-physio'), adapter.workspace('demo-physio'), adapter.workspace('demo-physio')]);
    expect(mem.calls.filter((c) => c.table === 'Patients' && c.method === 'GET')).toHaveLength(1);
  });
  it('a workspace without the tables simply has no clinical pages', async () => {
    const { adapter } = build(false);
    const ws = (await adapter.workspace('demo-physio'))!;
    expect(ws.supported.modules).not.toContain('patients'); expect(ws.records?.() ?? null).toBeNull();
  });
});
