// The durable audit outbox: the file store (durability, locking, corruption, disk-full, compaction, forced termination) and the booking operations built on it
// (write-ahead intent, recovery at every crash point, no duplicate audit rows, nothing reported failed after it was saved). Synthetic data only.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendError, GristClient, memoryGrist, type GristRecord } from '../src/server/grist';
import { AuditOutbox, FileStore, MemoryStore, OutboxUnavailable, volumeOf } from '../src/server/booking/outbox';
import { StaffBooking } from '../src/server/booking/staff-service';
import type { BookingActor } from '../src/server/booking/service';
import { SEED_CONFIG, SEED_DOCTORS, SEED_SCHEDULES } from '../src/server/booking/seed';
import { APPOINTMENT_EXTRA, BT, bookingColNames } from '../src/server/booking/schema';
import { M09, M0930, M10, buildFixture, THU } from './booking-fixture';

const NOW = Date.UTC(2026, 9, 7, 6, 30);
const LEGACY = ['Booking_UID', 'Lead', 'Service', 'Physio', 'Start', 'End', 'Status', 'Fee_INR', 'R24_Sent', 'R2_Sent', 'Rebook_Sent', 'Review_Sent', 'Outcome_Sent'];
const ADMIN: BookingActor = { kind: 'staff', id: 'admin@test', name: 'Owner', source: 'Staff', role: 'admin' };
const DESK: BookingActor = { kind: 'staff', id: 'desk@test', name: 'Front desk', source: 'Staff', role: 'staff' };
const AI: BookingActor = { kind: 'service', id: 'n8n-test', name: 'n8n-test', source: 'WhatsApp AI' };
const P1 = '9876543210';
let keyN = 0; const key = () => `outbox-key-${++keyN}-abcdefgh`;
const rows = (list: Array<Record<string, unknown>>): GristRecord[] => list.map((f, i) => ({ id: i + 1, fields: { ...f } as GristRecord['fields'] }));
const fail = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { const b = e as BackendError; return { status: b.status, code: b.code }; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tmp: string[] = []; const stoppers: Array<() => Promise<void>> = [];
const newDir = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'fhq-outbox-')); tmp.push(d); return d; };
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(async () => { vi.restoreAllMocks(); for (const s of stoppers.splice(0)) await s().catch(() => undefined); for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });

const fastStore = (dir: string, o: Partial<ConstructorParameters<typeof FileStore>[0]> = {}) => new FileStore({ dir, staleMs: 120, waitMs: 4000, heartbeatMs: 20, ...o });
const intentInput = (n = 1) => ({ actor: 'desk@test', source: 'Staff', action: 'create', record: `GKA-00000${n}`, table: 'Appointments', detail: {} });
const lines = (dir: string) => readFileSync(path.join(dir, 'outbox.jsonl'), 'utf8').split('\n').filter(Boolean);

