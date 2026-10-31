// /api/health carries the audit-outbox state (ok / amber / red / null) for uptime monitors, without exposing anything else and without changing the status code.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFixture } from './booking-fixture';

const tmp: string[] = [];
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('/api/health audit_outbox', () => {
  it('is null before a booking service exists, then ok for a working outbox, and needs no login', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hl-')); tmp.push(dir);
    const fx = await buildFixture({ bookingOn: true, outboxDir: dir });
    const before = await fx.app.request('/api/health'); expect(before.status).toBe(200); expect((await before.json()).audit_outbox).toBeNull();
    const svc = await fx.booking(); await svc.start();
    const r = await fx.app.request('/api/health'); const j = await r.json();
    expect(r.status).toBe(200); expect(j.ok).toBe(true); expect(j.audit_outbox).toBe('ok');
    expect(Object.keys(j).sort()).toEqual(['audit_outbox', 'backend', 'demo', 'detail', 'ok']);   // nothing else is exposed
    await svc.stop();
  });

  it('is red when the outbox cannot be opened, and the status code stays 200 (a monitor reads the field; a container check does not restart a healthy app)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hl-')); tmp.push(dir);
    const blocker = path.join(dir, 'a-file'); writeFileSync(blocker, 'x');
    const fx = await buildFixture({ bookingOn: true, outboxDir: path.join(blocker, 'under-a-file') });   // a directory cannot be created below a file
    const svc = await fx.booking(); await svc.start();
    const r = await fx.app.request('/api/health'); const j = await r.json();
    expect(r.status).toBe(200); expect(j.audit_outbox).toBe('red');
  });
});
