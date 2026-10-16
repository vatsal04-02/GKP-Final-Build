// FLOW HQ API (the BFF). The browser talks only to this; this talks to the backend adapter. No backend credential, document id,
// phone-number id or workflow secret is ever put in a response.
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AutomationKey, BookingStatus, IndustryKey, Workspace } from '../core/domain';
import { INDUSTRIES, INDUSTRY_KEYS } from '../core/industries';
import { resolveProfile } from '../core/registry';
import { BackendError } from './grist';
import type { BackendAdapter, Ctx, WorkspaceBackend } from './adapters/types';
import { COOKIE, canAccess, loginAllowed, loginFailed, loginSucceeded, readSession, signSession, verifyPassword, viewerOf, type UserRecord } from './auth';
import type { ProfileStore } from './profiles';
import { recordsRoutes } from './records/routes';

export interface AppDeps {
  adapter: BackendAdapter;
  profiles: ProfileStore;
  users: UserRecord[];
  sessionSecret: string;
  secureCookies: boolean;
  demo: boolean;
  now?: () => number;
}
type Env = { Variables: { user: UserRecord; backend: WorkspaceBackend; ctx: Ctx } };

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || 'W';

export function createApp(d: AppDeps) {
  const app = new Hono<Env>();
  const now = d.now || (() => Date.now());
  const err = (c: Context, status: number, code: string, message: string) => c.json({ error: { code, message } }, status as 400);

  app.onError((e, c) => {
    if (e instanceof BackendError) return c.json({ error: { code: e.code, message: e.message }, ...(e.extra || {}) }, e.status as 400);
    if (e instanceof z.ZodError) return err(c, 400, 'invalid', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    console.error('FLOW HQ API error:', (e as Error).message);
    return err(c, 500, 'internal', 'Something went wrong on the server');
  });

  // security headers on every API response
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
  });
  // CSRF: state-changing calls must carry a custom header (only our own pages can send it)
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('x-flowhq-csrf') !== '1') return err(c, 403, 'csrf', 'Missing request header');
    await next();
  });

  app.get('/api/health', async (c) => {
    const h = await d.adapter.health();
    return c.json({ ok: h.ok, backend: d.adapter.label, detail: h.ok ? h.detail : 'backend not reachable', demo: d.demo }, h.ok ? 200 : 503);
  });

  // ---------------------------------------------------------------- session
  app.post('/api/auth/login', async (c) => {
    const body = z.object({ email: z.string().min(3).max(200), password: z.string().min(1).max(200) }).parse(await c.req.json());
    const email = body.email.trim().toLowerCase();
    const key = `${c.req.header('x-forwarded-for') || 'local'}|${email}`;
    if (!loginAllowed(key)) return err(c, 429, 'rate_limited', 'Too many attempts. Try again in 15 minutes.');
    const u = d.users.find((x) => x.email === email);
    if (!u || !verifyPassword(body.password, u.passwordHash)) { loginFailed(key); return err(c, 401, 'bad_login', 'Email or password is not correct'); }
    loginSucceeded(key);
    setCookie(c, COOKIE, signSession(u.email, d.sessionSecret), { httpOnly: true, sameSite: 'Lax', secure: d.secureCookies, path: '/', maxAge: 12 * 3600 });
    return c.json({ user: viewerOf(u) });
  });
  app.post('/api/auth/logout', (c) => { deleteCookie(c, COOKIE, { path: '/' }); return c.json({ ok: true }); });

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path === '/api/auth/login' || c.req.path === '/api/auth/logout') return next();
    const email = readSession(getCookie(c, COOKIE), d.sessionSecret, now());
    const u = email ? d.users.find((x) => x.email === email) : undefined;
    if (!u) return err(c, 401, 'signed_out', 'Please sign in');
    c.set('user', u);
    await next();
  });

  app.get('/api/me', async (c) => {
    const u = c.get('user');
    const all = await d.adapter.listWorkspaces();
    const list = all.filter((w) => canAccess(u, w.id)).map((w) => {
      const p = d.profiles.get(w.id);
      const name = p.displayName || w.name;
      return { id: w.id, name, initials: initials(name), industry: p.industry, logoUrl: p.logoUrl || null };
    });
    return c.json({ user: viewerOf(u), workspaces: list, demo: d.demo, industries: INDUSTRY_KEYS.map((k) => ({ key: k, label: INDUSTRIES[k].label, description: INDUSTRIES[k].description })) });
  });

  // ---------------------------------------------------------------- workspace scope
  app.use('/api/w/:ws/*', async (c, next) => {
    const u = c.get('user');
    const ws = c.req.param('ws');
    if (!canAccess(u, ws)) return err(c, 404, 'not_found', 'Workspace not found');
    const backend = await d.adapter.workspace(ws);
    if (!backend) return err(c, 404, 'not_found', 'Workspace not found');
    c.set('backend', backend);
    c.set('ctx', { viewer: viewerOf(u), now: now() });
    await next();
  });
  const B = (c: Context<Env>) => c.get('backend');
  const X = (c: Context<Env>) => c.get('ctx');
  const admin = (c: Context<Env>) => { if (c.get('ctx').viewer.role !== 'admin') throw new BackendError(403, 'forbidden', 'Only an admin can do this'); };

  async function workspaceView(backend: WorkspaceBackend, ctx: Ctx): Promise<Workspace> {
    const p = d.profiles.get(backend.info.id);
    const r = resolveProfile(p, backend.supported);
    const name = p.displayName || backend.info.name;
    return {
      id: backend.info.id, name, logoUrl: p.logoUrl || null, initials: initials(name), industry: p.industry,
      terminology: r.terminology, modules: r.modules, automations: r.automations, dashboardMetrics: r.dashboardMetrics,
      timezone: backend.info.timezone, locale: backend.info.locale, currency: backend.info.currency,
      backend: { adapter: d.adapter.key, label: d.adapter.label, capabilities: await backend.capabilities(ctx.viewer), modules: backend.supported.modules },
      demo: d.demo,
    };
  }
  app.get('/api/w/:ws/workspace', async (c) => c.json(await workspaceView(B(c), X(c))));
  app.patch('/api/w/:ws/profile', async (c) => {
    admin(c);
    const body = z.object({
      industry: z.enum(INDUSTRY_KEYS as [IndustryKey, ...IndustryKey[]]).optional(),
      displayName: z.string().max(80).optional(),
      logoUrl: z.string().max(500).optional(),
      terminology: z.record(z.any()).optional(),
      modules: z.object({ enable: z.array(z.string()).max(30).optional(), disable: z.array(z.string()).max(30).optional() }).optional(),
    }).parse(await c.req.json());
    try { d.profiles.update(B(c).info.id, body as Parameters<ProfileStore['update']>[1]); } catch (e) { throw new BackendError(400, 'invalid', (e as Error).message); }
    return c.json(await workspaceView(B(c), X(c)));
  });

  app.get('/api/w/:ws/dashboard', async (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days') || 7), 1), 90);
    return c.json(await B(c).dashboard(days, X(c)));
  });

  app.get('/api/w/:ws/contacts', async (c) => c.json(await B(c).contacts({ q: c.req.query('q'), status: c.req.query('status'), stage: c.req.query('stage'), attention: c.req.query('attention') === '1' }, X(c))));
  app.get('/api/w/:ws/contacts/:id', async (c) => {
    const r = await B(c).contact(c.req.param('id'), X(c));
    return r ? c.json(r) : err(c, 404, 'not_found', 'Not found');
  });
  app.patch('/api/w/:ws/contacts/:id', async (c) => {
    const body = z.object({ status: z.enum(['new', 'contacted', 'booked', 'converted', 'lost']).optional(), owner: z.string().max(80).optional(), notes: z.string().max(2000).optional(), nextActionAt: z.string().max(40).nullable().optional() }).parse(await c.req.json());
    return c.json(await B(c).updateContact(c.req.param('id'), body, X(c)));
  });

  app.get('/api/w/:ws/conversations', async (c) => c.json(await B(c).conversations({ filter: (c.req.query('filter') || 'all') as 'all', q: c.req.query('q') }, X(c))));
  app.get('/api/w/:ws/conversations/:id', async (c) => {
    const r = await B(c).conversation(c.req.param('id'), X(c));
    return r ? c.json(r) : err(c, 404, 'not_found', 'Not found');
  });
  app.post('/api/w/:ws/conversations/:id/reply', async (c) => {
    const body = z.object({ body: z.string().min(1).max(4096) }).parse(await c.req.json());
    return c.json(await B(c).reply(c.req.param('id'), body.body, X(c)), 201);
  });
  app.patch('/api/w/:ws/conversations/:id', async (c) => {
    const body = z.object({ assignedTo: z.string().max(80).optional(), automationPaused: z.boolean().optional(), resolveAttention: z.boolean().optional(), markRead: z.boolean().optional() }).parse(await c.req.json());
    return c.json(await B(c).updateConversation(c.req.param('id'), body, X(c)));
  });

  app.get('/api/w/:ws/bookings', async (c) => c.json(await B(c).bookings({ view: (c.req.query('view') || 'upcoming') as 'upcoming', q: c.req.query('q') }, X(c))));
  app.patch('/api/w/:ws/bookings/:id', async (c) => {
    const body = z.object({ status: z.enum(['completed', 'no_show']) }).parse(await c.req.json());
    return c.json(await B(c).updateBooking(c.req.param('id'), body.status as BookingStatus, X(c)));
  });

  app.get('/api/w/:ws/automations', async (c) => {
    const ws = await workspaceView(B(c), X(c));
    return c.json((await B(c).automations(X(c))).filter((a) => ws.automations.includes(a.key)));
  });
  app.patch('/api/w/:ws/automations/:key', async (c) => {
    admin(c);
    const body = z.object({ value: z.string().max(20) }).parse(await c.req.json());
    return c.json(await B(c).setAutomation(c.req.param('key') as AutomationKey, body.value, X(c)));
  });

  app.get('/api/w/:ws/tasks', async (c) => c.json(await B(c).tasks(X(c))));
  app.get('/api/w/:ws/activity', async (c) => c.json(await B(c).activity({ kind: (c.req.query('kind') || '') as '', contactId: c.req.query('contact') || undefined, limit: Number(c.req.query('limit') || 100) }, X(c))));
  app.get('/api/w/:ws/reports', async (c) => c.json(await B(c).reports(X(c))));
  app.get('/api/w/:ws/analytics', async (c) => c.json(await B(c).analytics(c.req.query('week') === 'this' ? 'this' : 'last', X(c))));
  app.get('/api/w/:ws/ai', async (c) => c.json(await B(c).ai(X(c))));
  app.get('/api/w/:ws/knowledge', async (c) => c.json(await B(c).knowledge(X(c))));
  app.post('/api/w/:ws/knowledge', async (c) => {
    const body = z.object({ title: z.string().min(1).max(200), category: z.string().max(40).optional(), content: z.string().min(1).max(4000), active: z.boolean().optional() }).parse(await c.req.json());
    return c.json(await B(c).saveKnowledge(body, X(c)), 201);
  });
  app.patch('/api/w/:ws/knowledge/:id', async (c) => {
    const body = z.object({ title: z.string().min(1).max(200).optional(), category: z.string().max(40).optional(), content: z.string().min(1).max(4000).optional(), active: z.boolean().optional() }).parse(await c.req.json());
    return c.json(await B(c).saveKnowledge({ ...body, id: c.req.param('id') }, X(c)));
  });
  app.get('/api/w/:ws/settings', async (c) => {
    const s = await B(c).settings(X(c));
    const ws = B(c).info.id;
    s.team.users = d.users.filter((u) => canAccess(u, ws)).map((u) => ({ name: u.name, email: u.email, role: u.role }));
    return c.json(s);
  });
  app.patch('/api/w/:ws/settings', async (c) => {
    const body = z.object({ values: z.record(z.string().max(2000)) }).parse(await c.req.json());
    const s = await B(c).updateSettings(body.values, X(c));
    s.team.users = d.users.filter((u) => canAccess(u, B(c).info.id)).map((u) => ({ name: u.name, email: u.email, role: u.role }));
    return c.json(s);
  });

  app.route('/api/w/:ws', recordsRoutes());      // patients, prescriptions, invoices, payments, visits (only live when the clinic doc has the records tables)

  app.all('/api/*', (c) => err(c, 404, 'not_found', 'No such API route'));
  return app;
}