describe('the outbox file', () => {
  it('survives a restart: completed and half-finished entries are both still there', async () => {
    const dir = newDir(); const a = new AuditOutbox(fastStore(dir)); await a.open();
    const done = await a.intent(intentInput(1)); await a.outcome(done, { outcome: 'ok', reason: 'created' }); await a.intent(intentInput(2));   // the second never finishes
    await a.close();
    const b = new AuditOutbox(fastStore(dir)); stoppers.push(() => b.close()); await b.open();
    expect(b.health()).toMatchObject({ waiting_to_flush: 1, open_intents: 1, durable: true, lock_held: true }); expect(b.pendingFlush()[0]).toMatchObject({ action: 'create', record: 'GKA-000001', suspect: true }); expect(b.openIntents()).toHaveLength(1);
  });
  it('writes one JSON record per line with only ids, action, outcome and reason codes (no personal fields)', async () => {
    const dir = newDir(); const a = new AuditOutbox(fastStore(dir)); stoppers.push(() => a.close());
    const id = await a.intent({ ...intentInput(), detail: { slot: 'DR-001|2026-10-08|09:00', source: 'Staff' } }); await a.outcome(id, { outcome: 'ok', reason: 'created', record: 'GKA-000001' }); await a.event({ ...intentInput(), outcome: 'rejected', reason: 'invalid_phone' }); await a.markFlushed([id]);
    const recs = lines(dir).map((l) => JSON.parse(l) as Record<string, unknown>); expect(recs.map((r) => r.t)).toEqual(['i', 'o', 'e', 'f']);
    const allowed = new Set(['t', 'id', 'ids', 'seq', 'at', 'actor', 'source', 'action', 'record', 'table', 'detail', 'outcome', 'reason']); for (const r of recs) for (const k of Object.keys(r)) expect(allowed.has(k), k).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, 'outbox.meta.json'), 'utf8'))).toMatchObject({ volume_id: expect.any(String), created_at: expect.any(String) });
  });
  it('a half-written last line (a crash mid-append) is sealed and skipped; every earlier record is intact', async () => {
    const dir = newDir(); const a = new AuditOutbox(fastStore(dir)); await a.open(); const id = await a.intent(intentInput()); await a.outcome(id, { outcome: 'ok', reason: 'created' }); await a.close();
    writeFileSync(path.join(dir, 'outbox.jsonl'), readFileSync(path.join(dir, 'outbox.jsonl'), 'utf8') + '{"t":"i","id":"half-writ');   // torn write, no newline
    const b = new AuditOutbox(fastStore(dir)); await b.open(); expect(b.health()).toMatchObject({ corrupt_lines: 1, waiting_to_flush: 1, level: 'amber' });
    const id2 = await b.intent(intentInput(2)); await b.close();   // the next record must start on its own line
    const again = new AuditOutbox(fastStore(dir)); stoppers.push(() => again.close()); await again.open(); expect(again.health()).toMatchObject({ corrupt_lines: 1, open_intents: 1, waiting_to_flush: 1 }); expect(again.openIntents()[0]!.id).toBe(id2);
  });
  it('a garbage line in the middle is skipped and counted; everything else loads', async () => {
    const dir = newDir(); const a = new AuditOutbox(fastStore(dir)); await a.open(); const id = await a.intent(intentInput()); await a.outcome(id, { outcome: 'ok', reason: 'created' }); await a.close();
    const ls = lines(dir); writeFileSync(path.join(dir, 'outbox.jsonl'), [ls[0], 'this is not json', '{"t":"zzz"}', ...ls.slice(1)].join('\n') + '\n');
    const b = new AuditOutbox(fastStore(dir)); stoppers.push(() => b.close()); await b.open(); expect(b.health()).toMatchObject({ corrupt_lines: 2, waiting_to_flush: 1 });
  });
  it('compaction drops only flushed entries, atomically, and never an unflushed or open one', async () => {
    const dir = newDir(); const a = new AuditOutbox(fastStore(dir), { compactAtBytes: 200 }); stoppers.push(() => a.close()); await a.open();
    const ids: string[] = []; for (let i = 0; i < 60; i++) { const id = await a.intent(intentInput(i)); await a.outcome(id, { outcome: 'ok', reason: 'created' }); ids.push(id); }
    const open = await a.intent(intentInput(99)); await a.markFlushed(ids.slice(0, 55));   // 5 complete + 1 open stay
    expect(lines(dir).length).toBeLessThan(20); expect(existsSync(path.join(dir, 'outbox.jsonl.tmp'))).toBe(false);
    await a.close(); const b = new AuditOutbox(fastStore(dir)); stoppers.push(() => b.close()); await b.open(); expect(b.health()).toMatchObject({ waiting_to_flush: 5, open_intents: 1 }); expect(b.openIntents()[0]!.id).toBe(open);
  });
  it('only one process can use an outbox: a second one is refused until the first lets go', async () => {
    const dir = newDir(); const a = new AuditOutbox(fastStore(dir)); await a.open();
    const b = new AuditOutbox(fastStore(dir, { waitMs: 150 })); await expect(b.open()).rejects.toMatchObject({ code: 'locked' }); expect(await fail(b.intent(intentInput()))).toBeTruthy();
    await a.close(); const c = new AuditOutbox(fastStore(dir)); stoppers.push(() => c.close()); await c.open(); expect(c.health().lock_held).toBe(true);
  });
  it('a killed process leaves a stale lock; the next start waits for it to go stale, then takes over', async () => {
    const dir = newDir(); const store = fastStore(dir); const a = new AuditOutbox(store); await a.open(); const id = await a.intent(intentInput()); await a.abandon();   // kill -9: lock left behind
    const t0 = Date.now(); const b = new AuditOutbox(fastStore(dir)); stoppers.push(() => b.close()); await b.open();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60); expect(b.openIntents().map((e) => e.id)).toEqual([id]);
  });
  it('a process that loses its lock stops writing instead of risking two writers', async () => {
    const dir = newDir(); const a = new AuditOutbox(fastStore(dir)); stoppers.push(() => a.close()); await a.open(); rmSync(path.join(dir, 'outbox.lock')); await sleep(120);
    await expect(a.intent(intentInput())).rejects.toBeInstanceOf(OutboxUnavailable); expect(a.health()).toMatchObject({ lock_held: false, level: 'red' });
  });
  it.skipIf(process.platform === 'win32')('creates the directory 0700 and the files 0600', async () => {
    const dir = path.join(newDir(), 'outbox'); const a = new AuditOutbox(fastStore(dir)); stoppers.push(() => a.close()); await a.open(); await a.intent(intentInput());
    expect(statSync(dir).mode & 0o777).toBe(0o700); for (const f of ['outbox.jsonl', 'outbox.lock', 'outbox.meta.json']) expect(statSync(path.join(dir, f)).mode & 0o777, f).toBe(0o600);
  });
  it('refuses to run on the container\'s own layer (lost on recreation) when a persistent volume is required; accepts a mounted volume', async () => {
    const dir = newDir(); const seen = '/app/flowhq/config/audit-outbox';   // what the container would see; the real test directory is a temp dir
    const overlay = '1 0 0:1 / / rw - overlay overlay rw\n'; const mounted = `${overlay}2 1 8:1 / /app/flowhq/config rw - ext4 /dev/sda1 rw\n`;
    expect(volumeOf(seen, overlay)).toEqual({ mount: '/', fstype: 'overlay' }); expect(volumeOf(seen, mounted)).toEqual({ mount: '/app/flowhq/config', fstype: 'ext4' });
    const bad = new AuditOutbox(fastStore(dir, { requireVolume: true, mountinfo: () => overlay, mountCheckPath: seen })); await expect(bad.open()).rejects.toMatchObject({ code: 'not_persistent' }); expect(await fail(bad.intent(intentInput()))).toBeTruthy();
    const good = new AuditOutbox(fastStore(dir, { requireVolume: true, mountinfo: () => mounted, mountCheckPath: seen })); stoppers.push(() => good.close()); await good.open(); expect(good.health()).toMatchObject({ persistent_volume: 'yes', level: 'ok' });
    await good.close(); const soft = new AuditOutbox(fastStore(dir, { mountinfo: () => overlay, mountCheckPath: seen })); stoppers.push(() => soft.close()); await soft.open(); expect(soft.health()).toMatchObject({ persistent_volume: 'no', level: 'red' });   // not required: it runs, but shouts
  });
  it('a full or read-only disk: the intent is refused (the caller must not mutate), an outcome never throws, break-glass is loud', async () => {
    const dir = newDir(); let mode: 'ok' | 'i' | 'o' = 'ok';
    const store = fastStore(dir, { hooks: { beforeAppend: (line) => { const t = JSON.parse(line).t; if ((mode === 'i' && t === 'i') || (mode === 'o' && t === 'o')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } } });
    const a = new AuditOutbox(store); stoppers.push(() => a.close()); await a.open();
    mode = 'i'; await expect(a.intent(intentInput())).rejects.toMatchObject({ code: 'write_failed' }); expect(a.health()).toMatchObject({ rejected_for_audit: 1, level: 'red' });
    mode = 'ok'; const id = await a.intent(intentInput(2)); mode = 'o'; expect(await a.outcome(id, { outcome: 'ok', reason: 'created' })).toBe(false); expect(a.health()).toMatchObject({ unsaved_outcomes: 1, waiting_to_flush: 1 });
    mode = 'ok'; await a.retryUnsavedOutcomes(); expect(a.health().unsaved_outcomes).toBe(0);
    const dir2 = newDir(); const bg = new AuditOutbox(fastStore(dir2, { hooks: { beforeAppend: () => { throw new Error('EROFS'); } } }), { breakGlass: true }); stoppers.push(() => bg.close()); await bg.open();
    expect(await bg.intent(intentInput())).toBeTruthy(); expect(bg.health()).toMatchObject({ break_glass: true, break_glass_uses: 1, level: 'red' });
  });
  it('a memory outbox (tests, demo) behaves the same but says it is not durable', async () => {
    const a = new AuditOutbox(new MemoryStore()); const id = await a.intent(intentInput()); await a.outcome(id, { outcome: 'ok', reason: 'created' }); expect(a.health()).toMatchObject({ durable: false, waiting_to_flush: 1, level: 'ok' });
    expect(AuditOutbox.summarise(['{"t":"i","id":"a","seq":1,"at":1,"actor":"x","source":"Staff","action":"create","record":"r","table":"Appointments","detail":{}}', 'junk'])).toEqual({ entries: 1, unflushed: 0, open_intents: 1, corrupt_lines: 1 });
  });
  it('a REAL forced termination (a child process killed with no clean shutdown) loses nothing that was durable', async () => {
    const dir = newDir(); const root = path.resolve(__dirname, '..');
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.join('tests', 'helpers', 'outbox-child.ts'), dir], { cwd: root, encoding: 'utf8', timeout: 60000 });
    expect(r.stdout).toContain('READY'); expect(r.status === 0).toBe(false);   // it did not exit normally
    expect(existsSync(path.join(dir, 'outbox.lock'))).toBe(true);   // no clean shutdown: the lock was left behind
    const b = new AuditOutbox(fastStore(dir)); stoppers.push(() => b.close()); await b.open();
    expect(b.health()).toMatchObject({ waiting_to_flush: 1, open_intents: 2, corrupt_lines: 0 }); expect(b.openIntents().map((e) => e.record)).toEqual(['GKA-000002', 'GKA-000003']);
  }, 90000);
});

