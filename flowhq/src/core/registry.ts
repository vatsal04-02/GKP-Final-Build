// Registries: modules (pages), automations, metrics, analytics categories, activity and task kinds. Every label is a
// terminology template ({contact.plural}, {booking.singular}...), resolved with the workspace's words at render time.
import type { ActivityKind, AnalyticsCategory, AutomationKey, IndustryKey, MetricKey, ModuleKey, TaskKind } from './domain';
import { INDUSTRIES } from './industries';
import { fmt, mergeTerminology, type Terminology, type TerminologyOverrides } from './terminology';

// ---------------------------------------------------------------- modules
export interface ModuleDef { key: ModuleKey; core: boolean; label: string; page: string | null; icon: string; shortcut?: string; order: number }
export const MODULES: Record<ModuleKey, ModuleDef> = {
  dashboard: { key: 'dashboard', core: true, label: 'Dashboard', page: '/', icon: 'layout-dashboard', shortcut: 'g d', order: 1 },
  inbox: { key: 'inbox', core: true, label: 'Inbox', page: '/inbox', icon: 'inbox', shortcut: 'g i', order: 2 },
  contacts: { key: 'contacts', core: true, label: '{contact.plural}', page: '/contacts', icon: 'users', shortcut: 'g c', order: 3 },
  patients: { key: 'patients', core: false, label: 'Patients', page: '/patients', icon: 'user-round', shortcut: 'g p', order: 3.2 },
  prescriptions: { key: 'prescriptions', core: false, label: 'Prescriptions', page: '/prescriptions', icon: 'clipboard-list', shortcut: 'g n', order: 3.4 },
  invoices: { key: 'invoices', core: false, label: 'Invoices & Payments', page: '/invoices', icon: 'receipt', shortcut: 'g v', order: 3.6 },
  visits: { key: 'visits', core: false, label: 'Attendance', page: '/attendance', icon: 'calendar-check', shortcut: 'g u', order: 3.8 },
  bookings: { key: 'bookings', core: false, label: '{booking.plural}', page: '/bookings', icon: 'calendar', shortcut: 'g b', order: 4 },
  schedule: { key: 'schedule', core: false, label: 'Schedule', page: '/schedule', icon: 'calendar-clock', shortcut: 'g k', order: 4.2 },
  automations: { key: 'automations', core: true, label: 'Automations', page: '/automations', icon: 'workflow', shortcut: 'g a', order: 5 },
  tasks: { key: 'tasks', core: false, label: 'Tasks', page: '/tasks', icon: 'list-checks', shortcut: 'g t', order: 6 },
  reports: { key: 'reports', core: false, label: 'Reports', page: '/reports', icon: 'bar-chart', shortcut: 'g r', order: 7 },
  activity: { key: 'activity', core: true, label: 'Activity', page: '/activity', icon: 'activity', shortcut: 'g y', order: 8 },
  ai: { key: 'ai', core: false, label: '{ai.short}', page: '/ai', icon: 'sparkles', shortcut: 'g x', order: 9 },
  settings: { key: 'settings', core: true, label: 'Settings', page: '/settings', icon: 'settings', shortcut: 'g s', order: 10 },
  // capability modules: they switch automations / metrics on, without a page of their own
  lead_qualification: { key: 'lead_qualification', core: false, label: 'Lead qualification', page: null, icon: 'target', order: 50 },
  reviews: { key: 'reviews', core: false, label: 'Reviews', page: null, icon: 'star', order: 51 },
  follow_ups: { key: 'follow_ups', core: false, label: 'Follow-ups', page: null, icon: 'repeat', order: 52 },
  reminders: { key: 'reminders', core: false, label: 'Reminders', page: null, icon: 'bell', order: 53 },
  staff: { key: 'staff', core: false, label: '{staff.plural}', page: null, icon: 'user-cog', order: 54 },
  analytics: { key: 'analytics', core: false, label: 'Analytics', page: null, icon: 'line-chart', order: 55 },
  // registered for future backends: no backend supports them yet, so they never appear (payments is now supported by the clinic backend)
  payments: { key: 'payments', core: false, label: 'Payment Management', page: '/payments', icon: 'credit-card', shortcut: 'g m', order: 4.4 },   // UPI payment review (src/web/clinical/PaymentManagement.tsx); appears only when the payment tables exist
  campaigns: { key: 'campaigns', core: false, label: 'Campaigns', page: null, icon: 'megaphone', order: 61 },
  forms: { key: 'forms', core: false, label: 'Forms', page: null, icon: 'file-text', order: 62 },
};
// Sidebar sections: the dashboard stays pinned at the top; everything else is grouped. A module that is not enabled simply does not show.
export const NAV_GROUPS: Array<{ key: string; label: string; modules: ModuleKey[] }> = [
  { key: 'care', label: 'Care', modules: ['inbox', 'contacts', 'patients', 'bookings', 'schedule', 'prescriptions', 'visits'] },
  { key: 'money', label: 'Money', modules: ['invoices', 'payments'] },
  { key: 'system', label: 'System', modules: ['automations', 'tasks', 'reports', 'activity', 'ai', 'settings'] },
];
export const CORE_MODULES = (Object.values(MODULES).filter((m) => m.core).map((m) => m.key));

