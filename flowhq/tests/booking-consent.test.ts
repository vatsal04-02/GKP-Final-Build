// Reminder consent (4B): the rules, who may record what, evidence, history, precedence, the AI / n8n exclusion, audit and crash recovery. Synthetic people only.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BT } from '../src/server/booking/schema';
import { effectiveConsent, parseApprovedForms, validateConsent, type ConsentInput, type ConsentKind } from '../src/server/booking/consent';
import { resetTokenFailures, SCOPES } from '../src/server/booking/tokens';
import { M09, M10, buildFixture, type Fixture } from './booking-fixture';

let fx: Fixture; const tmp: string[] = [];
const P = '9876543210'; const PN = '+919876543210'; const P2 = '9123456780';
beforeEach(async () => { vi.spyOn(console, 'error').mockImplementation(() => {}); resetTokenFailures(); fx = await buildFixture({ bookingOn: true }); });
afterEach(() => { vi.restoreAllMocks(); for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });
const yes = (over: Record<string, unknown> = {}) => ({ phone: P, value: 'Yes', source: 'Told staff in person', evidence_ref: 'Register serial 1234', ...over });
const rec = (who: string, body: Record<string, unknown>) => fx.s(who, '/consent', { method: 'POST', body });
const state = async (who = 'admin', phone = P) => (await fx.s(who, `/consent?phone=${phone}`)).json;
const logRows = () => fx.doc[BT.consentLog]!.map((r) => r.fields); const stateRows = () => fx.doc[BT.consent]!.map((r) => r.fields); const audit = () => fx.doc[BT.audit]!.map((r) => r.fields);

describe('the rules (pure)', () => {
  const ctx = { kind: 'recorded' as ConsentKind, approvedForms: ['GK-REG-v1'], today: '2026-10-07' };
  const v = (i: Partial<ConsentInput>, c = ctx) => validateConsent({ phone: P, value: 'Yes', source: 'Told staff in person', evidenceRef: 'ref-1', ...i }, c)?.code ?? null;
  it('a Yes needs evidence; a signed form also needs a signature date and an APPROVED form version', () => {
    expect(v({})).toBeNull(); expect(v({ evidenceRef: '' })).toBe('evidence_required'); expect(v({ evidenceRef: '   ' })).toBe('evidence_required');
    expect(v({ source: 'Signed registration form' })).toBe('evidence_date_required'); expect(v({ source: 'Signed registration form', evidenceDate: '2026-10-01' })).toBe('form_version_required');
    expect(v({ source: 'Signed registration form', evidenceDate: '2026-10-01', formVersion: 'WEBSITE-DRAFT' })).toBe('form_not_approved');
    expect(v({ source: 'Signed registration form', evidenceDate: '2026-10-01', formVersion: 'gk-reg-v1' })).toBeNull();   // case-insensitive match to an approved version
    expect(v({ source: 'Imported with evidence', evidenceDate: '2026-10-01', formVersion: 'GK-REG-v1' })).toBeNull(); expect(v({ source: 'Imported with evidence', evidenceDate: '2026-10-01', formVersion: 'other' })).toBe('form_not_approved');
    expect(v({ source: 'Signed registration form', evidenceDate: '2026-10-01', formVersion: 'GK-REG-v1' }, { ...ctx, approvedForms: [] })).toBe('form_not_approved');   // nothing is approved yet
  });
  it('rejects a future or invalid evidence date, a withdrawal as the source of a Yes, unknown sources, and Unknown as a recorded answer', () => {
    expect(v({ evidenceDate: '2026-12-01' })).toBe('invalid_date'); expect(v({ evidenceDate: '2026-02-30' })).toBe('invalid_date'); expect(v({ source: 'Patient withdrew' })).toBe('invalid_source'); expect(v({ source: 'Telepathy' })).toBe('invalid_source');
    expect(v({ value: 'Unknown' })).toBe('invalid_consent'); expect(v({ value: 'Maybe' as never })).toBe('invalid_consent'); expect(v({ evidenceRef: 'x'.repeat(121) })).toBe('too_long');
  });
  it('a No needs no evidence; a correction or revocation needs a note', () => {
    expect(v({ value: 'No', evidenceRef: '', source: 'Patient withdrew' })).toBeNull();
    expect(v({ value: 'No', source: 'Admin correction' }, { ...ctx, kind: 'corrected' })).toBe('note_required'); expect(v({ value: 'No', source: 'Admin correction', note: 'wrong number' }, { ...ctx, kind: 'corrected' })).toBeNull();
    expect(v({ value: 'Unknown', source: 'Admin correction', note: 'entered by mistake' }, { ...ctx, kind: 'corrected' })).toBeNull();   // only a correction may reset to Unknown
  });
  it('precedence: opt-out beats everything, then No, then Yes; everything else (blank, typo, nothing) is Unknown and suppresses', () => {
    expect(effectiveConsent({ value: 'Yes' }, true)).toEqual({ value: 'No', allowed: false, reason: 'opted_out' }); expect(effectiveConsent({ value: 'No' }, false)).toEqual({ value: 'No', allowed: false, reason: 'consent_no' });
    expect(effectiveConsent({ value: 'Yes' }, false)).toEqual({ value: 'Yes', allowed: true, reason: 'consent_yes' });
    for (const row of [null, { value: '' }, { value: 'yes' }, { value: 'YES ' }, { value: 'Unknown' }, { value: 'true' }]) expect(effectiveConsent(row, false)).toEqual({ value: 'Unknown', allowed: false, reason: 'consent_unknown' });
    expect(parseApprovedForms(' A, B ;C\n')).toEqual(['A', 'B', 'C']); expect(parseApprovedForms('')).toEqual([]);
  });
});