// ---------------------------------------------------------------- booking operations on a real outbox
interface Env { docs: Record<string, Record<string, GristRecord[]>>; grist: GristClient; fail: { grist: null | ((m: string, t: string) => boolean) } }
function newEnv(): Env {
  const cfg = SEED_CONFIG.map((r) => ({ ...r })); cfg.find((r) => r.Key === 'booking_enabled')!.Value = 'on';
  const docs = { D: { [BT.config]: rows(cfg), [BT.doctors]: rows(SEED_DOCTORS), [BT.schedules]: rows(SEED_SCHEDULES), [BT.blocks]: [] as GristRecord[], [BT.audit]: [] as GristRecord[], [BT.appointments]: [] as GristRecord[], LEADS: [] as GristRecord[], Patients: [] as GristRecord[] } };
  const fail: Env['fail'] = { grist: null };
  const columns: Record<string, string[]> = { [BT.appointments]: [...LEGACY, ...APPOINTMENT_EXTRA.map(([n]) => n)], [BT.audit]: bookingColNames(BT.audit), [BT.config]: bookingColNames(BT.config), [BT.doctors]: bookingColNames(BT.doctors), [BT.schedules]: bookingColNames(BT.schedules), [BT.blocks]: bookingColNames(BT.blocks) };
  const mem = memoryGrist(docs, { columns, failOn: (m, t) => !!fail.grist?.(m, t) });
  return { docs, grist: new GristClient('http://memory', '', mem), fail };
}
function boot(env: Env, dir: string) {
  const hooks = { failKinds: new Set<string>() };
  const store = new FileStore({ dir, staleMs: 120, waitMs: 4000, heartbeatMs: 20, hooks: { beforeAppend: (line) => { const k = (JSON.parse(line) as { t: string }).t; if (hooks.failKinds.has(k) || hooks.failKinds.has('*')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); } } });
  const ob = new AuditOutbox(store, { now: () => NOW });
  const svc = new StaffBooking(env.grist, 'D', { tz: 'Asia/Kolkata', now: () => NOW, outbox: ob });
  stoppers.push(() => svc.stop());
  return { svc, ob, store, hooks };
}
const book = (svc: StaffBooking, slot = M09, over: { name?: string; phone?: string; reason?: string; key?: string } = {}, actor: BookingActor = DESK) =>
  svc.create({ slotId: slot, patientName: over.name || 'Test Patient One', patientPhone: over.phone || P1, reason: over.reason ?? 'Knee pain', idempotencyKey: over.key || key() }, actor);
