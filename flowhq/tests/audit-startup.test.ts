// The audit outbox must open even when Grist is not up yet at start-up (found in production on 1 Nov 2026: a backup restarted FLOW HQ before Grist answered, the one-shot
// start-up only logged the failure, and /api/health stayed red until a manual restart).
import { describe, expect, it } from 'vitest';
import { startAuditOutboxes, type OutboxHost, type Startable } from '../src/server/audit-startup';

const svc = (log: string[], name: string, opts: { failStarts?: number } = {}): Startable => { let fails = opts.failStarts || 0; return { start: async () => { if (fails-- > 0) throw new Error('registry unreachable'); log.push(`start ${name}`); }, stop: async () => { log.push(`stop ${name}`); } }; };
const host = (failLists: number, workspaces: Record<string, Startable | null>): OutboxHost & { lists: number } => { let n = 0; const h = { lists: 0, listWorkspaces: async () => { h.lists = ++n; if (n <= failLists) throw new Error('The data backend did not answer (network error)'); return Object.keys(workspaces).map((id) => ({ id })); }, workspace: async (id: string) => ({ booking: () => workspaces[id] }) }; return h; };
const fast = (msgs: string[]) => ({ retryMs: 1, maxRetryMs: 4, log: (m: string) => msgs.push(m), sleep: async () => undefined });

describe('start-up of the audit outbox', () => {
  it('Grist not answering at boot: it keeps retrying and then opens the outbox (no manual restart)', async () => {
    const log: string[] = []; const msgs: string[] = []; const h = host(3, { 'demo-clinic': svc(log, 'demo-clinic') });
    const o = startAuditOutboxes(h, fast(msgs)); await o.done;
    expect(h.lists).toBe(4); expect(log).toEqual(['start demo-clinic']);
    expect(msgs.filter((m) => /could not start the audit outbox/.test(m))).toHaveLength(3); expect(msgs.at(-1)).toMatch(/open now \(after 4 attempts\)/);
  });
  it('a workspace that failed to start is retried, one that started is NOT started twice', async () => {
    const log: string[] = []; const h = host(0, { a: svc(log, 'a'), b: svc(log, 'b', { failStarts: 2 }) });
    const o = startAuditOutboxes(h, fast([])); await o.done;
    expect(log.filter((x) => x === 'start a')).toEqual(['start a']); expect(log.filter((x) => x === 'start b')).toEqual(['start b']);
  });
  it('a workspace without booking tables is skipped without error', async () => {
    const log: string[] = []; const o = startAuditOutboxes(host(0, { plain: null, booked: svc(log, 'booked') }), fast([])); await o.done; expect(log).toEqual(['start booked']);
  });
  it('stop() releases every started outbox and ends the retrying', async () => {
    const log: string[] = []; const h = host(0, { a: svc(log, 'a') }); const o = startAuditOutboxes(h, fast([])); await o.done; await o.stop(); expect(log).toEqual(['start a', 'stop a']);
    const never = host(1000000, {}); let slept = 0; const o2 = startAuditOutboxes(never, { retryMs: 1, log: () => undefined, sleep: async () => { if (++slept === 3) await o2.stop(); } }); await o2.done; expect(slept).toBe(3);
  });
});
