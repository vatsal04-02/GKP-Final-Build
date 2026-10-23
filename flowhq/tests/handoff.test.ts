// Human handling switch (Conversations.Automation_Paused): enable, disable, persistence, failed writes, roles, workspace isolation,
// and that W13's gate really stays away from a paused conversation.
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { hashPassword, type UserRecord } from '../src/server/auth';
import { BackendError, memoryGrist } from '../src/server/grist';
import { ProfileStore } from '../src/server/profiles';
import { createAutopilotAdapter } from '../src/server/adapters/autopilot';
import { COLUMNS, TABLES } from '../src/server/adapters/autopilot/schema';
import { demoDocs } from '../src/server/demo/fixtures';
import type { Ctx } from '../src/server/adapters/types';

const NOW = Date.UTC(2026, 9, 7, 6, 30);
const KEY = 'test-grist-key-0123456789abcdef';
const PW = 'correct horse 42';
const admin: Ctx = { viewer: { email: 'alex@test', name: 'Alex', role: 'admin' }, now: NOW };
const columns = { [TABLES.leads]: COLUMNS.leads, [TABLES.appointments]: COLUMNS.appointments, [TABLES.conversations]: COLUMNS.conversations, [TABLES.messages]: COLUMNS.messages, [TABLES.runLog]: COLUMNS.runLog, [TABLES.knowledge]: COLUMNS.knowledge, [TABLES.settings]: ['Key', 'Value'] };