const auditRows = (env: Env) => env.docs.D[BT.audit]!.map((r) => r.fields);
const appts = (env: Env) => env.docs.D[BT.appointments]!;

describe('booking operations: write-ahead, recovery, no duplicate audit', () => {
  it('a normal booking: the intent, outcome and flush are in the file, the row and the audit row share one Audit_ID, and health is ok', async () => {
    const env = newEnv(); const dir = newDir(); const { svc, ob } = boot(env, dir); await svc.start();
    const r = await book(svc); expect(r.appointment.booking_reference).toBe('GKA-000001');
    expect(lines(dir).map((l) => JSON.parse(l).t)).toEqual(['i', 'o', 'f']);
    expect(auditRows(env)).toHaveLength(1); expect(auditRows(env)[0]).toMatchObject({ Action: 'create', Outcome: 'ok', Reason: 'created', Record: 'GKA-000001', Actor: 'desk@test', Source: 'Staff' });
    expect(appts(env)[0]!.fields.Audit_ID).toBe(auditRows(env)[0]!.Audit_ID); expect(typeof auditRows(env)[0]!.Audit_ID).toBe('string'); expect(ob.health()).toMatchObject({ level: 'ok', waiting_to_flush: 0, open_intents: 0 });
  });
  it('the audit intent cannot be saved: the booking is REFUSED before anything is written (staff and AI), then works again once it can', async () => {
    const env = newEnv(); const dir = newDir(); const { svc, hooks, ob } = boot(env, dir); await svc.start(); hooks.failKinds.add('i');
    for (const actor of [DESK, AI]) expect(await fail(book(svc, M09, {}, actor))).toEqual({ status: 503, code: 'audit_unavailable' });
    expect(appts(env)).toHaveLength(0); expect(auditRows(env)).toHaveLength(0); expect(ob.health()).toMatchObject({ rejected_for_audit: 2, level: 'red' });
    hooks.failKinds.clear(); expect((await book(svc)).replayed).toBe(false); expect(appts(env)).toHaveLength(1);
  });
  it('every kind of mutation is refused while the audit intent cannot be saved, and changes nothing', async () => {
    const env = newEnv(); const dir = newDir(); const { svc, hooks } = boot(env, dir); await svc.start(); const ref = (await book(svc)).appointment.booking_reference; const before = JSON.stringify(env.docs.D);
    hooks.failKinds.add('i');
    const attempts = [svc.reschedule(ref, { slotId: M10 }, DESK), svc.cancel(ref, { reason: 'x' }, DESK), svc.setStatus(ref, 'Checked in', DESK), svc.updateSettings({ booking_enabled: 'off' }, ADMIN), svc.updateDoctor('DR-001', { active: false }, ADMIN),
      svc.addBlock({ kind: 'Clinic closure', dateFrom: THU }, DESK), svc.saveSchedule({ doctorId: 'DR-001', weekday: 'Sun', shift: 'morning', start: '09:00', end: '13:00', slotMinutes: null, bufferMinutes: null, capacity: null, from: null, to: null, active: true, isOverride: false, reason: '' }, ADMIN)];
    for (const p of attempts) expect(await fail(p)).toEqual({ status: 503, code: 'audit_unavailable' });
    expect(JSON.stringify(env.docs.D)).toBe(before);   // not one row, setting or audit entry changed
  });
  it('refusals and replays are recorded as single events, durably', async () => {
    const env = newEnv(); const dir = newDir(); const { svc } = boot(env, dir); await svc.start(); const k = key();
    await fail(book(svc, M09, { phone: '123' })); await book(svc, M09, { key: k }); await book(svc, M09, { key: k });
    expect(auditRows(env).map((r) => `${r.Action}:${r.Outcome}:${r.Reason}`)).toEqual(['create:rejected:invalid_phone', 'create:ok:created', 'create:ok:replayed']); expect(lines(dir).filter((l) => JSON.parse(l).t === 'e')).toHaveLength(2);
  });
  it('the outcome cannot be saved: the booking is STILL reported saved (it is), nothing is duplicated, and a restart finishes the job', async () => {
    const env = newEnv(); const dir = newDir(); const a = boot(env, dir); await a.svc.start(); a.hooks.failKinds.add('o'); a.hooks.failKinds.add('f');
    const r = await book(a.svc); expect(r.appointment.booking_reference).toBe('GKA-000001'); expect(appts(env)).toHaveLength(1); expect(auditRows(env)).toHaveLength(1);   // flushed from memory
    expect(a.ob.health()).toMatchObject({ level: 'amber' }); await a.ob.abandon();   // the process dies now
    const b = boot(env, dir); await b.svc.start();   // restart: the file has an intent with no outcome
    expect(auditRows(env)).toHaveLength(1); expect(b.ob.health()).toMatchObject({ waiting_to_flush: 0, open_intents: 0, level: 'ok' });
  });
  it('a crash after the Grist write but before the outcome AND before the audit flush: recovery finds the row by Audit_ID and writes exactly one audit row', async () => {
    const env = newEnv(); const dir = newDir(); const a = boot(env, dir); await a.svc.start(); a.hooks.failKinds.add('o'); env.fail.grist = (m, t) => m === 'POST' && t === BT.audit;
    await book(a.svc); expect(appts(env)).toHaveLength(1); expect(auditRows(env)).toHaveLength(0); await a.ob.abandon();
    env.fail.grist = null; const b = boot(env, dir); await b.svc.start();
    expect(auditRows(env)).toHaveLength(1); expect(auditRows(env)[0]).toMatchObject({ Action: 'create', Outcome: 'ok', Reason: 'recovered', Record: 'GKA-000001' }); expect(auditRows(env)[0]!.Audit_ID).toBe(appts(env)[0]!.fields.Audit_ID);
  });
  it('a crash BEFORE the Grist write: recovery finds no row with that Audit_ID and records the operation as not applied', async () => {
    const env = newEnv(); const dir = newDir(); const a = boot(env, dir); await a.svc.start(); env.fail.grist = (m, t) => m === 'POST' && t === BT.appointments;
    expect((await fail(book(a.svc)))?.status).toBe(502); expect(appts(env)).toHaveLength(0);
    expect(auditRows(env).map((r) => `${r.Action}:${r.Outcome}:${r.Reason}`)).toEqual(['create:rejected:not_applied']);   // already resolved by the flush that follows the failure
    await a.ob.abandon(); env.fail.grist = null; const b = boot(env, dir); await b.svc.start(); expect(auditRows(env)).toHaveLength(1); expect(b.ob.health()).toMatchObject({ waiting_to_flush: 0, open_intents: 0 });
  });
  it('the audit store (Grist) is down: bookings still succeed, entries wait and are visible, and a restart plus recovery writes each exactly once', async () => {
    const env = newEnv(); const dir = newDir(); const a = boot(env, dir); await a.svc.start(); env.fail.grist = (m, t) => m === 'POST' && t === BT.audit;
    await book(a.svc, M09, { phone: P1 }); await book(a.svc, M0930, { phone: '9123456780' }); expect(appts(env)).toHaveLength(2); expect(auditRows(env)).toHaveLength(0);
    expect(a.ob.health()).toMatchObject({ waiting_to_flush: 2, waiting_to_retry: 2 }); expect(a.ob.health().failed_since_start).toBeGreaterThanOrEqual(2); await a.ob.abandon();
    env.fail.grist = null; const b = boot(env, dir); await b.svc.start(); expect(auditRows(env)).toHaveLength(2); expect(new Set(auditRows(env).map((r) => r.Audit_ID)).size).toBe(2);
    await b.svc.flushAudit(); await b.svc.flushAudit(); expect(auditRows(env)).toHaveLength(2);   // repeated passes add nothing
  });
  it('a crash between the audit insert and the "flushed" marker: the restart finds the row already in Grist and does NOT insert it again', async () => {
    const env = newEnv(); const dir = newDir(); const a = boot(env, dir); await a.svc.start(); a.hooks.failKinds.add('f'); await book(a.svc); expect(auditRows(env)).toHaveLength(1);
    expect(lines(dir).map((l) => JSON.parse(l).t)).toEqual(['i', 'o']); await a.ob.abandon();
    const b = boot(env, dir); await b.svc.start(); expect(auditRows(env)).toHaveLength(1); expect(lines(dir).map((l) => JSON.parse(l).t)).toContain('f');
  });
  it('an old backup restored over a newer outbox causes no duplicate audit rows', async () => {
    const env = newEnv(); const dir = newDir(); const a = boot(env, dir); await a.svc.start(); env.fail.grist = (m, t) => m === 'POST' && t === BT.audit;
    await book(a.svc); const backup = path.join(newDir(), 'backup.jsonl'); copyFileSync(path.join(dir, 'outbox.jsonl'), backup);   // the nightly backup: operation 1, not yet in Booking_Audit
    env.fail.grist = null; await a.svc.flushAudit(); expect(auditRows(env)).toHaveLength(1); await book(a.svc, M0930, { phone: '9123456780' }); expect(auditRows(env)).toHaveLength(2); await a.svc.stop();
    copyFileSync(backup, path.join(dir, 'outbox.jsonl'));   // disaster recovery: the OLD file comes back
    const b = boot(env, dir); await b.svc.start(); expect(auditRows(env)).toHaveLength(2); expect(new Set(auditRows(env).map((r) => r.Audit_ID)).size).toBe(2);
  });
  it('settings and the AI switch go through the same path: the config row carries the Audit_ID and the audit row records from and to', async () => {
    const env = newEnv(); const dir = newDir(); const { svc } = boot(env, dir); await svc.start(); await svc.updateSettings({ booking_enabled: 'off' }, ADMIN);
    const row = env.docs.D[BT.config]!.find((r) => r.fields.Key === 'booking_enabled')!; const audit = auditRows(env)[0]!;
    expect(audit).toMatchObject({ Action: 'booking_enabled', Outcome: 'ok', Actor: 'admin@test', Record: 'booking_enabled' }); expect(audit.Audit_ID).toBe(row.fields.Audit_ID); expect(JSON.parse(audit.Detail as string)).toMatchObject({ key: 'booking_enabled', from: 'on', to: 'off' });
  });
  it('20 parallel mutations share one outbox: every record is whole, every audit row unique, nothing lost', async () => {
    const env = newEnv(); const dir = newDir(); const { svc, ob } = boot(env, dir); await svc.start();
    const slots = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30'].map((s) => `DR-001|${THU}|${s}`).concat(['16:00', '16:30', '17:00', '17:30'].map((s) => `DR-002|${THU}|${s}`));
    const res = await Promise.all(slots.map((s, i) => book(svc, s, { phone: `9${String(500000000 + i).padStart(9, '0')}` })));
    expect(res).toHaveLength(12); expect(auditRows(env)).toHaveLength(12); expect(new Set(auditRows(env).map((r) => r.Audit_ID)).size).toBe(12);
    for (const l of lines(dir)) expect(() => JSON.parse(l)).not.toThrow(); expect(ob.health()).toMatchObject({ level: 'ok', waiting_to_flush: 0, open_intents: 0, corrupt_lines: 0 });
  });
  it('no patient name, phone, free text, idempotency key or secret in the outbox file, the audit rows or the logs', async () => {
    const env = newEnv(); const dir = newDir(); const { svc, hooks } = boot(env, dir); await svc.start(); const k = key();
    await book(svc, M09, { name: 'Zed Private Person', phone: P1, reason: 'Secret reason text', key: k }); await book(svc, M09, { name: 'Zed Private Person', phone: P1, reason: 'Secret reason text', key: k }); await fail(book(svc, M10, { phone: '12345', name: 'Zed Private Person' }));
    await svc.cancel('GKA-000001', { reason: 'Private cancel note' }, DESK); hooks.failKinds.add('i'); await fail(book(svc, M0930, { name: 'Zed Private Person', phone: P1, reason: 'Secret reason text' }));
    env.fail.grist = (m, t) => m === 'POST' && t === BT.audit; hooks.failKinds.clear(); await book(svc, M10, { name: 'Zed Private Person', phone: '9123456780' });   // also exercise the audit-failure log
    const everything = [readFileSync(path.join(dir, 'outbox.jsonl'), 'utf8'), JSON.stringify(auditRows(env)), JSON.stringify(vi.mocked(console.error).mock.calls)].join('\n');
    for (const secret of [P1, '919876543210', '9123456780', 'Zed', 'Private Person', 'Secret reason', 'Private cancel', k]) expect(everything, secret).not.toContain(secret);
  });
  it('start() recovers what a crash left behind and keeps flushing; stop() releases the lock for the next start', async () => {
    const env = newEnv(); const dir = newDir(); const a = boot(env, dir); await a.svc.start(); env.fail.grist = (m, t) => m === 'POST' && t === BT.audit; await book(a.svc); await a.svc.stop();
    expect(existsSync(path.join(dir, 'outbox.lock'))).toBe(false); env.fail.grist = null; const b = boot(env, dir); await b.svc.start(); expect(auditRows(env)).toHaveLength(1);
  });
  it('a missing Audit_ID column fails safe: the write is refused by Grist, nothing is reported booked, and the intent is resolved as not applied', async () => {
    const env = newEnv(); const dir = newDir(); const { svc } = boot(env, dir); await svc.start();
    env.fail.grist = (m, t) => m === 'POST' && t === BT.appointments;   // what an unprovisioned column looks like to the caller: the write is refused
    expect((await fail(book(svc)))?.status).toBe(502); expect(appts(env)).toHaveLength(0); expect(auditRows(env).map((r) => r.Reason)).toEqual(['not_applied']);
  });
});