// ---------------------------------------------------------------- automations (the universal catalogue)
export interface AutomationDef { key: AutomationKey; module: ModuleKey; category: 'capture' | 'engage' | 'bookings' | 'retention' | 'ai' | 'insight' | 'system'; order: number }
export const AUTOMATIONS: Record<AutomationKey, AutomationDef> = {
  ai_assistant: { key: 'ai_assistant', module: 'ai', category: 'ai', order: 1 },
  contact_capture: { key: 'contact_capture', module: 'contacts', category: 'capture', order: 2 },
  inbound_messaging: { key: 'inbound_messaging', module: 'inbox', category: 'capture', order: 3 },
  speed_to_lead: { key: 'speed_to_lead', module: 'lead_qualification', category: 'engage', order: 4 },
  booking_sync: { key: 'booking_sync', module: 'bookings', category: 'bookings', order: 5 },
  booking_reminders: { key: 'booking_reminders', module: 'reminders', category: 'bookings', order: 6 },
  follow_ups: { key: 'follow_ups', module: 'follow_ups', category: 'engage', order: 7 },
  outcome_checkins: { key: 'outcome_checkins', module: 'follow_ups', category: 'retention', order: 8 },
  review_requests: { key: 'review_requests', module: 'reviews', category: 'retention', order: 9 },
  staff_reply: { key: 'staff_reply', module: 'inbox', category: 'engage', order: 10 },
  weekly_reports: { key: 'weekly_reports', module: 'reports', category: 'insight', order: 11 },
  error_alerts: { key: 'error_alerts', module: 'settings', category: 'system', order: 12 },
};
export const automationName = (key: AutomationKey, t: Terminology) => fmt(t.automations[key]?.name || key, t);
export const automationDescription = (key: AutomationKey, t: Terminology) => fmt(t.automations[key]?.description || '', t);

