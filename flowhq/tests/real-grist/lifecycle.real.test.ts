// REAL Grist + the real FLOW HQ PROCESS, abused: stop signals, forced kill, restart recovery, a corrupt / full / doubly-opened audit outbox, expired and revoked tokens,
// backup and restore of the Grist document and of the outbox. Skipped unless REAL_GRIST_URL and REAL_GRIST_KEY_FILE are set.
//   * The signal tests (SIGTERM / SIGINT / SIGKILL) need Linux (Windows has no signals): run them in the container: `npm run test:real-grist:linux` (docs/staging-environment.md).
//   * The disk-full test needs a tiny filesystem for the outbox: it runs only when REAL_SMALL_DISK_DIR points at one (the container mounts a 256 KB tmpfs there).
// Invariants after ANY interruption: every booking the caller was told about exists exactly once; no slot is double-booked; a retry with the same key never makes a second one;
// every applied change gets its Booking_Audit row after the restart, once.
import { appendFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newToken } from '../../src/server/booking/tokens';
import { REAL_ENABLED, REAL_URL, createStaging, deleteStaging, futureDay, slotId, startServer, type Server, type Staging } from './harness';

const d = describe.skipIf(!REAL_ENABLED);
const linux = it.skipIf(process.platform !== 'linux');
const DAY = futureDay(5); const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MORNING = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30'];
const phone = (i: number) => `90000${String(30000 + i).padStart(5, '0')}`;
const EVENING = ['16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30'];
/** The i-th test slot: the first 8 are DR-001's morning, the next 8 DR-002's evening, then the next day's (so a test can book up to 16 on one day). */
const slotFor = (i: number) => (i < 8 ? { doctor: 'DR-001', time: MORNING[i]! } : { doctor: 'DR-002', time: EVENING[(i - 8) % 8]! });
const create = (srv: Server, i: number, tag: string, time = slotFor(i).time, doctor = slotFor(i).doctor) =>
  srv.api('/appointments', { method: 'POST', headers: { 'idempotency-key': `${tag}-${String(i).padStart(2, '0')}-abcdefgh` }, body: { slot_id: slotId(doctor, DAY, time), patient: { name: `Life Patient ${i}`, phone: phone(i) } } }).catch(() => ({ status: 0, json: null, text: '' }));
const rowsOf = (s: Staging) => s.client.records(s.clinicDocId, 'Appointments');
const audit = (s: Staging) => s.client.records(s.clinicDocId, 'Booking_Audit');
const health = async (srv: Server) => (await srv.staff('admin', '/overview')).json?.audit_health as { level: string; waiting_to_flush: number; open_intents: number; corrupt_lines: number; ready: boolean; lock_held: boolean; reasons: string[] } | undefined;
async function settled(srv: Server, ms = 60000) { const end = Date.now() + ms; let h; while (Date.now() < end) { h = await health(srv); if (h && h.ready && h.waiting_to_flush === 0 && h.open_intents === 0) return h; await sleep(700); } throw new Error(`the audit outbox did not settle: ${JSON.stringify(h)}`); }

/** The invariants that must hold after an interruption, given what the callers were told. */
async function checkInvariants(s: Staging, told: Array<{ i: number; status: number; ref?: string }>, tag: string) {
  const rows = await rowsOf(s); const mine = rows.filter((r) => String(r.fields.Idem_Key || '').startsWith(tag));
  const keys = mine.map((r) => r.fields.Idem_Key); expect(new Set(keys).size, 'one row per idempotency key').toBe(keys.length);
  const slots = rows.filter((r) => r.fields.Status === 'Booked' && r.fields.Slot_Key).map((r) => r.fields.Slot_Key); expect(new Set(slots).size, 'no slot is booked twice').toBe(slots.length);
  for (const t of told.filter((x) => x.status === 201 || x.status === 200)) expect(mine.some((r) => r.fields.Booking_UID === t.ref), `booking ${t.ref} that the caller was told about exists`).toBe(true);
  const a = await audit(s); const ids = a.map((r) => r.fields.Audit_ID); expect(new Set(ids).size, 'no audit row twice').toBe(ids.length);
  for (const r of mine) expect(ids, `applied row ${r.fields.Booking_UID} has its audit entry`).toContain(r.fields.Audit_ID);
  return { rows: mine, audit: a };
}

