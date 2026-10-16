// Demo mode: only the demo physio clinic has the Clinic Records tables, so only it shows the clinical pages (regression: all three
// demo businesses used to get them, so the salon and real-estate demos showed Patients / Prescriptions / Invoices too).
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server/index';

describe('demo mode', () => {
  it('shows the clinical pages for the physio demo only', async () => {
    const { app } = buildServer({ FLOWHQ_DEMO: 'true' } as NodeJS.ProcessEnv);
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-flowhq-csrf': '1' }, body: JSON.stringify({ email: 'admin@flowhq.demo', password: 'demo1234' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const modules = async (ws: string) => ((await (await app.request(`/api/w/${ws}/workspace`, { headers: { cookie } })).json()) as { modules: string[] }).modules;
    expect(await modules('demo-physio')).toEqual(expect.arrayContaining(['patients', 'prescriptions', 'invoices', 'visits']));
    for (const other of ['demo-salon', 'demo-realty']) expect((await modules(other)).filter((m) => ['patients', 'prescriptions', 'invoices', 'visits'].includes(m))).toEqual([]);
  });
});
