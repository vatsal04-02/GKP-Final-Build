// Dashboard enquiry numbers: converted, awaiting a first outbound reply, the date range, empty state and role access.
import { describe, expect, it } from 'vitest';
import { memoryGrist } from '../src/server/grist';
import { createAutopilotAdapter } from '../src/server/adapters/autopilot';
import { COLUMNS, TABLES } from '../src/server/adapters/autopilot/schema';
import { demoDocs } from '../src/server/demo/fixtures';
import type { Ctx } from '../src/server/adapters/types';

const NOW = Date.UTC(2026, 9, 7, 6, 30);            // Wed 7 Oct 2026, 12:00 IST
const HOUR = 3600;
const DAY = 86400;
const nowSec = Math.floor(NOW / 1000);
const admin: Ctx = { viewer: { email: 'alex@test', name: 'Alex', role: 'admin' }, now: NOW };
const staff: Ctx = { viewer: { email: 'sam@test', name: 'Sam', role: 'staff' }, now: NOW };
const columns = { [TABLES.leads]: COLUMNS.leads, [TABLES.appointments]: COLUMNS.appointments, [TABLES.conversations]: COLUMNS.conversations, [TABLES.messages]: COLUMNS.messages, [TABLES.runLog]: COLUMNS.runLog, [TABLES.knowledge]: COLUMNS.knowledge, [TABLES.settings]: ['Key', 'Value'] };

type Row = { id: number; fields: Record<string, unknown> };
interface Lead { status?: string; ageSec: number; optedOut?: boolean; firstResponse?: boolean; out?: string[] }   // out: statuses of outbound messages in its conversation

// A physio workspace whose leads, conversations and messages are exactly what the test lists.
async function workspace(leads: Lead[]) {
  const { docs } = demoDocs(NOW);
  const rows = docs.DEMO_PHYSIO as Record<string, Row[]>;
  for (const t of ['LEADS', 'Conversations', 'Messages']) rows[t]!.length = 0;
  let mid = 1;
  leads.forEach((l, i) => {
    const id = i + 1;
    rows.LEADS!.push({ id, fields: { Name: `Lead ${id}`, Phone: `+9190000000${String(id).padStart(2, '0')}`, Created_At: nowSec - l.ageSec, Status: l.status ?? 'New', Opted_Out: l.optedOut === true, First_Response_At: l.firstResponse ? nowSec - l.ageSec + 60 : null } });
    rows.Conversations!.push({ id, fields: { Lead: id, Phone: `+9190000000${String(id).padStart(2, '0')}`, Last_Inbound_At: nowSec - l.ageSec } });
    rows.Messages!.push({ id: mid++, fields: { Conversation: id, Direction: 'In', Body: 'Hi', Status: 'Received', Created_At: nowSec - l.ageSec } });
    for (const status of l.out || []) rows.Messages!.push({ id: mid++, fields: { Conversation: id, Direction: 'Out', Body: 'Reply', Status: status, Sent_By: 'W3', Created_At: nowSec - l.ageSec + 120 } });
  });
  const adapter = createAutopilotAdapter({ gristBaseUrl: 'http://memory', gristApiKey: 'test-grist-key-0123456789abcdef', registryDocId: 'REGISTRY', timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR', fetchImpl: memoryGrist(docs, { columns }), cacheMs: 0 });
  return (await adapter.workspace('demo-physio'))!;
}
const metric = (d: { metrics: Array<{ key: string; value: number | null }> }, k: string) => d.metrics.find((m) => m.key === k)?.value ?? null;

describe('dashboard enquiries', () => {
  it('counts converted as Booked or Converted, matching the conversion metric', async () => {
    const b = await workspace([{ status: 'Booked', ageSec: HOUR }, { status: 'Converted', ageSec: HOUR }, { status: 'Lost', ageSec: HOUR }, { status: 'Contacted', ageSec: HOUR }]);
    const d = await b.dashboard(7, admin);
    expect(metric(d, 'new_contacts')).toBe(4);
    expect(d.enquiries.converted).toBe(2);
    expect(metric(d, 'conversion')).toBe(50);          // the rate and the count come from the same rule
  });

  it('awaiting reply = still New, reachable, and no outbound message has gone out', async () => {
    const b = await workspace([
      { ageSec: HOUR },                                          // 1 awaiting
      { ageSec: HOUR, out: ['sent'] },                           // replied
      { ageSec: HOUR, out: ['queued'] },                         // a reply is on its way
      { ageSec: HOUR, out: ['failed'] },                         // never reached them: still awaiting
      { ageSec: HOUR, out: ['needs_template'] },                 // never reached them: still awaiting
      { ageSec: HOUR, optedOut: true },                          // must not be contacted
      { ageSec: HOUR, firstResponse: true },                     // first response already recorded
      { ageSec: HOUR, status: 'Contacted' },                     // someone already handled it
      { ageSec: HOUR, status: 'Lost' },
    ]);
    expect((await b.dashboard(7, admin)).enquiries.awaitingReply).toBe(3);
  });

  it('only counts enquiries created inside the selected range', async () => {
    const b = await workspace([
      { ageSec: 2 * HOUR, status: 'Booked' },                    // today
      { ageSec: 3 * DAY, status: 'Booked' },                     // inside 7 days, outside Today
      { ageSec: 20 * DAY, status: 'Booked' },                    // inside 30 days only
      { ageSec: 60 * DAY, status: 'Booked' },                    // outside everything
    ]);
    const counts = async (days: number) => { const d = await b.dashboard(days, admin); return [metric(d, 'new_contacts'), d.enquiries.converted]; };
    expect(await counts(1)).toEqual([1, 1]);
    expect(await counts(7)).toEqual([2, 2]);
    expect(await counts(30)).toEqual([3, 3]);
    const old = await workspace([{ ageSec: 20 * DAY }]);
    expect((await old.dashboard(7, admin)).enquiries).toEqual({ converted: 0, awaitingReply: 0 });
    expect((await old.dashboard(30, admin)).enquiries.awaitingReply).toBe(1);
  });

  it('is all zeros, not an error, when there are no enquiries', async () => {
    const b = await workspace([]);
    const d = await b.dashboard(7, admin);
    expect(d.enquiries).toEqual({ converted: 0, awaitingReply: 0 });
    expect(metric(d, 'new_contacts')).toBe(0);
    expect(metric(d, 'conversion')).toBeNull();                  // no enquiries: no rate to show
  });

  it('gives staff and admins the same counts and no personal data', async () => {
    const b = await workspace([{ status: 'Booked', ageSec: HOUR }, { ageSec: HOUR }]);
    const a = await b.dashboard(7, admin);
    const s = await b.dashboard(7, staff);
    expect(s.enquiries).toEqual(a.enquiries);
    expect(Object.keys(s.enquiries).sort()).toEqual(['awaitingReply', 'converted']);   // numbers only
    expect(JSON.stringify(s.enquiries)).not.toMatch(/Lead \d|\+91/);
    expect(s.metrics.some((m) => m.key === 'revenue')).toBe(false);                     // money stays hidden from staff
  });
});
