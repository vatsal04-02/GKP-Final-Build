// STAGING JOURNEY: a REAL n8n (the repo's 4C workflow candidate, imported through n8n's own CLI into a throwaway instance) + a REAL Grist (throwaway container) + the REAL FLOW HQ server
// process. The ONLY stand-ins are the two outside services we cannot call for real here:
//   * WhatsApp / Meta: a local HTTP stub that records every send (no authorised test number or Meta credential exists, so NOTHING reaches WhatsApp: this is NOT a WhatsApp test);
//   * the AI model: a deterministic stub (n8n/tests/ai-fixtures.js style) that returns fixed decisions: this tests the workflow around the model, NOT the model's judgement.
// Needs Linux with n8n installed: run it with flowhq/deploy/staging/run-staging-n8n.ps1 (image gkp-staging-n8n:local). Skipped everywhere else.
// The 12 steps of the patient journey are the 12 `it`s below, in order.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REAL_ENABLED, REAL_URL, createStaging, deleteStaging, futureDay, prepareForN8n, startServer, type Server, type Staging } from './harness';

const req = createRequire(import.meta.url);
const N8N_TESTS = path.resolve('..', 'n8n', 'production', 'tests', 'real');
const ready = REAL_ENABLED && !!process.env.N8N_RUNTIME_DIR && fs.existsSync(path.join(process.env.N8N_RUNTIME_DIR || '/nope', 'node_modules', '.bin', 'n8n')) && fs.existsSync(path.join(N8N_TESTS, 'n8n-real.js'));
const d = describe.skipIf(!ready);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = () => fs.readFileSync(process.env.REAL_GRIST_KEY_FILE!, 'utf8').trim();
const PATIENT = '+919000020001'; const PATIENT_DIGITS = PATIENT.slice(1); const OWNER = '+919000000018';
const KEYS = { app: 'staging-app-secret-0123456789abcdef', verify: 'staging-verify-token-0123456789', w1: 'staging-w1-secret-0123456789abcdef', wa: 'staging-wa-token-0123456789', ai: 'staging-ai-key-0123456789', tg: '123456789:staging-telegram-token-abcdefghij0123456', cal: 'staging-cal-secret-0123456789abcdef' };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const dayWord = (iso: string) => WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()]!;
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }).replace(',', '');   // "Thu 05 Nov"

