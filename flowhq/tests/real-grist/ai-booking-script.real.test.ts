// The production AI-booking API test (scripts/4d/97-ai-booking-api-test.js) proven on the staging stack BEFORE it is used on production: real Grist, the real FLOW HQ server process,
// the AI switch ON. It must pass; and with the switch OFF it must stop without writing anything.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REAL_ENABLED, REAL_URL, createStaging, deleteStaging, startServer, type Server, type Staging } from './harness';

const d = describe.skipIf(!REAL_ENABLED);
const SCRIPT = path.resolve('..', 'scripts', '4d', '97-ai-booking-api-test.js');
const key = () => fs.readFileSync(process.env.REAL_GRIST_KEY_FILE!, 'utf8').trim();

d('PRODUCTION AI-BOOKING TEST SCRIPT, proven on staging', () => {
  let s: Staging; let srv: Server;
  const run = (token: string) => spawnSync(process.execPath, ['-e', 'const t=require("fs").readFileSync(0,"utf8"); const i=t.indexOf("\\n"); global.TOKEN=t.slice(0,i).trim(); new Function("require","TOKEN",t.slice(i+1))(require,global.TOKEN);'],
    { input: `${token}\n${fs.readFileSync(SCRIPT, 'utf8')}`, encoding: 'utf8', timeout: 120000, env: { ...process.env, BOOKING_BASE: srv.base, GRIST_BASE_URL: REAL_URL, GRIST_API_KEY: key(), GRIST_REGISTRY_DOC_ID: s.registryDocId, CLINIC_SLUG: s.slug } });
  const appts = async () => (await s.client.records(s.clinicDocId, 'Appointments')).length;
  beforeAll(async () => { s = await createStaging('ai-script-physio', { bookingOn: false }); srv = await startServer(s); }, 240000);
  afterAll(async () => { await srv?.stop('SIGKILL').catch(() => undefined); if (s) await deleteStaging(s).catch(() => undefined); }, 120000);

  it('with the AI switch OFF it stops (exit 3) and writes nothing', async () => {
    const before = await appts(); const r = run(srv.token);
    expect(r.status, r.stdout + r.stderr).toBe(3); expect(r.stdout).toMatch(/AI booking switch is OFF/); expect(await appts()).toBe(before);
  });
  it('with the AI switch ON it passes every check and leaves exactly one cancelled synthetic appointment', async () => {
    const cfg = await s.client.records(s.clinicDocId, 'Booking_Config'); const row = cfg.find((x) => x.fields.Key === 'booking_enabled')!; await s.client.update(s.clinicDocId, 'Booking_Config', [{ id: row.id, fields: { Value: 'on' } }]);
    await new Promise((r) => setTimeout(r, 1500)); const before = await appts(); const r = run(srv.token);
    expect(r.status, r.stdout + r.stderr).toBe(0); expect(r.stdout).toMatch(/ALL PASSED/); expect(r.stdout).not.toMatch(/FAIL /);
    expect(await appts()).toBe(before + 1);
    const a = (await s.client.records(s.clinicDocId, 'Appointments')).filter((x) => String(x.fields.Patient_Name).startsWith('ZZ AI Booking Test')); expect(a).toHaveLength(1); expect(String(a[0]!.fields.Status)).toMatch(/Cancel/i);
  });
});
