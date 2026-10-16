// The ONE place user-facing words for business concepts come from. Screens never write "Patient" or "Appointment": they ask
// for `contact.plural` or `booking.singular` and the workspace's industry profile (plus its own overrides) answers.
import type { AutomationKey, BookingStatus, ContactStage, ContactStatus, MetricKey } from './domain';

export interface Noun { singular: string; plural: string }

export interface Terminology {
  workspace: Noun;          // the business itself: Clinic, Salon, Agency, Business...
  contact: Noun;            // Patient, Client, Lead, Prospect, Customer...
  booking: Noun;            // Appointment, Session, Meeting, Site visit, Job...
  service: Noun;            // Treatment, Service, Property, Course...
  staff: Noun;              // Therapist, Stylist, Agent, Consultant, Technician...
  conversation: Noun;
  ai: { name: string; short: string };   // AI Receptionist, AI Sales Assistant...
  contactStatus: Record<ContactStatus, string>;
  contactStage: Record<ContactStage, string>;
  bookingStatus: Record<BookingStatus, string>;
  outcome: { better: string; same: string; worse: string };   // answers to an after-visit check-in
  automations: Partial<Record<AutomationKey, { name?: string; description?: string }>>;
  metrics: Partial<Record<MetricKey, string>>;
}

export type TermPath =
  | 'workspace.singular' | 'workspace.plural' | 'contact.singular' | 'contact.plural' | 'booking.singular' | 'booking.plural'
  | 'service.singular' | 'service.plural' | 'staff.singular' | 'staff.plural' | 'conversation.singular' | 'conversation.plural'
  | 'ai.name' | 'ai.short';

// Plain lookup: term(t, 'contact.plural') -> "Patients". Also reaches the other word lists: 'outcome.better', 'contactStage.hot',
// 'bookingStatus.no_show', 'contactStatus.converted'.
export function term(t: Terminology, path: TermPath | string): string {
  const [a, b] = path.split('.');
  const group = (t as unknown as Record<string, Record<string, unknown>>)[a];
  const v = group && typeof group === 'object' ? group[b] : undefined;
  return typeof v === 'string' ? v : path;
}

// Templates: "New {contact.plural}" -> "New Patients". Modifiers: {contact.plural|lower}, {booking.singular|a} ("an appointment").
const TOKEN = /\{([a-zA-Z]+\.[a-zA-Z_]+)(\|[a-z]+)?\}/g;
export function fmt(template: string, t: Terminology): string {
  return template.replace(TOKEN, (_, path: TermPath, mod?: string) => {
    let v = term(t, path);
    if (mod === '|lower') v = v.toLowerCase();
    if (mod === '|a') v = `${/^[aeiou]/i.test(v) ? 'an' : 'a'} ${v.toLowerCase()}`;
    return v;
  });
}

// Count-aware noun: plural(t, 'contact', 1) -> "1 patient", plural(t, 'contact', 3) -> "3 patients"
export function count(t: Terminology, noun: 'contact' | 'booking' | 'service' | 'staff' | 'conversation' | 'workspace', n: number): string {
  const w = n === 1 ? t[noun].singular : t[noun].plural;
  return `${n.toLocaleString()} ${w.toLowerCase()}`;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type TerminologyOverrides = DeepPartial<Terminology>;

// base <- profile <- workspace overrides (only non-empty strings win)
export function mergeTerminology(base: Terminology, ...layers: Array<TerminologyOverrides | undefined>): Terminology {
  const out = JSON.parse(JSON.stringify(base)) as Terminology;
  const apply = (target: Record<string, unknown>, src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        apply(target[k] as Record<string, unknown>, v as Record<string, unknown>);
      } else if (typeof v === 'string' && v.trim()) target[k] = v.trim();
    }
  };
  for (const l of layers) if (l) apply(out as unknown as Record<string, unknown>, l as Record<string, unknown>);
  return out;
}

// The nouns a workspace admin may rename in Settings > Terminology (the rest stays with the industry profile).
export const EDITABLE_NOUNS = ['contact', 'booking', 'service', 'staff', 'workspace'] as const;