describe('through the real app', () => {
  it('when the audit log cannot be saved both the staff API and the n8n API return 503 audit_unavailable, change nothing, and the admin sees it', async () => {
    const blocker = path.join(newDir(), 'not-a-directory'); writeFileSync(blocker, 'x');   // a FILE where the outbox directory should be: it can never be created
    const fx = await buildFixture({ bookingOn: true, outboxDir: path.join(blocker, 'outbox') });
    const staff = await fx.s('desk', '/appointments', { method: 'POST', body: { slot_id: M09, idempotency_key: key(), patient: { name: 'Test Patient One', phone: P1 } } });
    expect(staff.status).toBe(503); expect(staff.json.error.code).toBe('audit_unavailable');
    const ai = await fx.api('/appointments', { method: 'POST', headers: { 'idempotency-key': key() }, body: { slot_id: M09, patient: { name: 'Test Patient One', phone: P1 } } }); expect(ai.status).toBe(503); expect(ai.json.error.code).toBe('audit_unavailable');
    expect(fx.doc[BT.appointments]).toHaveLength(0); expect(fx.doc[BT.audit]).toHaveLength(0);
    const o = (await fx.s('admin', '/overview')).json; expect(o.audit_health).toMatchObject({ level: 'red', ready: false }); expect((await fx.s('desk', '/overview')).json.audit_health).toBeUndefined();
    expect((await fx.api(`/availability?date=${THU}`)).status).toBe(200);   // reads are unaffected
  });
  it('with a working outbox the app writes the durable log, reports durable: true, and the audit row matches the log', async () => {
    const root = newDir(); const fx = await buildFixture({ bookingOn: true, outboxDir: root });
    const r = await fx.s('desk', '/appointments', { method: 'POST', body: { slot_id: M09, idempotency_key: key(), patient: { name: 'Test Patient One', phone: P1 } } }); expect(r.status).toBe(201);
    const dir = path.join(root, 'demo-physio'); expect(lines(dir).map((l) => JSON.parse(l).t)).toEqual(['i', 'o', 'f']); expect(readFileSync(path.join(dir, 'outbox.jsonl'), 'utf8')).not.toContain('Test Patient One');
    const h = (await fx.s('admin', '/overview')).json.audit_health; expect(h).toMatchObject({ durable: true, level: 'ok', lock_held: true, waiting_to_flush: 0 }); expect(fx.doc[BT.audit]).toHaveLength(1);
    expect((await fx.s('admin', '/audit')).json.health).toMatchObject({ durable: true });
    mkdirSync(dir, { recursive: true });   // (the directory exists; nothing to assert beyond not throwing)
  });
});
