// The universal layer: terminology, industry profiles, registries and module resolution.
import { describe, expect, it } from 'vitest';
import { INDUSTRIES, INDUSTRY_KEYS } from '../src/core/industries';
import { ACTIVITY, ANALYTICS_CATEGORIES, AUTOMATIONS, METRICS, MODULES, TASKS, automationDescription, automationName, resolveProfile } from '../src/core/registry';
import { count, fmt, mergeTerminology, term } from '../src/core/terminology';
import type { AutomationKey, MetricKey, ModuleKey } from '../src/core/domain';

const ALL_SUPPORTED = {
  modules: ['bookings', 'ai', 'lead_qualification', 'reviews', 'follow_ups', 'reminders', 'reports', 'tasks', 'staff', 'analytics'] as ModuleKey[],
  automations: Object.keys(AUTOMATIONS) as AutomationKey[],
  metrics: Object.keys(METRICS) as MetricKey[],
};
const leftover = /\{[a-zA-Z]+\.[a-zA-Z_]+(\|[a-z]+)?\}/;

describe('terminology', () => {
  const t = INDUSTRIES.clinic.terminology;
  it('resolves tokens and modifiers', () => {
    expect(fmt('New {contact.plural}', t)).toBe('New Patients');
    expect(fmt('{booking.plural|lower}', t)).toBe('appointments');
    expect(fmt('book {booking.singular|a}', t)).toBe('book an appointment');
    expect(fmt('{contactStage.hot} and {bookingStatus.no_show}', t)).toBe('Hot and No-show');
    expect(term(t, 'ai.name')).toBe('AI Receptionist');
    expect(count(t, 'contact', 1)).toBe('1 patient');
    expect(count(t, 'contact', 3)).toBe('3 patients');
  });
  it('unknown paths fall back to the path, never to undefined', () => {
    expect(term(t, 'nope.nothing')).toBe('nope.nothing');
  });
  it('overrides win only with non-empty strings', () => {
    const m = mergeTerminology(t, { contact: { singular: 'Guest', plural: '  ' } });
    expect(m.contact.singular).toBe('Guest');
    expect(m.contact.plural).toBe('Patients');
  });
});

describe('industry profiles', () => {
  it.each(INDUSTRY_KEYS)('%s: every word, automation, metric, activity and task label resolves', (k) => {
    const p = INDUSTRIES[k];
    for (const noun of ['workspace', 'contact', 'booking', 'service', 'staff', 'conversation'] as const) {
      expect(p.terminology[noun].singular.trim()).not.toBe('');
      expect(p.terminology[noun].plural.trim()).not.toBe('');
    }
    for (const a of Object.keys(AUTOMATIONS) as AutomationKey[]) {
      expect(automationName(a, p.terminology)).not.toMatch(leftover);
      expect(automationName(a, p.terminology)).not.toBe(a);
      expect(automationDescription(a, p.terminology)).not.toMatch(leftover);
    }
    const templates = [
      ...Object.values(METRICS).flatMap((m) => [m.label, m.hint]),
      ...Object.values(ACTIVITY).map((a) => a.label),
      ...Object.values(TASKS).flatMap((x) => [x.label, x.action]),
      ...Object.values(MODULES).map((m) => m.label),
      ...Object.values(ANALYTICS_CATEGORIES).flatMap((c) => [c.label, c.description]),
    ];
    for (const s of templates) expect(fmt(s, p.terminology)).not.toMatch(leftover);
  });
  it('the same screen speaks each industry’s language', () => {
    const word = (k: keyof typeof INDUSTRIES) => resolveProfile({ industry: k }, ALL_SUPPORTED).terminology.contact.plural;
    expect(word('clinic')).toBe('Patients');
    expect(word('salon')).toBe('Clients');
    expect(word('agency')).toBe('Prospects');
    expect(word('real_estate')).toBe('Leads');
    expect(word('home_services')).toBe('Customers');
  });
});

describe('module resolution', () => {
  it('core modules are always on and cannot be disabled', () => {
    const r = resolveProfile({ industry: 'custom', modules: { disable: ['inbox', 'settings'] } }, ALL_SUPPORTED);
    for (const m of ['dashboard', 'inbox', 'contacts', 'activity', 'settings', 'automations'] as ModuleKey[]) expect(r.modules).toContain(m);
  });
  it('a module the backend cannot power never appears, even when enabled', () => {
    const r = resolveProfile({ industry: 'clinic', modules: { enable: ['payments', 'campaigns'] } }, ALL_SUPPORTED);
    expect(r.modules).not.toContain('payments');
    expect(r.modules).not.toContain('campaigns');
  });
  it('disabling a module removes its automations and dashboard metrics', () => {
    const on = resolveProfile({ industry: 'clinic' }, ALL_SUPPORTED);
    const off = resolveProfile({ industry: 'clinic', modules: { disable: ['ai', 'reviews'] } }, ALL_SUPPORTED);
    expect(on.automations).toContain('ai_assistant');
    expect(off.automations).not.toContain('ai_assistant');
    expect(off.automations).not.toContain('review_requests');
    expect(off.dashboardMetrics).not.toContain('ai_handled');
    expect(off.modules).not.toContain('ai');
  });
  it('without a booking backend there is no bookings page, automation or metric', () => {
    const r = resolveProfile({ industry: 'salon' }, { ...ALL_SUPPORTED, modules: ALL_SUPPORTED.modules.filter((m) => m !== 'bookings') });
    expect(r.modules).not.toContain('bookings');
    expect(r.automations).not.toContain('booking_sync');
    expect(r.dashboardMetrics).not.toContain('bookings');
  });
});

describe('clinic records modules', () => {
  const base = { modules: [] as never[], automations: [] as never[], metrics: [] as never[] };
  const RECORDS = ['patients', 'prescriptions', 'invoices', 'visits'] as const;
  const withRecords = { ...base, modules: [...RECORDS] as never[] };
  it('switch on for ANY industry once the backend has the records tables (e.g. the shipped default industry "clinic")', () => {
    for (const industry of ['clinic', 'physiotherapy', 'custom'] as const) {
      const r = resolveProfile({ industry }, withRecords);
      expect(r.modules).toEqual(expect.arrayContaining([...RECORDS]));
      expect(r.terminology.contact.plural).toBe(industry === 'custom' ? 'Contacts' : 'Enquiries');   // leads are never also called "Patients" (custom never did)
    }
  });
  it('stay off, and change nothing, where the backend has no records tables', () => {
    const r = resolveProfile({ industry: 'clinic' }, base);
    expect(r.modules.some((m) => (RECORDS as readonly string[]).includes(m))).toBe(false);
    expect(r.terminology.contact.plural).toBe('Patients');
  });
  it('respect the workspace: an explicit rename wins, a disabled module stays off', () => {
    expect(resolveProfile({ industry: 'clinic', terminology: { contact: { singular: 'Lead', plural: 'Leads' } } }, withRecords).terminology.contact.plural).toBe('Leads');
    const r = resolveProfile({ industry: 'clinic', modules: { disable: ['invoices'] } }, withRecords);
    expect(r.modules).not.toContain('invoices'); expect(r.modules).toContain('patients');
  });
  it('do not rename industries that never call leads "Patients"', () => {
    expect(resolveProfile({ industry: 'salon' }, withRecords).terminology.contact.plural).toBe('Clients');
  });
});