describe('who may record, correct and revoke (server-side)', () => {
  it('a Yes: admin always; front desk and doctors ONLY with the explicit grant', async () => {
    expect((await rec('desk', yes())).status).toBe(403); expect((await rec('desk', yes())).json.error.message).toMatch(/needs permission/);
    expect((await rec('mahesh', yes())).status).toBe(403);   // a doctor without the grant
    expect((await rec('admin', yes())).status).toBe(201);
    expect((await rec('granted', yes({ phone: P2 }))).status).toBe(201);        // front desk with the grant
    expect((await rec('grantdoc', yes({ phone: '9000000001' }))).status).toBe(201);   // a doctor with the grant
    expect(stateRows()).toHaveLength(3);
  });
  it('a No: any signed-in staff member (it can only suppress reminders)', async () => {
    for (const [who, phone] of [['desk', P], ['mahesh', P2], ['sandeep', '9000000001'], ['granted', '9000000002']] as const) expect((await rec(who, { phone, value: 'No', source: 'Patient withdrew' })).status, who).toBe(201);
    expect(stateRows().every((r) => r.Reminder_Consent === 'No')).toBe(true);
  });
  it('correct and revoke are admin only, even with the grant', async () => {
    await rec('admin', yes());
    for (const who of ['desk', 'granted', 'grantdoc', 'mahesh']) {
      expect((await fx.s(who, '/consent/correct', { method: 'POST', body: yes({ value: 'No', source: 'Admin correction', note: 'wrong person' }) })).status, who).toBe(403);
      expect((await fx.s(who, '/consent/revoke', { method: 'POST', body: { phone: P, note: 'patient withdrew' } })).status, who).toBe(403);
    }
    expect((await state()).value).toBe('Yes');
    expect((await fx.s('admin', '/consent/revoke', { method: 'POST', body: { phone: P, note: 'Patient told reception to stop' } })).json).toMatchObject({ value: 'No', effective: { allowed: false, reason: 'consent_no' } });
  });
  it('not signed in = 401; writes need the CSRF header; unknown fields (a claimed role) are refused', async () => {
    expect((await fx.s('none', '/consent', { method: 'POST', body: yes() })).status).toBe(401); expect((await fx.s('admin', '/consent', { method: 'POST', body: yes(), csrf: false })).status).toBe(403);
    expect((await rec('desk', { ...yes(), role: 'admin', grants: ['consent:write'] })).status).toBe(400); expect((await fx.s('none', `/consent?phone=${P}`)).status).toBe(401);
  });
  it('the overview tells the page what THIS login may do', async () => {
    for (const [who, can] of [['admin', { record_yes: true, record_no: true, correct: true }], ['granted', { record_yes: true, record_no: true, correct: false }], ['desk', { record_yes: false, record_no: true, correct: false }]] as const) expect((await fx.s(who, '/overview')).json.me.can, who).toEqual(can);
  });
});