// ---------------------------------------------------------------- metrics
export interface MetricDef { key: MetricKey; label: string; hint: string; module: ModuleKey; unit: 'count' | 'percent' | 'currency'; good: 'up' | 'down' | 'neutral' }
export const METRICS: Record<MetricKey, MetricDef> = {
  new_contacts: { key: 'new_contacts', label: 'New {contact.plural}', hint: '{contact.plural} created in the period', module: 'contacts', unit: 'count', good: 'up' },
  active_conversations: { key: 'active_conversations', label: 'Active conversations', hint: 'Conversations with a message from the {contact.singular|lower} in the period', module: 'inbox', unit: 'count', good: 'up' },
  bookings: { key: 'bookings', label: '{booking.plural}', hint: '{booking.plural} starting in the period (not cancelled)', module: 'bookings', unit: 'count', good: 'up' },
  completed: { key: 'completed', label: 'Completed', hint: '{booking.plural} marked completed in the period', module: 'bookings', unit: 'count', good: 'up' },
  no_shows: { key: 'no_shows', label: 'No-shows', hint: '{booking.plural} marked no-show in the period', module: 'bookings', unit: 'count', good: 'down' },
  pending_actions: { key: 'pending_actions', label: 'Needs attention', hint: 'Open tasks: replies a person owes, outcomes to mark, failed replies, due follow-ups', module: 'dashboard', unit: 'count', good: 'down' },
  ai_handled: { key: 'ai_handled', label: '{ai.short} handled', hint: 'Share of incoming messages the {ai.name} answered without a person', module: 'ai', unit: 'percent', good: 'up' },
  human_handoffs: { key: 'human_handoffs', label: 'Human handoffs', hint: 'Messages the {ai.name} passed to a person', module: 'ai', unit: 'count', good: 'neutral' },
  conversion: { key: 'conversion', label: 'Conversion', hint: 'New {contact.plural|lower} in the period who booked or converted', module: 'contacts', unit: 'percent', good: 'up' },
  revenue: { key: 'revenue', label: 'Revenue', hint: 'Value of completed {booking.plural|lower} (only where the value is recorded)', module: 'bookings', unit: 'currency', good: 'up' },
  follow_ups: { key: 'follow_ups', label: 'Follow-ups', hint: 'Follow-up messages sent', module: 'follow_ups', unit: 'count', good: 'up' },
  reviews: { key: 'reviews', label: 'Reviews asked', hint: 'Review requests sent', module: 'reviews', unit: 'count', good: 'up' },
  reminders: { key: 'reminders', label: 'Reminders', hint: '{booking.singular} reminders sent', module: 'reminders', unit: 'count', good: 'up' },
};

// ---------------------------------------------------------------- analytics categories (reports)
export const ANALYTICS_CATEGORIES: Record<AnalyticsCategory, { label: string; description: string }> = {
  acquisition: { label: 'Acquisition', description: 'Where new {contact.plural|lower} come from' },
  engagement: { label: 'Engagement', description: 'Conversations and response speed' },
  bookings: { label: '{booking.plural}', description: 'What happened to {booking.plural|lower}' },
  conversion: { label: 'Conversion', description: 'From first message to {booking.singular|lower}' },
  automation: { label: 'Automation', description: 'Messages your automations sent' },
  ai: { label: '{ai.name}', description: 'What the assistant handled' },
  handoffs: { label: 'Human handoffs', description: 'Where people were needed' },
  retention: { label: 'Retention', description: 'Bringing {contact.plural|lower} back' },
  feedback: { label: '{contact.singular} feedback', description: 'Answers after a {booking.singular|lower}' },
};