type Fetch = ReturnType<typeof memoryGrist>;
// `tamper` can fail or swallow writes to the Conversations table, to simulate Grist problems
function build(tamper?: (url: string, init: { method?: string }, real: Fetch) => ReturnType<Fetch> | undefined) {
  const d = demoDocs(NOW);
  const real = memoryGrist(d.docs, { columns });
  const fetchImpl = ((url: string, init?: { method?: string }) => tamper?.(url, init || {}, real) ?? real(url, init as never)) as Fetch;
  const adapter = createAutopilotAdapter({ gristBaseUrl: 'http://memory', gristApiKey: KEY, registryDocId: 'REGISTRY', timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR', fetchImpl, cacheMs: 0 });
  return { d, adapter };
}
const isConvWrite = (url: string, init: { method?: string }) => init.method === 'PATCH' && /\/tables\/Conversations\/records/.test(url);
async function physio(tamper?: Parameters<typeof build>[0]) {
  const { d, adapter } = build(tamper);
  const b = (await adapter.workspace('demo-physio'))!;
  const conv = (await b.conversations({}, admin))[0]!;
  const row = () => (d.docs.DEMO_PHYSIO!.Conversations as Array<{ id: number; fields: Record<string, unknown> }>).find((r) => String(r.id) === conv.id)!;
  return { b, conv, row, d, adapter };
}

describe('Human handling switch: the data layer', () => {
  it('turning it on writes Automation_Paused = true to Grist and returns the saved state', async () => {
    const { b, conv, row } = await physio();
    row().fields.Automation_Paused = false;
    const saved = await b.updateConversation(conv.id, { automationPaused: true }, admin);
    expect(row().fields.Automation_Paused).toBe(true);
    expect(saved.automationPaused).toBe(true);
    expect(saved.aiActive).toBe(false);
    expect((await b.conversation(conv.id, admin))!.conversation.automationPaused).toBe(true);       // persisted, not just echoed
  });
  it('turning it off writes false and the AI is active again', async () => {
    const { b, conv, row } = await physio();
    row().fields.Automation_Paused = true;
    const saved = await b.updateConversation(conv.id, { automationPaused: false }, admin);
    expect(row().fields.Automation_Paused).toBe(false);
    expect(saved.automationPaused).toBe(false);
  });
  it('the contact detail carries the linked conversation state (and null without a conversation)', async () => {
    const { b, conv, row } = await physio();
    row().fields.Automation_Paused = true;
    const c = (await b.contact(conv.contactId!, admin))!.contact;
    expect(c.conversationId).toBe(conv.id);
    expect(c.automationPaused).toBe(true);
    const lonely = (await b.contacts({}, admin)).find((x) => !x.conversationId);
    if (lonely) expect(lonely.automationPaused).toBeNull();
  });
  it('a failed Grist write is an error, changes nothing, and never reports success', async () => {
    const { b, conv, row } = await physio((url, init) => (isConvWrite(url, init) ? Promise.reject(new Error('down')) as never : undefined));
    row().fields.Automation_Paused = false;
    const e = await b.updateConversation(conv.id, { automationPaused: true }, admin).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(BackendError);
    expect((e as BackendError).status).toBe(502);
    expect(row().fields.Automation_Paused).toBe(false);
    expect((await b.conversation(conv.id, admin))!.conversation.automationPaused).toBe(false);
  });
  it('a write that Grist accepts but does not apply is not reported as saved', async () => {
    const { b, conv, row } = await physio((url, init) => (isConvWrite(url, init) ? Promise.resolve({ ok: true, status: 200, text: async () => '{}', headers: { get: () => 'application/json' } }) as never : undefined));
    row().fields.Automation_Paused = false;
    const e = await b.updateConversation(conv.id, { automationPaused: true }, admin).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(BackendError);
    expect((e as BackendError).code).toBe('not_saved');
  });
  it('an unknown conversation is 404', async () => {
    const { b } = await physio();
    const e = await b.updateConversation('99999', { automationPaused: true }, admin).then(() => null, (x) => x);
    expect((e as BackendError).status).toBe(404);
  });
});

describe('Human handling switch: over HTTP (roles and workspace isolation)', () => {
  let app: ReturnType<typeof createApp>;
  let docs: ReturnType<typeof demoDocs>['docs'];
  beforeAll(() => {
    const { d, adapter } = build();
    docs = d.docs;
    const h = hashPassword(PW);
    const users: UserRecord[] = [
      { email: 'admin@test', name: 'Alex', role: 'admin', workspaces: ['*'], passwordHash: h },
      { email: 'staff@test', name: 'Sam', role: 'staff', workspaces: ['demo-physio'], passwordHash: h },
      { email: 'salon@test', name: 'Sal', role: 'staff', workspaces: ['demo-salon'], passwordHash: h },
    ];
    app = createApp({ adapter, profiles: new ProfileStore(null, 'clinic', d.profiles), users, sessionSecret: 'test-session-secret-0123456789abcdef-xyz', secureCookies: true, demo: false, now: () => NOW });
  });
  const J = { 'content-type': 'application/json', 'x-flowhq-csrf': '1' };
  const login = async (email: string) => {
    const r = await app.request('/api/auth/login', { method: 'POST', headers: { ...J, 'x-forwarded-for': `10.1.0.${email.length}` }, body: JSON.stringify({ email, password: PW }) });
    return r.headers.get('set-cookie')!.split(';')[0]!;
  };
  const patch = (cookie: string | null, ws: string, id: string | number, body: unknown, csrf = true) =>
    app.request(`/api/w/${ws}/conversations/${id}`, { method: 'PATCH', headers: { ...(cookie ? { cookie } : {}), ...(csrf ? J : { 'content-type': 'application/json' }) }, body: JSON.stringify(body) });
  const paused = (ws: 'DEMO_PHYSIO' | 'DEMO_SALON', id: number) => (docs[ws]!.Conversations as Array<{ id: number; fields: Record<string, unknown> }>).find((r) => r.id === id)!.fields.Automation_Paused;
  const firstId = (ws: 'DEMO_PHYSIO' | 'DEMO_SALON') => (docs[ws]!.Conversations as Array<{ id: number }>)[0]!.id;

  it('staff of the clinic can switch it on and off, and Grist holds the result', async () => {
    const cookie = await login('staff@test');
    const id = firstId('DEMO_PHYSIO');
    const on = await patch(cookie, 'demo-physio', id, { automationPaused: true });
    expect(on.status).toBe(200);
    expect((await on.json()).automationPaused).toBe(true);
    expect(paused('DEMO_PHYSIO', id)).toBe(true);
    const off = await patch(cookie, 'demo-physio', id, { automationPaused: false });
    expect((await off.json()).automationPaused).toBe(false);
    expect(paused('DEMO_PHYSIO', id)).toBe(false);
  });
  it('admins can too', async () => {
    const id = firstId('DEMO_PHYSIO');
    expect((await patch(await login('admin@test'), 'demo-physio', id, { automationPaused: true })).status).toBe(200);
    expect(paused('DEMO_PHYSIO', id)).toBe(true);
  });
  it('nobody without a session, or without the CSRF header, can change it', async () => {
    const id = firstId('DEMO_PHYSIO');
    const before = paused('DEMO_PHYSIO', id);
    expect((await patch(null, 'demo-physio', id, { automationPaused: !before })).status).toBe(401);
    expect((await patch(await login('staff@test'), 'demo-physio', id, { automationPaused: !before }, false)).status).toBe(403);
    expect(paused('DEMO_PHYSIO', id)).toBe(before);
  });
  it('a user of another clinic cannot touch this clinic’s conversations', async () => {
    const id = firstId('DEMO_PHYSIO');
    const before = paused('DEMO_PHYSIO', id);
    const r = await patch(await login('salon@test'), 'demo-physio', id, { automationPaused: !before });
    expect(r.status).toBe(404);
    expect(paused('DEMO_PHYSIO', id)).toBe(before);
  });
  it('a conversation id from another clinic does not resolve inside this one', async () => {
    const salonOnly = (docs.DEMO_SALON!.Conversations as Array<{ id: number }>).map((r) => r.id).filter((i) => !(docs.DEMO_PHYSIO!.Conversations as Array<{ id: number }>).some((p) => p.id === i));
    const id = salonOnly[0] ?? 99999;
    expect((await patch(await login('staff@test'), 'demo-physio', id, { automationPaused: true })).status).toBe(404);
  });
  it('rejects a non-boolean value', async () => {
    expect((await patch(await login('staff@test'), 'demo-physio', firstId('DEMO_PHYSIO'), { automationPaused: 'yes' })).status).toBe(400);
  });
});

describe('W13 suppression (the automation reads the same field)', () => {
  const ai = createRequire(import.meta.url)('../../n8n/snippets/ai-receptionist.js') as { aiGates: (c: Record<string, unknown>) => { route: string; reason?: string } };
  // a plain, answerable patient message that passes every other gate
  const base = { failed: '', dry_run: false, not_inbound: false, ai_status: '', text: 'How much does a session cost?', ai_mode: 'auto', opted_out: false, paused: false, needs_human: false, after_handoff: false, answered_after: false, newer_inbound: false, staff_active: false, night: false, msg_type: 'text', ai_replies_last_hour: 0, max_per_hour: 6 };
  it('Human handling on: the incoming message is skipped, no AI reply', () => {
    const g = ai.aiGates({ ...base, paused: true });
    expect(g.route).toBe('skip');
    expect(g.reason).toMatch(/paused/);
  });
  it('Human handling off: the same message goes to the AI again', () => {
    expect(ai.aiGates({ ...base, paused: false }).route).toBe('ai');
  });
  it('it also holds after an earlier W13 hand-off, where Needs_Human alone would let a newer message through', () => {
    expect(ai.aiGates({ ...base, needs_human: true, after_handoff: true, paused: false }).route).toBe('ai');
    expect(ai.aiGates({ ...base, needs_human: true, after_handoff: true, paused: true }).route).toBe('skip');
  });
});