describe('evidence, history and precedence', () => {
  it('a signed form is refused until an admin approves its wording; then it works and records the form version and date', async () => {
    const form = yes({ source: 'Signed registration form', evidence_ref: 'Form scan 77', evidence_date: '2026-10-01', form_version: 'GK-REG-2027-v1' });
    expect((await rec('admin', form)).json.error.code).toBe('form_not_approved');
    expect((await fx.s('desk', '/settings', { method: 'PUT', body: { values: { approved_consent_forms: 'GK-REG-2027-v1' } } })).status).toBe(403);   // only an admin approves a form
    expect((await fx.s('admin', '/settings', { method: 'PUT', body: { values: { approved_consent_forms: 'GK-REG-2027-v1' } } })).status).toBe(200);
    const ok = await rec('admin', form); expect(ok.status).toBe(201); expect(ok.json).toMatchObject({ value: 'Yes', source: 'Signed registration form', evidence_ref: 'Form scan 77', evidence_date: '2026-10-01', form_version: 'GK-REG-2027-v1', effective: { allowed: true } });
  });
  it('bad requests are refused with a reason and write nothing', async () => {
    for (const [body, code] of [[yes({ evidence_ref: '' }), 'evidence_required'], [yes({ evidence_date: '2099-01-01' }), 'invalid_date'], [yes({ source: 'Patient withdrew' }), 'invalid_source'], [yes({ value: 'Unknown' }), 'invalid_consent'], [yes({ phone: '12345' }), 'invalid_phone'], [yes({ source: 'Telepathy' }), 'invalid_source']] as const)
      expect((await rec('admin', body as never)).json.error.code, JSON.stringify(body)).toBe(code);
    expect(logRows()).toHaveLength(0); expect(stateRows()).toHaveLength(0);
  });
  it('history is append-only and complete: value, previous value, when, who, source, evidence, in order', async () => {
    await rec('admin', yes()); await rec('desk', { phone: P, value: 'No', source: 'Patient withdrew', note: 'asked reception to stop' });
    await fx.s('admin', '/consent/correct', { method: 'POST', body: yes({ source: 'Admin correction', evidence_ref: 'Call note 9', note: 'patient called back and agreed' }) });
    const s = await state(); expect(s.value).toBe('Yes'); expect(s.history.map((h: { kind: string; value: string; previous_value: string; actor: string }) => `${h.kind}:${h.previous_value}>${h.value}:${h.actor}`)).toEqual(['corrected:No>Yes:admin@test', 'recorded:Yes>No:desk@test', 'recorded:Unknown>Yes:admin@test']);
    expect(logRows()).toHaveLength(3); expect(stateRows()).toHaveLength(1); expect(stateRows()[0]).toMatchObject({ Previous_Value: 'No', Recorded_By: 'admin@test' });
    const first = JSON.stringify(logRows()[0]); await rec('desk', { phone: P, value: 'No', source: 'Told staff by phone' }); expect(JSON.stringify(logRows()[0])).toBe(first);   // earlier rows are never rewritten
  });
  it('recording the very same answer twice is a no-op, not a duplicate history row', async () => {
    await rec('admin', yes()); await rec('admin', yes()); expect(logRows()).toHaveLength(1);
  });
  it('No beats an earlier Yes; an opt-out beats a recorded Yes; nothing recorded is Unknown', async () => {
    expect((await state()).effective).toMatchObject({ value: 'Unknown', allowed: false, reason: 'consent_unknown' });
    await rec('admin', yes()); expect((await state()).effective).toMatchObject({ allowed: true, reason: 'consent_yes' });
    await rec('admin', { phone: P, value: 'No', source: 'Patient withdrew' }); expect((await state()).effective).toMatchObject({ allowed: false, reason: 'consent_no' });
    fx.doc.LEADS!.push({ id: 9000, fields: { Name: 'Opted Out Lead', Phone: '+919000099999', Opted_Out: true } }); await rec('admin', yes({ phone: '9000099999' }));
    expect((await state('admin', '9000099999')).effective).toMatchObject({ value: 'No', allowed: false, reason: 'opted_out' });   // the recorded Yes does not override the opt-out
  });
  it('legacy "consent" never becomes reminder consent: a lead that messaged first, or ticked the website box, is Unknown', async () => {
    fx.doc.LEADS!.push({ id: 9001, fields: { Name: 'Inbound Lead', Phone: '+919000088888', Consent_WhatsApp: true, Consent_Source: 'whatsapp-inbound' }, }, { id: 9002, fields: { Name: 'Website Lead', Phone: '+919000077777', Consent_WhatsApp: true, Consent_Source: 'website-form', Consent_Version: 'DRAFT-2026-10-v1' } });
    for (const phone of ['9000088888', '9000077777']) expect(await state('admin', phone)).toMatchObject({ value: 'Unknown', effective: { allowed: false, reason: 'consent_unknown' }, history: [] });
    expect(stateRows()).toHaveLength(0); expect(logRows()).toHaveLength(0);   // and nothing was migrated or backfilled
  });
  it('Unknown is NEVER turned into Yes by anything else the system does (property over every other mutation)', async () => {
    await fx.s('desk', '/appointments', { method: 'POST', body: { slot_id: M09, idempotency_key: 'prop-key-0001-abcdefgh', patient: { name: 'Prop Patient', phone: P } } });
    const ref = fx.doc[BT.appointments]![0]!.fields.Booking_UID as string;
    await fx.s('desk', `/appointments/${ref}`, { method: 'PATCH', body: { slot_id: M10 } }); await fx.s('desk', `/appointments/${ref}/status`, { method: 'POST', body: { status: 'Completed' } }); await fx.s('desk', `/appointments/${ref}/status`, { method: 'POST', body: { status: 'Confirmed' } });
    await fx.s('admin', '/settings', { method: 'PUT', body: { values: { booking_enabled: 'on' } } });
    await fx.api('/appointments', { method: 'POST', headers: { 'idempotency-key': 'prop-key-0002-abcdefgh' }, body: { slot_id: slot2(), patient: { name: 'AI Patient', phone: P2 } } });
    await fx.s('desk', `/appointments/${ref}/cancel`, { method: 'POST', body: {} });
    expect(stateRows()).toHaveLength(0); expect(logRows()).toHaveLength(0); expect((await state()).value).toBe('Unknown'); expect((await state('admin', P2)).effective.allowed).toBe(false);
  });
  it('the summary counts what has been recorded and says that everyone else is Unknown', async () => {
    await rec('admin', yes()); await rec('admin', yes({ phone: P2 })); await rec('desk', { phone: '9000000001', value: 'No', source: 'Patient withdrew' });
    expect((await fx.s('desk', '/consent/summary')).json).toMatchObject({ yes: 2, no: 1, recorded: 3 });
  });
});

