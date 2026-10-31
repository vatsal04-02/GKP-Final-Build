// Real-Grist integration harness. NOTHING here runs unless REAL_GRIST_URL and REAL_GRIST_KEY_FILE are set (see docs/staging-environment.md), so the normal
// `npm test` is unaffected. It talks to a THROWAWAY Grist (a local Docker container with synthetic data: never a clinic's Grist), creates its own documents,
// and starts the REAL FLOW HQ server (src/server/index.ts) as a child process, exactly as production runs it, with a real audit-outbox directory.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { GristClient } from '../../src/server/grist';
import { provision } from '../../src/server/records/provision';
import { provisionBooking } from '../../src/server/booking/provision';
import { provisionPayments } from '../../src/server/payments/provision';
import { seedBooking } from '../../src/server/booking/seed';
import { newToken, type TokenRecord } from '../../src/server/booking/tokens';
import { hashPassword } from '../../src/server/auth';

export const REAL_URL = (process.env.REAL_GRIST_URL || '').replace(/\/+$/, '');
export const REAL_ENABLED = !!REAL_URL && !!process.env.REAL_GRIST_KEY_FILE;
const key = () => readFileSync(process.env.REAL_GRIST_KEY_FILE!, 'utf8').trim();
export const PW = 'correct horse 42';

const T = (id: string, fields: Record<string, unknown> = {}) => ({ id, fields: { type: 'Text', label: id, ...fields } });
const DT = (id: string) => T(id, { type: 'DateTime:Asia/Kolkata' });
const choice = (id: string, choices: string[]) => T(id, { type: 'Choice', widgetOptions: JSON.stringify({ choices }) });
const bool = (id: string) => T(id, { type: 'Bool' });

/** The Clinic CRM template tables the booking provisioning expects to exist already (grist/schema.md), as columns for the REST API. */
const BASE: Record<string, Array<ReturnType<typeof T>>> = {
  LEADS: [T('Lead_id'), DT('Created_At'), T('Name'), T('Phone'), choice('Source', ['Website', 'WhatsApp', 'Instagram', 'Call', 'Walk-in', 'Referral']), T('Page_URL'), T('UTM_Campaign'), T('Enquiry'), T('AI_Summary'), T('Likely_Service'),
    choice('Status', ['New', 'Contacted', 'Booked', 'Converted', 'Lost']), T('Owner'), DT('Next_Action_At'), DT('First_Response_At'), bool('Opted_Out'), bool('Escalated'), bool('Followup_Sent'), T('Notes'), choice('Lead_Stage', ['cold', 'warm', 'hot']),
    bool('Consent_WhatsApp'), T('Consent_Source'), DT('Consent_At')],
  Appointments: [T('Booking_UID'), T('Lead', { type: 'Ref:LEADS' }), T('Service'), T('Physio'), DT('Start'), DT('End'), choice('Status', ['Booked', 'Rescheduled', 'Cancelled', 'Completed', 'No-show']), T('Fee_INR', { type: 'Numeric' }),
    DT('R24_Sent'), DT('R2_Sent'), DT('Rebook_Sent'), DT('Review_Sent'), DT('Outcome_Sent'), DT('Requested_At'), DT('Confirm_Sent')],
  Settings: [T('Key'), T('Value')],
  Conversations: [T('Lead', { type: 'Ref:LEADS' }), T('Phone'), DT('Last_Inbound_At'), T('Unread', { type: 'Int' }), bool('Automation_Paused'), T('Assigned_To'), bool('Needs_Human'), T('Handoff_Reason'), T('Last_Intent')],
  Messages: [T('Conversation', { type: 'Ref:Conversations' }), choice('Direction', ['In', 'Out']), T('Body'), T('Template'), T('Sent_By'), T('WA_Message_ID'), choice('Status', ['queued', 'needs_template', 'sent', 'delivered', 'read', 'failed', 'Received']), bool('Send'), DT('Created_At'),
    T('Intent'), T('AI_Action'), T('AI_Confidence', { type: 'Numeric' }), choice('AI_Status', ['processing', 'replied', 'drafted', 'handed_off', 'no_reply', 'skipped', 'opted_out', 'deferred', 'failed', 'dry_run']), bool('Needs_Human'), T('AI_Reply'), T('AI_Reason')],
  Run_Log: [T('Workflow'), T('Record'), choice('Outcome', ['ok', 'skipped', 'failed']), T('Error'), DT('At')],
  Knowledge: [T('Title'), choice('Category', ['services', 'pricing', 'hours', 'location', 'policy', 'faq', 'general']), T('Content'), bool('Active')],
};

