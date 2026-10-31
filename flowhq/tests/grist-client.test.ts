// The Grist client must not flood Grist (it answers 429 "Too many backlogged requests" when one document gets too many at once).
import { describe, expect, it } from 'vitest';
import { GristClient, type FetchLike } from '../src/server/grist';

const ok = (records: unknown[] = []) => ({ ok: true, status: 200, json: async () => ({ records }), text: async () => JSON.stringify({ records }), headers: { get: () => 'application/json' } });
const make = (impl: (url: string, init?: { method?: string }) => Promise<ReturnType<typeof ok> | { ok: false; status: number; text(): Promise<string> }>) => new GristClient('http://grist', 'k', impl as unknown as FetchLike, 5000, 2);

describe('GristClient', () => {
  it('overlapping identical reads share one request', async () => {
    let calls = 0;
    const g = make(async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return ok([{ id: 1, fields: {} }]); });
    const [a, b, c] = await Promise.all([g.records('d', 'T'), g.records('d', 'T'), g.records('d', 'T')]);
    expect(calls).toBe(1);
    expect(a).toBe(b); expect(b).toBe(c);
    await g.records('d', 'T');                       // not overlapping: a new request (no stale caching here)
    expect(calls).toBe(2);
  });

  it('never has more than the allowed number of requests in flight', async () => {
    let now = 0; let peak = 0;
    const g = make(async () => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 15)); now--; return ok(); });
    await Promise.all(['A', 'B', 'C', 'D', 'E', 'F'].map((t) => g.records('d', t)));
    expect(peak).toBe(2);
  });

  it('retries a 429 ("busy") and then succeeds', async () => {
    let calls = 0;
    const g = make(async () => (++calls < 3 ? { ok: false as const, status: 429, text: async () => 'Too many backlogged requests' } : ok([{ id: 7, fields: {} }])));
    expect((await g.records('d', 'T'))[0]!.id).toBe(7);
    expect(calls).toBe(3);
  });

  it('a write is never answered from a read that started before it', async () => {
    let version = 0; const seen: number[] = [];
    const g = make(async (_u, init) => {
      if (init?.method === 'POST') { version++; return ok(); }
      const v = version; await new Promise((r) => setTimeout(r, 20)); seen.push(v); return ok([{ id: v, fields: {} }]);
    });
    const before = g.records('d', 'T');
    await g.add('d', 'T', [{ A: 1 }]);
    const after = await g.records('d', 'T');
    expect(after[0]!.id).toBe(1);                    // it saw the write
    await before;
  });
});