describe('AI and n8n can never grant consent', () => {
  it('no service-token scope or route touches consent, and the booking API refuses a consent field', async () => {
    expect([...SCOPES].some((s) => /consent/.test(s))).toBe(false);
    for (const [method, p] of [['GET', `/consent?phone=${P}`], ['POST', '/consent'], ['POST', '/consent/correct'], ['POST', '/consent/revoke']] as const) { const r = await fx.api(p, { method, body: method === 'POST' ? yes() : undefined }); expect([401, 404], `${method} ${p}`).toContain(r.status); expect(r.text).not.toContain('Yes'); }
    await fx.s('admin', '/settings', { method: 'PUT', body: { values: { booking_enabled: 'on' } } });
    const withConsent = await fx.api('/appointments', { method: 'POST', headers: { 'idempotency-key': 'ai-consent-key-abcdefgh' }, body: { slot_id: M09, patient: { name: 'AI Patient', phone: P }, reminder_consent: 'Yes' } });
    expect(withConsent.status).toBe(400); expect(fx.doc[BT.appointments]).toHaveLength(0); expect(stateRows()).toHaveLength(0);
    expect((await fx.app.request(`/api/w/demo-physio/schedule/consent?phone=${P}`, { headers: { authorization: `Bearer ${fx.token}` } })).status).toBe(401);   // a token is not a staff session
  });
});

