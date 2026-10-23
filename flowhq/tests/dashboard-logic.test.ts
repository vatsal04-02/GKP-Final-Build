// The dashboard's pure helpers: follow-up priority and labels, reschedule dates, "today" in the clinic's time zone, and the rule that a
// money zero is only shown as a zero when invoices exist.
import { describe, expect, it } from 'vitest';
import { addDaysISO, checkRescheduleDate, daysBetween, dayOf, dueLabel, isISODate, moneyNote, moneyState, rescheduleChoices, sortFollowUps } from '../src/web/clinical/dashboardLogic';

const fu = (name: string, followUpOn: string, overdueDays: number) => ({ patientId: name, name, phone: '', complaint: '', followUpOn, overdueDays });

describe('follow-up priority', () => {
  it('puts the most overdue first, then today, then upcoming; ties by date then name; the input is not changed', () => {
    const input = [fu('Zed', '2026-10-09', 0), fu('Asha', '2026-10-07', 0), fu('Bina', '2026-10-01', 6), fu('Cara', '2026-10-05', 2), fu('Dev', '2026-10-05', 2), fu('Anu', '2026-10-05', 2)];
    const copy = JSON.stringify(input);
    expect(sortFollowUps(input).map((x) => x.name)).toEqual(['Bina', 'Anu', 'Cara', 'Dev', 'Asha', 'Zed']);
    expect(JSON.stringify(input)).toBe(copy);
    expect(sortFollowUps([])).toEqual([]);
  });
  it('labels how late (singular and plural), today, soon and far away, using the server\'s own numbers', () => {
    expect(dueLabel({ overdueDays: 1, followUpOn: '2026-10-06' }, '2026-10-07')).toEqual({ text: '1 day overdue', tone: 'red' });
    expect(dueLabel({ overdueDays: 6, followUpOn: '2026-10-01' }, '2026-10-07')).toEqual({ text: '6 days overdue', tone: 'red' });
    expect(dueLabel({ overdueDays: 0, followUpOn: '2026-10-07' }, '2026-10-07')).toEqual({ text: 'Due today', tone: 'amber' });
    expect(dueLabel({ overdueDays: 0, followUpOn: '2026-10-08' }, '2026-10-07')).toEqual({ text: 'Due in 1 day', tone: 'neutral' });
    expect(dueLabel({ overdueDays: 0, followUpOn: '2026-10-10' }, '2026-10-07')).toEqual({ text: 'Due in 3 days', tone: 'neutral' });
  });
});

describe('dates', () => {
  it('adds days across month, year and leap boundaries without drifting', () => {
    expect(addDaysISO('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysISO('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysISO('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-07', '2026-10-21')).toBe(14);
  });
  it('knows a real date from a look-alike', () => {
    for (const ok of ['2026-10-07', '2028-02-29']) expect(isISODate(ok)).toBe(true);
    for (const bad of ['2026-02-30', '2026-13-01', '07/10/2026', '2026-1-7', '', 'tomorrow']) expect(isISODate(bad)).toBe(false);
  });
  it('the reschedule choices are relative to today, and the checker accepts only today or later', () => {
    expect(rescheduleChoices('2026-10-07')).toEqual([{ label: 'Tomorrow', date: '2026-10-08' }, { label: 'In 3 days', date: '2026-10-10' }, { label: 'In a week', date: '2026-10-14' }, { label: 'In 2 weeks', date: '2026-10-21' }]);
    expect(checkRescheduleDate('2026-10-07', '2026-10-07')).toBeNull();
    expect(checkRescheduleDate('2026-12-01', '2026-10-07')).toBeNull();
    expect(checkRescheduleDate('2026-10-06', '2026-10-07')).toMatch(/today or a later/);
    expect(checkRescheduleDate('', '2026-10-07')).toMatch(/Choose a date/);
    expect(checkRescheduleDate('2026-02-30', '2026-10-07')).toMatch(/valid date/);
  });
  it('a moment belongs to the calendar day of the clinic\'s time zone, not of the machine', () => {
    expect(dayOf('2026-10-07T20:00:00Z', 'Asia/Kolkata')).toBe('2026-10-08');   // 01:30 next day in India
    expect(dayOf('2026-10-07T20:00:00Z', 'UTC')).toBe('2026-10-07');
    expect(dayOf('2026-10-07T18:29:00Z', 'Asia/Kolkata')).toBe('2026-10-07');
    expect(dayOf(null, 'Asia/Kolkata')).toBeNull();
  });
});

describe('money is never "zero" by default', () => {
  it('a state needs a finished, successful look at the invoices', () => {
    expect(moneyState({ loading: true, error: false, count: null })).toBe('unknown');
    expect(moneyState({ loading: false, error: true, count: null })).toBe('unknown');
    expect(moneyState({ loading: false, error: true, count: 5 })).toBe('unknown');
    expect(moneyState({ loading: false, error: false, count: null })).toBe('unknown');
    expect(moneyState({ loading: false, error: false, count: 0 })).toBe('none');
    expect(moneyState({ loading: false, error: false, count: 3 })).toBe('yes');
  });
  it('a zero is shown only when invoices exist; otherwise it says what is missing; a real amount is always shown', () => {
    expect(moneyNote(0, 'yes')).toBeNull();
    expect(moneyNote(0, 'none')).toBe('No invoices yet');
    expect(moneyNote(0, 'unknown')).toBe('Not confirmed yet');
    for (const s of ['yes', 'none', 'unknown'] as const) expect(moneyNote(480000, s)).toBeNull();
  });
});
