// The durable audit outbox: a write-ahead log for booking mutations, so the audit trail survives restarts, crashes and a Grist outage.
//
//   intent   written + fsynced BEFORE any booking mutation. If it cannot be saved, the mutation is refused before anything is written.
//   outcome  written after the mutation was verified (ok) or failed (rejected). If THIS cannot be saved the booking is still reported as saved
//            (it is); the entry stays pending and recovery finalises it from the Audit_ID stored on the row itself.
//   flushed  written after the entry was inserted into Booking_Audit (idempotent by Audit_ID) and read back.
//
// Storage is an append-only JSON-lines file on the persistent volume (FileStore). A MemoryStore (tests, demo) has the same behaviour but is NOT durable.
// No patient name, phone, free text, idempotency key or secret is ever written here, to the logs, or into an alert: entries hold ids, action,
// outcome, a reason code and non-personal detail only.
import { randomUUID } from 'node:crypto';
import { promises as fsp, readFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class OutboxUnavailable extends Error { constructor(message: string, public code: 'unavailable' | 'locked' | 'not_persistent' | 'write_failed' = 'unavailable') { super(message); } }

export type Outcome = 'ok' | 'rejected' | 'aborted';
export interface Entry {
  id: string; seq: number; at: number; actor: string; source: string; action: string; record: string; table: string; detail: Record<string, unknown>;
  hasIntent: boolean; outcome?: { at: number; outcome: Outcome; reason: string; record?: string; detail?: Record<string, unknown> };
  flushed: boolean; suspect: boolean; inflight: boolean; volatile: boolean; outcomeUnsaved?: boolean;
}
export interface IntentInput { actor: string; source: string; action: string; record: string; table: string; detail: Record<string, unknown> }

// ---------------------------------------------------------------- stores
export interface StoreInfo { durable: boolean; location: string; created_at: string | null; volume_id: string | null; lock_held: boolean; persistent_volume: 'yes' | 'no' | 'unchecked'; mount?: string }
export interface OutboxStore {
  readonly durable: boolean;
  open(): Promise<{ lines: string[] }>;
  append(line: string): Promise<void>;
  rewrite(lines: string[]): Promise<void>;
  size(): number;
  abandon?(): Promise<void>;   // tests: behave as if the process had been killed (no clean shutdown, lock left behind)
  lockHeld(): boolean;
  info(): StoreInfo;
  close(): Promise<void>;
}

/** Volatile (tests, demo mode). Same behaviour as the file store, but nothing survives a restart; health says `durable: false`. */
export class MemoryStore implements OutboxStore {
  readonly durable = false; lines: string[] = []; failAppend: string | null = null;
  async open() { return { lines: [...this.lines] }; }
  async append(line: string) { if (this.failAppend) throw new Error(this.failAppend); this.lines.push(line); }
  async rewrite(lines: string[]) { this.lines = [...lines]; }
  size() { return this.lines.reduce((n, l) => n + l.length + 1, 0); }
  lockHeld() { return true; }
  info(): StoreInfo { return { durable: false, location: 'memory', created_at: null, volume_id: null, lock_held: true, persistent_volume: 'unchecked' }; }
  async close() { /* nothing */ }
}

export interface FileStoreOptions {
  dir: string;
  staleMs?: number;            // a lock whose heartbeat is older than this belongs to a dead process (default 20 s)
  waitMs?: number;             // how long start-up waits for a recent lock to clear (default 30 s; covers a container being replaced)
  heartbeatMs?: number;        // default staleMs / 4
  requireVolume?: boolean;     // refuse to run if the directory is on the container's own (ephemeral) layer
  mountinfo?: () => string | null;   // tests: a fake /proc/self/mountinfo
  mountCheckPath?: string;           // tests: the path the container would see (the real directory may be a Windows path)
  hooks?: { beforeAppend?: (line: string) => void | Promise<void> };   // tests: simulate a full or read-only disk
  now?: () => number;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Which mount holds `dir`? Linux only (/proc/self/mountinfo). In a container, the root `overlay` mount is the container's own writable layer: lost on recreation. */
export function volumeOf(dir: string, mountinfo?: string | null): { mount: string; fstype: string } | null {
  let text = mountinfo; if (text === undefined) { try { text = readFileSync('/proc/self/mountinfo', 'utf8'); } catch { return null; } }
  if (!text) return null;
  const abs = dir.startsWith('/') ? path.posix.resolve(dir) : path.resolve(dir).split(path.sep).join('/'); let best: { mount: string; fstype: string } | null = null;
  for (const line of text.split('\n')) {
    const p = line.split(' '); const dash = p.indexOf('-'); if (dash < 0 || p.length < dash + 3) continue;
    const mount = (p[4] || '').replace(/\\040/g, ' '); const fstype = p[dash + 1] || '';
    if ((abs === mount || abs.startsWith(mount.endsWith('/') ? mount : `${mount}/`)) && (!best || mount.length > best.mount.length)) best = { mount, fstype };
  }
  return best;
}

export class FileStore implements OutboxStore {
  readonly durable = true;
  private handle: FileHandle | null = null; private chain: Promise<unknown> = Promise.resolve(); private held = false; private instance = randomUUID();
  private beat: ReturnType<typeof setInterval> | null = null; private bytes = 0; private meta: { created_at: string; volume_id: string } | null = null; private vol: StoreInfo['persistent_volume'] = 'unchecked'; private mount = '';
  constructor(private o: FileStoreOptions) {}
  private get dir() { return this.o.dir; }
  private p(name: string) { return path.join(this.dir, name); }
  private now() { return this.o.now ? this.o.now() : Date.now(); }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const r = this.chain.then(fn, fn); this.chain = r.catch(() => undefined); return r; }

  async open(): Promise<{ lines: string[] }> {
    try { await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 }); await fsp.chmod(this.dir, 0o700).catch(() => undefined); }
    catch (e) { throw new OutboxUnavailable(`cannot create the audit outbox directory: ${(e as NodeJS.ErrnoException).code || 'error'}`, 'write_failed'); }
    const v = volumeOf(this.o.mountCheckPath || this.dir, this.o.mountinfo ? this.o.mountinfo() : undefined);
    if (v) { this.mount = `${v.mount} (${v.fstype})`; this.vol = v.mount === '/' && v.fstype === 'overlay' ? 'no' : 'yes'; } else this.vol = 'unchecked';
    if (this.vol === 'no' && this.o.requireVolume) throw new OutboxUnavailable('the audit outbox directory is on the container\'s own layer, which is lost when the container is recreated: mount a persistent volume there', 'not_persistent');
    await this.acquireLock();
    try {
      try { this.meta = JSON.parse(await fsp.readFile(this.p('outbox.meta.json'), 'utf8')); } catch { /* first run */ }
      if (!this.meta?.volume_id) { this.meta = { created_at: new Date(this.now()).toISOString(), volume_id: randomUUID() }; await fsp.writeFile(this.p('outbox.meta.json'), JSON.stringify(this.meta), { mode: 0o600 }); }
      let text = ''; try { text = await fsp.readFile(this.p('outbox.jsonl'), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      this.bytes = Buffer.byteLength(text);
      this.handle = await fsp.open(this.p('outbox.jsonl'), 'a', 0o600);
      if (text && !text.endsWith('\n')) { await this.handle.write('\n'); await this.handle.sync(); this.bytes += 1; }   // seal a half-written last line so the next record starts clean
      return { lines: text.split('\n').filter((l) => l.length > 0) };
    } catch (e) { await this.releaseLock(); if (e instanceof OutboxUnavailable) throw e; throw new OutboxUnavailable(`cannot open the audit outbox: ${(e as NodeJS.ErrnoException).code || 'error'}`, 'write_failed'); }
  }

  private async acquireLock() {
    const staleMs = this.o.staleMs ?? 20000; const deadline = this.now() + (this.o.waitMs ?? 30000);
    for (;;) {
      try {
        const fh = await fsp.open(this.p('outbox.lock'), 'wx', 0o600);
        await fh.writeFile(JSON.stringify({ instance: this.instance, host: os.hostname(), pid: process.pid, at: new Date(this.now()).toISOString() })); await fh.sync(); await fh.close();
        this.held = true; this.startBeat(staleMs); return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new OutboxUnavailable(`cannot lock the audit outbox: ${(e as NodeJS.ErrnoException).code || 'error'}`, 'write_failed');
        const st = await fsp.stat(this.p('outbox.lock')).catch(() => null); if (!st) continue;
        if (Date.now() - st.mtimeMs > staleMs) { await fsp.rm(this.p('outbox.lock'), { force: true }).catch(() => undefined); continue; }   // its heartbeat stopped: that process is gone
        if (this.now() >= deadline) throw new OutboxUnavailable('another FLOW HQ process is using this audit outbox (its lock is recent). Only one instance may run.', 'locked');
        await sleep(Math.min(250, Math.max(10, Math.floor(staleMs / 4))));
      }
    }
  }
  private startBeat(staleMs: number) {
    this.beat = setInterval(() => {
      void (async () => {
        try { const cur = JSON.parse(await fsp.readFile(this.p('outbox.lock'), 'utf8')) as { instance?: string }; if (cur.instance !== this.instance) { this.held = false; return; } const t = new Date(); await fsp.utimes(this.p('outbox.lock'), t, t); }
        catch { this.held = false; }   // lock file gone or unreadable: do not pretend to hold it
      })();
    }, this.o.heartbeatMs ?? Math.max(10, Math.floor(staleMs / 4)));
    this.beat.unref?.();
  }
  private async releaseLock() {
    if (this.beat) { clearInterval(this.beat); this.beat = null; }
    if (this.held) { try { const cur = JSON.parse(await fsp.readFile(this.p('outbox.lock'), 'utf8')) as { instance?: string }; if (cur.instance === this.instance) await fsp.rm(this.p('outbox.lock'), { force: true }); } catch { /* already gone */ } }
    this.held = false;
  }

  append(line: string): Promise<void> {
    return this.serial(async () => {
      if (!this.held) throw new OutboxUnavailable('this process no longer holds the audit outbox lock', 'locked');
      try {
        await this.o.hooks?.beforeAppend?.(line);
        if (!this.handle) this.handle = await fsp.open(this.p('outbox.jsonl'), 'a', 0o600);
        const data = `${line}\n`; await this.handle.write(data); await this.handle.sync(); this.bytes += Buffer.byteLength(data);   // durable before we return
      } catch (e) {
        if (this.handle) { await this.handle.close().catch(() => undefined); this.handle = null; }   // reopen on the next try
        throw new OutboxUnavailable(`the audit outbox could not be written: ${(e as NodeJS.ErrnoException).code || (e as Error).message}`.slice(0, 160), 'write_failed');
      }
    });
  }
  rewrite(lines: string[]): Promise<void> {   // atomic: temp file + fsync + rename; unflushed entries are always carried over by the caller
    return this.serial(async () => {
      const tmp = this.p('outbox.jsonl.tmp'); const data = lines.map((l) => `${l}\n`).join('');
      const fh = await fsp.open(tmp, 'w', 0o600); try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
      if (this.handle) { await this.handle.close().catch(() => undefined); this.handle = null; }
      await fsp.rename(tmp, this.p('outbox.jsonl')); this.handle = await fsp.open(this.p('outbox.jsonl'), 'a', 0o600); this.bytes = Buffer.byteLength(data);
    });
  }
  size() { return this.bytes; }
  async abandon() { if (this.beat) { clearInterval(this.beat); this.beat = null; } this.held = false; if (this.handle) { await this.handle.close().catch(() => undefined); this.handle = null; } }   // like kill -9: the lock file stays behind
  lockHeld() { return this.held; }
  info(): StoreInfo { return { durable: true, location: path.resolve(this.dir), created_at: this.meta?.created_at || null, volume_id: this.meta?.volume_id || null, lock_held: this.held, persistent_volume: this.vol, ...(this.mount ? { mount: this.mount } : {}) }; }
  async close() { await this.chain.catch(() => undefined); if (this.handle) { await this.handle.close().catch(() => undefined); this.handle = null; } await this.releaseLock(); }
}

// ---------------------------------------------------------------- the outbox
export interface OutboxOptions { now?: () => number; breakGlass?: boolean; compactAtBytes?: number; amberWaiting?: number; redWaiting?: number; amberAgeSec?: number; redAgeSec?: number }
export interface OutboxHealth {
  durable: boolean; location: string; level: 'ok' | 'amber' | 'red'; reasons: string[]; ready: boolean; lock_held: boolean; persistent_volume: StoreInfo['persistent_volume']; created_at: string | null; volume_id: string | null;
  waiting_to_flush: number; open_intents: number; unsaved_outcomes: number; oldest_waiting_age_sec: number | null; failed_since_start: number; waiting_to_retry: number; last_failure_at: string | null; last_error: string | null;
  rejected_for_audit: number; corrupt_lines: number; break_glass: boolean; break_glass_uses: number;
}

export class AuditOutbox {
  private entries = new Map<string, Entry>(); private seq = 0; private opening: Promise<void> | null = null; private openedAt = 0; private openError: OutboxUnavailable | null = null; private ready = false;
  private persistFailures = 0; private flushFailures = 0; private rejected = 0; private corrupt = 0; private lastError: string | null = null; private lastErrorAt: number | null = null; private bgUses = 0;
  constructor(private store: OutboxStore, private o: OutboxOptions = {}) {}
  private now() { return this.o.now ? this.o.now() : Date.now(); }
  private sec() { return Math.floor(this.now() / 1000); }
  get durable() { return this.store.durable; }

  /** Opens the store and rebuilds state from the log. Safe to call repeatedly; a failed open is retried (after a short pause) on the next call. */
  open(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.opening) return this.opening;
    if (this.openError && Date.now() - this.openedAt < 2000) return Promise.reject(this.openError);
    this.opening = (async () => {
      try { const { lines } = await this.store.open(); this.load(lines); this.ready = true; this.openError = null; if (this.corrupt) console.error(`FLOW HQ AUDIT OUTBOX: ${this.corrupt} unreadable line(s) skipped while loading (counts only; see npm run audit-outbox -- verify)`); }
      catch (e) { this.openError = e instanceof OutboxUnavailable ? e : new OutboxUnavailable((e as Error).message); this.note(this.openError.message); throw this.openError; }
      finally { this.openedAt = Date.now(); this.opening = null; }
    })();
    return this.opening;
  }
  async close() { await this.store.close(); this.ready = false; }
  async abandon() { await this.store.abandon?.(); this.ready = false; }

  private load(lines: string[]) {
    this.entries.clear(); this.seq = 0; this.corrupt = 0;
    for (const raw of lines) {
      let r: Record<string, unknown>; try { r = JSON.parse(raw) as Record<string, unknown>; if (!r || typeof r !== 'object' || typeof r.t !== 'string') throw new Error('shape'); } catch { this.corrupt++; continue; }
      const id = String(r.id || '');
      if (r.t === 'i' || r.t === 'e') {
        if (!id) { this.corrupt++; continue; }
        const e: Entry = { id, seq: Number(r.seq) || 0, at: Number(r.at) || 0, actor: String(r.actor || ''), source: String(r.source || ''), action: String(r.action || ''), record: String(r.record || ''), table: String(r.table || ''), detail: (r.detail as Record<string, unknown>) || {}, hasIntent: r.t === 'i', flushed: false, suspect: true, inflight: false, volatile: false };
        if (r.t === 'e') e.outcome = { at: e.at, outcome: (r.outcome as Outcome) || 'ok', reason: String(r.reason || ''), ...(r.detail ? { detail: r.detail as Record<string, unknown> } : {}) };
        this.entries.set(id, e); this.seq = Math.max(this.seq, e.seq);
      } else if (r.t === 'o') {
        const e = this.entries.get(id); if (!e) { this.corrupt++; continue; }
        e.outcome = { at: Number(r.at) || 0, outcome: (r.outcome as Outcome) || 'ok', reason: String(r.reason || ''), ...(r.record ? { record: String(r.record) } : {}), ...(r.detail ? { detail: r.detail as Record<string, unknown> } : {}) };
      } else if (r.t === 'f') { for (const x of Array.isArray(r.ids) ? r.ids : []) { const e = this.entries.get(String(x)); if (e) e.flushed = true; } }
      else this.corrupt++;   // valid JSON of a kind we never write
    }
    this.seq += 1;
    for (const e of this.entries.values()) if (e.flushed) e.suspect = false;   // everything not marked flushed is suspect: it may or may not have reached Grist before a crash
  }

  private note(msg: string) { this.lastError = msg.slice(0, 200); this.lastErrorAt = this.sec(); }
  private async persist(rec: Record<string, unknown>) { await this.store.append(JSON.stringify(rec)); }

  /** Write-ahead intent. Throws OutboxUnavailable if it cannot be saved: the caller must then NOT mutate anything. */
  async intent(i: IntentInput): Promise<string> {
    try { await this.open(); } catch (e) { this.rejected++; throw e; }
    const id = randomUUID(); const e: Entry = { id, seq: this.seq++, at: this.sec(), ...i, hasIntent: true, flushed: false, suspect: false, inflight: true, volatile: false };
    try { await this.persist({ t: 'i', id, seq: e.seq, at: e.at, actor: e.actor, source: e.source, action: e.action, record: e.record, table: e.table, detail: e.detail }); }
    catch (err) {
      this.note((err as Error).message);
      if (!this.o.breakGlass) { this.rejected++; throw err instanceof OutboxUnavailable ? err : new OutboxUnavailable((err as Error).message, 'write_failed'); }
      e.volatile = true; this.bgUses++; console.error('FLOW HQ AUDIT OUTBOX: BREAK-GLASS in use: this operation is audited from memory only (not restart-safe)');
    }
    this.entries.set(id, e); return id;
  }
  /** The operation finished (verified, or failed). Never throws: a saved booking is never reported failed because of audit. Returns false if the outcome could not be saved yet. */
  async outcome(id: string, o: { outcome: Outcome; reason: string; record?: string; detail?: Record<string, unknown> }): Promise<boolean> {
    const e = this.entries.get(id); if (!e) return false;
    e.outcome = { at: this.sec(), ...o }; e.inflight = false;
    try { await this.persist({ t: 'o', id, at: e.outcome.at, outcome: o.outcome, reason: o.reason, ...(o.record ? { record: o.record } : {}), ...(o.detail ? { detail: o.detail } : {}) }); e.outcomeUnsaved = false; return true; }
    catch (err) { this.persistFailures++; e.outcomeUnsaved = true; this.note((err as Error).message); console.error(`FLOW HQ AUDIT OUTBOX: an outcome could not be saved (${e.action}); it is kept in memory and will be recovered from the row's Audit_ID`); return false; }
  }
  /** A single complete event with no mutation (a refusal, a replay). Best effort: never throws, never masks the caller's own result. */
  async event(i: IntentInput & { outcome: Outcome; reason: string }): Promise<boolean> {
    const id = randomUUID(); const e: Entry = { id, seq: this.seq++, at: this.sec(), actor: i.actor, source: i.source, action: i.action, record: i.record, table: i.table, detail: i.detail, hasIntent: false, outcome: { at: this.sec(), outcome: i.outcome, reason: i.reason }, flushed: false, suspect: false, inflight: false, volatile: false };
    let saved = true;
    try { await this.open(); await this.persist({ t: 'e', id, seq: e.seq, at: e.at, actor: e.actor, source: e.source, action: e.action, record: e.record, table: e.table, detail: e.detail, outcome: i.outcome, reason: i.reason }); }
    catch (err) { saved = false; e.volatile = true; this.persistFailures++; this.note((err as Error).message); }
    this.entries.set(id, e); return saved;
  }
  /** The caller gave up on an operation without knowing its fate (an unverified write): leave it for recovery by Audit_ID. */
  release(id: string) { const e = this.entries.get(id); if (e) e.inflight = false; }

  openIntents(): Entry[] { return [...this.entries.values()].filter((e) => e.hasIntent && !e.outcome && !e.inflight).sort((a, b) => a.seq - b.seq); }
  pendingFlush(limit = 100): Entry[] { return [...this.entries.values()].filter((e) => !!e.outcome && !e.flushed).sort((a, b) => a.seq - b.seq).slice(0, limit); }
  async retryUnsavedOutcomes() { for (const e of this.entries.values()) if (e.outcomeUnsaved && e.outcome) { try { await this.persist({ t: 'o', id: e.id, at: e.outcome.at, outcome: e.outcome.outcome, reason: e.outcome.reason, ...(e.outcome.record ? { record: e.outcome.record } : {}) }); e.outcomeUnsaved = false; } catch { /* still down */ } } }
  markSuspect(ids: string[]) { for (const id of ids) { const e = this.entries.get(id); if (e) e.suspect = true; } }
  noteFlushFailure(err: unknown) { this.flushFailures++; this.note((err as Error)?.message || 'flush failed'); }
  async markFlushed(ids: string[]) {
    if (!ids.length) return;
    for (const id of ids) { const e = this.entries.get(id); if (e) { e.flushed = true; e.suspect = false; } }
    try { await this.persist({ t: 'f', ids, at: this.sec() }); } catch (err) { this.persistFailures++; this.note((err as Error).message); }   // a restart will re-check these by Audit_ID instead
    await this.maybeCompact();
  }
  /** Drop fully flushed entries from the file (atomically). Unflushed and open entries are ALWAYS kept. */
  async maybeCompact(force = false) {
    const flushed = [...this.entries.values()].filter((e) => e.flushed && !e.inflight);
    if (!force && !(this.store.size() > (this.o.compactAtBytes ?? 1_000_000) && flushed.length >= 50)) return;
    const keep = [...this.entries.values()].filter((e) => !(e.flushed && !e.inflight)).sort((a, b) => a.seq - b.seq);
    const lines: string[] = [];
    for (const e of keep) {
      if (e.hasIntent) { lines.push(JSON.stringify({ t: 'i', id: e.id, seq: e.seq, at: e.at, actor: e.actor, source: e.source, action: e.action, record: e.record, table: e.table, detail: e.detail })); if (e.outcome) lines.push(JSON.stringify({ t: 'o', id: e.id, at: e.outcome.at, outcome: e.outcome.outcome, reason: e.outcome.reason, ...(e.outcome.record ? { record: e.outcome.record } : {}), ...(e.outcome.detail ? { detail: e.outcome.detail } : {}) })); }
      else lines.push(JSON.stringify({ t: 'e', id: e.id, seq: e.seq, at: e.at, actor: e.actor, source: e.source, action: e.action, record: e.record, table: e.table, detail: e.detail, outcome: e.outcome?.outcome, reason: e.outcome?.reason }));
    }
    try { await this.store.rewrite(lines); for (const e of flushed) this.entries.delete(e.id); } catch (err) { this.note((err as Error).message); }   // keep the old file if the rewrite failed
  }

  health(): OutboxHealth {
    const all = [...this.entries.values()]; const waiting = all.filter((e) => !!e.outcome && !e.flushed); const open = all.filter((e) => e.hasIntent && !e.outcome); const info = this.store.info();
    const oldest = [...waiting, ...open.filter((e) => !e.inflight)].reduce<number | null>((m, e) => (m === null || e.at < m ? e.at : m), null); const age = oldest === null ? null : Math.max(0, this.sec() - oldest);
    const reasons: string[] = []; let level: OutboxHealth['level'] = 'ok'; const raise = (l: 'amber' | 'red', why: string) => { reasons.push(why); if (l === 'red' || level === 'ok') level = l; };
    if (!this.ready) raise(this.openError ? 'red' : 'amber', this.openError ? `the audit outbox is not open: ${this.openError.message}` : 'the audit outbox has not been opened yet');
    if (info.durable && !info.lock_held) raise('red', 'this process does not hold the audit outbox lock');
    if (info.durable && info.persistent_volume === 'no') raise('red', 'the audit outbox is not on a persistent volume');
    if (this.o.breakGlass) raise('red', 'BREAK-GLASS is on: audit is not restart-safe');
    if (this.rejected > 0) raise('red', `${this.rejected} change(s) were refused because the audit log could not be saved`);
    if (age !== null && age > (this.o.redAgeSec ?? 1800)) raise('red', 'audit entries have been waiting more than 30 minutes');
    else if (age !== null && age > (this.o.amberAgeSec ?? 300)) raise('amber', 'audit entries have been waiting more than 5 minutes');
    if (waiting.length + open.length >= (this.o.redWaiting ?? 100)) raise('red', `${waiting.length + open.length} audit entries are waiting`);
    else if (waiting.length + open.length >= (this.o.amberWaiting ?? 20)) raise('amber', `${waiting.length + open.length} audit entries are waiting`);
    if (this.corrupt > 0) raise('amber', `${this.corrupt} unreadable line(s) were skipped when the outbox was loaded`);
    if (all.some((e) => e.outcomeUnsaved)) raise('amber', 'an outcome could not be saved to disk yet');
    return { durable: info.durable, location: info.location, level, reasons, ready: this.ready, lock_held: info.lock_held, persistent_volume: info.persistent_volume, created_at: info.created_at, volume_id: info.volume_id,
      waiting_to_flush: waiting.length, open_intents: open.length, unsaved_outcomes: all.filter((e) => e.outcomeUnsaved).length, oldest_waiting_age_sec: age, failed_since_start: this.flushFailures + this.persistFailures, waiting_to_retry: waiting.length,
      last_failure_at: this.lastErrorAt ? new Date(this.lastErrorAt * 1000).toISOString() : null, last_error: this.lastError, rejected_for_audit: this.rejected, corrupt_lines: this.corrupt, break_glass: !!this.o.breakGlass, break_glass_uses: this.bgUses };
  }
  /** For tools and tests: read-only summary of a log without opening or locking anything. */
  static summarise(lines: string[]) { const o = new AuditOutbox(new MemoryStore()); o.load(lines); const e = [...o.entries.values()]; return { entries: e.length, unflushed: e.filter((x) => !!x.outcome && !x.flushed).length, open_intents: e.filter((x) => x.hasIntent && !x.outcome).length, corrupt_lines: o.corrupt }; }
}