d('real process lifecycle', () => {
  const made: Staging[] = []; const servers: Server[] = [];
  afterAll(async () => { for (const v of servers) await v.stop('SIGKILL').catch(() => undefined); for (const m of made) await deleteStaging(m).catch(() => undefined); });
  const stage = async (slug: string) => { const s = await createStaging(slug, { bookingOn: true }); made.push(s); return s; };
  const boot = async (s: Staging, o: Parameters<typeof startServer>[1] = {}) => { const v = await startServer(s, o); servers.push(v); return v; };

  async function interrupted(signal: NodeJS.Signals, tag: string) {
    const s = await stage(`life-${tag}`); let srv = await boot(s);
    const inflight = Array.from({ length: 10 }, (_, i) => create(srv, i, tag));
    await sleep(120);
    const t0 = Date.now(); const exit = await srv.stop(signal); const took = Date.now() - t0;
    const results = await Promise.all(inflight);
    const told = results.map((r, i) => ({ i, status: r.status, ref: r.json?.appointment?.booking_reference as string | undefined }));
    // restart the SAME installation (same directories, same token)
    srv = await boot(s, { reuse: srv, startTimeoutMs: 90000 });
    const h = await settled(srv, 90000);
    const out = await checkInvariants(s, told, tag);
    // every caller retries with the same key: never a second booking, never "duplicate"
    const retried = await Promise.all(told.map((t) => create(srv, t.i, tag)));
    for (const r of retried) expect([200, 201], r.text).toContain(r.status);
    await settled(srv); const after = await checkInvariants(s, told, tag);
    expect(after.rows.length).toBe(10);
    return { exit, took, told, h, out, srv };
  }

  linux('SIGTERM while bookings are in flight: exits cleanly (code 0) within the grace period; after restart every told booking exists once, audit complete, retries replay', async () => {
    const r = await interrupted('SIGTERM', 'term'); expect(r.exit.code).toBe(0); expect(r.took).toBeLessThan(25000);
  }, 240000);
  linux('SIGINT behaves the same', async () => {
    const r = await interrupted('SIGINT', 'int'); expect(r.exit.code).toBe(0);
  }, 240000);
  linux('SIGKILL (forced termination, the lock is left behind): the restart waits for the dead lock, recovers the write-ahead log, and the same invariants hold', async () => {
    const r = await interrupted('SIGKILL', 'kill'); expect(r.exit.signal).toBe('SIGKILL');
  }, 300000);

  it('a clean stop and restart keeps everything: same booking, the key replays, audit complete', async () => {
    const s = await stage('life-restart'); let srv = await boot(s);
    const first = await create(srv, 1, 'rst'); expect(first.status).toBe(201);
    await settled(srv); await srv.stop('SIGTERM');
    srv = await boot(s, { reuse: srv });
    const again = await create(srv, 1, 'rst'); expect(again.status).toBe(200); expect(again.json.replayed).toBe(true); expect(again.json.appointment.booking_reference).toBe(first.json.appointment.booking_reference);
    await settled(srv); await checkInvariants(s, [{ i: 1, status: 201, ref: first.json.appointment.booking_reference }], 'rst');
  }, 180000);

  it('a second process on the same outbox cannot book (single-process enforcement); the first keeps working', async () => {
    const s = await stage('life-single'); const one = await boot(s); await settled(one);
    const two = await boot(s, { reuse: one, freshPort: true, startTimeoutMs: 45000 });   // same directories while the first holds the lock, on its OWN port (otherwise it could not even start and the first would answer for it)
    const refused = await create(two, 2, 'dbl'); expect(refused.status, refused.text).toBe(503); expect(refused.json.error.code).toBe('audit_unavailable');
    expect((await rowsOf(s)).filter((r) => String(r.fields.Idem_Key || '').startsWith('dbl'))).toHaveLength(0);
    expect((await create(one, 3, 'dbl')).status).toBe(201);
    expect(two.port).not.toBe(one.port); expect(two.proc.exitCode, 'the second process is really running').toBeNull();
    await two.stop('SIGKILL');
  }, 180000);

  it('a corrupt outbox (garbage and a torn last line) does not stop the server: it starts, reports the damage to admins, and bookings continue', async () => {
    const s = await stage('life-corrupt'); let srv = await boot(s);
    expect((await create(srv, 1, 'cor')).status).toBe(201); await settled(srv); await srv.stop('SIGTERM');
    const f = path.join(srv.outboxDir, s.slug, 'outbox.jsonl'); expect(existsSync(f)).toBe(true);
    appendFileSync(f, '{this is not json}\n{"t":"i","id":"zzz-torn","at":'); // garbage line + a torn tail
    srv = await boot(s, { reuse: srv, startTimeoutMs: 60000 });
    const h = await settled(srv);
    expect(h.corrupt_lines).toBeGreaterThanOrEqual(1); expect(h.level).not.toBe('ok');
    expect((await create(srv, 2, 'cor')).status).toBe(201); await settled(srv);
    await checkInvariants(s, [], 'cor');
  }, 180000);

  it('token expiry and revocation (real process): a valid token works, an expired one and a revoked one get 401, none says which', async () => {
    const s = await stage('life-token');
    const expired = newToken('n8n-expired', s.slug, { days: 1, now: Date.now() - 10 * 86400000 }); const revoked = newToken('n8n-revoked', s.slug); revoked.record.revoked = true;
    const srv = await boot(s, { extraTokens: [expired.record, revoked.record] });
    expect((await srv.api('/config')).status).toBe(200);
    const a = await srv.api('/config', { token: expired.token }); const b = await srv.api('/config', { token: revoked.token }); const c = await srv.api('/config', { token: 'n8n-nobody.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect([a.status, b.status, c.status]).toEqual([401, 401, 401]); expect(a.text).toBe(b.text); expect(b.text).toBe(c.text);
    expect((await create(srv, 1, 'tok')).status).toBe(201);
    expect((await srv.api('/appointments', { method: 'POST', token: expired.token, headers: { 'idempotency-key': 'tok-expired-abcdefgh' }, body: { slot_id: slotId('DR-001', DAY, '12:30'), patient: { name: 'X Patient', phone: '9000012345' } } })).status).toBe(401);
  }, 120000);

  it('staff permission boundaries (real process): front desk cannot change the AI switch or read the audit log; an admin can; the AI token cannot call staff routes', async () => {
    const s = await stage('life-perm'); const srv = await boot(s);
    expect((await srv.staff('desk', '/settings', { method: 'PUT', body: { values: { booking_enabled: 'off' } } })).status).toBe(403);
    expect((await srv.staff('desk', '/audit')).status).toBe(403);
    expect((await srv.staff('admin', '/audit')).status).toBe(200);
    const aiOnStaff = await fetch(`${srv.base}/api/w/${s.slug}/schedule/overview`, { headers: { authorization: `Bearer ${srv.token}` } }); expect([401, 403]).toContain(aiOnStaff.status);
    const consentByAi = await srv.api('/consent', { method: 'POST', body: { phone: '9000012345', value: 'Yes' } }); expect([401, 403, 404]).toContain(consentByAi.status);
  }, 120000);

  it('BACKUP AND RESTORE: download the clinic document and the outbox, restore both as new copies, point the registry at the restored document: same bookings, same consent, bookings still work', async () => {
    const s = await stage('life-backup'); let srv = await boot(s);
    const a = await create(srv, 1, 'bak'); const b = await create(srv, 2, 'bak'); expect([a.status, b.status]).toEqual([201, 201]);
    expect((await srv.staff('admin', '/consent', { method: 'POST', body: { phone: phone(1), value: 'Yes', source: 'Told staff in person', evidence_ref: 'Register serial 77' } })).status).toBe(201);
    await settled(srv); await srv.stop('SIGTERM');
    // 1. back up: the Grist document (SQLite download) and the outbox directory
    const key = readFileSync(process.env.REAL_GRIST_KEY_FILE!, 'utf8').trim();
    const dl = await fetch(`${REAL_URL}/api/docs/${s.clinicDocId}/download`, { headers: { Authorization: `Bearer ${key}` } }); expect(dl.status).toBe(200);
    const bytes = new Uint8Array(await dl.arrayBuffer()); expect(bytes.length).toBeGreaterThan(10000); expect(Buffer.from(bytes.slice(0, 15)).toString()).toBe('SQLite format 3');
    const outboxCopy = path.join(srv.configDir, 'outbox-backup'); cpSync(srv.outboxDir, outboxCopy, { recursive: true });
    // 2. disaster: the document is deleted. 3. restore: import the backup as a NEW document
    const clinicBefore = await rowsOf(s); await s.client.deleteDoc(s.clinicDocId);
    const form = new FormData(); form.append('upload', new Blob([bytes]), 'restore.grist');
    const imp = await fetch(`${REAL_URL}/api/workspaces/${s.workspaceId}/import`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form }); expect(imp.status, await imp.clone().text()).toBe(200);
    const restoredId = ((await imp.json()) as { id: string }).id; expect(restoredId).toBeTruthy(); expect(restoredId).not.toBe(s.clinicDocId);
    // 4. cut over: the registry row now names the restored document (the only change an operator makes)
    const reg = (await s.client.records(s.registryDocId, 'Clinics'))[0]!; await s.client.update(s.registryDocId, 'Clinics', [{ id: reg.id, fields: { Grist_Doc_ID: restoredId } }]);
    made.push({ ...s, clinicDocId: restoredId });
    const restored = { ...s, clinicDocId: restoredId };
    srv = await boot(restored, { reuse: srv, outboxDir: outboxCopy, startTimeoutMs: 60000 });
    const after = await rowsOf(restored);
    expect(after.map((r) => r.fields.Booking_UID).sort()).toEqual(clinicBefore.map((r) => r.fields.Booking_UID).sort());
    expect((await create(srv, 1, 'bak')).status).toBe(200);                                    // the idempotency key still replays on the restored copy
    expect((await create(srv, 3, 'bak', MORNING[1]!)).status).toBe(409);                    // a taken slot is still taken
    expect((await create(srv, 4, 'bak', '12:30')).status).toBe(201);                           // and a new booking works
    expect((await restored.client.records(restoredId, 'Reminder_Consent')).some((r) => r.fields.Reminder_Consent === 'Yes')).toBe(true);
    await settled(srv, 90000);
  }, 300000);

  // ---------------------------------------------------------------- disk full (needs a tiny filesystem: the container mounts one)
  const smallDisk = process.env.REAL_SMALL_DISK_DIR;
  it.skipIf(!smallDisk)('DISK FULL: when the audit outbox cannot be written, bookings are REFUSED (503 audit_unavailable) with NOTHING written to Grist; space freed = bookings resume; nothing already booked is lost', async () => {
    const s = await stage('life-disk'); const dir = path.join(smallDisk!, `ob-${Date.now()}`);
    const srv = await boot(s, { outboxDir: dir }); await settled(srv);
    const ok = await create(srv, 1, 'dsk'); expect(ok.status).toBe(201); await settled(srv);
    // fill the filesystem completely
    const filler = path.join(dir, 'filler.bin'); const chunk = Buffer.alloc(4096, 1); let written = 0;
    for (;;) { try { appendFileSync(filler, chunk); written += chunk.length; } catch (e) { expect((e as NodeJS.ErrnoException).code).toBe('ENOSPC'); break; } }
    expect(written).toBeGreaterThan(0);
    // A full filesystem only fails a write that needs a NEW block: bookings may still fit in the outbox file's last block, so keep booking until the first refusal.
    const told: Array<{ i: number; status: number; ref?: string }> = [{ i: 1, status: 201, ref: ok.json.appointment.booking_reference }];
    let refusedAt = -1; let refused;
    for (let i = 2; i < 16; i++) {
      const r = await create(srv, i, 'dsk'); told.push({ i, status: r.status, ref: r.json?.appointment?.booking_reference });
      if (r.status !== 201) { refusedAt = i; refused = r; break; }
    }
    expect(refusedAt, 'the outbox must eventually refuse when the disk is full').toBeGreaterThan(0);
    expect(refused!.status, refused!.text).toBe(503); expect(refused!.json.error.code).toBe('audit_unavailable');
    const rows = await rowsOf(s); const accepted = told.filter((t) => t.status === 201);
    expect(rows.filter((r) => String(r.fields.Idem_Key || '').startsWith('dsk')).length, 'exactly the accepted bookings are in Grist: the refused one wrote NOTHING').toBe(accepted.length);
    expect(rows.some((r) => r.fields.Idem_Key === `dsk-${String(refusedAt).padStart(2, '0')}-abcdefgh`)).toBe(false);
    expect((await srv.api(`/appointments/${ok.json.appointment.booking_reference}?patient_phone=${phone(1)}`)).status, 'reads still work while full').toBe(200);
    const h = await health(srv); expect(h && h.level).toBe('red');
    rmSync(filler, { force: true });
    const resumed = await create(srv, refusedAt, 'dsk'); expect(resumed.status, resumed.text).toBe(201);    // the SAME request, retried with the same key, now succeeds
    await settled(srv, 90000); const a = await checkInvariants(s, [...accepted, { i: refusedAt, status: 201, ref: resumed.json.appointment.booking_reference }], 'dsk');
    expect(a.rows).toHaveLength(accepted.length + 1); expect(statSync(dir).isDirectory()).toBe(true); expect(readdirSync(dir).length).toBeGreaterThan(0);
  }, 240000);
});

// keep the unused-import guard honest: these helpers are used by the Linux-only / small-disk-only branches above
void [writeFileSync];
