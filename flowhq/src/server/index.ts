// FLOW HQ server: the API (BFF) + the built web app, one process. Run behind HTTPS (Caddy) in production.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { createApp } from './app';
import { loadConfig } from './config';
import { hashPassword, loadUsers, type UserRecord } from './auth';
import { ProfileStore } from './profiles';
import { createAutopilotAdapter } from './adapters/autopilot';
import { memoryGrist } from './grist';
import { demoDocs } from './demo/fixtures';
import { startStaffReplySimulator } from './demo/simulator';
import { loadClinicConfig } from './clinic';
import { TokenStore, loadTokens } from './booking/tokens';
import { RECORD_TABLE_NAMES, STAFF_TABLE_NAMES } from './records/schema';
import { startAuditOutboxes } from './audit-startup';

export function buildServer(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadConfig(env);
  const clinic = loadClinicConfig(cfg.clinicFile);
  let adapter;
  let profiles: ProfileStore;
  let users: UserRecord[];
  if (cfg.demo) {
    const { docs, profiles: seed } = demoDocs(Date.now());
    // demo: Clinic Records for the demo PHYSIO clinic only (provisioned per clinic): the fictional patients seeded by demo/fixtures; anything entered lives in memory only
    const physioDoc = String(docs.REGISTRY?.Clinics?.find((r) => r.fields.Clinic_Slug === 'demo-physio')?.fields.Grist_Doc_ID || '');
    if (docs[physioDoc]) for (const t of [...RECORD_TABLE_NAMES, ...STAFF_TABLE_NAMES]) docs[physioDoc][t] ||= [];
    const mem = memoryGrist(docs);
    adapter = createAutopilotAdapter({ gristBaseUrl: 'http://memory', gristApiKey: '', registryDocId: 'REGISTRY', timezone: cfg.timezone, locale: cfg.locale, currency: cfg.currency, fetchImpl: mem, clinic, cacheMs: 1000 });
    profiles = new ProfileStore(null, cfg.defaultIndustry, seed);
    users = [
      { email: 'admin@flowhq.demo', name: 'Alex (admin)', role: 'admin', workspaces: ['*'], passwordHash: hashPassword('demo1234') },
      { email: 'staff@flowhq.demo', name: 'Sam', role: 'staff', workspaces: ['*'], passwordHash: hashPassword('demo1234') },
    ];
    startStaffReplySimulator(docs);
  } else {
    adapter = createAutopilotAdapter({ gristBaseUrl: cfg.grist.baseUrl, gristApiKey: cfg.grist.apiKey, registryDocId: cfg.grist.registryDocId, payments: { filesDir: cfg.paymentFilesDir, qrDir: cfg.paymentQrDir, webhookSecret: cfg.paymentWebhookSecret }, auditOutbox: { dir: cfg.auditOutboxDir, requireVolume: cfg.auditRequireVolume, breakGlass: cfg.auditBreakGlass }, leadsTable: cfg.grist.leadsTable, timezone: cfg.timezone, locale: cfg.locale, currency: cfg.currency, clinic, allowCreate: true });
    profiles = new ProfileStore(cfg.workspacesFile, cfg.defaultIndustry);
    users = loadUsers(cfg.usersFile, cfg.usersJson);
    if (!users.length) throw new Error('No FLOW HQ users: create config/users.json (see README) or set FLOWHQ_USERS');
  }
  // Service tokens for the n8n booking API. Demo mode has none (the booking API stays closed there).
  const bookingTokens = new TokenStore(cfg.demo ? [] : loadTokens(cfg.bookingTokensFile, cfg.bookingTokensJson));
  const api = createApp({ adapter, profiles, users, sessionSecret: cfg.sessionSecret, secureCookies: cfg.secureCookies, demo: cfg.demo, bookingTokens, trustProxy: cfg.trustProxy });
  const root = new Hono();
  root.use('*', async (c, next) => {
    await next();
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    c.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  });
  root.route('/', api);
  if (existsSync(cfg.staticDir)) {
    // built files have a content hash in their name: the browser may keep them for good. Logos keep their name, so a day only.
    root.use('/assets/*', async (c, next) => { await next(); if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable'); });
    root.use('/brand/*', async (c, next) => { await next(); if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=86400'); });
    root.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), cfg.staticDir) }));
    root.use('/brand/*', serveStatic({ root: path.relative(process.cwd(), cfg.staticDir) }));
    root.get('/favicon.svg', serveStatic({ path: path.relative(process.cwd(), path.join(cfg.staticDir, 'favicon.svg')) }));
    const index = readFileSync(path.join(cfg.staticDir, 'index.html'), 'utf8');
    root.get('*', (c) => c.html(index));
  }
  return { app: root, cfg, adapter };
}

if (process.argv[1] && /index\.(ts|js)$/.test(process.argv[1])) {
  const { app, cfg, adapter } = buildServer();
  serve({ fetch: app.fetch, port: cfg.port }, (i) => console.log(`FLOW HQ on http://localhost:${i.port}${cfg.demo ? ' (DEMO data)' : ''}`));

  // Audit outbox: open each workspace's outbox now (not on the first booking), recover anything a crash left half-finished, and keep flushing.
  // On a stop signal, finish and release the outbox lock so the next container starts cleanly. Demo mode has a volatile outbox and nothing to recover.
  // It keeps retrying (start-up can beat Grist after a backup or a reboot) instead of staying red until a manual restart: src/server/audit-startup.ts.
  const outboxes = cfg.demo ? null : startAuditOutboxes(adapter);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { void (outboxes ? outboxes.stop() : Promise.resolve()).finally(() => process.exit(0)); });
}
