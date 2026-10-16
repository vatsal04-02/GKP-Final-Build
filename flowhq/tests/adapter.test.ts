// The Clinic Autopilot adapter against an in-memory Grist with the real schema: mapping, write rules, the staff-reply path
// (BFF -> Messages row -> W10 -> W12), and numbers that must equal the weekly-report engine's.
import { describe, expect, it } from 'vitest';
import { memoryGrist, BackendError } from '../src/server/grist';
import { createAutopilotAdapter } from '../src/server/adapters/autopilot';
import { COLUMNS, TABLES } from '../src/server/adapters/autopilot/schema';
import { clinicModules } from '../src/server/adapters/autopilot/shared';
import { demoDocs } from '../src/server/demo/fixtures';
import { processStaffReplies } from '../src/server/demo/simulator';
import type { Ctx } from '../src/server/adapters/types';

const NOW = Date.UTC(2026, 9, 7, 6, 30);            // Wed 7 Oct 2026, 12:00 IST
const KEY = 'test-grist-key-0123456789abcdef';
const admin: Ctx = { viewer: { email: 'alex@test', name: 'Alex', role: 'admin' }, now: NOW };
const staff: Ctx = { viewer: { email: 'sam@test', name: 'Sam', role: 'staff' }, now: NOW };

// writes are checked against the real column names (CLAUDE.md rule 3)
const columns = { [TABLES.leads]: COLUMNS.leads, [TABLES.appointments]: COLUMNS.appointments, [TABLES.conversations]: COLUMNS.conversations, [TABLES.messages]: COLUMNS.messages, [TABLES.runLog]: COLUMNS.runLog, [TABLES.knowledge]: COLUMNS.knowledge, [TABLES.settings]: ['Key', 'Value'] };
function setup() {
  const { docs } = demoDocs(NOW);
  const mem = memoryGrist(docs, { columns });
  const auth: string[] = [];
  const fetchImpl = ((url: string, init?: { headers?: Record<string, string> }) => { auth.push(init?.headers?.Authorization || ''); return mem(url, init as never); }) as typeof mem;
  const adapter = createAutopilotAdapter({ gristBaseUrl: 'http://memory', gristApiKey: KEY, registryDocId: 'REGISTRY', timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR', fetchImpl, cacheMs: 0 });
  return { docs, mem, adapter, auth };
}
async function physio() { const s = setup(); const b = (await s.adapter.workspace('demo-physio'))!; return { ...s, b, rows: s.docs.DEMO_PHYSIO }; }
const rejects = async (p: Promise<unknown>, status: number, code?: string) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(BackendError);
  expect((e as BackendError).status).toBe(status);
  if (code) expect((e as BackendError).code).toBe(code);
};

describe('workspace registry', () => {
  it('lists active workspaces without exposing document or phone-number ids', async () => {
    const { adapter, auth } = setup();
    const list = await adapter.listWorkspaces();
    expect(list.map((w) => w.id)).toEqual(['demo-physio', 'demo-salon', 'demo-realty']);
    expect(JSON.stringify(list)).not.toMatch(/DEMO_PHYSIO|DEMO_SALON|DEMO_REALTY|10000000000000/);
    expect(auth.every((h) => h === `Bearer ${KEY}`)).toBe(true);
  });
  it('an unknown workspace is not found', async () => {
    expect(await setup().adapter.workspace('nope')).toBeNull();
  });
});

describe('contacts mapping (Leads -> Contact)', () => {
  it('maps stage, interest, attention, opted out and status', async () => {
    const { b, rows } = await physio();
    const list = await b.contacts({}, admin);
    const lead = (id: number) => rows.LEADS.find((l) => l.id === id)!;
    const c17 = list.find((c) => c.id === '17')!;
    expect(c17.optedOut).toBe(true);
    const anyLead = list.find((c) => c.id === '5')!;
    expect(anyLead.stage).toBe(lead(5).fields.Lead_Stage);
    expect(anyLead.interest).toBe(lead(5).fields.Likely_Service);
    expect(anyLead.status).toBe(String(lead(5).fields.Status).toLowerCase());
    const conv = rows.Conversations.find((c) => c.fields.Needs_Human === true && /^HIGH/.test(String(c.fields.Handoff_Reason)))!;
    const flagged = list.find((c) => c.id === String(conv.fields.Lead))!;
    expect(flagged.attentionRequired).toBe(true);
    expect(flagged.priority).toBe('high');
  });
  it('writes contact edits to the real columns', async () => {
    const { b, rows } = await physio();
    await b.updateContact('5', { status: 'lost', notes: 'moved away' }, admin);
    expect(rows.LEADS.find((l) => l.id === 5)!.fields).toMatchObject({ Status: 'Lost', Notes: 'moved away' });
  });
});

describe('staff reply: FLOW HQ -> Messages row -> W10 -> W12', () => {
  const open = async (b: Awaited<ReturnType<typeof physio>>['b'], until = NOW) => (await b.conversations({}, admin)).find((c) => !c.optedOut && c.replyWindow.open && Date.parse(c.replyWindow.closesAt!) > until)!;
  it('only writes a Send row; nothing is sent from FLOW HQ', async () => {
    const { b, rows, mem } = await physio();
    const c = await open(b);
    const before = mem.calls.length;
    const m = await b.reply(c.id, '  Hello from the desk  ', admin);
    const writes = mem.calls.slice(before).filter((x) => x.method !== 'GET');
    expect(writes).toEqual([{ method: 'POST', table: 'Messages', body: { records: [{ fields: { Conversation: Number(c.id), Direction: 'Out', Body: 'Hello from the desk', Sent_By: 'Alex', Send: true, Created_At: Math.floor(NOW / 1000) } }] } }]);
    expect(m.status).toBe('pending');
    const row = rows.Messages.find((r) => r.fields.Body === 'Hello from the desk')!;
    expect(row.fields.WA_Message_ID).toBeUndefined();
  });
  it('W10 (its own functions) sends it once in the day, and never twice', async () => {
    const { b, rows, docs } = await physio();
    const c = await open(b);
    await b.reply(c.id, 'Day reply', admin);
    expect(processStaffReplies(docs, NOW)).toBe(1);
    const row = rows.Messages.find((r) => r.fields.Body === 'Day reply')!;
    expect(row.fields).toMatchObject({ Send: false, Status: 'sent' });
    expect(String(row.fields.WA_Message_ID)).toMatch(/^wamid\.DEMO\./);
    expect(processStaffReplies(docs, NOW + 5000)).toBe(0);
    const thread = await b.conversation(c.id, admin);
    expect(thread!.messages.find((m) => m.body === 'Day reply')!.status).toBe('sent');
  });
  it('in quiet hours W10 holds it, and FLOW HQ shows why', async () => {
    const { b, rows, docs } = await physio();
    const late = NOW + 11 * 3600000;   // 23:00 IST
    const c = await open(b, late);
    await b.reply(c.id, 'Late reply', admin);
    expect(processStaffReplies(docs, late)).toBe(0);
    const row = rows.Messages.find((r) => r.fields.Body === 'Late reply')!;
    expect(row.fields.Send).toBe(true);
    const shown = (await b.conversation(c.id, { ...admin, now: late }))!.messages.find((m) => m.body === 'Late reply')!;
    expect(shown.status).toBe('pending');
    expect(shown.statusNote).toMatch(/quiet hours/);
  });
  it('refuses opted-out contacts and closed reply windows', async () => {
    const { b } = await physio();
    const all = await b.conversations({}, admin);
    await rejects(b.reply(all.find((c) => c.optedOut)!.id, 'hi', admin), 409, 'opted_out');
    await rejects(b.reply(all.find((c) => !c.optedOut && !c.replyWindow.open)!.id, 'hi', admin), 409, 'window_closed');
    await rejects(b.reply(all[0].id, '   ', admin), 400, 'empty');
  });
  it('backend notes are shown in the workspace’s own words', async () => {
    const { b, rows } = await physio();
    const row = rows.Messages.find((r) => r.fields.Status === 'needs_template')!;
    const m = (await b.conversation(String(row.fields.Conversation), admin))!.messages.find((x) => x.id === String(row.id))!;
    expect(m.statusNote).toMatch(/\{contact\.singular\|lower\}'s last message/);
    expect(m.statusNote).not.toMatch(/patient/i);
  });
});

describe('bookings: the booking system stays the source of truth', () => {
  it('marks a past scheduled booking completed / no-show, and nothing else', async () => {
    const { b, rows } = await physio();
    const all = await b.bookings({ view: 'all' }, admin);
    const due = all.find((x) => x.needsOutcome)!;
    const future = all.find((x) => x.start && Date.parse(x.start) > NOW && x.status === 'scheduled')!;
    const cancelled = all.find((x) => x.status === 'cancelled');
    await rejects(b.updateBooking(future.id, 'completed', admin), 409, 'in_future');
    if (cancelled && cancelled.start && Date.parse(cancelled.start) < NOW) await rejects(b.updateBooking(cancelled.id, 'completed', admin), 409, 'not_scheduled');
    await rejects(b.updateBooking(due.id, 'cancelled', admin), 400);
    const r = await b.updateBooking(due.id, 'no_show', admin);
    expect(r.status).toBe('no_show');
    expect(rows.Appointments.find((a) => String(a.id) === due.id)!.fields.Status).toBe('No-show');
  });
  it('booking value (Fee_INR) is shown to admins only', async () => {
    const { b } = await physio();
    expect((await b.capabilities(admin.viewer)).revenue).toBe(true);
    expect((await b.capabilities(staff.viewer)).revenue).toBe(false);
    expect((await b.bookings({ view: 'all' }, staff)).every((x) => x.value === null)).toBe(true);
    expect((await b.bookings({ view: 'all' }, admin)).some((x) => x.value !== null)).toBe(true);
  });
});

describe('automations', () => {
  it('reads status and numbers from Run_Log, never in the future', async () => {
    const { b } = await physio();
    const list = await b.automations(admin);
    expect(list.map((a) => a.key)).toContain('ai_assistant');
    for (const a of list) if (a.lastRunAt) expect(Date.parse(a.lastRunAt)).toBeLessThanOrEqual(NOW);
    const rem = list.find((a) => a.key === 'booking_reminders')!;
    expect(rem.stats.failed7d).toBeGreaterThan(0);  // the demo has one undeliverable reminder this week
    expect(rem.lastError).toMatch(/131026/);
    expect(rem.status).toBe('always_on');          // a later run succeeded, so it is not flagged
    expect(rem.control).toBeNull();                // W5 has no per-workspace switch: shown, not faked
  });
  it('switches write the workflows’ own Settings keys; admins only', async () => {
    const { b, rows } = await physio();
    const r = await b.setAutomation('review_requests', 'off', admin);
    expect(r.status).toBe('off');
    expect(rows.Settings.find((s) => s.fields.Key === 'review_requests')!.fields.Value).toBe('off');
    await b.setAutomation('ai_assistant', 'draft', admin);
    expect(rows.Settings.find((s) => s.fields.Key === 'ai_mode')!.fields.Value).toBe('draft');
    await rejects(b.setAutomation('review_requests', 'on', staff), 403);
    await rejects(b.setAutomation('booking_reminders', 'off', admin), 400, 'no_switch');
    await rejects(b.setAutomation('ai_assistant', 'yolo', admin), 400);
  });
});

describe('settings', () => {
  it('masks private numbers for staff and normalises switches to on/off', async () => {
    const { b } = await physio();
    const s = await b.settings(staff);
    const owner = s.fields.find((f) => f.key === 'owner_phone')!;
    expect(owner.value).not.toMatch(/\d{5}/);
    expect(owner.editable).toBe(false);
    expect(s.fields.find((f) => f.key === 'TEST_MODE')!.value).toBe('off');
    const a = await b.settings(admin);
    expect(a.fields.find((f) => f.key === 'owner_phone')!.value).toBe('+919000000901');
    expect(JSON.stringify(a)).not.toContain(KEY);
  });
  it('validates and writes values the workflows understand', async () => {
    const { b, rows } = await physio();
    await rejects(b.updateSettings({ open_time: '07:00' }, staff), 403);
    await rejects(b.updateSettings({ owner_phone: '12345' }, admin), 400);
    await rejects(b.updateSettings({ review_link: 'http://insecure.example' }, admin), 400);
    await rejects(b.updateSettings({ GRIST_API_KEY: 'x' }, admin), 400);
    // two opening windows a day: what W13 can read is accepted, what it could not read is refused (and nothing is written)
    await rejects(b.updateSettings({ open_hours: '09:00-13:00, 16:00-20:00' }, staff), 403);
    for (const bad of ['09:00-13:00, 12:00-20:00', '13:00-09:00', 'lunch', '09:00-13:00-16:00']) await rejects(b.updateSettings({ open_hours: bad }, admin), 400);
    expect(rows.Settings.some((s) => s.fields.Key === 'open_hours')).toBe(false);
    await b.updateSettings({ open_hours: '9 AM - 1 PM and 4 PM - 8 PM' }, admin);
    expect(rows.Settings.find((s) => s.fields.Key === 'open_hours')!.fields.Value).toBe('9 AM - 1 PM and 4 PM - 8 PM');
    await b.updateSettings({ open_hours: '' }, admin);                                  // empty = back to Opens / Closes
    expect(rows.Settings.find((s) => s.fields.Key === 'open_hours')!.fields.Value).toBe('');
    await b.updateSettings({ TEST_MODE: 'on', open_time: '08:30', owner_phone: '90000 00911' }, admin);
    const v = (k: string) => rows.Settings.find((s) => s.fields.Key === k)!.fields.Value;
    expect(v('TEST_MODE')).toBe('true');
    expect(v('open_time')).toBe('08:30');
    expect(v('owner_phone')).toBe('+919000000911');
  });
});

describe('analytics and reports come from the weekly-report engine', () => {
  it('equal cmWeeklyMetrics on the same rows', async () => {
    const { b, rows } = await physio();
    const a = await b.analytics('last', admin);
    const win = clinicModules.cmWeekWindow(NOW);
    const m = clinicModules.cmWeeklyMetrics({ leads: rows.LEADS, appointments: rows.Appointments, conversations: rows.Conversations, messages: rows.Messages, runlog: rows.Run_Log }, NOW, win, { messages: 5000, runlog: 5000 });
    const v = (k: string) => a.metrics.find((x) => x.key === k)!.value;
    expect(v('new')).toBe(m.leads.new);
    expect(v('completed')).toBe(m.appointments.completed);
    expect(v('no_show')).toBe(m.appointments.no_show);
    expect(v('ai_replied')).toBe(m.ai.replied);
    expect(v('handed_off')).toBe(m.ai.handed_off);
    expect(v('failures')).toBe(m.failures.total);
    expect(a.period.label).toBe(win.label);
    const fails = a.breakdowns.find((x) => x.key === 'failures')!;
    expect(fails.items.every((i) => i.label.startsWith('automation:'))).toBe(true);
  });
  it('stored reports are the W9 rows, parsed into sections', async () => {
    const { b } = await physio();
    const r = await b.reports(admin);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].sections.map((s) => s.key)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
  });
});

describe('derived tasks and errors', () => {
  it('derives reply, outcome and follow-up tasks from live rows', async () => {
    const { b } = await physio();
    const kinds = new Set((await b.tasks(admin)).map((t) => t.kind));
    for (const k of ['reply_needed', 'booking_outcome', 'reply_failed']) expect(kinds).toContain(k);
  });
  it('a backend failure becomes a clean error with no key, document id or backend text', async () => {
    const { docs } = demoDocs(NOW);
    const mem = memoryGrist(docs, { failOn: (_method, table) => table === 'LEADS' });
    const adapter = createAutopilotAdapter({ gristBaseUrl: 'http://memory', gristApiKey: KEY, registryDocId: 'REGISTRY', timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR', fetchImpl: mem, cacheMs: 0 });
    const b = (await adapter.workspace('demo-physio'))!;
    const orig = console.error; console.error = () => {};
    const e = await b.contacts({}, admin).then(() => null, (x: Error) => x);
    console.error = orig;
    expect(e).toBeInstanceOf(BackendError);
    expect(e!.message).toBe('The data backend refused the request (500)');
    expect(e!.message).not.toMatch(new RegExp(`${KEY}|DEMO_PHYSIO|injected`));
  });
});