export interface Staging { client: GristClient; registryDocId: string; clinicDocId: string; slug: string; workspaceId: number; log: string[] }

async function raw(method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(`${REAL_URL}${p}`, { method, headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); if (!r.ok) throw new Error(`Grist ${method} ${p.split('?')[0]} -> ${r.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

export async function newClient() { return new GristClient(REAL_URL, key(), fetch as never, 20000, 4); }

/** Creates two NEW documents (registry + clinic) in the staging user's first workspace, builds the base tables, provisions + seeds the booking tables. Returns their ids. */
export async function createStaging(slug = 'staging-physio', opts: { seed?: boolean; bookingOn?: boolean; provision?: boolean } = {}): Promise<Staging> {
  const client = await newClient(); const log: string[] = [];
  const orgs = await raw('GET', '/api/orgs'); const org = orgs.find((o: any) => o.access === 'owners') || orgs[0];
  const ws = await raw('GET', `/api/orgs/${org.id}/workspaces`); const workspaceId = ws[0].id as number;
  const stamp = Date.now().toString(36);
  const clinicDocId = await raw('POST', `/api/workspaces/${workspaceId}/docs`, { name: `STAGING clinic ${slug} ${stamp}` }) as string;
  const registryDocId = await raw('POST', `/api/workspaces/${workspaceId}/docs`, { name: `STAGING registry ${stamp}` }) as string;
  // a new doc starts with one default table: remove nothing (it is ours and throwaway), just add what we need
  await client.createTable(registryDocId, 'Clinics', [T('Clinic_Slug'), T('Clinic_Name'), T('Grist_Doc_ID'), T('WA_Phone_Number_ID'), bool('Active'), T('Call_Number')]);
  await client.add(registryDocId, 'Clinics', [{ Clinic_Slug: slug, Clinic_Name: 'Staging Physio', Grist_Doc_ID: clinicDocId, WA_Phone_Number_ID: '', Active: true, Call_Number: '' }]);
  for (const [name, cols] of Object.entries(BASE)) await client.createTable(clinicDocId, name, cols);
  await provision(client, clinicDocId, true, (l) => log.push(l));   // Clinic Records (Patients ...)
  if (opts.provision === false) return { client, registryDocId, clinicDocId, slug, workspaceId, log };   // a clinic document as the CRM template leaves it: NO booking tables yet (the operator provisions it)
  const pb = await provisionBooking(client, clinicDocId, true, (l) => log.push(l)); if (!pb.appointmentsFound) throw new Error('Appointments table missing after setup');
  await provisionPayments(client, clinicDocId, true, (l) => log.push(l));   // Booking_Payments, Payment_Events, Payment_Files (additive)
  if (opts.seed !== false) {
    await seedBooking(client, clinicDocId, true, (l) => log.push(l));
    const cfg = await client.records(clinicDocId, 'Booking_Config'); const row = cfg.find((r) => r.fields.Key === 'booking_enabled');
    if (row) await client.update(clinicDocId, 'Booking_Config', [{ id: row.id, fields: { Value: opts.bookingOn ? 'on' : 'off' } }]);
    await client.add(clinicDocId, 'Settings', [{ Key: 'clinic_name', Value: 'Staging Physio' }, { Key: 'TEST_MODE', Value: 'true' }]);
  }
  return { client, registryDocId, clinicDocId, slug, workspaceId, log };
}

/** Prepares the staging clinic document for the REAL n8n workflows: the production migration (n8n/production/scripts/migrate-grist.js, run for real against the real Grist: Send_Ledger + the consent columns),
 *  the WhatsApp phone_number_id in the registry, and the Settings / Knowledge rows the workflows read. Returns the migration's own output (no secrets in it). */
export async function prepareForN8n(s: Staging, o: { settings?: Record<string, string> } = {}): Promise<string> {
  const { spawnSync } = await import('node:child_process');
  const script = path.resolve('..', 'n8n', 'production', 'scripts', 'migrate-grist.js');
  const r = spawnSync(process.execPath, [script, '--doc', s.clinicDocId, '--apply'], { env: { ...process.env, FLOWHQ_GRIST_URL: REAL_URL, FLOWHQ_GRIST_API_KEY: key() }, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`; if (r.status !== 0) throw new Error(`migrate-grist failed (${r.status}): ${out.slice(-500)}`);
  const reg = (await s.client.records(s.registryDocId, 'Clinics'))[0]!; await s.client.update(s.registryDocId, 'Clinics', [{ id: reg.id, fields: { WA_Phone_Number_ID: '123456789012345' } }]);
  const settings: Record<string, string> = { clinic_name: 'Staging Physio', ai_mode: 'auto', TEST_MODE: 'false', TEST_PHONE: '+919000000019', owner_phone: '+919000000018', booking_link: 'https://www.staging-physio.example/book', ...o.settings };
  const have = await s.client.records(s.clinicDocId, 'Settings');
  for (const [k, v] of Object.entries(settings)) { const row = have.find((x) => x.fields.Key === k); if (row) await s.client.update(s.clinicDocId, 'Settings', [{ id: row.id, fields: { Value: v } }]); else await s.client.add(s.clinicDocId, 'Settings', [{ Key: k, Value: v }]); }
  await s.client.add(s.clinicDocId, 'Knowledge', [{ Title: 'Knee pain physiotherapy', Category: 'services', Content: '₹800 per session (45 minutes)', Active: true }, { Title: 'First assessment', Category: 'pricing', Content: '₹500 (45 minutes)', Active: true }]);
  return out;
}

export async function deleteStaging(s: Staging) { for (const d of [s.clinicDocId, s.registryDocId]) { try { await s.client.deleteDoc(d); } catch { /* already gone */ } } }

const freePort = () => new Promise<number>((res, rej) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => res(p)); }); srv.on('error', rej); });

