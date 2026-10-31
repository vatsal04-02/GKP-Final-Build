// Opens every workspace's durable audit outbox at start-up, and KEEPS TRYING until it has.
// Why: FLOW HQ can start before Grist answers (a backup or a host reboot starts the containers together). The first attempt then fails reading the workspace list, and the old
// one-shot start-up only logged it: the outbox was never opened and /api/health stayed RED (bookings refused) until someone restarted FLOW HQ by hand.
export interface Startable { start(): Promise<void>; stop(): Promise<void> }
export interface OutboxHost {
  listWorkspaces(): Promise<Array<{ id: string }>>;
  workspace(id: string): Promise<{ booking?: () => Startable | null | undefined; payments?: () => Startable | null | undefined } | null | undefined>;
}
export interface StartOptions { retryMs?: number; maxRetryMs?: number; log?: (message: string) => void; sleep?: (ms: number) => Promise<void> }

export function startAuditOutboxes(host: OutboxHost, o: StartOptions = {}) {
  const log = o.log || ((m: string) => console.error(m));
  const sleep = o.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = new Map<string, Startable>(); const ready = new Set<string>(); let stopped = false;
  const done = (async () => {
    let wait = o.retryMs ?? 2000; const cap = o.maxRetryMs ?? 30000;
    for (let attempt = 1; !stopped; attempt++) {
      try {
        for (const w of await host.listWorkspaces()) {
          if (ready.has(w.id)) continue;
          const ws = await host.workspace(w.id); const svc = ws?.booking?.();
          if (!svc) { ready.add(w.id); continue; }
          started.set(w.id, svc); await svc.start();
          const pay = ws?.payments?.(); if (pay) { started.set(`${w.id}:payments`, pay); await pay.start(); }   // payment expiry / release housekeeping (every 60 s)
          ready.add(w.id);
        }
        if (attempt > 1) log(`FLOW HQ: the audit outbox is open now (after ${attempt} attempts)`);
        return;
      } catch (e) {
        log(`FLOW HQ: could not start the audit outbox for every workspace (${(e as Error).message}); trying again in ${Math.round(wait / 1000)} s. Bookings are refused until it is open.`);
        await sleep(wait); wait = Math.min(wait * 2, cap);
      }
    }
  })();
  return { done, async stop() { stopped = true; await Promise.allSettled([...started.values()].map((s) => s.stop())); } };
}
