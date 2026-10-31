// The PRODUCTION IMAGE (flowhq/Dockerfile, built as REAL_IMAGE) run as a container against the throwaway staging Grist: that it boots as production does (NODE_ENV=production, user `node`),
// refuses an audit outbox on the container's own layer, keeps the outbox on a named volume across container re-creation, and stops cleanly on `docker stop` (SIGTERM as PID 1, exit 0).
// Needs the Docker CLI, REAL_IMAGE (the built image name) and the staging Grist on the Docker network REAL_DOCKER_NETWORK (default gkp-staging) reachable as REAL_GRIST_INTERNAL_URL
// (default http://gkp-staging-grist:8484). Skipped otherwise. Synthetic data only.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { newToken } from '../../src/server/booking/tokens';
import { hashPassword } from '../../src/server/auth';
import { PW, REAL_ENABLED, createStaging, deleteStaging, futureDay, slotId, type Staging } from './harness';

const IMAGE = process.env.REAL_IMAGE || ''; const NET = process.env.REAL_DOCKER_NETWORK || 'gkp-staging'; const INTERNAL = process.env.REAL_GRIST_INTERNAL_URL || 'http://gkp-staging-grist:8484';
const d = describe.skipIf(!REAL_ENABLED || !IMAGE);
const docker = (...a: string[]) => execFileSync('docker', a, { stdio: 'pipe', encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = futureDay(4);

d('the production image', () => {
  let s: Staging; const names: string[] = []; const volumes: string[] = [];
  afterAll(async () => { for (const n of names) { try { docker('rm', '-f', n); } catch { /* gone */ } } for (const v of volumes) { try { docker('volume', 'rm', '-f', v); } catch { /* gone */ } } if (s) await deleteStaging(s).catch(() => undefined); });

  const run = async (name: string, o: { volume?: string; tokenRec: ReturnType<typeof newToken>['record']; port: number; env?: Record<string, string> }) => {
    names.push(name);
    const key = readFileSync(process.env.REAL_GRIST_KEY_FILE!, 'utf8').trim();
    const users = JSON.stringify([{ email: 'admin@test', name: 'Owner', role: 'admin', workspaces: ['*'], passwordHash: hashPassword(PW) }]);
    const args = ['run', '-d', '--name', name, '--network', NET, '-p', `127.0.0.1:${o.port}:8787`, '-e', `GRIST_BASE_URL=${INTERNAL}`, '-e', `GRIST_API_KEY=${key}`, '-e', `GRIST_REGISTRY_DOC_ID=${s.registryDocId}`,
      '-e', 'FLOWHQ_SESSION_SECRET=image-test-session-secret-0123456789abcdef', '-e', `FLOWHQ_USERS=${users}`, '-e', `FLOWHQ_BOOKING_TOKENS=${JSON.stringify([o.tokenRec])}`, '-e', 'FLOWHQ_SECURE_COOKIES=false', '-e', 'FLOWHQ_TRUST_PROXY=false',
      ...Object.entries(o.env || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]), ...(o.volume ? ['-v', `${o.volume}:/app/flowhq/config`] : []), IMAGE];
    docker(...args);
    const base = `http://127.0.0.1:${o.port}`;
    for (let i = 0; i < 100; i++) { try { const r = await fetch(`${base}/api/health`); if (r.status < 500) return base; } catch { /* starting */ } await sleep(300); }
    throw new Error(`container did not start: ${docker('logs', name).slice(-500)}`);
  };
  const book = async (base: string, token: string, key: string, time: string) => { const r = await fetch(`${base}/api/booking/appointments`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ slot_id: slotId('DR-001', DAY, time), patient: { name: 'Image Patient', phone: '9000050001' } }) }); return { status: r.status, json: (await r.json()) as any }; };
  const login = async (base: string) => { const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-flowhq-csrf': '1' }, body: JSON.stringify({ email: 'admin@test', password: PW }) }); return r.headers.get('set-cookie')!.split(';')[0]!; };
  const health = async (base: string) => { const c = await login(base); const r = await fetch(`${base}/api/w/${s.slug}/schedule/overview`, { headers: { cookie: c, 'x-flowhq-csrf': '1' } }); return ((await r.json()) as any).audit_health; };

  it('boots as production does: non-root user, NODE_ENV=production, volume required by default; with a named volume bookings work and the outbox is on the volume', async () => {
    s = await createStaging('image-physio', { bookingOn: true }); const tok = newToken('n8n-image', s.slug); const vol = `gkp-image-vol-${Date.now().toString(36)}`; volumes.push(vol);
    const base = await run('gkp-image-a', { volume: vol, tokenRec: tok.record, port: 18787 });
    expect(docker('exec', 'gkp-image-a', 'id', '-un')).toBe('node'); expect(docker('exec', 'gkp-image-a', 'printenv', 'NODE_ENV')).toBe('production'); expect(docker('exec', 'gkp-image-a', 'printenv', 'FLOWHQ_AUDIT_REQUIRE_VOLUME')).toBe('true');
    const r = await book(base, tok.token, 'image-key-0001-abcd', '09:00'); expect(r.status, JSON.stringify(r.json)).toBe(201);
    for (let i = 0; i < 20; i++) { const h = await health(base); if (h.waiting_to_flush === 0 && h.open_intents === 0) break; await sleep(1000); }
    const h = await health(base); expect(h).toMatchObject({ durable: true, persistent_volume: 'yes', lock_held: true, level: 'ok' });
    expect(docker('exec', 'gkp-image-a', 'sh', '-c', `ls /app/flowhq/config/audit-outbox/${s.slug}`)).toContain('outbox.jsonl');
    (globalThis as any).__imageState = { tok, vol, volumeId: h.volume_id, created: h.created_at, ref: r.json.appointment.booking_reference };
  }, 240000);

  it('`docker stop` (SIGTERM to PID 1) exits cleanly with code 0 well inside the 30 s grace period, and releases the outbox lock', async () => {
    const t0 = Date.now(); docker('stop', '-t', '30', 'gkp-image-a'); const took = Date.now() - t0;
    expect(docker('inspect', '-f', '{{.State.ExitCode}}', 'gkp-image-a')).toBe('0'); expect(took).toBeLessThan(15000);
    const lock = docker('run', '--rm', '-v', `${(globalThis as any).__imageState.vol}:/c:ro`, 'node:20-alpine', 'sh', '-c', `ls /c/audit-outbox/${s.slug}`);
    expect(lock).not.toContain('outbox.lock');   // a clean stop removes the lock, so the next container starts at once
  }, 120000);

  it('RE-CREATING the container on the same volume keeps everything: same outbox identity, the earlier idempotency key replays, the audit entry is in Grist exactly once', async () => {
    const st = (globalThis as any).__imageState; docker('rm', '-f', 'gkp-image-a');
    const base = await run('gkp-image-b', { volume: st.vol, tokenRec: st.tok.record, port: 18788 });
    const t0 = Date.now(); const h = await health(base); expect(h.volume_id).toBe(st.volumeId); expect(h.created_at).toBe(st.created); expect(Date.now() - t0).toBeLessThan(10000);   // no stale-lock wait after a clean stop
    const again = await book(base, st.tok.token, 'image-key-0001-abcd', '09:00'); expect(again.status).toBe(200); expect(again.json.replayed).toBe(true); expect(again.json.appointment.booking_reference).toBe(st.ref);
    for (let i = 0; i < 20; i++) { const x = await health(base); if (x.waiting_to_flush === 0 && x.open_intents === 0) break; await sleep(1000); }
    const audit = await s.client.records(s.clinicDocId, 'Booking_Audit'); const ids = audit.map((r) => r.fields.Audit_ID); expect(new Set(ids).size).toBe(ids.length);
    docker('stop', '-t', '30', 'gkp-image-b');
  }, 240000);

  it('the OPERATOR TOOLS run inside the image: provision-booking (dry run, apply, seed, second run = nothing) on a clinic document that has no booking tables, and booking-token (token shown once, only a hash stored on the volume)', async () => {
    const fresh = await createStaging('image-prov', { provision: false });
    try {
      const key = readFileSync(process.env.REAL_GRIST_KEY_FILE!, 'utf8').trim(); const vol = `gkp-image-tools-${Date.now().toString(36)}`; volumes.push(vol);
      const tool = (name: string, ...a: string[]) => { const r = spawnSync('docker', ['run', '--rm', '--network', NET, '-v', `${vol}:/app/flowhq/config`, '-e', `GRIST_BASE_URL=${INTERNAL}`, '-e', `GRIST_API_KEY=${key}`, '-e', `GRIST_REGISTRY_DOC_ID=${fresh.registryDocId}`, '-e', 'FLOWHQ_AUDIT_REQUIRE_VOLUME=false', IMAGE, 'node', `dist/tools/${name}.mjs`, ...a], { encoding: 'utf8' }); return { code: r.status, out: `${r.stdout}${r.stderr}` }; };
      expect(await fresh.client.tableIds(fresh.clinicDocId)).not.toContain('Doctors');
      const dry = tool('provision-booking', fresh.slug); expect(dry.code, dry.out).toBe(0); expect(dry.out).toMatch(/Dry run|would/i); expect(await fresh.client.tableIds(fresh.clinicDocId), 'a dry run changes nothing').not.toContain('Doctors');
      const apply = tool('provision-booking', fresh.slug, '--apply', '--seed'); expect(apply.code, apply.out).toBe(0);
      expect(await fresh.client.tableIds(fresh.clinicDocId)).toEqual(expect.arrayContaining(['Doctors', 'Doctor_Schedules', 'Booking_Config', 'Closures_Blocks', 'Booking_Audit', 'Reminder_Consent', 'Reminder_Consent_Log']));
      const cfg = await fresh.client.records(fresh.clinicDocId, 'Booking_Config'); expect(cfg.find((r) => r.fields.Key === 'booking_enabled')?.fields.Value, 'AI booking is OFF after provisioning').toBe('off');
      expect((await fresh.client.records(fresh.clinicDocId, 'Doctors')).map((r) => r.fields.Doctor_ID)).toEqual(['DR-001', 'DR-002']);
      const again = tool('provision-booking', fresh.slug, '--apply', '--seed'); expect(again.code, again.out).toBe(0); expect((await fresh.client.records(fresh.clinicDocId, 'Doctors')).length, 'a second run seeds nothing').toBe(2);
      const t = tool('booking-token', 'n8n-image-tool', fresh.slug, '--days', '90', '--write'); expect(t.code, t.out).toBe(0);
      const shown = t.out.match(/n8n-image-tool\.[A-Za-z0-9_-]{30,}/)?.[0]; expect(shown, 'the token is printed once').toBeTruthy();
      const file = docker('run', '--rm', '-v', `${vol}:/c:ro`, 'node:20-alpine', 'cat', '/c/booking-tokens.json'); expect(file).not.toContain(shown!.split('.')[1]!); expect(file).toContain('sha256$'); expect(file).toContain('n8n-image-tool');
      expect(docker('run', '--rm', '-v', `${vol}:/c:ro`, 'node:20-alpine', 'stat', '-c', '%a', '/c/booking-tokens.json'), 'the token file is owner-only').toBe('600');
      expect(tool('booking-token', 'n8n-image-tool', fresh.slug, '--days', '90', '--write').code, 'a duplicate id is refused').toBe(1);
      const rv = tool('booking-token', 'revoke', 'n8n-image-tool'); expect(rv.code, rv.out).toBe(0);
      expect(docker('run', '--rm', '-v', `${vol}:/c:ro`, 'node:20-alpine', 'cat', '/c/booking-tokens.json')).toContain('"revoked": true');
    } finally { await deleteStaging(fresh).catch(() => undefined); }
  }, 300000);

  it('WITHOUT a volume the container refuses the outbox (it would be lost on re-creation): bookings are refused 503 audit_unavailable, nothing is written to Grist, and admins are told', async () => {
    const tok = newToken('n8n-image2', s.slug); const before = (await s.client.records(s.clinicDocId, 'Appointments')).length;
    const base = await run('gkp-image-c', { tokenRec: tok.record, port: 18789 });
    await sleep(2500);
    const r = await book(base, tok.token, 'image-key-0002-abcd', '09:30'); expect(r.status, JSON.stringify(r.json)).toBe(503); expect(r.json.error.code).toBe('audit_unavailable');
    expect((await s.client.records(s.clinicDocId, 'Appointments')).length).toBe(before);
    const h = await health(base); expect(h.level).toBe('red'); expect(h.reasons.join(' ')).toMatch(/container's own layer|persistent volume/i);
    const lg = spawnSync('docker', ['logs', 'gkp-image-c'], { encoding: 'utf8' }); const logs = `${lg.stdout}${lg.stderr}`;   // the server logs this on stderr
    expect(logs).toMatch(/FLOW HQ AUDIT OUTBOX: not available \(.*container's own layer.*\); bookings are refused until it is/);
  }, 240000);
});