export interface Server { port: number; base: string; proc: ChildProcess; outboxDir: string; configDir: string; token: string; tokenRecord: TokenRecord; stdout: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; stop: (sig?: NodeJS.Signals) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>; api: (p: string, o?: Req) => Promise<Res>; staff: (who: 'admin' | 'desk', p: string, o?: Req) => Promise<Res> }
export interface Req { method?: string; body?: unknown; headers?: Record<string, string>; token?: string | null }
export interface Res { status: number; json: any; text: string }

/** Starts the REAL server process against the staging Grist. Same code path as production (src/server/index.ts). `outboxDir` / `configDir` can be reused to simulate a restart. */
export async function startServer(s: Staging, o: { outboxDir?: string; configDir?: string; env?: Record<string, string>; tokens?: TokenRecord[]; extraTokens?: TokenRecord[]; reuse?: Server; startTimeoutMs?: number; port?: number; freshPort?: boolean } = {}): Promise<Server> {
  const configDir = o.configDir || o.reuse?.configDir || mkdtempSync(path.join(os.tmpdir(), 'flowhq-real-')); const outboxDir = o.outboxDir || o.reuse?.outboxDir || path.join(configDir, 'audit-outbox');
  const full = o.reuse ? { token: o.reuse.token, record: o.reuse.tokenRecord } : newToken('n8n-staging', s.slug); const tokens = o.tokens || [full.record, ...(o.extraTokens || [])];   // `reuse` = a RESTART of the same installation: same token, same directories
  const h = hashPassword(PW);
  const users = [{ email: 'admin@test', name: 'Owner', role: 'admin', workspaces: ['*'], passwordHash: h }, { email: 'desk@test', name: 'Front desk', role: 'staff', workspaces: ['*'], passwordHash: h }];
  const port = o.port ?? (o.reuse && !o.freshPort ? o.reuse.port : await freePort());   // a RESTART keeps its port (n8n is configured with the address); a second CONCURRENT instance needs freshPort
  // the repo ships a TypeScript source: run it the way `npm run dev:server` does (tsx), from the flowhq directory
  const env = { ...process.env, PORT: String(port), GRIST_BASE_URL: REAL_URL, GRIST_API_KEY: key(), GRIST_REGISTRY_DOC_ID: s.registryDocId, FLOWHQ_SESSION_SECRET: 'staging-session-secret-0123456789abcdef-xyz', FLOWHQ_SECURE_COOKIES: 'false', FLOWHQ_USERS: JSON.stringify(users),
    FLOWHQ_BOOKING_TOKENS: JSON.stringify(tokens), FLOWHQ_AUDIT_OUTBOX_DIR: outboxDir, FLOWHQ_PAYMENT_FILES_DIR: path.join(configDir, 'payment-files'), FLOWHQ_AUDIT_REQUIRE_VOLUME: 'false', FLOWHQ_TRUST_PROXY: 'false', FLOWHQ_CLINIC_FILE: path.resolve('config/clinic.json'), FLOWHQ_STATIC_DIR: path.join(configDir, 'no-static'), FLOWHQ_DEMO: '', NODE_ENV: 'test', ...o.env } as NodeJS.ProcessEnv;
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { cwd: path.resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout!.on('data', (d) => { out += d; }); proc.stderr!.on('data', (d) => { out += d; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => proc.on('exit', (code, signal) => res({ code, signal })));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode}): ${out.slice(-600)}`);
    try { const r = await fetch(`${base}/api/health`); if (r.status < 500) break; } catch { /* not up yet */ }
    if (i > (o.startTimeoutMs ?? 30000) / 200) { proc.kill('SIGKILL'); throw new Error(`server did not start: ${out.slice(-600)}`); }
    await new Promise((r) => setTimeout(r, 200));
  }
  const parse = async (r: Response): Promise<Res> => { const text = await r.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ } return { status: r.status, json, text }; };
  const cookies: Record<string, string> = {};
  const login = async (who: 'admin' | 'desk') => { const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-flowhq-csrf': '1' }, body: JSON.stringify({ email: `${who}@test`, password: PW }) }); if (r.status !== 200) throw new Error(`login ${who} -> ${r.status}`); cookies[who] = r.headers.get('set-cookie')!.split(';')[0]!; };
  const api = async (p: string, x: Req = {}) => parse(await fetch(`${base}/api/booking${p}`, { method: x.method || 'GET', headers: { ...(x.token === null ? {} : { authorization: `Bearer ${x.token ?? full.token}` }), ...(x.body !== undefined ? { 'content-type': 'application/json' } : {}), ...x.headers }, body: x.body === undefined ? undefined : JSON.stringify(x.body) }));
  const staff = async (who: 'admin' | 'desk', p: string, x: Req = {}) => { if (!cookies[who]) await login(who); return parse(await fetch(`${base}/api/w/${s.slug}/schedule${p}`, { method: x.method || 'GET', headers: { cookie: cookies[who]!, 'x-flowhq-csrf': '1', ...(x.body !== undefined ? { 'content-type': 'application/json' } : {}), ...x.headers }, body: x.body === undefined ? undefined : JSON.stringify(x.body) })); };
  const stop = async (sig: NodeJS.Signals = 'SIGTERM') => { if (proc.exitCode === null && proc.signalCode === null) proc.kill(sig); return exited; };
  return { port, base, proc, outboxDir, configDir, token: full.token, tokenRecord: full.record, stdout: () => out, exited, stop, api, staff };
}

/** A weekday (Mon-Sat) at least `ahead` days from the real clock, as YYYY-MM-DD in Asia/Kolkata: the server uses the real clock, so test slots must be in the future. */
export function futureDay(ahead = 4, nth = 0): string {
  const istNow = new Date(Date.now() + 5.5 * 3600e3); let found = -1; let d = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + ahead));
  for (;;) { if (d.getUTCDay() !== 0) { found++; if (found === nth) break; } d = new Date(d.getTime() + 86400e3); }
  return d.toISOString().slice(0, 10);
}
export const slotId = (doctor: string, date: string, hhmm: string) => `${doctor}|${date}|${hhmm}`;
export const writeFile = (p: string, t: string) => writeFileSync(p, t);