// ---------------------------------------------------------------- the two stand-ins
function listen(server: http.Server) { return new Promise<number>((res) => server.listen(0, '127.0.0.1', () => res((server.address() as { port: number }).port))); }
const readBody = (r: http.IncomingMessage) => new Promise<string>((res) => { const c: Buffer[] = []; r.on('data', (x) => c.push(x)); r.on('end', () => res(Buffer.concat(c).toString('utf8'))); });
interface MetaCall { path: string; body: any }
async function startMeta() {
  const calls: MetaCall[] = []; let n = 0;
  const server = http.createServer(async (rq, rs) => {
    const body = JSON.parse((await readBody(rq)) || '{}'); calls.push({ path: rq.url || '', body }); n++;
    rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.STAGING${n}` }] }));
  });
  const port = await listen(server); return { calls, url: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections?.(); server.close(); } };
}
/** The AI stand-in: fixed decisions by the words of the patient's message and the last clinic question in RECENT CONVERSATION. */
async function startAi(F: any) {
  const base = F.BASE_DECISION; const clone = (o: unknown) => JSON.parse(JSON.stringify(o)); const trace: string[] = [];
  const decide = (b: any) => {
    const facts = b.system.map((x: { text: string }) => x.text).join('\n'); const text = String(b.messages[0].content).replace(/<\/?\[?[A-Za-z_]*\]?_?message>/gi, '').trim();   // the redaction layer rewrites the wrapper tag, so strip any <...message> tag
    const recent = facts.slice(Math.max(0, facts.lastIndexOf('RECENT CONVERSATION (oldest first)')));   // the real section, not the mention in the rules
    const lastClinic = [...(recent.match(/^- clinic[^\n]*$/gim) || [])].pop() || '';
    const dateOf = (label: string) => (facts.match(new RegExp(`^- (\\d{4}-\\d{2}-\\d{2}) = \\w+ ${label}`, 'm')) || [])[1] || null;
    const hhmm = (h: string, ap?: string) => { let n = Number(h.split(':')[0]); const m = h.split(':')[1] || '00'; if (ap === 'PM' && n < 12) n += 12; if (ap === 'AM' && n === 12) n = 0; return `${String(n).padStart(2, '0')}:${m}`; };
    const d = clone(base);
    trace.push(`text=${JSON.stringify(text.slice(0, 60))} | RECENT=${JSON.stringify(recent.slice(0, 520))}`);
    if (/^\s*yes/i.test(text)) {
      let m = lastClinic.match(/Shall I book (\w{3} \d{2} \w{3}) at (\d{1,2}:\d{2}) (AM|PM)/);
      if (m) return Object.assign(d, { intent: 'book_appointment', action: 'book_slot', confidence: 0.95, lead_stage: 'hot', booking: { date: dateOf(m[1]!), time: hhmm(m[2]!, m[3]), time_window: null } });
      m = lastClinic.match(/Shall I cancel your appointment on/);
      if (m) return Object.assign(d, { intent: 'cancel_appointment', action: 'cancel_appointment', confidence: 0.95, appointment_ref: 'A1', lead_stage: 'cold' });
      m = lastClinic.match(/Shall I move your appointment from .* to (\w{3} \d{2} \w{3}) at (\d{1,2}:\d{2}) (AM|PM)/);
      if (m) return Object.assign(d, { intent: 'reschedule_appointment', action: 'reschedule_appointment', confidence: 0.95, appointment_ref: 'A1', booking: { date: dateOf(m[1]!), time: hhmm(m[2]!, m[3]), time_window: null } });
    }
    let m = text.match(/book me for (\w+) at (\d+)/i);
    if (m) return Object.assign(d, { intent: 'book_appointment', action: 'book_slot', confidence: 0.95, lead_stage: 'hot', booking: { date: dateOf(`${m[1]}`) || (facts.match(new RegExp(`^- (\\d{4}-\\d{2}-\\d{2}) = ${m[1]!.toLowerCase()}`, 'm')) || [])[1] || null, time: hhmm(`${m[2]}:00`, Number(m[2]) < 9 ? 'PM' : undefined), time_window: null }, reply: 'ok' });
    m = text.match(/move it to (\w+) at (\d+)/i);
    if (m) return Object.assign(d, { intent: 'reschedule_appointment', action: 'reschedule_appointment', confidence: 0.95, appointment_ref: 'A1', booking: { date: (facts.match(new RegExp(`^- (\\d{4}-\\d{2}-\\d{2}) = ${m[1]!.toLowerCase()}`, 'm')) || [])[1] || null, time: hhmm(`${m[2]}:00`), time_window: null }, reply: 'ok' });
    if (/cancel/i.test(text)) return Object.assign(d, { intent: 'cancel_appointment', action: 'cancel_appointment', confidence: 0.95, appointment_ref: 'A1', lead_stage: 'cold', reply: 'ok' });
    return Object.assign(d, { intent: 'greeting', action: 'reply', reply: 'Hello! How can we help you today?', lead_summary: 'Said hello.' });
  };
  const fake = F.fakeOpenRouter(F.fakeClaude((b: unknown) => decide(b)));
  const calls: unknown[] = [];
  const server = http.createServer(async (rq, rs) => { const body = JSON.parse((await readBody(rq)) || '{}'); calls.push(body); const r = fake(rq.method, `https://openrouter.ai${rq.url}`, rq.headers, body); rs.writeHead(r.status, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(r.body)); });
  const port = await listen(server); return { calls, trace, url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

d('STAGING JOURNEY: real n8n + real Grist + real FLOW HQ (WhatsApp and the AI model are stubs)', () => {
  const R = ready ? req(path.join(N8N_TESTS, 'n8n-real.js')) : null; const FX = ready ? req(path.resolve('..', 'n8n', 'tests', 'ai-fixtures.js')) : null;
  const { remap } = ready ? req(path.resolve('..', 'n8n', 'final', 'tools', 'remap-credentials-for-scratch.js')) : { remap: null as never };
  let s: Staging; let flow: Server; let meta: Awaited<ReturnType<typeof startMeta>>; let ai: Awaited<ReturnType<typeof startAi>>; let n8n: any; let dir = '';
  const DAY = futureDay(3); const NEXT = futureDay(3, 1); const WORD = dayWord(DAY); const NEXTWORD = dayWord(NEXT);
  // n8n runs with its clock shifted so that "now" is 11:00 IST (always inside clinic hours). The shift is fixed ONCE, when n8n starts; the time n8n sees is then real time + that shift.
  // (Recomputing it on every call would freeze the clock at 11:00:00 and make every patient message look older than the clinic's replies.)
  const SHIFT_MS = R && R.FAKETIME_LIB ? R.dayShiftSeconds() * 1000 : 0; const clockNow = () => Date.now() + SHIFT_MS;
  const rows = (t: string) => s.client.records(s.clinicDocId, t);
  const patientTexts = () => meta.calls.filter((c) => c.body.to === PATIENT_DIGITS).map((c) => (c.body.type === 'text' ? c.body.text.body as string : `[template ${c.body.template?.name}]`));
  /** What n8n itself recorded about failed executions (its database): the log does not show node errors. Used only to explain a failure. */
  const execErrors = async (): Promise<string> => {
    try {
      const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (p: string, o: { readOnly: boolean }) => { prepare(sql: string): { all(): unknown[] }; close(): void } }; const db = new DatabaseSync(path.join(n8n.userFolder, '.n8n', 'database.sqlite'), { readOnly: true });
      const rowsx = db.prepare("select e.id, e.status, d.data from execution_entity e join execution_data d on d.executionId = e.id order by e.id desc limit 6").all() as Array<{ id: number; status: string; data: string }>; db.close();
      return rowsx.map((r) => `#${r.id} ${r.status}: ${[...new Set((r.data.match(/"([^"]{12,260})"/g) || []).map((x) => x.slice(1, -1)).filter((x) => /error|fail|not set|incomplete|cannot|invalid|unknown|undefined|refused|ECONN|credential/i.test(x) && !/^(node|stack|name)/.test(x)))].slice(0, 5).join(' | ')}`).join('\n');
    } catch (e) { return `(could not read executions: ${(e as Error).message})`; }
  };
  const gristDiag = async (): Promise<string> => {
    const m = (await rows('Messages')).slice(-5).map((r) => `${r.fields.Direction} "${String(r.fields.Body).slice(0, 50)}" st=${r.fields.AI_Status || '-'} act=${r.fields.AI_Action || '-'} why=${String(r.fields.AI_Reason || '').slice(0, 220)}`);
    const l = (await rows('Run_Log')).slice(-4).map((r) => `${r.fields.Workflow}/${r.fields.Outcome}: ${String(r.fields.Record).slice(0, 80)} ${String(r.fields.Error).slice(0, 160)}`);
    return `messages:\n  ${m.join('\n  ')}\nrun_log:\n  ${l.join('\n  ')}\nai stub saw:\n  ${ai.trace.slice(-4).join('\n  ')}`;
  };
  const waitFor = async <T,>(fn: () => Promise<T> | T, ms = 90000, what = 'condition'): Promise<NonNullable<T>> => { const end = Date.now() + ms; let last: unknown; while (Date.now() < end) { try { const v = await fn(); if (v) return v as NonNullable<T>; } catch (e) { last = e; } await sleep(400); } throw new Error(`timed out waiting for ${what}${last ? ` (${(last as Error).message})` : ''}\nfailed executions:\n${await execErrors()}\n${await gristDiag()}\nn8n log tail: ${String(n8n.logTail(9000)).split('\n').filter((l: string) => /error|fail|credential|exception|warn|execution|workflow/i.test(l)).slice(-25).join('\n')}`); };
  const inbound = async (text: string, id: string) => {
    const body = { object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '123456789012345' }, contacts: [{ profile: { name: 'Staging Patient' }, wa_id: PATIENT_DIGITS }], messages: [{ from: PATIENT_DIGITS, id, timestamp: String(Math.floor(clockNow() / 1000)), type: 'text', text: { body: text } }] } }] }] };
    const raw = JSON.stringify(body); const sig = crypto.createHmac('sha256', KEYS.app).update(raw).digest('hex');
    return n8n.request('POST', '/webhook/whatsapp-inbound', { body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${sig}` } });
  };
  /** send a patient message and wait until the clinic has answered it (one more text to the patient) */
  const say = async (text: string, id: string) => { const before = patientTexts().length; const r = await inbound(text, id); expect(r.status, r.text).toBe(200); await waitFor(() => patientTexts().length > before, 90000, `the clinic's answer to "${text}"`); return patientTexts()[patientTexts().length - 1]!; };
  /** assert on the clinic's answer; on a mismatch wait for W13's final record, then fail with the recorded reason */
  const answered = async (text: string, re: RegExp) => { if (re.test(text)) return; await sleep(8000); throw new Error(`unexpected answer "${text}" (wanted ${re})
${await gristDiag()}`); };
  const appts = async () => (await rows('Appointments')).filter((r) => String(r.fields.Booking_UID || '').startsWith('wa-'));
  const noCal = (texts: string[]) => texts.forEach((t) => expect(t).not.toMatch(/cal\.com|\/reschedule\/|cancel=true/i));
  const trigger = (path_: string) => n8n.request('POST', path_, { body: '{}', headers: { 'content-type': 'application/json' } });

  beforeAll(async () => {
    s = await createStaging('staging-physio', { bookingOn: true }); await prepareForN8n(s);
    flow = await startServer(s);
    meta = await startMeta(); ai = await startAi(FX);
    // the workflow under test: the 4C candidate, with credentials re-pointed BY ROLE to the ids create-credentials.js makes (test-only remap), and the W5 schedule trigger replaced by a webhook (STAGING ONLY: a 15-minute schedule cannot be waited for)
    const wf = remap(JSON.parse(fs.readFileSync(path.resolve('..', 'n8n', 'final', 'workflows', process.env.STAGING_WORKFLOW || 'FlowHQ_Clinic_Automation_production_candidate4c.json'), 'utf8'))).wf;   // STAGING_WORKFLOW=FlowHQ_Clinic_Automation_production_candidate4d.json stages the 4D candidate
    const w5 = wf.nodes.find((n: any) => n.name === 'W5 – Every 15 minutes'); Object.assign(w5, { type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: { httpMethod: 'POST', path: 'staging-w5', options: {} }, webhookId: crypto.randomUUID() });
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'stg-n8n-')); const file = path.join(dir, 'workflow.staging.json'); fs.writeFileSync(file, JSON.stringify(wf));
    const env = {
      FLOWHQ_GRIST_URL: REAL_URL, FLOWHQ_REGISTRY_DOC_ID: s.registryDocId, FLOWHQ_DEFAULT_COUNTRY_CODE: '91', FLOWHQ_TEST_PHONE: '+919000000019',
      FLOWHQ_WA_SEND_MODE: 'allowlist', FLOWHQ_WA_ALLOWLIST: `${PATIENT},${OWNER},+919000000019`, FLOWHQ_WA_GRAPH_VERSION: 'v23.0', FLOWHQ_WA_GRAPH_BASE_URL: meta.url, FLOWHQ_WA_TEMPLATE_LANGUAGE: 'en',
      FLOWHQ_META_APP_SECRET: KEYS.app, FLOWHQ_META_VERIFY_TOKEN: KEYS.verify, FLOWHQ_CAL_WEBHOOK_SECRET: KEYS.cal, FLOWHQ_CAL_MAX_AGE_HOURS: '24', FLOWHQ_ALERT_EMAIL_TO: '', FLOWHQ_EMAIL_FROM: 'noreply@clinic.example',
      FLOWHQ_AI_EXTERNAL_ENABLED: 'true', FLOWHQ_AI_BASE_URL: ai.url, FLOWHQ_AI_MODEL: 'openai/gpt-4o-mini', FLOWHQ_TELEGRAM_CHAT_ID: '', FLOWHQ_BOOKING_API_URL: flow.base,
      FLOWHQ_AI_MAX_REPLIES_PER_HOUR: '40',   // this journey is ONE compressed conversation of ~14 replies in a few minutes; the default of 6 per patient per hour is too tight for the explicit-YES flow (a booking = 2 replies; hello + book + move + cancel = 7): production should use 10-12 (docs/n8n-4c-changes.md)
    };
    n8n = await new R.RealN8n({ workflowFile: file, env }).init();
    const out = path.join(n8n.dir, 'credentials.import.local.json');
    const cred = spawnSync(process.execPath, [path.resolve('..', 'n8n', 'production', 'scripts', 'create-credentials.js'), '--out', out, '--import', n8n.importCommand()], { env: { ...process.env, NODE_ENV: 'production' /* vitest sets NODE_ENV=test, which makes n8n's CLI use another database: the import would silently not reach the instance that is started below */, FLOWHQ_GRIST_API_KEY: key(), FLOWHQ_W1_WEBHOOK_SECRET: KEYS.w1, FLOWHQ_WA_ACCESS_TOKEN: KEYS.wa, FLOWHQ_AI_API_KEY: KEYS.ai, FLOWHQ_TELEGRAM_BOT_TOKEN: KEYS.tg, FLOWHQ_BOOKING_API_TOKEN: flow.token, FLOWHQ_SMTP_HOST: '127.0.0.1', FLOWHQ_SMTP_PORT: '1' }, encoding: 'utf8' });
    if (cred.status !== 0) throw new Error(`create-credentials failed: ${(cred.stdout + cred.stderr).slice(-600)}`);
    expect(`${cred.stdout}${cred.stderr}`).toContain('FlowHQ Booking API'); for (const v of [flow.token, key(), KEYS.wa]) expect(`${cred.stdout}${cred.stderr}`).not.toContain(v);
    n8n.importWorkflow(); n8n.publish(); await n8n.start(240000);
    // the harness's own readiness check can pass on the editor's HTML before the workflow has finished activating: wait for the real webhook to answer its handshake
    await waitFor(async () => (await n8n.request('GET', `/webhook/whatsapp-inbound?hub.mode=subscribe&hub.verify_token=${KEYS.verify}&hub.challenge=4711`)).text === '4711', 120000, 'the WhatsApp webhook to be live');
  }, 600000);
  afterAll(async () => { try { await n8n?.stop(); } catch { /* */ } meta?.close(); ai?.close(); await flow?.stop('SIGKILL').catch(() => undefined); if (s) await deleteStaging(s).catch(() => undefined); });

  it('setup: the 4C candidate imports and activates in a real n8n, the booking credential exists, and Grist was migrated by the production script', async () => {
    const log = n8n.logTail(20000); expect(log).not.toMatch(/could not be activated/i);
    expect((await n8n.request('GET', `/webhook/whatsapp-inbound?hub.mode=subscribe&hub.verify_token=${KEYS.verify}&hub.challenge=4711`)).text).toBe('4711');
    expect((await s.client.tableIds(s.clinicDocId))).toEqual(expect.arrayContaining(['Send_Ledger', 'Reminder_Consent', 'Reminder_Consent_Log']));
    const exp = path.join(n8n.dir, 'creds-export.json'); n8n.cli(['export:credentials', '--all', `--output=${exp}`]);
    expect(JSON.parse(fs.readFileSync(exp, 'utf8')).map((c: { name: string }) => c.name)).toContain('FlowHQ Booking API'); fs.unlinkSync(exp);
  });

  it('1-2. the patient writes on WhatsApp; n8n verifies the signature, stores lead + conversation + message in the REAL Grist, and the AI stub is consulted', async () => {
    const bad = await n8n.request('POST', '/webhook/whatsapp-inbound', { body: '{}', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' } }); expect(bad.status).toBe(401);
    const answer = await say('Hello, do you treat knee pain?', 'wamid.STG.1');
    expect(answer).toMatch(/Hello/);
    expect((await rows('LEADS')).some((l) => l.fields.Phone === PATIENT)).toBe(true);
    expect((await rows('Messages')).filter((m) => m.fields.WA_Message_ID === 'wamid.STG.1')).toHaveLength(1);
    expect(ai.calls.length).toBeGreaterThan(0);
  }, 240000);

  it('3-4. the patient asks for a time: the free times came from FLOW HQ (real availability); the clinic does NOT book yet but asks for an explicit YES naming the exact day, time and doctor', async () => {
    const before = (await appts()).length;
    const q = await say(`Book me for ${WORD} at 10`, 'wamid.STG.2');
    expect(q).toBe(`Shall I book ${dayLabel(DAY)} at 10:00 AM with Dr. Mahesh Tiwari? Reply YES to confirm.`);
    expect((await appts()).length, 'nothing is booked before the YES').toBe(before);
    expect(q).not.toMatch(/cal\.com|booked|confirmed/i);
  }, 240000);

  let reference = '';
  it('5-6. the patient says YES: FLOW HQ creates EXACTLY ONE appointment in the real Grist (with an idempotency key and an audit id); the patient is told it is booked only after that', async () => {
    const text = await say('Yes', 'wamid.STG.3');
    await answered(text, /^Your appointment is booked/);
    expect(text).toMatch(/^Your appointment is booked: .* at 10:00 AM with Dr\. Mahesh Tiwari\. Your reference is wa-GKA-\d+\. See you then!$/);
    reference = text.match(/(wa-GKA-\d+)/)![1]!;
    const mine = await appts(); expect(mine).toHaveLength(1);
    expect(mine[0]!.fields).toMatchObject({ Booking_UID: reference, Slot_Key: `DR-001|${DAY}|10:00`, Status: 'Booked', Patient_Phone: PATIENT, Booking_Source: 'WhatsApp AI' });
    expect(String(mine[0]!.fields.Idem_Key)).toMatch(/^w13-[0-9a-f]{16}$/); expect(String(mine[0]!.fields.Audit_ID).length).toBeGreaterThan(10);
    await waitFor(async () => (await rows('LEADS')).find((l) => l.fields.Phone === PATIENT)?.fields.Status === 'Booked', 30000, 'the lead to become Booked (W13 writes it after the reply)');
  }, 240000);

  it('7. staff see it and manage it in FLOW HQ (week calendar, detail with the reminder outlook, check-in)', async () => {
    const week = await flow.staff('desk', `/week?date=${DAY}&doctor_id=DR-001`); expect(week.status).toBe(200);
    expect(week.json.days.flatMap((x: { appointments: Array<{ booking_reference: string }> }) => x.appointments).map((a: { booking_reference: string }) => a.booking_reference)).toContain(reference);
    const det = await flow.staff('desk', `/appointments/${reference}`); expect(det.status).toBe(200);
    expect(det.json.reminder).toMatchObject({ state: 'held' }); expect(det.json.reminder.codes).toContain('consent_unknown');
    expect((await flow.staff('desk', `/appointments/${reference}/status`, { method: 'POST', body: { status: 'Checked in' } })).json.appointment.status).toBe('Checked in');
    expect((await flow.staff('desk', `/appointments/${reference}/status`, { method: 'POST', body: { status: 'Confirmed' } })).status).toBeGreaterThanOrEqual(200);
  }, 120000);

  it('8. the booking confirmation reached the patient through W12 and Meta (the stub), exactly once, with a ledger row and the right recipient; nothing went to anyone else', async () => {
    const confirmations = patientTexts().filter((t) => /Your appointment is booked/.test(t)); expect(confirmations).toHaveLength(1);
    const ledger = await rows('Send_Ledger'); expect(ledger.filter((l) => /^W13:patient_reply:/.test(String(l.fields.Idem_Key))).length).toBeGreaterThanOrEqual(3);
    for (const c of meta.calls) expect([PATIENT_DIGITS, OWNER.slice(1)]).toContain(c.body.to);
    expect(meta.calls.every((c) => c.path.includes('/v23.0/123456789012345/messages'))).toBe(true);
  });

  it('9. reminder eligibility (W5 in real n8n): no consent = NOT reminded and the reason is logged; Pending = not reminded; a recorded Yes = ONE 24 h reminder; a second run sends nothing', async () => {
    const [row] = await appts(); const nowSec = Math.floor(clockNow() / 1000); const start = nowSec + 24 * 3600;
    await s.client.update(s.clinicDocId, 'Appointments', [{ id: row!.id, fields: { Start: start, End: start + 1800, R24_Sent: null, R2_Sent: null } }]);   // test data: bring the appointment into W5's 24 h window
    const templates = () => meta.calls.filter((c) => c.body.type === 'template' && c.body.template?.name === 'reminder_24h').length;
    expect((await trigger('/webhook/staging-w5')).status).toBe(200); await sleep(12000);
    expect(templates(), 'no reminder consent = no reminder').toBe(0);
    expect((await rows('Appointments')).find((r) => r.id === row!.id)!.fields.R24_Sent == null).toBe(true);
    // consent recorded by an admin in FLOW HQ (real Grist), but the appointment is still Pending confirmation
    expect((await flow.staff('admin', '/consent', { method: 'POST', body: { phone: PATIENT.slice(3), value: 'Yes', source: 'Told staff in person', evidence_ref: 'Register serial 9001' } })).status).toBe(201);
    await s.client.update(s.clinicDocId, 'Appointments', [{ id: row!.id, fields: { Appt_Stage: 'Pending confirmation' } }]);
    await trigger('/webhook/staging-w5'); await sleep(12000); expect(templates(), 'Pending is never reminded').toBe(0);
    await s.client.update(s.clinicDocId, 'Appointments', [{ id: row!.id, fields: { Appt_Stage: 'Confirmed' } }]);
    await trigger('/webhook/staging-w5'); await waitFor(() => templates() === 1, 60000, 'the 24 h reminder');
    await waitFor(async () => typeof (await rows('Appointments')).find((r) => r.id === row!.id)!.fields.R24_Sent === 'number', 30000, 'R24_Sent to be set (W5 sets it after the send)');
    await trigger('/webhook/staging-w5'); await sleep(12000); expect(templates(), 'a second run does not remind again').toBe(1);
    const t = meta.calls.find((c) => c.body.template?.name === 'reminder_24h')!; expect(t.body.to).toBe(PATIENT_DIGITS);
    expect((await flow.staff('desk', `/appointments/${reference}`)).json.reminder.r24_sent_at).toBeTruthy();
  }, 400000);

  it('10. the patient reschedules, then cancels, on WhatsApp: each asks first, each is ONE FLOW HQ call; the same reference moves; the audit log keeps every step', async () => {
    const q = await say(`Move it to ${NEXTWORD} at 11`, 'wamid.STG.4'); await answered(q, /^Shall I move/); expect(q).toMatch(/^Shall I move your appointment from .* to .* at 11:00 AM with Dr\. Mahesh Tiwari\? Reply YES to confirm\.$/);
    expect((await appts())[0]!.fields.Slot_Key).toBe(`DR-001|${DAY}|10:00`);
    const done = await say('Yes', 'wamid.STG.5'); await answered(done, /^Your appointment is moved/); expect(done).toMatch(/^Your appointment is moved to .* at 11:00 AM with Dr\. Mahesh Tiwari\.$/);
    const moved = (await appts()); expect(moved).toHaveLength(1);
    expect(moved[0]!.fields).toMatchObject({ Booking_UID: reference, Slot_Key: `DR-001|${NEXT}|11:00`, Status: 'Booked' }); expect(moved[0]!.fields.R24_Sent == null).toBe(true);
    const c = await say('Please cancel my appointment', 'wamid.STG.6'); await answered(c, /^Shall I cancel/); expect(c).toMatch(/^Shall I cancel your appointment on .*\? Reply YES to confirm\.$/);
    expect((await appts())[0]!.fields.Status).toBe('Booked');
    const gone = await say('Yes', 'wamid.STG.7'); await answered(gone, /is cancelled\.$/);
    expect((await appts())[0]!.fields.Status).toBe('Cancelled'); expect(await appts()).toHaveLength(1);
  }, 600000);

  it('11. audit preserved: Booking_Audit has the create, the move and the cancel with unique ids, the token as actor, and no patient data', async () => {
    let audit = await rows('Booking_Audit'); for (let i = 0; i < 40 && !['create', 'reschedule', 'cancel'].every((a) => audit.some((r) => r.fields.Action === a)); i++) { await sleep(1000); audit = await rows('Booking_Audit'); }
    for (const a of ['create', 'reschedule', 'cancel']) expect(audit.some((r) => r.fields.Action === a && r.fields.Outcome === 'ok' && r.fields.Record === reference), a).toBe(true);
    expect(audit.filter((r) => r.fields.Source === 'API').every((r) => String(r.fields.Actor).startsWith('token:'))).toBe(true);
    const ids = audit.map((r) => r.fields.Audit_ID); expect(new Set(ids).size).toBe(ids.length);
    const text = JSON.stringify(audit.map((r) => r.fields)); for (const v of [PATIENT, PATIENT.slice(3), 'Staging Patient']) expect(text).not.toContain(v);
  }, 120000);

  it('12. failures and retries create no duplicates: the same WhatsApp message delivered again is ignored; a stray YES books nothing; FLOW HQ down = no false "booked"; its return = it works', async () => {
    const msgs = patientTexts().length; const calls = flow.base ? (await appts()).length : 0;
    const again = await inbound('Yes', 'wamid.STG.7'); expect(again.status).toBe(200); await sleep(10000);
    expect(patientTexts().length, 'a replayed webhook is answered once').toBe(msgs); expect((await appts()).length).toBe(calls);
    const stray = await say('Yes', 'wamid.STG.8'); expect(stray).not.toMatch(/booked|moved/i);   // nothing is pending: the AI stub answers with a greeting
    expect((await appts()).filter((r) => r.fields.Status === 'Booked')).toHaveLength(0);
    // FLOW HQ dies BETWEEN the question and the YES: the YES must not be reported as booked; a person is alerted
    const q = await say(`Book me for ${WORD} at 10`, 'wamid.STG.9'); await answered(q, /^Shall I book/);
    await flow.stop('SIGKILL');
    const y = await say('Yes', 'wamid.STG.10'); expect(y).not.toMatch(/booked|confirmed/i);
    expect(y, 'with no free times known the patient gets the clinic\'s own booking page, never a time').toContain('https://www.staging-physio.example/book'); noCal([y]);
    expect((await appts()).filter((r) => r.fields.Status === 'Booked'), 'nothing was booked while FLOW HQ was down').toHaveLength(0);
    await waitFor(async () => (await rows('Messages')).some((m) => m.fields.WA_Message_ID === 'wamid.STG.10' && /booking system: .*no free times offered/.test(String(m.fields.AI_Reason))), 40000, 'staff to be able to see WHY (AI_Reason)');
    // while it is down a fresh request is never answered with a time or a booking
    const down = await say(`Book me for ${NEXTWORD} at 11`, 'wamid.STG.11'); expect(down).not.toMatch(/booked|confirmed|Shall I book/i); noCal([down]);    // FLOW HQ returns (same port, same installation): the patient asks again and it works, exactly once
    flow = await startServer(s, { reuse: flow, startTimeoutMs: 120000 });
    await waitFor(async () => (await flow.api('/config')).status === 200, 60000, 'FLOW HQ to answer again');
    const q2 = await say(`Book me for ${WORD} at 10`, 'wamid.STG.12'); await answered(q2, /^Shall I book/);
    const ok = await say('Yes', 'wamid.STG.13'); await answered(ok, /^Your appointment is booked/);
    expect((await appts()).filter((r) => r.fields.Status === 'Booked')).toHaveLength(1);
  }, 600000);
  it('13. n8n unavailable: FLOW HQ and staff keep booking; the patient\'s message is not lost (Meta re-delivers it); after n8n returns it is answered exactly once', async () => {
    const before = patientTexts().length; const apptsBefore = (await rows('Appointments')).length;
    await n8n.stop();
    const dead = await n8n.request('POST', '/webhook/whatsapp-inbound', { body: '{}', headers: { 'content-type': 'application/json' } }); expect(dead.status).toBe(0);   // nothing answers: Meta would retry
    // staff are not affected: a front-desk booking works while n8n is down
    const free = (await flow.api(`/availability?date=${NEXT}&doctor_id=DR-001`)).json.slots[0];
    const staffBooking = await flow.staff('desk', '/appointments', { method: 'POST', body: { slot_id: free.slot_id, idempotency_key: 'staff-while-n8n-down-1', patient: { name: 'Walk In Patient', phone: '9000020077' } } });
    expect(staffBooking.status, staffBooking.text).toBe(201);
    expect((await rows('Appointments')).length, 'a staff booking made while n8n was down').toBe(apptsBefore + 1);
    await n8n.start(240000);
    await waitFor(async () => (await n8n.request('GET', `/webhook/whatsapp-inbound?hub.mode=subscribe&hub.verify_token=${KEYS.verify}&hub.challenge=4711`)).text === '4711', 120000, 'the webhook to be live again');
    // Meta re-delivers the SAME message (same wamid) until it gets a 200: twice here
    const r1 = await inbound('Hello again', 'wamid.STG.20'); const r2 = await inbound('Hello again', 'wamid.STG.20'); expect([r1.status, r2.status]).toEqual([200, 200]);
    await waitFor(() => patientTexts().length > before, 90000, 'the answer after n8n came back'); await sleep(10000);
    expect(patientTexts().length - before, 'answered exactly once').toBe(1);
    console.log(`STAGING FINDING two simultaneous deliveries of one wamid: inbound rows stored = ${(await rows('Messages')).filter((m) => m.fields.WA_Message_ID === 'wamid.STG.20').length}`);
  }, 600000);

  it('14. the SAME "Yes" delivered twice at the same instant (a webhook retry race) books exactly ONE appointment and reports it to the patient; what the race does to the inbox is measured and reported', async () => {
    const q = await say(`Book me for ${WORD} at 11`, 'wamid.STG.21'); await answered(q, /^Shall I book/);
    const before = patientTexts().length; const bookedBefore = (await appts()).filter((r) => r.fields.Status === 'Booked').length;
    const [a, b] = await Promise.all([inbound('Yes', 'wamid.STG.22'), inbound('Yes', 'wamid.STG.22')]); expect([a.status, b.status]).toEqual([200, 200]);
    await waitFor(() => patientTexts().length > before, 90000, 'the booking answer'); await sleep(15000);
    const booked = (await appts()).filter((r) => r.fields.Status === 'Booked'); expect(booked.length - bookedBefore, 'exactly one appointment').toBe(1);
    expect(new Set(booked.map((r) => r.fields.Slot_Key)).size, 'no slot twice').toBe(booked.length);
    const confirmations = patientTexts().slice(before).filter((t) => /Your appointment is booked/.test(t)); const inboundRows = (await rows('Messages')).filter((m) => m.fields.WA_Message_ID === 'wamid.STG.22').length;
    console.log(`STAGING FINDING concurrent duplicate YES: appointments created = 1, booked-confirmation texts = ${confirmations.length}, inbound rows = ${inboundRows}`);
    expect(confirmations.length).toBeGreaterThanOrEqual(1); expect(confirmations.length).toBeLessThanOrEqual(2);
  }, 600000);
});
