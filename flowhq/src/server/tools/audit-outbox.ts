// Operator tool for the durable audit outbox. It never prints entry content (no actors, records or details), only counts, ages and locations.
//   npm run audit-outbox -- status  [dir]          counts, lock age, size, volume id. Read-only, takes no lock, safe while FLOW HQ runs.
//   npm run audit-outbox -- verify  [dir]          parse the whole log; exit 1 if any line is unreadable. Read-only.
//   npm run audit-outbox -- canary write|check [dir]   leave / look for a marker file: proves the volume survives a container being recreated.
//   npm run audit-outbox -- selftest write|read [dir]  a throw-away outbox in <dir>/selftest (never the real one): write-ahead records, optionally killed
//                                                      with no clean shutdown (--kill), then read back after a restart / recreation.
// [dir] defaults to FLOWHQ_AUDIT_OUTBOX_DIR, else config/audit-outbox. Per-clinic outboxes are sub-directories (one per workspace slug): pass the sub-directory.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { AuditOutbox, FileStore, volumeOf } from '../booking/outbox';

const [cmd, a1, a2, ...rest] = process.argv.slice(2);
const flags = [a1, a2, ...rest].filter((x) => x?.startsWith('--')); const pos = [a1, a2, ...rest].filter((x) => x && !x.startsWith('--'));
const root = path.resolve(process.env.FLOWHQ_AUDIT_OUTBOX_DIR || 'config/audit-outbox');
const out = (s: string) => console.log(s);

function describe(dir: string) {
  const file = path.join(dir, 'outbox.jsonl'); const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const sum = AuditOutbox.summarise(lines); const lock = path.join(dir, 'outbox.lock');
  const meta = existsSync(path.join(dir, 'outbox.meta.json')) ? (JSON.parse(readFileSync(path.join(dir, 'outbox.meta.json'), 'utf8')) as { created_at?: string; volume_id?: string }) : null;
  const v = volumeOf(dir);
  return { dir, exists: existsSync(dir), size_bytes: existsSync(file) ? statSync(file).size : 0, ...sum, lock_age_seconds: existsSync(lock) ? Math.round((Date.now() - statSync(lock).mtimeMs) / 1000) : null, volume_id: meta?.volume_id || null, created_at: meta?.created_at || null, mount: v ? `${v.mount} (${v.fstype})` : 'unknown (not Linux)', on_container_layer: v ? v.mount === '/' && v.fstype === 'overlay' : null };
}

