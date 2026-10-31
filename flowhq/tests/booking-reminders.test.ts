// "Will this appointment be reminded, and if not, why?" (reminders.ts, shown in the staff drawer). It mirrors W5's decision (n8n/final/tools/4c/w5-find-due.body.js);
// the n8n tests prove W5 itself. Synthetic people only; nothing here sends a message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BT } from '../src/server/booking/schema';
import { reminderOutlook, type ReminderInput } from '../src/server/booking/reminders';
import { resetTokenFailures } from '../src/server/booking/tokens';
import { M09, buildFixture, type Fixture } from './booking-fixture';

const NOW = 1_790_000_000;
const base: ReminderInput = { status: 'Booked', stage: 'Confirmed', startSec: NOW + 86_400, nowSec: NOW, r24Sent: null, r2Sent: null, phone: '+919876543210', consent: 'Yes', optedOut: false };
const o = (over: Partial<ReminderInput> = {}) => reminderOutlook({ ...base, ...over });

describe('reminderOutlook (pure)', () => {
  it('Booked + confirmed + a recorded Yes = will be sent, no reasons', () => {
    expect(o()).toMatchObject({ state: 'will_send', codes: [], reasons: [] });
    for (const stage of ['Checked in', '']) expect(o({ stage }).state, stage).toBe('will_send');   // a blank stage is every legacy / Cal.com row
  });
  it('Pending confirmation holds the reminder, whatever the consent', () => {
    expect(o({ stage: 'Pending confirmation' })).toMatchObject({ state: 'held', codes: ['pending_confirmation'] });
  });
  it('no usable phone holds it, and says so without consulting consent', () => {
    expect(o({ phone: '' })).toMatchObject({ state: 'held', codes: ['no_contact'] });
  });
  it('consent: No, Unknown (no row or blank), opted out and an unreadable table all hold it; opt-out beats a Yes', () => {
    expect(o({ consent: 'No' }).codes).toEqual(['consent_no']);
    expect(o({ consent: '' }).codes).toEqual(['consent_unknown']);
    expect(o({ consent: 'yes' }).codes).toEqual(['consent_unknown']);   // a typo is Unknown
    expect(o({ consent: 'Yes', optedOut: true }).codes).toEqual(['opted_out']);
    expect(o({ consent: null }).codes).toEqual(['consent_unreadable']);
    expect(o({ consent: null, optedOut: true }).codes).toEqual(['opted_out']);
    for (const c of [o({ consent: 'No' }), o({ consent: '' }), o({ consent: null })]) { expect(c.state).toBe('held'); expect(c.reasons[0]).toMatch(/\w/); }
  });
  it('several reasons are all listed (pending AND no consent)', () => {
    const r = o({ stage: 'Pending confirmation', consent: '' });
    expect(r.codes).toEqual(['pending_confirmation', 'consent_unknown']);
    expect(r.reasons).toHaveLength(2);
  });
  it('not applicable when the appointment is not Booked or has already started; the sent flags are reported', () => {
    for (const status of ['Cancelled', 'Completed', 'No-show', 'Rescheduled', '']) expect(o({ status }), status).toMatchObject({ state: 'not_applicable', codes: ['not_booked'] });
    expect(o({ startSec: NOW - 60 })).toMatchObject({ state: 'not_applicable', codes: ['already_started'] });
    expect(o({ r24Sent: NOW - 3600, r2Sent: null })).toMatchObject({ state: 'will_send', r24_sent_at: new Date((NOW - 3600) * 1000).toISOString(), r2_sent_at: null });
  });
});

describe('the staff detail carries the outlook (HTTP, real sessions)', () => {
  let fx: Fixture; let n = 0;
  const P = '9876543210'; const PN = '+919876543210';
  beforeEach(async () => { vi.spyOn(console, 'error').mockImplementation(() => {}); resetTokenFailures(); fx = await buildFixture({ bookingOn: true }); });
  afterEach(() => { vi.restoreAllMocks(); });
  const book = async (over: { stage?: string; phone?: string; patient_id?: string } = {}) => {
    const r = await fx.s('desk', '/appointments', { method: 'POST', body: { slot_id: M09, idempotency_key: `rem-key-${++n}-abcdefgh`, patient: { name: 'Test Patient One', phone: over.phone || P, ...(over.patient_id ? { patient_id: over.patient_id } : {}) }, ...(over.stage ? { stage: over.stage } : {}) } });
    expect(r.status).toBe(201); return r.json.appointment.booking_reference as string;
  };
  const outlook = async (ref: string) => (await fx.s('desk', `/appointments/${ref}`)).json.reminder;
  const consent = (value: string, phone = PN) => fx.doc[BT.consent]!.push({ id: fx.doc[BT.consent]!.length + 1, fields: { Consent_ID: 'RC-1', Phone: phone, Reminder_Consent: value } });

  it('a new booking with no consent record: held, "No reminder consent is recorded"', async () => {
    const r = await outlook(await book());
    expect(r).toMatchObject({ state: 'held', codes: ['consent_unknown'] });
    expect(r.reasons[0]).toMatch(/No reminder consent is recorded/);
  });
  it('after staff record a Yes it will be sent; a later No holds it again', async () => {
    const ref = await book();
    expect((await fx.s('admin', '/consent', { method: 'POST', body: { phone: P, value: 'Yes', source: 'Told staff in person', evidence_ref: 'Register serial 1234' } })).status).toBe(201);
    expect(await outlook(ref)).toMatchObject({ state: 'will_send', codes: [] });
    expect((await fx.s('desk', '/consent', { method: 'POST', body: { phone: P, value: 'No', source: 'Patient withdrew' } })).status).toBe(201);
    expect(await outlook(ref)).toMatchObject({ state: 'held', codes: ['consent_no'] });
  });
  it('a Pending confirmation booking is held even with a Yes', async () => {
    consent('Yes');
    expect(await outlook(await book({ stage: 'Pending confirmation' }))).toMatchObject({ state: 'held', codes: ['pending_confirmation'] });
  });
  it('an opt-out on any lead with that phone holds it; a cancelled appointment is not applicable', async () => {
    consent('Yes');
    const ref = await book();
    expect(await outlook(ref)).toMatchObject({ state: 'will_send' });
    fx.doc.LEADS!.push({ id: 900, fields: { Name: 'Opt Out', Phone: PN, Opted_Out: true } });
    expect(await outlook(ref)).toMatchObject({ state: 'held', codes: ['opted_out'] });
    expect((await fx.s('desk', `/appointments/${ref}/cancel`, { method: 'POST', body: {} })).status).toBe(200);
    expect(await outlook(ref)).toMatchObject({ state: 'not_applicable', codes: ['not_booked'] });
  });
  it('the consent tables not set up: reminders are held as unreadable, and the detail still loads', async () => {
    const ref = await book();
    delete fx.doc[BT.consent]; delete fx.doc[BT.consentLog];
    const r = await fx.s('desk', `/appointments/${ref}`);
    expect(r.status).toBe(200);
    expect(r.json.reminder).toMatchObject({ state: 'held', codes: ['consent_unreadable'] });
  });
});