// ---------------------------------------------------------------- activity and task kinds
export const ACTIVITY: Record<ActivityKind, { label: string; tone: 'blue' | 'neutral' | 'amber' | 'red' | 'green'; icon: string }> = {
  contact_created: { label: 'New {contact.singular|lower}', tone: 'blue', icon: 'user-plus' },
  message_received: { label: 'Message received', tone: 'neutral', icon: 'message-circle' },
  ai_replied: { label: '{ai.short} replied', tone: 'blue', icon: 'sparkles' },
  ai_handoff: { label: 'Handed to a person', tone: 'amber', icon: 'hand' },
  booking_created: { label: '{booking.singular} created', tone: 'blue', icon: 'calendar-plus' },
  booking_rescheduled: { label: '{booking.singular} rescheduled', tone: 'neutral', icon: 'calendar-clock' },
  booking_cancelled: { label: '{booking.singular} cancelled', tone: 'neutral', icon: 'calendar-x' },
  reminder_sent: { label: 'Reminder sent', tone: 'neutral', icon: 'bell' },
  follow_up_sent: { label: 'Follow-up sent', tone: 'neutral', icon: 'repeat' },
  outcome_checkin_sent: { label: 'Check-in sent', tone: 'neutral', icon: 'heart-pulse' },
  review_requested: { label: 'Review requested', tone: 'neutral', icon: 'star' },
  staff_replied: { label: '{staff.singular} replied', tone: 'green', icon: 'reply' },
  contact_escalated: { label: 'Team alerted', tone: 'amber', icon: 'alarm-clock' },
  report_generated: { label: 'Report ready', tone: 'blue', icon: 'file-bar-chart' },
  automation_failed: { label: 'Automation failed', tone: 'red', icon: 'alert-triangle' },
  automation_skipped: { label: 'Automation skipped', tone: 'neutral', icon: 'skip-forward' },
  message_sent: { label: 'Message sent', tone: 'neutral', icon: 'send' },
};
export const TASKS: Record<TaskKind, { label: string; action: string }> = {
  reply_needed: { label: 'Reply needed', action: 'Open conversation' },
  next_action_due: { label: 'Follow-up due', action: 'Open {contact.singular|lower}' },
  booking_outcome: { label: 'Mark the outcome', action: 'Completed or no-show?' },
  reply_failed: { label: 'Reply not delivered', action: 'Open conversation' },
  first_response: { label: 'Waiting for a first reply', action: 'Open {contact.singular|lower}' },
};

// ---------------------------------------------------------------- resolving a workspace's profile
export interface WorkspaceProfileInput {
  industry: IndustryKey;
  terminology?: TerminologyOverrides;
  modules?: { enable?: ModuleKey[]; disable?: ModuleKey[] };
  dashboardMetrics?: MetricKey[];
}
const RECORDS_MODULES: ModuleKey[] = ['patients', 'prescriptions', 'invoices', 'visits', 'schedule', 'payments'];
export function resolveProfile(input: WorkspaceProfileInput, supported: { modules: ModuleKey[]; automations: AutomationKey[]; metrics: MetricKey[] }) {
  const p = INDUSTRIES[input.industry] || INDUSTRIES.custom;
  let terminology = mergeTerminology(p.terminology, input.terminology);
  // Clinic records (patients, prescriptions, invoices, attendance) are an explicit opt-in: they exist only where the clinic's data has the
  // Clinic Records tables, so they switch on whatever industry the workspace defaults to (a workspace may still disable them).
  const wanted = new Set<ModuleKey>([...CORE_MODULES, ...p.modules, ...(input.modules?.enable || []), ...RECORDS_MODULES.filter((m) => supported.modules.includes(m))]);
  for (const m of input.modules?.disable || []) if (!MODULES[m].core) wanted.delete(m);
  const modules = [...wanted].filter((m) => MODULES[m].core || supported.modules.includes(m)).sort((a, b) => MODULES[a].order - MODULES[b].order);
  // With a real patient register, enquiries (leads) must never also be called "Patients". An explicit rename by the workspace wins.
  if (modules.includes('patients') && !input.terminology?.contact && terminology.contact.plural.toLowerCase() === 'patients') terminology = { ...terminology, contact: { singular: 'Enquiry', plural: 'Enquiries' } };
  const automations = supported.automations.filter((a) => modules.includes(AUTOMATIONS[a].module)).sort((a, b) => AUTOMATIONS[a].order - AUTOMATIONS[b].order);
  const dashboardMetrics = (input.dashboardMetrics || p.dashboardMetrics).filter((m) => supported.metrics.includes(m) && modules.includes(METRICS[m].module === 'dashboard' ? 'dashboard' : METRICS[m].module));
  return { terminology, modules, automations, dashboardMetrics };
}