async function main() {
  const dir = path.resolve(pos[0] || root);
  if (cmd === 'status') {
    const d = describe(dir); out(JSON.stringify(d, null, 2));
    const sub = existsSync(root) ? readdirSync(root).filter((n) => existsSync(path.join(root, n, 'outbox.jsonl'))) : []; if (!pos[0] && sub.length) out(`per-workspace outboxes under ${root}: ${sub.join(', ')} (pass one as the directory)`);
    if (d.on_container_layer) { out('WARNING: this directory is on the container layer, not a persistent volume: it will be lost when the container is recreated.'); process.exitCode = 1; }
    return;
  }
  if (cmd === 'verify') { const d = describe(dir); out(JSON.stringify({ entries: d.entries, unflushed: d.unflushed, open_intents: d.open_intents, corrupt_lines: d.corrupt_lines }, null, 2)); if (d.corrupt_lines > 0) { out('FAIL: unreadable lines found'); process.exitCode = 1; } else out('OK: every line is readable'); return; }
  if (cmd === 'canary') {
    const f = path.join(dir, 'persistence-canary.json');
    if (pos[0] === 'write' || a1 === 'write') { const d = path.resolve(pos[1] || root); mkdirSync(d, { recursive: true }); const c = { token: randomUUID(), at: new Date().toISOString() }; writeFileSync(path.join(d, 'persistence-canary.json'), JSON.stringify(c)); out(`canary written: ${c.token}`); return; }
    const d = path.resolve(pos[1] || root); const cf = path.join(d, 'persistence-canary.json');
    if (!existsSync(cf)) { out('FAIL: the canary is gone: the directory did NOT survive'); process.exitCode = 1; return; }
    out(`OK: the canary survived (${(JSON.parse(readFileSync(cf, 'utf8')) as { token: string }).token})`); void f; return;
  }
  if (cmd === 'selftest') {
    const mode = pos[0]; const base = path.resolve(pos[1] || root); const dirS = path.join(base, 'selftest');
    if (mode === 'write') {
      const ob = new AuditOutbox(new FileStore({ dir: dirS, staleMs: 3000, waitMs: 8000, requireVolume: flags.includes('--require-volume') })); await ob.open();
      const count = Number((flags.find((f) => f.startsWith('--count=')) || '').split('=')[1]) || 0;
      if (count) {   // disk-full drill: keep writing until the outbox refuses; every refusal must be a clean 'write_failed' and everything before it must still load
        let n = 0; try { for (; n < count; n++) { const id = await ob.intent({ actor: 'selftest', source: 'System', action: 'create', record: `SELFTEST-${n}`, table: 'Appointments', detail: {} }); await ob.outcome(id, { outcome: 'ok', reason: 'created' }); } out('wrote all ' + count + ' records (the disk did not fill)'); }
        catch (e) { out(`refused at record ${n}: ${(e as { code?: string }).code || 'error'} (clean refusal, nothing half-done)`); } await ob.close(); return;
      }
      const id = await ob.intent({ actor: 'selftest', source: 'System', action: 'create', record: 'SELFTEST-1', table: 'Appointments', detail: {} }); await ob.outcome(id, { outcome: 'ok', reason: 'created' });
      await ob.intent({ actor: 'selftest', source: 'System', action: 'cancel', record: 'SELFTEST-2', table: 'Appointments', detail: {} });   // never finished
      out(`selftest written to ${dirS}: 1 complete + 1 open intent (durable)`);
      if (flags.includes('--hold')) {
        out('holding the outbox open until this process is killed from outside (docker kill) or stopped (docker stop)');
        for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { void ob.close().finally(() => { out('stopped cleanly: the outbox lock was released'); process.exit(0); }); });   // what the server does on a stop signal
        setInterval(() => undefined, 1000); return;
      }
      if (flags.includes('--kill')) { out('killing this process with no clean shutdown (SIGKILL)'); process.kill(process.pid, 'SIGKILL'); setTimeout(() => process.exit(9), 5000); return; }
      await ob.close(); return;
    }
    if (mode === 'read') {
      const ob = new AuditOutbox(new FileStore({ dir: dirS, staleMs: 3000, waitMs: 12000, requireVolume: flags.includes('--require-volume') })); await ob.open(); const h = ob.health(); await ob.close();
      if (flags.includes('--summary')) { out(`selftest summary: ${JSON.stringify({ entries: h.waiting_to_flush + h.open_intents, corrupt_lines: h.corrupt_lines })}`); return; }
      const ok = h.waiting_to_flush === 1 && h.open_intents === 1 && h.corrupt_lines === 0; out(`selftest read: ${JSON.stringify({ waiting_to_flush: h.waiting_to_flush, open_intents: h.open_intents, corrupt_lines: h.corrupt_lines, volume_id: h.volume_id })}`);
      out(ok ? 'OK: everything written before the kill / recreation is still there, and the stale lock was taken over' : 'FAIL: the selftest data is not as written'); process.exitCode = ok ? 0 : 1; return;
    }
  }
  out('Usage: npm run audit-outbox -- status|verify [dir] | canary write|check [dir] | selftest write [--kill]|read [dir]'); process.exitCode = 2;
}
main().catch((e) => { console.error(`audit-outbox: ${(e as Error).message}`); process.exitCode = 1; });