describe('audit and recovery', () => {
  it('each change is audited with from, to and source but NO phone and no evidence text; the rows share the Audit_ID', async () => {
    await rec('admin', yes({ evidence_ref: 'Secret register serial 555' })); await rec('desk', { phone: P, value: 'No', source: 'Patient withdrew' });
    const a = audit().filter((r) => r.Action === 'consent'); expect(a).toHaveLength(2); expect(a.map((r) => JSON.parse(r.Detail as string))).toEqual([{ kind: 'recorded', from: 'Unknown', to: 'Yes', source: 'Told staff in person' }, { kind: 'recorded', from: 'Yes', to: 'No', source: 'Patient withdrew' }]);
    expect(a.every((r) => r.Outcome === 'ok')).toBe(true); expect(a[0]!.Audit_ID).toBe(logRows()[0]!.Audit_ID); expect(a[1]!.Audit_ID).toBe(stateRows()[0]!.Audit_ID);
    const raw = JSON.stringify(audit()); for (const secret of [P, PN, 'Secret register', '555']) expect(raw, secret).not.toContain(secret);
  });
  it('a refused consent change is itself audited (who tried, why refused)', async () => {
    await rec('desk', yes()); expect(audit().find((r) => r.Action === 'consent')).toMatchObject({ Outcome: 'rejected', Reason: 'forbidden', Actor: 'desk@test' });
  });
  it('if the audit log cannot be saved the consent change is REFUSED before anything is written', async () => {
    const blocker = path.join(mkdtempSync(path.join(os.tmpdir(), 'fhq-c-')), 'file'); tmp.push(path.dirname(blocker)); writeFileSync(blocker, 'x');
    const b = await buildFixture({ bookingOn: true, outboxDir: path.join(blocker, 'outbox') });
    const r = await b.s('admin', '/consent', { method: 'POST', body: yes() }); expect(r.status).toBe(503); expect(r.json.error.code).toBe('audit_unavailable'); expect(b.doc[BT.consentLog]).toHaveLength(0); expect(b.doc[BT.consent]).toHaveLength(0);
  });
  it('a crash between the history row and the current-state row: the next start rebuilds the state from the history, exactly one audit row, nothing duplicated', async () => {
    fx.fail.grist = (m, t) => m === 'POST' && t === BT.consent;   // the state write fails after the history row was saved
    const r = await rec('admin', yes()); expect(r.status).toBe(502); expect(logRows()).toHaveLength(1); expect(stateRows()).toHaveLength(0);
    fx.fail.grist = null; const svc = await fx.booking(); await svc.start();   // restart: recovery resolves the intent by Audit_ID and repairs the state
    expect(stateRows()).toHaveLength(1); expect(stateRows()[0]).toMatchObject({ Phone: PN, Reminder_Consent: 'Yes', Audit_ID: logRows()[0]!.Audit_ID }); expect(logRows()).toHaveLength(1);
    expect(audit().filter((x) => x.Action === 'consent')).toHaveLength(1); expect((await state()).value).toBe('Yes');
    await svc.start(); expect(stateRows()).toHaveLength(1); expect(audit().filter((x) => x.Action === 'consent')).toHaveLength(1);   // repeat start: still nothing new
  });
  it('repair never invents consent: with no history there is nothing to rebuild', async () => {
    const svc = await fx.booking(); expect(await svc.repairConsentState()).toBe(0); expect(stateRows()).toHaveLength(0);
  });
  it('the consent tables not being set up fails safe with a clear 503 (and reminders stay suppressed because there is nothing recorded)', async () => {
    const bare = await buildFixture({ bookingOn: true }); delete bare.doc[BT.consent]; delete bare.doc[BT.consentLog];
    const r = await bare.s('admin', '/consent', { method: 'POST', body: yes() }); expect(r.status).toBe(503); expect(r.json.error.code).toBe('booking_unavailable');
  });
});

// The n8n copy of the rule (n8n/snippets/reminder-consent.js, pasted into W5 / W12 / W15) must answer exactly like consent.ts for every input.
describe('n8n parity: reminder-consent.js equals consent.ts', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rc = createRequire(import.meta.url)('../../n8n/snippets/reminder-consent.js') as { rcEffective: (rows: unknown[] | null, optedOut: boolean) => { value: string; allowed: boolean; reason: string } };
  const values = ['Yes', 'No', 'Unknown', '', 'yes', 'YES', 'maybe', undefined, null];
  it('same value, allowed and reason for every consent value and opt-out state', () => {
    for (const v of values) for (const optedOut of [false, true]) {
      const ts = effectiveConsent(v === undefined ? null : { value: v as string }, optedOut);
      const js = rc.rcEffective(v === undefined ? [] : [{ id: 1, fields: { Phone: P, Reminder_Consent: v } }], optedOut);
      expect(js, `${String(v)} optedOut=${optedOut}`).toEqual(ts);
    }
  });
  it('an unreadable table is never allowed in the n8n copy', () => { expect(rc.rcEffective(null, false).allowed).toBe(false); });
});

function slot2() { return 'DR-002|2026-10-08|16:00'; }
